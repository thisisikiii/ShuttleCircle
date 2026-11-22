"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { FinanceDashboard } from "@/components/finance-dashboard";
import { Ledger } from "@/components/ledger";
import { PayDialog } from "@/components/pay-dialog";
import { Guard } from "@/components/shell";
import { Button, Chip, ErrorAlert, Input, PageHeader } from "@/components/ui";
import { api, useAct } from "@/lib/api";
import { fmtDate, fmtMonth, monthStart, rupiah } from "@/lib/format";
import { atLeast } from "@/lib/session";
import { t } from "@/lib/strings";
import type { Member } from "@/lib/types";

const MIN_TOPUP_IDR = 10_000; // the configured minimum is not readable by members; the server has the last word

export default function WalletPage() {
  return <Guard min="member">{(me) => <Wallet me={me} />}</Guard>;
}

const submit = (run: () => void) => (e: FormEvent) => {
  e.preventDefault();
  run();
};

function Wallet({ me }: { me: Member }) {
  const balance = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.get<{ balance_idr: number }>("/wallets/me").then((r) => r.data.balance_idr),
  });
  const months = [monthStart(0), monthStart(1)];

  const [topupAmount, setTopupAmount] = useState("");
  const [topupOpen, setTopupOpen] = useState(false);
  const buyMembership = useAct((month: string) => api.post("/memberships", { month }));
  const [donation, setDonation] = useState("");
  const donate = useAct(
    () => api.post("/donations", { amount_idr: Number(donation) }),
    () => setDonation(""),
  );

  return (
    <>
      <PageHeader title={t.wallet.title} />
      <section className="on-dark court-pattern mb-8 grid gap-6 overflow-hidden rounded-[2rem] p-6 shadow-xl shadow-emerald-950/20 sm:p-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
        <div>
          <p className="label">{t.wallet.balance}</p>
          <p className="mono mt-1 text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
            {rupiah(balance.data ?? me.wallet_balance_idr)}
          </p>
          <p className="caption mt-2 text-emerald-100/80">{t.wallet.balanceHint}</p>
          <dl className="mt-5 flex flex-wrap gap-2 text-sm">
            <div className="flex gap-1.5 rounded-full bg-white/10 px-3.5 py-1.5">
              <dt className="text-emerald-100/80">{t.wallet.membershipNow}:</dt>
              <dd className="font-bold text-lime">
                {me.membership_months.includes(months[0]) ? t.status.active : t.wallet.none}
              </dd>
            </div>
            <div className="flex gap-1.5 rounded-full bg-white/10 px-3.5 py-1.5">
              <dt className="text-emerald-100/80">{t.wallet.rewards}:</dt>
              <dd className="mono text-lime">{me.rewards.length}</dd>
            </div>
          </dl>
        </div>
        <form className="space-y-3 rounded-3xl bg-slate-950/40 p-4 backdrop-blur" onSubmit={submit(() => setTopupOpen(true))}>
          <Input
            label={t.wallet.topup + " · " + t.wallet.amountIdr}
            type="number"
            inputMode="numeric"
            min={MIN_TOPUP_IDR}
            value={topupAmount}
            onChange={(e) => setTopupAmount(e.target.value)}
            required
          />
          <div role="group" aria-label={t.wallet.quickAmounts} className="flex flex-wrap gap-2">
            {[50_000, 100_000, 200_000].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={Number(topupAmount) === n}
                onClick={() => setTopupAmount(String(n))}
                className="min-h-9 cursor-pointer rounded-full border border-white/20 px-3 text-xs font-bold text-white transition hover:border-lime aria-pressed:border-lime aria-pressed:bg-lime aria-pressed:text-slate-950"
              >
                {rupiah(n)}
              </button>
            ))}
          </div>
          <Button type="submit" variant="primary" className="w-full">
            {t.wallet.topup}
          </Button>
        </form>
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section>
          <h2 className="mb-3">{t.wallet.ledger}</h2>
          <Ledger path="/wallets/me/transactions" />
        </section>

        <div className="space-y-4 lg:order-last">
          {topupOpen && <PayDialog amount={Number(topupAmount)} onClose={() => setTopupOpen(false)} />}

          <section className="card p-5">
            <PanelTitle icon="M4 8h16v11H4zM8 8V5h8v3M4 13h16">{t.wallet.membership}</PanelTitle>
            <p className="caption mb-2 text-muted">{t.wallet.membershipHint}</p>
            {months.map((month) => (
              <div key={month} className="flex min-h-12 items-center justify-between gap-3 border-t border-border first-of-type:border-0">
                {fmtMonth(month)}
                {me.membership_months.includes(month) ? (
                  <Chip status="active" />
                ) : (
                  <Button disabled={buyMembership.isPending} onClick={() => buyMembership.mutate(month)}>
                    {t.wallet.buy}
                  </Button>
                )}
              </div>
            ))}
            {buyMembership.isError && <ErrorAlert error={buyMembership.error} />}
          </section>

          <form className="card space-y-3 p-5" onSubmit={submit(() => donate.mutate())}>
            <PanelTitle icon="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z">{t.wallet.donation}</PanelTitle>
            <p className="caption text-muted">{t.wallet.donationHint}</p>
            <Input
              label={t.wallet.amountIdr}
              type="number"
              inputMode="numeric"
              min={1}
              value={donation}
              onChange={(e) => setDonation(e.target.value)}
              required
            />
            {donate.isError && <ErrorAlert error={donate.error} />}
            {donate.isSuccess && <p className="caption text-success">{t.wallet.donationThanks}</p>}
            <Button type="submit" disabled={donate.isPending}>
              {t.wallet.donate}
            </Button>
          </form>

          <section className="card p-5">
            <PanelTitle icon="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z">{t.wallet.rewards}</PanelTitle>
            {me.rewards.length === 0 ? (
              <p className="text-muted">{t.wallet.rewardsEmpty}</p>
            ) : (
              <ul>
                {me.rewards.map((r) => (
                  <li key={r.id}>{t.wallet.rewardUntil(fmtDate(r.expires_at))}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {atLeast(me, "admin") && (
        <div className="mt-10">
          <FinanceDashboard />
        </div>
      )}
    </>
  );
}

/** Panel heading with a lime icon tile (DESIGN.md §9). */
function PanelTitle({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-3">
      <span aria-hidden className="tile-icon bg-lime/25 text-success">
        <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={icon} />
        </svg>
      </span>
      {children}
    </h3>
  );
}
