"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Qris } from "@/components/pay-dialog";
import { Button, Empty, ErrorAlert, Input, Load, buttonClass } from "@/components/ui";
import { api, fieldErrors, useAct } from "@/lib/api";
import { fmtDateTime, rupiah } from "@/lib/format";
import { t } from "@/lib/strings";
import type { Bank, PaymentClaim, Settings } from "@/lib/types";

const p = t.payments;

/** Admin > Pembayaran: claims to confirm, then (superadmin) the payment details members see. */
export function PaymentsTab({ isSuper }: { isSuper: boolean }) {
  const q = useQuery({
    queryKey: ["payment-claims"],
    queryFn: () => api.get<PaymentClaim[]>("/payment-claims?status=pending").then((r) => r.data),
    refetchInterval: 30_000,
  });
  const act = useAct(({ id, action }: { id: string; action: "confirm" | "reject" }) => api.post(`/payment-claims/${id}/${action}`));
  return (
    <>
      <h2 className="mb-1">{p.pending}</h2>
      <p className="caption mb-3 text-muted">{p.hint}</p>
      {act.isError && <ErrorAlert error={act.error} />}
      <Load q={q}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty>{p.empty}</Empty>
          ) : (
            <ul className="mb-8">
              {rows.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {c.user.full_name} · <span className="mono">{rupiah(c.amount_idr)}</span> · {c.method}
                    </p>
                    <p className="caption text-muted">
                      {c.match_title ? p.forMatch(c.match_title) : p.topup} · {fmtDateTime(c.created_at)}
                      {c.note && ` · ${c.note}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" disabled={act.isPending} onClick={() => act.mutate({ id: c.id, action: "confirm" })}>
                      {p.confirm}
                    </Button>
                    <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate({ id: c.id, action: "reject" })}>
                      {p.reject}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Load>
      {isSuper && <PaymentSettings />}
    </>
  );
}

function PaymentSettings() {
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings").then((r) => r.data) });
  return <Load q={q}>{(s) => <PaymentFields key={JSON.stringify(s)} s={s} />}</Load>;
}

function PaymentFields({ s }: { s: Settings }) {
  const [holder, setHolder] = useState(s.pay_holder ?? "");
  const [number, setNumber] = useState(s.pay_ewallet_number ?? "");
  const [names, setNames] = useState(s.pay_ewallet_names ?? "");
  const [banks, setBanks] = useState<Bank[]>(s.pay_banks);
  const [qrisVersion, setQrisVersion] = useState(0);
  const save = useAct(() =>
    api.patch("/settings", {
      pay_holder: holder,
      pay_ewallet_number: number.replace(/\D/g, ""),
      pay_ewallet_names: names,
      pay_banks: banks.filter((b) => b.bank.trim() || b.number.trim()).map((b) => ({ bank: b.bank, number: b.number.replace(/\D/g, "") })),
    }),
  );
  const upload = useAct(
    (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post("/settings/qris", form);
    },
    () => setQrisVersion((v) => v + 1),
  );
  const errors = fieldErrors(save.error);
  const setBank = (i: number, patch: Partial<Bank>) => setBanks(banks.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <section className="max-w-[640px] border-t border-border pt-6">
      <h2 className="mb-1">{p.settingsTitle}</h2>
      <p className="caption mb-4 text-muted">{p.settingsHint}</p>

      <h3 className="mb-2">{p.qrisImage}</h3>
      {s.pay_qris_path || qrisVersion > 0 ? <Qris version={qrisVersion} /> : <p className="text-muted">{p.qrisNone}</p>}
      <label className={`${buttonClass()} mt-2 has-focus-visible:outline-2 has-focus-visible:outline-accent ${upload.isPending ? "opacity-40" : ""}`}>
        {s.pay_qris_path || qrisVersion > 0 ? p.qrisReplace : p.qrisUpload}
        <input
          type="file"
          className="sr-only"
          accept="image/jpeg,image/png,image/webp"
          disabled={upload.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = "";
          }}
        />
      </label>
      {upload.isError && <ErrorAlert error={upload.error} />}

      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Input label={p.ewalletNumber} inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} error={errors.pay_ewallet_number} />
        <Input label={p.ewalletNames} value={names} maxLength={80} onChange={(e) => setNames(e.target.value)} />
        <fieldset className="space-y-2">
          <legend className="label mb-1">{t.manualPay.banks}</legend>
          {banks.map((b, i) => (
            <div key={i} className="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-end gap-2">
              <Input label={p.bankName} value={b.bank} maxLength={40} onChange={(e) => setBank(i, { bank: e.target.value })} />
              <Input label={p.bankNumber} inputMode="numeric" value={b.number} onChange={(e) => setBank(i, { number: e.target.value })} />
              <Button variant="tertiary" aria-label={p.removeBank(b.bank)} onClick={() => setBanks(banks.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          {errors.pay_banks && <p className="caption text-danger">{errors.pay_banks}</p>}
          {banks.length < 10 && <Button onClick={() => setBanks([...banks, { bank: "", number: "" }])}>{p.addBank}</Button>}
        </fieldset>
        <Input label={p.holder} value={holder} maxLength={80} onChange={(e) => setHolder(e.target.value)} />
        {save.isError && <ErrorAlert error={save.error} />}
        {save.isSuccess && <p className="caption text-success">{t.admin.saved}</p>}
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t.common.save}
        </Button>
      </form>
    </section>
  );
}
