"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, ErrorAlert, Input } from "@/components/ui";
import { api, useAct } from "@/lib/api";
import { t } from "@/lib/strings";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const send = useAct(() => api.post("/auth/password/forgot", { email }));
  return (
    <>
      <h1 className="mb-2">{t.auth.forgotTitle}</h1>
      <p className="mb-6 text-muted">{t.auth.forgotIntro}</p>
      {send.isSuccess ? (
        <Alert tone="info">{t.auth.forgotSent}</Alert>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <Input label={t.auth.email} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {send.isError && <ErrorAlert error={send.error} />}
          <Button type="submit" variant="primary" className="w-full" disabled={send.isPending}>
            {t.auth.forgotSend}
          </Button>
        </form>
      )}
      <p className="mt-6 border-t border-border pt-4">
        <Link href="/login" className="link">
          {t.auth.login}
        </Link>
      </p>
    </>
  );
}
