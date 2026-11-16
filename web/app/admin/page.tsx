"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { InviteForm } from "@/components/invite";
import { Ledger } from "@/components/ledger";
import { Guard } from "@/components/shell";
import { Alert, Button, Checkbox, Chip, DataTable, Empty, ErrorAlert, Input, Load, LoadMore, PageHeader, Select, Strip } from "@/components/ui";
import { api, fieldErrors, useAct, usePaged } from "@/lib/api";
import { monthStart, rupiah, today } from "@/lib/format";
import { atLeast } from "@/lib/session";
import { t } from "@/lib/strings";
import type { Expense, ExpenseCategory, FinanceSummary, Member, Role, Settings, User } from "@/lib/types";

const TABS = ["finance", "members", "invite", "whatsapp", "settings"] as const;

const submit = (run: () => void) => (e: FormEvent) => {
  e.preventDefault();
  run();
};

export default function AdminPage() {
  return <Guard min="admin">{(me) => <Admin me={me} />}</Guard>;
}

function Admin({ me }: { me: Member }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("finance");
  const isSuper = atLeast(me, "superadmin");
  return (
    <>
      <PageHeader title={t.admin.title} />
      <div role="tablist" aria-label={t.admin.title} className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.filter((k) => k !== "whatsapp" || isSuper).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className="-mb-px min-h-11 shrink-0 cursor-pointer border-b-2 border-transparent px-3 text-sm font-semibold text-muted aria-selected:border-accent aria-selected:font-bold aria-selected:text-accent"
          >
            {t.admin[k]}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "finance" && <Finance isSuper={isSuper} />}
        {tab === "members" && <Members isSuper={isSuper} selfId={me.id} />}
        {tab === "invite" && <InviteForm />}
        {tab === "whatsapp" && <WhatsApp />}
        {tab === "settings" && <SettingsForm isSuper={isSuper} />}
      </div>
    </>
  );
}

