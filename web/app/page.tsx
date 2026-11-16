"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button, Chip, Empty, Load, Skeleton, buttonClass } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDate, fmtMonth, fmtTime, groupBy, jakartaDay, monthStart, rupiah, today } from "@/lib/format";
import { atLeast, useMe } from "@/lib/session";
import { t } from "@/lib/strings";
import type { Match } from "@/lib/types";

const cell = "border-r border-b border-border";

export default function CalendarPage() {
  const me = useMe();
  const [offset, setOffset] = useState(0); // months from the current Jakarta month: −1 … 3 (AC-F2-01)
  const q = useQuery({
    queryKey: ["matches"],
    queryFn: () => api.get<Match[]>(`/matches?from=${monthStart(-1)}&to=${monthStart(4)}`).then((r) => r.data),
  });

  const first = monthStart(offset);
  const [year, month] = first.split("-").map(Number);
  const days = Array.from(
    { length: new Date(Date.UTC(year, month, 0)).getUTCDate() },
    (_, i) => `${first.slice(0, 8)}${String(i + 1).padStart(2, "0")}`,
  );
  const leadingBlanks = (new Date(first).getUTCDay() + 6) % 7; // weeks start on Monday
  const create = atLeast(me, "host") && (
    <Link href="/matches/new" className={buttonClass("primary")}>
      {t.calendar.create}
    </Link>
  );

  return (
    <>
      <section className="court-pattern on-dark mb-6 flex flex-col gap-4 rounded-2xl border border-emerald-900 p-5 sm:p-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h1>
            {t.calendar.hero} <span className="text-lime">{me.kind === "member" ? me.full_name : me.nickname}</span>?
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-emerald-100/80">{t.calendar.heroIntro}</p>
          {create && <div className="mt-4">{create}</div>}
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-2.5">
          {[
            { label: t.calendar.openSessions, value: q.data?.filter((m) => m.status === "scheduled" && m.seats_taken < m.capacity).length },
            { label: t.calendar.scheduled, value: q.data?.filter((m) => m.status === "scheduled").length },
          ].map((s) => (
            <div key={s.label} className="flex min-w-24 flex-col-reverse rounded-2xl border border-white/15 bg-white/10 p-3 text-center">
              <dt className="text-[0.6875rem] font-medium text-emerald-100">{s.label}</dt>
              <dd className="text-2xl font-extrabold text-lime">{s.value ?? "–"}</dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="mb-4 flex items-center justify-between gap-2">
        <Button variant="tertiary" className="shrink-0" aria-label={t.calendar.prev} disabled={offset <= -1} onClick={() => setOffset(offset - 1)}>
          ‹ <span className="max-md:hidden">{t.calendar.prev}</span>
        </Button>
        <h2 aria-live="polite" className="text-center max-md:text-xl">
          {fmtMonth(first)}
        </h2>
        <Button variant="tertiary" className="shrink-0" aria-label={t.calendar.next} disabled={offset >= 3} onClick={() => setOffset(offset + 1)}>
          <span className="max-md:hidden">{t.calendar.next}</span> ›
        </Button>
      </div>

      <Load
        q={q}
        skeleton={
          <div role="status" className="grid gap-2 md:grid-cols-7">
            <span className="sr-only">{t.common.loading}</span>
            {Array.from({ length: 14 }, (_, i) => (
              <Skeleton key={i} className="h-16 md:h-28" />
            ))}
          </div>
        }
      >
        {(matches) => {
          const byDay = groupBy(matches, (m) => jakartaDay(m.starts_at));
          const busyDays = days.filter((d) => byDay.has(d));
          return (
            <>
              {/* ≥768 px: month grid */}
              <div className="card overflow-hidden border-r-0 border-b-0 max-md:hidden">
                <div className="grid grid-cols-7">
                  {t.calendar.weekdays.map((d) => (
                    <div key={d} className={`label bg-bg px-2 py-2 ${cell}`}>
                      {d}
                    </div>
                  ))}
                  {Array.from({ length: leadingBlanks }, (_, i) => (
                    <div key={i} className={`bg-bg ${cell}`} />
                  ))}
                  {days.map((d) => (
                    <div key={d} className={`min-h-28 min-w-0 p-1 ${cell}`}>
                      <p
                        className={`mono flex size-6 items-center justify-center rounded-full text-xs ${d === today() ? "bg-accent text-on-accent" : "text-muted"}`}
                      >
                        {Number(d.slice(8))}
                      </p>
                      {byDay.get(d)?.map((m) => (
                        <Link
                          key={m.id}
                          href={`/matches/${m.id}`}
                          className="mt-1 block rounded-lg border border-emerald-200 bg-emerald-50 px-1.5 py-1 hover:bg-emerald-100"
                        >
                          <span className="block truncate font-medium">
                            <span className="mono">{fmtTime(m.starts_at)}</span> {m.title}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Chip status={m.status} />
                            <span className="mono">
                              {m.seats_taken}/{m.capacity}
                            </span>
                            <span className="mono">{rupiah(m.price_idr)}</span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* <768 px: agenda list */}
              <div className="md:hidden">
                {busyDays.map((d) => (
                  <section key={d} className="mb-4">
                    <h3 className="label mb-2">{fmtDate(d)}</h3>
                    {byDay.get(d)?.map((m) => (
                      <Link
                        key={m.id}
                        href={`/matches/${m.id}`}
                        className="card mb-2 flex min-h-11 items-center justify-between gap-3 p-3.5"
                      >
                        <span className="min-w-0">
                          <span className="block font-medium">
                            <span className="mono">{fmtTime(m.starts_at)}</span> {m.title}
                          </span>
                          <span className="mono text-muted">
                            {t.match.seats(m.seats_taken, m.capacity)} · {rupiah(m.price_idr)}
                          </span>
                        </span>
                        <Chip status={m.status} />
                      </Link>
                    ))}
                  </section>
                ))}
              </div>

              {busyDays.length === 0 && <Empty action={create}>{t.calendar.empty}</Empty>}
            </>
          );
        }}
      </Load>
    </>
  );
}
