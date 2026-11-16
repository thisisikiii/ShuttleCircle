"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Countdown } from "@/components/countdown";
import { Alert, Button, Chip, Empty, ErrorAlert, Load, PageHeader, buttonClass } from "@/components/ui";
import { api, inPaymentTab, useAct } from "@/lib/api";
import { fmtDateTime, rupiah } from "@/lib/format";
import { useFeatures } from "@/lib/session";
import { t } from "@/lib/strings";
import type { JoinRequest, PayResult } from "@/lib/types";

export default function RequestsPage() {
  const features = useFeatures();
  const q = useQuery({
    queryKey: ["my-requests"],
    queryFn: () => api.get<JoinRequest[]>("/me/join-requests").then((r) => r.data),
    // 5 s while a seat is held and payment is due, 30 s otherwise
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === "awaiting_payment") ? 5_000 : 30_000,
  });
  const withdraw = useAct((id: string) => api.post(`/join-requests/${id}/cancel`));
  const pay = useAct((id: string) =>
    inPaymentTab(
      () => api.post<PayResult>(`/join-requests/${id}/pay`).then((r) => r.data),
      (r) => (r.status === "awaiting_payment" ? r.payment.redirect_url : undefined),
    ),
  );

  return (
    <>
      <PageHeader title={t.requests.title} />
      <Load q={q}>
        {(requests) => {
          const held = requests.filter((r) => r.status === "awaiting_payment");
          if (requests.length === 0) {
            return (
              <Empty
                action={
                  <Link href="/" className={buttonClass()}>
                    {t.common.toCalendar}
                  </Link>
                }
              >
                {t.requests.empty}
              </Empty>
            );
          }
          return (
            <>
              {features?.gateway === false && held.some((r) => !r.conversion_required) && (
                <Alert tone="info">{t.pay.gatewayOff}</Alert>
              )}
              {withdraw.isError && <ErrorAlert error={withdraw.error} />}
              <ul>
                {requests.map((r) => (
                  <li key={r.id} className="border-t border-border py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link href={`/matches/${r.match_id}`} className="link font-medium">
                          {r.match_title}
                        </Link>
                        <p className="caption text-muted">
                          {fmtDateTime(r.match_starts_at)} {t.common.wib} ·{" "}
                          <span className="mono">{rupiah(r.price_idr)}</span>
                          {r.payment_method && ` · ${t.paymentMethod[r.payment_method]}`}
                        </p>
                        {r.note && <p className="text-muted">{r.note}</p>}
                      </div>
                      <Chip status={r.status} />
                    </div>

                    {r.status === "awaiting_payment" && r.hold_expires_at && (
                      // the first held request is a sticky bar above the tab bar on phones (DESIGN.md §10)
                      <div
                        className={`mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border border-border bg-surface p-3 ${
                          r === held[0]
                            ? "max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:z-10 max-md:border-x-0"
                            : ""
                        }`}
                      >
                        <p>
                          <span className="caption block text-muted">{t.requests.holdLeft}</span>
                          <Countdown expiresAt={r.hold_expires_at} onExpire={() => q.refetch()} />
                        </p>
                        {r.conversion_required ? (
                          // DEC-004: a guest must create an account before paying
                          <div className="max-w-md">
                            <p className="mb-2">{t.requests.convert}</p>
                            <div className="flex flex-wrap gap-2">
                              <Link href="/register?next=/requests" className={buttonClass("primary")}>
                                {t.auth.register}
                              </Link>
                              <Link href="/login?next=/requests" className={buttonClass()}>
                                {t.auth.login}
                              </Link>
                            </div>
                          </div>
                        ) : (
                          <Button variant="primary" disabled={pay.isPending} onClick={() => pay.mutate(r.id)}>
                            {t.requests.payNow}
                          </Button>
                        )}
                        {pay.variables === r.id && pay.isError && (
                          <div className="w-full">
                            <ErrorAlert error={pay.error} onRetry={() => pay.mutate(r.id)} />
                          </div>
                        )}
                        {pay.variables === r.id && pay.data?.status === "awaiting_payment" && (
                          <p className="caption w-full text-muted">
                            {t.pay.waiting}{" "}
                            <a
                              href={pay.data.payment.redirect_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              {t.pay.openPage}
                            </a>
                          </p>
                        )}
                      </div>
                    )}

                    {(r.status === "pending" || r.status === "awaiting_payment") && (
                      <Button
                        variant="tertiary"
                        className="mt-1 -ml-2"
                        disabled={withdraw.isPending}
                        onClick={() => withdraw.mutate(r.id)}
                      >
                        {t.requests.withdraw}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {/* room for the fixed payment bar on phones */}
              {held.length > 0 && <div className="h-40 md:hidden" />}
            </>
          );
        }}
      </Load>
    </>
  );
}
