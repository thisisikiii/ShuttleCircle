"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, ErrorAlert, Input, PageHeader, buttonClass } from "@/components/ui";
import { api, useAct } from "@/lib/api";
import { useMe } from "@/lib/session";
import { t } from "@/lib/strings";
import type { Member } from "@/lib/types";

export default function ProfilePage() {
  const me = useMe();
  return (
    <>
      <PageHeader title={t.profile.title} />
      <div className="max-w-[640px]">{me.kind === "member" ? <MemberProfile me={me} /> : <GuestProfile nickname={me.nickname} />}</div>
    </>
  );
}

function GuestProfile({ nickname }: { nickname: string }) {
  return (
    <>
      <p className="text-lg font-semibold">{nickname}</p>
      <p className="caption mb-4 text-muted">{t.common.guest}</p>
      <p className="mb-4">{t.profile.guestIntro}</p>
      <div className="flex gap-2">
        <Link href="/register" className={buttonClass("primary")}>
          {t.auth.register}
        </Link>
        <Link href="/login" className={buttonClass()}>
          {t.auth.login}
        </Link>
      </div>
    </>
  );
}

function MemberProfile({ me }: { me: Member }) {
  const [name, setName] = useState(me.full_name);
  const [whatsapp, setWhatsapp] = useState(me.whatsapp_number ?? "");
  const save = useAct(() => api.patch("/me", { full_name: name, whatsapp_number: whatsapp }));
  // A full reload drops the in-memory access token and every cached query.
  const logout = useAct(
    () => api.post("/auth/logout"),
    () => window.location.assign("/"),
  );
  return (
    <>
      <p className="mb-4 text-muted">
        {me.email} · {t.role[me.role]}
      </p>
      {!me.email_verified && <Alert tone="info">{t.profile.unverified}</Alert>}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Input label={t.auth.fullName} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Input label={t.auth.whatsapp} type="tel" autoComplete="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
        {save.isError && <ErrorAlert error={save.error} />}
        {save.isSuccess && <p className="caption text-success">{t.profile.saved}</p>}
        <Button type="submit" disabled={save.isPending}>
          {t.common.save}
        </Button>
      </form>
      <div className="mt-8 border-t border-border pt-4">
        <Button variant="tertiary" disabled={logout.isPending} onClick={() => logout.mutate()}>
          {t.auth.logout}
        </Button>
      </div>
    </>
  );
}