function Finance({ isSuper }: { isSuper: boolean }) {
  const [from, setFrom] = useState(monthStart(0));
  const [to, setTo] = useState(today());
  const range = `from=${from}&to=${to}`;
  const summary = useQuery({
    queryKey: ["finance", range],
    queryFn: () => api.get<FinanceSummary>(`/finance/summary?${range}`).then((r) => r.data),
  });
  const expenses = useQuery({
    queryKey: ["expenses", range],
    queryFn: () => api.get<Expense[]>(`/expenses?${range}`).then((r) => r.data),
  });
  const [draft, setDraft] = useState({ category: "shuttlecock" as ExpenseCategory, amount: "", spent_on: today(), note: "" });
  const add = useAct(
    () => api.post("/expenses", { category: draft.category, amount_idr: Number(draft.amount), spent_on: draft.spent_on, note: draft.note }),
    () => setDraft({ ...draft, amount: "", note: "" }),
  );
  const remove = useAct((id: string) => api.del(`/expenses/${id}`));
  return (
    <>
      <div className="mb-4 grid max-w-[640px] grid-cols-2 gap-3">
        <Input label={t.admin.from} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input label={t.admin.to} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Load q={summary}>
        {(s) => (
          <Strip
            className="grid-cols-2 lg:grid-cols-4"
            items={[
              { label: t.admin.cashIn, value: rupiah(s.cash_in_idr) },
              { label: t.admin.feeIncome, value: rupiah(s.fee_income_idr) },
              { label: t.admin.membershipIncome, value: rupiah(s.membership_income_idr) },
              { label: t.admin.donations, value: rupiah(s.donation_idr) },
              { label: t.admin.courtCost, value: rupiah(s.court_cost_idr) },
              {
                label: t.admin.otherExpenses,
                value: rupiah(s.expenses.drinking_water + s.expenses.shuttlecock + s.expenses.other),
              },
              { label: t.admin.memberBalance, value: rupiah(s.member_balance_idr) },
            ]}
          />
        )}
      </Load>

      <h2 className="mb-3">{t.admin.expenses}</h2>
      {isSuper && (
        <form onSubmit={submit(() => add.mutate())} className="mb-4 grid max-w-[640px] grid-cols-2 gap-3">
          <Select label={t.admin.category} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as ExpenseCategory })}>
            {Object.entries(t.admin.categories).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Input
            label={t.wallet.amountIdr}
            type="number"
            inputMode="numeric"
            min={1}
            required
            value={draft.amount}
            onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            error={fieldErrors(add.error).amount_idr}
          />
          <Input label={t.admin.spentOn} type="date" required value={draft.spent_on} onChange={(e) => setDraft({ ...draft, spent_on: e.target.value })} />
          <Input label={t.wallet.note} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          {add.isError && <ErrorAlert error={add.error} />}
          <Button type="submit" className="col-span-2" disabled={add.isPending}>
            {t.admin.addExpense}
          </Button>
        </form>
      )}
      {remove.isError && <ErrorAlert error={remove.error} />}
      <Load q={expenses}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>{t.admin.expensesEmpty}</Empty>
          ) : (
            <DataTable
              rows={rows}
              rowKey={(e) => e.id}
              columns={[
                { head: t.admin.spentOn, cell: (e) => e.spent_on, className: "caption text-muted" },
                { head: t.admin.category, cell: (e) => t.admin.categories[e.category], className: "max-md:grow" },
                { head: t.wallet.note, cell: (e) => e.note, className: "max-md:w-full max-md:text-muted" },
                { head: t.wallet.amount, cell: (e) => rupiah(e.amount_idr), className: "mono md:text-right" },
                ...(isSuper
                  ? [
                      {
                        head: t.common.delete,
                        cell: (e: Expense) => (
                          <Button variant="tertiary" disabled={remove.isPending} onClick={() => remove.mutate(e.id)}>
                            {t.common.delete}
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )
        }
      </Load>
    </>
  );
}

function Members({ isSuper, selfId }: { isSuper: boolean; selfId: string }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const q = usePaged<User>(["users", search], `/users?q=${encodeURIComponent(search)}`);
  const user = q.items.find((u) => u.id === selected);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <Input label={t.admin.search} type="search" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-4" />
        <Load q={q}>
          {() =>
            q.items.length === 0 ? (
              <Empty>{t.admin.membersEmpty}</Empty>
            ) : (
              <>
                <DataTable
                  rows={q.items}
                  rowKey={(u) => u.id}
                  selected={selected}
                  columns={[
                    {
                      head: t.admin.name,
                      cell: (u) => (
                        <>
                          {u.full_name}
                          <span className="caption block text-muted">
                            {u.email} · {t.role[u.role]}
                          </span>
                        </>
                      ),
                      className: "max-md:grow",
                    },
                    { head: t.admin.statusLabel, cell: (u) => <Chip status={u.status} /> },
                    { head: t.wallet.balance, cell: (u) => rupiah(u.wallet_balance_idr), className: "mono md:text-right" },
                    {
                      head: t.admin.open,
                      cell: (u) => (
                        <Button variant="tertiary" aria-pressed={selected === u.id} onClick={() => setSelected(u.id)}>
                          {t.admin.open}
                        </Button>
                      ),
                    },
                  ]}
                />
                <LoadMore q={q} />
              </>
            )
          }
        </Load>
      </div>
      {user && <MemberPanel key={user.id} user={user} isSuper={isSuper} isSelf={user.id === selfId} />}
    </div>
  );
}

function MemberPanel({ user, isSuper, isSelf }: { user: User; isSuper: boolean; isSelf: boolean }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<"credits" | "adjustments">("credits");
  const post = useAct(
    () => api.post(`/wallets/${user.id}/${kind}`, { amount_idr: Number(amount), note }),
    () => {
      setAmount("");
      setNote("");
    },
  );
  const change = useAct((body: { role?: Role; status?: User["status"] }) => api.patch(`/users/${user.id}`, body));
  const errors = fieldErrors(post.error);
  return (
    <section aria-label={user.full_name} className="border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
      <h2 className="mb-1">{user.full_name}</h2>
      <p className="mb-4 text-muted">
        {user.email} · <span className="mono">{rupiah(user.wallet_balance_idr)}</span>
      </p>

      <form onSubmit={submit(() => post.mutate())} className="mb-6 space-y-3">
        {isSuper && (
          <Select label={t.wallet.type} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="credits">{t.admin.credit}</option>
            <option value="adjustments">{t.admin.adjust}</option>
          </Select>
        )}
        <p className="caption text-muted">{t.admin.creditHint}</p>
        <Input
          label={t.wallet.amountIdr}
          type="number"
          inputMode="numeric"
          required
          min={kind === "credits" ? 1 : undefined}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={errors.amount_idr}
        />
        <Input label={t.admin.reason} required value={note} onChange={(e) => setNote(e.target.value)} error={errors.note} />
        {post.isError && <ErrorAlert error={post.error} />}
        <Button type="submit" variant="primary" disabled={post.isPending}>
          {t.admin.apply}
        </Button>
      </form>

      {isSuper && !isSelf && (
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <Select label={t.admin.roleLabel} value={user.role} disabled={change.isPending} onChange={(e) => change.mutate({ role: e.target.value as Role })}>
            {Object.entries(t.role).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Button disabled={change.isPending} onClick={() => change.mutate({ status: user.status === "active" ? "suspended" : "active" })}>
            {user.status === "active" ? t.admin.suspend : t.admin.activate}
          </Button>
          {change.isError && <ErrorAlert error={change.error} />}
        </div>
      )}

      <h3 className="mb-2">{t.wallet.ledger}</h3>
      <Ledger path={`/wallets/${user.id}/transactions`} />
    </section>
  );
}

type WhatsAppState = { enabled: boolean; status?: string; number?: string | null; name?: string | null; qr?: string | null };

/** Links the admin WhatsApp number to the gateway by QR code, like WhatsApp Web. */
function WhatsApp() {
  const q = useQuery({
    queryKey: ["whatsapp"],
    queryFn: () => api.get<WhatsAppState>("/whatsapp").then((r) => r.data),
    // the QR code changes every 20 to 60 seconds while waiting for the scan
    refetchInterval: (query) => (query.state.data?.enabled && query.state.data.status !== "WORKING" ? 5_000 : 30_000),
  });
  const unlink = useAct(() => api.post("/whatsapp/logout"));
  return (
    <Load q={q}>
      {(s) =>
        !s.enabled ? (
          <Empty>{t.whatsapp.off}</Empty>
        ) : (
          <div className="max-w-[640px] space-y-4">
            <p className="text-muted">{t.whatsapp.intro}</p>
            <Alert tone="info">{t.whatsapp.risk}</Alert>
            {s.status === "WORKING" ? (
              <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
                <p className="font-bold text-success">
                  {t.whatsapp.connected(`+${s.number}`)}
                  {s.name && <span className="caption block text-muted">{s.name}</span>}
                </p>
                <Button disabled={unlink.isPending} onClick={() => unlink.mutate()}>
                  {t.whatsapp.unlink}
                </Button>
              </div>
            ) : s.qr ? (
              <div className="card p-4">
                <p className="mb-3">{t.whatsapp.scan}</p>
                {/* a white frame: the code must stay scannable whatever the theme */}
                <img src={s.qr} alt={t.whatsapp.qrAlt} className="mx-auto size-64 rounded-xl bg-white p-2" />
              </div>
            ) : (
              <p role="status" className="text-muted">
                {t.whatsapp.starting}
              </p>
            )}
            {unlink.isError && <ErrorAlert error={unlink.error} />}
          </div>
        )
      }
    </Load>
  );
}

function SettingsForm({ isSuper }: { isSuper: boolean }) {
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings").then((r) => r.data) });
  return <Load q={q}>{(s) => <SettingsFields key={JSON.stringify(s)} s={s} isSuper={isSuper} />}</Load>;
}

function SettingsFields({ s, isSuper }: { s: Settings; isSuper: boolean }) {
  const [reward, setReward] = useState(s.reward_enabled);
  const [price, setPrice] = useState(String(s.membership_price_idr ?? 0));
  const [minTopup, setMinTopup] = useState(String(s.min_topup_idr));
  const save = useAct(() =>
    api.patch("/settings", {
      reward_enabled: reward,
      ...(isSuper && { membership_price_idr: Number(price), min_topup_idr: Number(minTopup) }),
    }),
  );
  const errors = fieldErrors(save.error);
  return (
    <form onSubmit={submit(() => save.mutate())} className="max-w-[640px] space-y-4">
      <Checkbox label={t.admin.rewardEnabled} checked={reward} onChange={(e) => setReward(e.target.checked)} />
      {isSuper && (
        <>
          <Input
            label={t.admin.membershipPrice}
            type="number"
            inputMode="numeric"
            min={0}
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            error={errors.membership_price_idr}
          />
          <Input
            label={t.admin.minTopup}
            type="number"
            inputMode="numeric"
            min={1}
            required
            value={minTopup}
            onChange={(e) => setMinTopup(e.target.value)}
            error={errors.min_topup_idr}
          />
        </>
      )}
      {save.isError && <ErrorAlert error={save.error} />}
      {save.isSuccess && <p className="caption text-success">{t.admin.saved}</p>}
      <Button type="submit" variant="primary" disabled={save.isPending}>
        {t.common.save}
      </Button>
    </form>
  );
}
