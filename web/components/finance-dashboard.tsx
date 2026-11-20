"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ErrorAlert, Input, Load } from "@/components/ui";
import { api, fetchBlob } from "@/lib/api";
import { monthStart, rupiah, today } from "@/lib/format";
import { t } from "@/lib/strings";
import type { FinanceSummary, PlayerBucket, PlayerBuckets } from "@/lib/types";

const d = t.dashboard;
// Reference categorical palette, slots 1-4 in fixed order (dataviz palette.md, light surface).
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
const dayMonth = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "Asia/Jakarta" });
const monthYear = new Intl.DateTimeFormat("id-ID", { month: "short", year: "2-digit", timeZone: "Asia/Jakarta" });
const asDate = (day: string) => new Date(`${day}T12:00:00+07:00`);

/** Club finance dashboard on the Wallet page (admins). Print view doubles as the PDF report. */
export function FinanceDashboard() {
  const [from, setFrom] = useState(monthStart(0));
  const [to, setTo] = useState(today());
  const range = `from=${from}&to=${to}`;
  const summary = useQuery({
    queryKey: ["finance", range],
    queryFn: () => api.get<FinanceSummary>(`/finance/summary?${range}`).then((r) => r.data),
  });
  const players = useQuery({
    queryKey: ["finance-players"],
    queryFn: () => api.get<PlayerBuckets>("/finance/players").then((r) => r.data),
  });
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const excel = async () => {
    setDownloadError(null);
    try {
      const url = URL.createObjectURL(await fetchBlob(`/finance/report.xlsx?${range}`));
      const a = Object.assign(document.createElement("a"), { href: url, download: `shuttlecircle-laporan-${from}-${to}.xlsx` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(e);
    }
  };

  return (
    <section id="finance-report" className="card mb-8 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2>{d.title}</h2>
          <p className="caption text-muted print:hidden">{d.intro}</p>
          <p className="caption hidden print:block">{d.reportRange(from, to)}</p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button onClick={excel}>{d.excel}</Button>
          <Button onClick={() => window.print()}>{d.pdf}</Button>
        </div>
      </div>
      {!!downloadError && <ErrorAlert error={downloadError} />}
      <div className="my-4 grid max-w-[640px] grid-cols-2 gap-3 print:hidden">
        <Input label={t.admin.from} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input label={t.admin.to} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>

      <Load q={summary}>{(s) => <Status s={s} />}</Load>

      <h3 className="mt-8 mb-2">{d.playersTitle}</h3>
      <Load q={players}>{(p) => <PlayersChart data={p} />}</Load>
    </section>
  );
}

function Status({ s }: { s: FinanceSummary }) {
  const income = s.fee_income_idr + s.membership_income_idr + s.donation_idr;
  const outcome = s.court_cost_idr + s.expenses.drinking_water + s.expenses.shuttlecock + s.expenses.other;
  const slices = [
    { label: d.income, hint: d.incomeHint, value: income },
    { label: d.outcome, hint: d.outcomeHint, value: outcome },
    { label: d.balance, hint: "", value: s.member_balance_idr },
    { label: d.discrepancy, hint: d.discrepancyHint, value: Math.abs(s.discrepancy_idr) },
  ];
  const total = slices.reduce((a, x) => a + Math.max(0, x.value), 0);
  const ok = s.discrepancy_idr === 0;
  return (
    <div className="grid items-center gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <figure className="mx-auto w-56">
        <figcaption className="sr-only">{d.statusTitle}</figcaption>
        {total === 0 ? <p className="text-muted">{d.pieEmpty}</p> : <Donut values={slices.map((x) => Math.max(0, x.value))} labels={slices.map((x) => x.label)} />}
      </figure>
      <div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {slices.map((x, i) => (
            <li key={x.label} className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 size-3 shrink-0 rounded-sm" style={{ background: SERIES[i] }} />
              <div className="min-w-0">
                <p className="label">{x.label}</p>
                <p className="mono font-semibold">
                  {i === 3 ? rupiah(s.discrepancy_idr) : rupiah(x.value)}
                  {total > 0 && <span className="caption ml-2 font-normal text-muted">{d.share(Math.round((Math.max(0, x.value) / total) * 100))}</span>}
                </p>
                {x.hint && <p className="caption text-muted">{x.hint}</p>}
                {i === 3 && (
                  <p className={`caption font-bold ${ok ? "text-success" : "text-warning"}`}>{ok ? `✓ ${d.discrepancyOk}` : `! ${d.discrepancyBad}`}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-border pt-2">
          <span className="label">{d.net} </span>
          <span className="mono font-bold">{rupiah(income - outcome)}</span>
        </p>
      </div>
    </div>
  );
}

/** Donut with a 2px surface gap between slices; each slice names itself on hover. */
function Donut({ values, labels }: { values: number[]; labels: string[] }) {
  const total = values.reduce((a, b) => a + b, 0);
  const R = 50;
  let angle = -Math.PI / 2;
  const point = (a: number) => `${60 + R * Math.cos(a)} ${60 + R * Math.sin(a)}`;
  return (
    <svg viewBox="0 0 120 120" role="img" aria-label={labels.map((l, i) => `${l} ${Math.round((values[i] / total) * 100)}%`).join(", ")}>
      {values.map((v, i) => {
        if (v <= 0) return null;
        const sweep = (v / total) * Math.PI * 2;
        const start = angle;
        angle += sweep;
        const title = <title>{`${labels[i]}: ${rupiah(v)} (${Math.round((v / total) * 100)}%)`}</title>;
        // A full circle cannot be one arc path.
        if (sweep >= Math.PI * 2 - 1e-6) {
          return (
            <circle key={i} cx="60" cy="60" r={R} fill={SERIES[i]}>
              {title}
            </circle>
          );
        }
        return (
          <path
            key={i}
            d={`M60 60 L${point(start)} A${R} ${R} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(angle)} Z`}
            fill={SERIES[i]}
            stroke="var(--color-surface)"
            strokeWidth="2"
            strokeLinejoin="round"
          >
            {title}
          </path>
        );
      })}
      <circle cx="60" cy="60" r="26" fill="var(--color-surface)" />
    </svg>
  );
}

function PlayersChart({ data }: { data: PlayerBuckets }) {
  const [unit, setUnit] = useState<"weeks" | "months">("weeks");
  const rows = data[unit];
  const label = (b: PlayerBucket) => (unit === "weeks" ? dayMonth.format(asDate(b.start)) : monthYear.format(asDate(b.start)));
  const name = (b: PlayerBucket) => (unit === "weeks" ? d.weekOf(label(b)) : label(b));
  const tip = (b: PlayerBucket) => d.barTip(unit === "weeks" ? d.weekOf(label(b)) : label(b), b.players, b.seats, b.new_members);
  const max = Math.max(4, ...rows.map((b) => b.players));
  const top = Math.ceil(max / 4) * 4; // four even gridline steps
  const W = 480, H = 200, L = 28, B = 24, slot = (W - L - 18) / rows.length, bw = Math.min(28, slot * 0.6);
  const y = (v: number) => H - B - (v / top) * (H - B - 8);
  return (
    <>
      <div role="group" aria-label={d.playersTitle} className="mb-2 flex gap-1 print:hidden">
        {(["weeks", "months"] as const).map((u) => (
          <Button key={u} variant={unit === u ? "primary" : "secondary"} aria-pressed={unit === u} onClick={() => setUnit(u)}>
            {u === "weeks" ? d.weekly : d.monthly}
          </Button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl" role="img" aria-label={`${d.playersTitle}, ${unit === "weeks" ? d.weekly : d.monthly}`}>
        {[0, 1, 2, 3, 4].map((k) => {
          const v = (top / 4) * k;
          return (
            <g key={k}>
              <line x1={L} x2={W} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={k === 0 ? 0.35 : 0.1} />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="13" fill="currentColor" opacity="0.6">
                {v}
              </text>
            </g>
          );
        })}
        {rows.map((b, i) => {
          const x = L + slot * i + (slot - bw) / 2;
          const h = y(0) - y(b.players);
          return (
            <g key={b.start}>
              <title>{tip(b)}</title>
              <rect x={L + slot * i} y={0} width={slot} height={H - B} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x} ${y(0)} V${y(b.players) + 4} Q${x} ${y(b.players)} ${x + 4} ${y(b.players)} H${x + bw - 4} Q${x + bw} ${y(b.players)} ${x + bw} ${y(b.players) + 4} V${y(0)} Z`}
                  fill={SERIES[0]}
                />
              )}
              {(rows.length - 1 - i) % 3 === 0 && (
                <text x={L + slot * i + slot / 2} y={H - 6} textAnchor="middle" fontSize="13" fill="currentColor" opacity="0.6">
                  {label(b)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="caption text-muted">{d.playersNote}</p>
      <details className="mt-2 print:hidden">
        <summary className="link caption cursor-pointer">{d.table}</summary>
        <BucketTable rows={rows} name={name} />
      </details>
      {/* a closed details element never prints, so the report gets its own copy */}
      <div className="hidden print:block">
        <BucketTable rows={rows} name={name} />
      </div>
    </>
  );
}

function BucketTable({ rows, name }: { rows: PlayerBucket[]; name: (b: PlayerBucket) => string }) {
  return (
    <table className="mt-2 w-full text-left text-sm">
      <thead>
        <tr className="label">
          <th scope="col" className="py-1 pr-3">{d.period}</th>
          <th scope="col" className="py-1 pr-3 text-right">{d.players}</th>
          <th scope="col" className="py-1 pr-3 text-right">{d.seats}</th>
          <th scope="col" className="py-1 text-right">{d.newMembers}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.start} className="border-t border-border">
            <th scope="row" className="py-1 pr-3 font-normal">{name(b)}</th>
            <td className="mono py-1 pr-3 text-right">{b.players}</td>
            <td className="mono py-1 pr-3 text-right">{b.seats}</td>
            <td className="mono py-1 text-right">{b.new_members}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
