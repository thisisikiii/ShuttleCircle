"use client";

import { usePaged } from "@/lib/api";
import { fmtDateTime, rupiah } from "@/lib/format";
import { t } from "@/lib/strings";
import type { LedgerEntry } from "@/lib/types";
import { DataTable, Empty, Load, LoadMore } from "./ui";

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
            <DataTable
              rows={q.items}
              rowKey={(e) => e.id}
              columns={[
                { head: t.wallet.date, cell: (e) => fmtDateTime(e.created_at), className: "caption text-muted" },
                { head: t.wallet.type, cell: (e) => t.txnType[e.txn_type], className: "max-md:order-first max-md:grow" },
                { head: t.wallet.note, cell: (e) => e.note, className: "max-md:w-full max-md:text-muted" },
                {
                  head: t.wallet.amount,
                  cell: (e) => `${e.amount_idr > 0 ? "+" : "−"}${rupiah(Math.abs(e.amount_idr))}`,
                  className: "mono md:text-right max-md:order-first",
                },
              ]}
            />
            <LoadMore q={q} />
          </>
        )
      }
    </Load>
  );
}
