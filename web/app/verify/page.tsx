"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Alert, ErrorAlert, buttonClass } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/strings";

export default function VerifyPage() {
  // The link is single-use, so run once and never refetch.
  const q = useQuery({
    queryKey: ["verify-email"],
    queryFn: () =>
      api.post("/auth/email/verify", { token: new URLSearchParams(window.location.search).get("token") ?? "" }).then(() => true),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  return (
    <>
      {q.isPending && <p role="status">{t.auth.verifying}</p>}
      {q.isSuccess && <Alert tone="info">{t.auth.verified}</Alert>}
      {q.isError && <ErrorAlert error={q.error} />}
      <Link href="/" className={buttonClass()}>
        {t.common.toCalendar}
      </Link>
    </>
  );
}
