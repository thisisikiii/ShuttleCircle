"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, ErrorAlert, Input, buttonClass } from "@/components/ui";
import { api, useAct } from "@/lib/api";
import { useFeatures, useSignIn } from "@/lib/session";
import { t } from "@/lib/strings";

export default function LoginPage() {
  const signIn = useSignIn();
  const features = useFeatures();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useAct(
    () => api.post<{ access_token: string }>("/auth/login", { email, password }),
    (r) => signIn(r.data.access_token),
  );
  return (
    <>
      <h1 className="mb-6">{t.auth.login}</h1>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Input label={t.auth.email} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input
          label={t.auth.password}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {login.isError && <ErrorAlert error={login.error} />}
        <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
          {t.auth.login}
        </Button>
      </form>
      {features?.google && (
        <a href="/api/v1/auth/google/start" className={`${buttonClass()} mt-3 w-full`}>
          {t.auth.google}
        </a>
      )}
      <p className="mt-6 border-t border-border pt-4 text-muted">
        {features?.email && (
          <>
            <Link href="/forgot" className="link">
              {t.auth.forgot}
            </Link>
            <br />
          </>
        )}
        {t.auth.noAccount}{" "}
        <Link href="/register" className="link">
          {t.auth.register}
        </Link>
      </p>
    </>
  );
}
