"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, ErrorAlert, Input, buttonClass } from "@/components/ui";
import { api, fieldErrors, useAct } from "@/lib/api";
import { t } from "@/lib/strings";

export default function ResetPage() {
  const [password, setPassword] = useState("");
  // The token is read from the address bar at submit time, so no Suspense boundary is needed.
  const reset = useAct(() =>
    api.post("/auth/password/reset", { token: new URLSearchParams(window.location.search).get("token") ?? "", password }),
  );
  if (reset.isSuccess) {
    return (
      <>
        <Alert tone="info">{t.auth.resetDone}</Alert>
        <Link href="/login" className={buttonClass("primary")}>
          {t.auth.login}
        </Link>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-6">{t.auth.resetTitle}</h1>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          reset.mutate();
        }}
      >
        <Input
          label={`${t.auth.password} (${t.auth.passwordHint})`}
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors(reset.error).password}
        />
        {reset.isError && <ErrorAlert error={reset.error} />}
        <Button type="submit" variant="primary" className="w-full" disabled={reset.isPending}>
          {t.auth.resetSave}
        </Button>
      </form>
    </>
  );
}
