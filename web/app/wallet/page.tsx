"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { FinanceDashboard } from "@/components/finance-dashboard";
import { Ledger } from "@/components/ledger";
import { PayDialog } from "@/components/pay-dialog";
import { Guard } from "@/components/shell";
import { Button, Chip, ErrorAlert, Input, PageHeader, Strip } from "@/components/ui";
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
      {atLeast(me, "admin") && <FinanceDashboard />}
      <Strip
        className="sm:grid-cols-3"
        items={[
          { label: t.wallet.balance, value: rupiah(balance.data ?? me.wallet_balance_idr) },
          {
            label: t.wallet.membershipNow,
            value: me.membership_months.includes(months[0]) ? t.status.active : t.wallet.none,
          },
          { label: t.wallet.rewards, value: me.rewards.length },
        ]}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section>
          <h2 className="mb-2">{t.wallet.ledger}</h2>
          <Ledger path="/wallets/me/transactions" />
        </section>

        <div className="space-y-6 divide-y divide-border *:pb-6 lg:order-last">
          <form className="space-y-3" onSubmit={submit(() => setTopupOpen(true))}>
            <h3>{t.wallet.topup}</h3>
            <Input
              label={t.wallet.amountIdr}
              type="number"
              inputMode="numeric"
              min={MIN_TOPUP_IDR}
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              required
            />
            <Button type="submit" variant="primary">
              {t.wallet.topup}
            </Button>
          </form>
          {topupOpen && <PayDialog amount={Number(topupAmount)} onClose={() => setTopupOpen(false)} />}

          <section>
            <h3 className="mb-1">{t.wallet.membership}</h3>
            <p className="caption mb-2 text-muted">{t.wallet.membershipHint}</p>
            {months.map((month) => (
              <div key={month} className="flex min-h-11 items-center justify-between gap-3">
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

          <form className="space-y-3" onSubmit={submit(() => donate.mutate())}>
            <h3>{t.wallet.donation}</h3>
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

          <section>
            <h3 className="mb-1">{t.wallet.rewards}</h3>
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
    </>
  );
}
