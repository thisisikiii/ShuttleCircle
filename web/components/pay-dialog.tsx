"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Alert, Button, Dialog, ErrorAlert, Input, Select } from "@/components/ui";
import { api, fetchBlob, useAct } from "@/lib/api";
import { rupiah } from "@/lib/format";
import { t } from "@/lib/strings";
import type { PaymentInfo } from "@/lib/types";

const p = t.manualPay;

/** Manual payment (FR-22): the club's QRIS, e-wallet and bank accounts, then a claim the admin confirms. */
export function PayDialog({
  amount,
  joinRequestId,
  onClose,
}: {
  amount: number;
  joinRequestId?: string;
  onClose: () => void;
}) {
  const info = useQuery({ queryKey: ["payment-info"], queryFn: () => api.get<PaymentInfo>("/payment-info").then((r) => r.data) });
  const i = info.data;
  const methods = i
    ? [
        ...(i.qris ? ["QRIS"] : []),
        ...(i.ewallet_number ? (i.ewallet_names ?? p.ewalletDefault).split(",").map((s) => s.trim()).filter(Boolean) : []),
        ...i.banks.map((b) => b.bank),
      ]
    : [];
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const claim = useAct(() =>
    api.post("/payment-claims", { amount_idr: amount, method: method || methods[0], join_request_id: joinRequestId, note }),
  );
  const empty = i && methods.length === 0;

  return (
    <Dialog open onClose={onClose} title={p.title}>
      <p className="label">{p.amount}</p>
      <p className="mono mb-3 text-2xl font-bold">{rupiah(amount)}</p>
      {info.isError && <ErrorAlert error={info.error} onRetry={() => info.refetch()} />}
      {empty && <Alert tone="info">{p.notSet}</Alert>}
      {i && !empty && (
        <div className="max-h-[55vh] space-y-4 overflow-y-auto">
          <p className="caption text-muted">{p.steps}</p>
          {joinRequestId && <p className="caption text-muted">{p.holdNote}</p>}
          {i.qris && (
            <section>
              <h3 className="mb-1">{p.qris}</h3>
              <Qris />
            </section>
          )}
          {i.ewallet_number && (
            <section>
              <h3 className="mb-1">{i.ewallet_names ? p.ewallet(i.ewallet_names) : p.ewalletDefault}</h3>
              <Account label={i.ewallet_names ?? p.ewalletDefault} number={i.ewallet_number} />
            </section>
          )}
          {i.banks.length > 0 && (
            <section>
              <h3 className="mb-1">{p.banks}</h3>
              <ul className="space-y-1">
                {i.banks.map((b) => (
                  <li key={b.bank + b.number}>
                    <Account label={b.bank} number={b.number} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {i.holder && <p className="caption text-muted">{p.holder(i.holder)}</p>}
        </div>
      )}

      {claim.isSuccess ? (
        <Alert tone="info">{p.claimed}</Alert>
      ) : (
        i &&
        !empty && (
          <form
            className="mt-4 space-y-3 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              claim.mutate();
            }}
          >
            <Select label={p.method} value={method || methods[0]} onChange={(e) => setMethod(e.target.value)}>
              {methods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Input label={p.note} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            {claim.isError && <ErrorAlert error={claim.error} />}
            <Button type="submit" variant="primary" className="w-full" disabled={claim.isPending}>
              {p.claim}
            </Button>
          </form>
        )
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="tertiary" onClick={onClose}>
          {p.close}
        </Button>
      </div>
    </Dialog>
  );
}

function Account({ label, number }: { label: string; number: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-1">
      <div className="min-w-0">
        <p className="caption text-muted">{label}</p>
        <p className="mono font-semibold tracking-wide">{number}</p>
      </div>
      <Button
        variant="tertiary"
        aria-label={p.copyOf(label)}
        onClick={() => navigator.clipboard?.writeText(number).then(() => setCopied(true))}
      >
        {copied ? p.copied : p.copy}
      </Button>
    </div>
  );
}

/** The QRIS image needs the bearer header, so it is fetched as a blob. */
export function Qris({ version = 0 }: { version?: number }) {
  const [img, setImg] = useState<{ url: string; blob: Blob }>();
  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;
    fetchBlob("/payment-info/qris")
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImg({ url: objectUrl, blob });
      })
      .catch(() => setImg(undefined));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [version]);
  if (!img) return null;

  const save = async () => {
    const name = `qris-shuttlecircle.${img.blob.type.split("/")[1] || "png"}`;
    const file = new File([img.blob], name, { type: img.blob.type });
    // iOS saves downloads to Files, not Photos; its share sheet has "Save Image". Android downloads show in the gallery.
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = img.url;
    a.download = name;
    a.click();
  };

  return (
    <div className="space-y-2 text-center">
      <img src={img.url} alt={p.qrisAlt} className="mx-auto w-full max-w-64 rounded-xl bg-white" />
      <Button onClick={save}>
        {p.saveQr}
      </Button>
    </div>
  );
}
