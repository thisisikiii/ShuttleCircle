"use client";

import Link from "next/link";
import { useState } from "react";
import { Guard } from "@/components/shell";
import { Alert, Button, Chip, Empty, ErrorAlert, Load, LoadMore, PageHeader, buttonClass } from "@/components/ui";
import { api, useAct, usePaged } from "@/lib/api";
import { fmtDateTime, rupiah } from "@/lib/format";
import { t } from "@/lib/strings";
import type { JoinRequest } from "@/lib/types";

export default function ApprovalsPage() {
  return <Guard min="host">{() => <Approvals />}</Guard>;
}

function Approvals() {
  const q = usePaged<JoinRequest>(["approvals"], "/join-requests?status=pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<JoinRequest | null>(null);
  const selected = q.items.find((r) => r.id === selectedId);
  const act = useAct(
    ({ id, action }: { id: string; action: "approve" | "reject" }) =>
      api.post<JoinRequest>(`/join-requests/${id}/${action}`).then((r) => r.data),
    (result) => {
      setOutcome(result);
      setSelectedId(null);
    },
  );

  return (
    <>
      <PageHeader title={t.approvals.title} />
      {outcome && (
        <Alert tone="info">
          {outcome.player.name}: {t.status[outcome.status]}
        </Alert>
      )}
      <Load q={q}>
        {() =>
          q.items.length === 0 ? (
            <Empty
              action={
                <Link href="/" className={buttonClass()}>
                  {t.common.toCalendar}
                </Link>
              }
            >
              {t.approvals.empty}
            </Empty>
          ) : (
            // ≥1024 px: split pane. Below: the list, then the detail as a full page (DESIGN.md §10).
            <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div className={selected ? "max-lg:hidden" : ""}>
                <ul className="card overflow-hidden p-1.5">
                  {q.items.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        aria-current={r.id === selectedId || undefined}
                        onClick={() => {
                          setSelectedId(r.id);
                          setOutcome(null);
                          act.reset();
                        }}
                        className="block min-h-11 w-full cursor-pointer rounded-2xl px-4 py-2.5 text-left transition hover:bg-primary/5 aria-[current]:bg-lime/25"
                      >
                        <span className="block font-medium">{r.player.name}</span>
                        <span className="caption block text-muted">
                          {r.match_title} · {fmtDateTime(r.match_starts_at)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <LoadMore q={q} />
              </div>

              {selected ? (
                <section className="card self-start p-5">
                  <Button variant="tertiary" className="mb-2 -ml-2 lg:hidden" onClick={() => setSelectedId(null)}>
                    ‹ {t.common.back}
                  </Button>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h2>{selected.player.name}</h2>
                    <Chip status={selected.status} />
                  </div>
                  <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2">
                    <dt className="caption text-muted">{t.approvals.player}</dt>
                    <dd>{selected.player.kind === "guest" ? t.common.guest : t.role.member}</dd>
                    <dt className="caption text-muted">{t.approvals.match}</dt>
                    <dd>
                      <Link href={`/matches/${selected.match_id}`} className="link">
                        {selected.match_title}
                      </Link>
                    </dd>
                    <dt className="caption text-muted">{t.match.time}</dt>
                    <dd>
                      {fmtDateTime(selected.match_starts_at)} {t.common.wib}
                    </dd>
                    <dt className="caption text-muted">{t.match.price}</dt>
                    <dd className="mono">{rupiah(selected.price_idr)}</dd>
                    <dt className="caption text-muted">{t.approvals.requestedAt}</dt>
                    <dd>{fmtDateTime(selected.created_at)}</dd>
                    {selected.note && (
                      <>
                        <dt className="caption text-muted">{t.match.note}</dt>
                        <dd>{selected.note}</dd>
                      </>
                    )}
                  </dl>
                  <p className="caption mt-4 text-muted">{t.approvals.hint}</p>
                  {act.isError && <ErrorAlert error={act.error} />}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: selected.id, action: "approve" })}
                    >
                      {t.approvals.approve}
                    </Button>
                    <Button
                      variant="danger"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: selected.id, action: "reject" })}
                    >
                      {t.approvals.reject}
                    </Button>
                  </div>
                </section>
              ) : (
                <p className="text-muted max-lg:hidden">{t.approvals.pick}</p>
              )}
            </div>
          )
        }
      </Load>
    </>
  );
}
