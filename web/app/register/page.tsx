"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, ErrorAlert, Input, buttonClass } from "@/components/ui";
import { api, fieldErrors, useAct } from "@/lib/api";
import { useFeatures, useSignIn } from "@/lib/session";
import { t } from "@/lib/strings";

export default function RegisterPage() {
  const signIn = useSignIn();
  const features = useFeatures();
  const [f, setF] = useState({ email: "", password: "", full_name: "", whatsapp_number: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const register = useAct(
    () => api.post<{ access_token: string }>("/auth/register", f),
    (r) => signIn(r.data.access_token),
  );
  const errors = fieldErrors(register.error);
  return (
    <>
      <h1 className="mb-2">{t.auth.register}</h1>
      <p className="mb-6 text-muted">{t.auth.guestNote}</p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          register.mutate();
        }}
      >
        <Input label={t.auth.fullName} autoComplete="name" required value={f.full_name} onChange={set("full_name")} error={errors.full_name} />
        <Input label={t.auth.email} type="email" autoComplete="email" required value={f.email} onChange={set("email")} error={errors.email} />
        <Input
          label={`${t.auth.password} (${t.auth.passwordHint})`}
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={f.password}
          onChange={set("password")}
          error={errors.password}
        />
        <Input label={t.auth.whatsapp} type="tel" autoComplete="tel" value={f.whatsapp_number} onChange={set("whatsapp_number")} />
        {register.isError && <ErrorAlert error={register.error} />}
        <Button type="submit" variant="primary" className="w-full" disabled={register.isPending}>
          {t.auth.register}
        </Button>
      </form>
      {features?.google && (
        <a href="/api/v1/auth/google/start" className={`${buttonClass()} mt-3 w-full`}>
          {t.auth.google}
        </a>
      )}
      <p className="mt-6 border-t border-border pt-4 text-muted">
        {t.auth.haveAccount}{" "}
        <Link href="/login" className="link">
          {t.auth.login}
        </Link>
      </p>
    </>
  );
}
