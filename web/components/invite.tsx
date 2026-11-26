"use client";

import { useId, useState } from "react";
import { api, fieldErrors, useAct } from "@/lib/api";
import { t } from "@/lib/strings";
import { Button, ErrorAlert, controlClass } from "./ui";

type Result = { contact: string; sent: boolean; error: string | null };

/** Sends invitations by email or WhatsApp: to one match when `matchId` is given, else to create an account. */
export function InviteForm({ matchId }: { matchId?: string }) {
  const id = useId();
  const [text, setText] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const send = useAct(
    () => api.post<Result[]>("/invitations", { match_id: matchId, contacts: text.split("\n") }),
    (r) => {
      setResults(r.data);
      // keep only the contacts that failed, ready to correct and resend
      setText(r.data.filter((x) => !x.sent).map((x) => x.contact).join("\n"));
    },
  );
  const error = fieldErrors(send.error).contacts;
  // Same link the API puts in the message; the browser origin is the public URL.
  const link = typeof window === "undefined" ? "" : `${window.location.origin}${matchId ? `/matches/${matchId}` : "/register"}`;
  const [copied, setCopied] = useState(false);
  return (
    <form
      className="max-w-[640px] space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <div>
        <label htmlFor={`${id}-link`} className="label mb-1.5 block">
          {t.invite.link}
        </label>
        <div className="flex gap-2">
          <input
            id={`${id}-link`}
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            aria-describedby={`${id}-link-hint`}
            className={`${controlClass} min-w-0`}
          />
          <Button
            className="shrink-0"
            onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}
          >
            {copied ? t.invite.copied : t.invite.copy}
          </Button>
        </div>
        <p id={`${id}-link-hint`} className="caption mt-1 text-muted">
          {t.invite.linkHint}
        </p>
      </div>
      <p className="text-muted">{matchId ? t.invite.matchIntro : t.invite.registerIntro}</p>
      <div>
        <label htmlFor={id} className="label mb-1.5 block">
          {t.invite.contacts}
        </label>
        <textarea
          id={id}
          rows={4}
          required
          aria-invalid={!!error}
          aria-describedby={`${id}-hint`}
          className={`${controlClass} py-2.5`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p id={`${id}-hint`} className={`caption mt-1 ${error ? "text-danger" : "text-muted"}`}>
          {error ?? t.invite.hint}
        </p>
      </div>
      {send.isError && !error && <ErrorAlert error={send.error} />}
      <Button type="submit" variant="primary" disabled={send.isPending}>
        {t.invite.send}
      </Button>
      {results.length > 0 && (
        <ul aria-live="polite" className="card divide-y divide-border">
          {results.map((r) => (
            <li key={r.contact} className="flex flex-wrap items-center justify-between gap-x-3 px-3.5 py-2 text-sm">
              <span className="min-w-0 font-medium">{r.contact}</span>
              <span className={`font-bold ${r.sent ? "text-success" : "text-danger"}`}>
                {r.sent ? t.invite.sent : `${t.invite.failed}: ${r.error}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
