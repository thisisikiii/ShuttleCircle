"use client";

import { usePaged } from "@/lib/api";
import { fmtDateTime, rupiah } from "@/lib/format";
import { t } from "@/lib/strings";
import type { LedgerEntry } from "@/lib/types";
import { Empty, Load, LoadMore } from "./ui";

/** Wallet ledger: the caller's own (`/wallets/me/transactions`) or a member's, for admins. */
export function Ledger({ path }: { path: string }) {
  const q = usePaged<LedgerEntry>(["ledger", path], path);
  return (
    <Load q={q}>
      {() =>
        q.items.length === 0 ? (
          <Empty>{t.wallet.ledgerEmpty}</Empty>
        ) : (
          <>
            <ul className="card divide-y divide-border px-2">
              {q.items.map((e) => {
                const credit = e.amount_idr > 0;
                return (
                  <li key={e.id} className="flex items-center gap-3 px-2 py-3">
                    <span aria-hidden className={`tile-icon text-lg font-extrabold ${credit ? "bg-lime/25 text-success" : "bg-danger/10 text-danger"}`}>
                      {credit ? "+" : "−"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-primary">{t.txnType[e.txn_type]}</p>
                      <p className="caption truncate text-muted">
                        {fmtDateTime(e.created_at)}
                        {e.note && ` · ${e.note}`}
                      </p>
                    </div>
                    <p className={`mono shrink-0 ${credit ? "text-success" : "text-primary"}`}>
                      {credit ? "+" : "−"}
                      {rupiah(Math.abs(e.amount_idr))}
                    </p>
                  </li>
                );
              })}
            </ul>
            <LoadMore q={q} />
          </>
        )
      }
    </Load>
  );
}
