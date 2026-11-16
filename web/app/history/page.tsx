"use client";

import Link from "next/link";
import { useState } from "react";
import { Guard } from "@/components/shell";
import { Checkbox, Empty, Load, LoadMore, PageHeader, buttonClass } from "@/components/ui";
import { usePaged } from "@/lib/api";
import { fmtDate, fmtMonth, fmtTime, groupBy, jakartaDay } from "@/lib/format";
import { atLeast } from "@/lib/session";
import { t } from "@/lib/strings";
import type { HistoryItem } from "@/lib/types";

export default function HistoryPage() {
  return <Guard min="member">{(me) => <History admin={atLeast(me, "admin")} />}</Guard>;
}

/** Timeline grouped by month with expandable roster rows (DESIGN.md §6). */
function History({ admin }: { admin: boolean }) {
  const [all, setAll] = useState(false);
  const q = usePaged<HistoryItem>(["history", all], all ? "/history?scope=all" : "/history");
  const months = groupBy(q.items, (m) => jakartaDay(m.starts_at).slice(0, 7));

  return (
    <>
      <PageHeader title={t.history.title}>
        {admin && <Checkbox label={t.history.all} checked={all} onChange={(e) => setAll(e.target.checked)} />}
      </PageHeader>
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
              {t.history.empty}
            </Empty>
          ) : (
            <>
              {[...months].map(([month, matches]) => (
                <section key={month} className="mb-6">
                  <h2 className="mb-2">{fmtMonth(`${month}-01`)}</h2>
                  <ol className="ml-1 border-l border-border pl-4">
                    {matches.map((m) => (
                      <li key={m.id} className="border-b border-border">
                        <details>
                          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-x-4 py-2">
                            <span>
                              <span className="caption block text-muted">
                                {fmtDate(m.starts_at)} · <span className="mono">{fmtTime(m.starts_at)}</span>
                              </span>
                              <span className="font-medium">{m.title}</span>
                            </span>
                            <span className="caption text-muted">
                              {t.history.players(m.players.length)}
                              {m.media_count > 0 && ` · ${t.history.media(m.media_count)}`}
                            </span>
                          </summary>
                          <ul className="pb-3">
                            {m.players.map((p, i) => (
                              <li key={i} className="flex justify-between gap-4 py-0.5">
                                {p.name}
                                {p.games_played !== null && (
                                  <span className="mono">{t.match.games(p.games_played)}</span>
                                )}
                              </li>
                            ))}
                            <li className="mt-2">
                              <Link href={`/matches/${m.id}`} className="link">
                                {t.history.open}
                              </Link>
                            </li>
                          </ul>
                        </details>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
              <LoadMore q={q} />
            </>
          )
        }
      </Load>
    </>
  );
}
