"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { InviteForm } from "@/components/invite";
import {
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  ErrorAlert,
  Input,
  Load,
  PageHeader,
  Skeleton,
  buttonClass,
  controlClass,
} from "@/components/ui";
import { api, fetchBlob, useAct } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtTime, rupiah } from "@/lib/format";
import { atLeast, useMe } from "@/lib/session";
import { t } from "@/lib/strings";
import type { JoinRequest, MatchDetail, Media } from "@/lib/types";

export default function MatchPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ["match", id],
    queryFn: () => api.get<MatchDetail>(`/matches/${id}`).then((r) => r.data),
  });
  return (
    <>
      <Link href="/" className="link caption">
        ‹ {t.common.toCalendar}
      </Link>
      <Load q={q}>{(m) => <Detail m={m} />}</Load>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="label pt-1">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Detail({ m }: { m: MatchDetail }) {
  const me = useMe();
  const [cancelling, setCancelling] = useState(false);
  const [inviting, setInviting] = useState(false);
  const cancel = useAct(
    () => api.post(`/matches/${m.id}/cancel`),
    () => setCancelling(false),
  );
  const scheduled = m.status === "scheduled";
  const started = m.status === "ongoing" || m.status === "completed";

  return (
    <>
      <PageHeader title={m.title}>
        <Chip status={m.status} />
        {m.can_manage && scheduled && (
          <>
            <Button onClick={() => setInviting(true)}>{t.invite.button}</Button>
            <Link href={`/matches/${m.id}/edit`} className={buttonClass()}>
              {t.match.edit}
            </Link>
          </>
        )}
        {atLeast(me, "superadmin") && (scheduled || m.status === "ongoing") && (
          <Button onClick={() => setCancelling(true)}>{t.match.cancel}</Button>
        )}
      </PageHeader>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <dl className="card grid grid-cols-[7.5rem_minmax(0,1fr)] content-start gap-x-4 gap-y-2 p-5">
          <Row label={t.match.time}>
            {fmtDate(m.starts_at)} · <span className="mono">{fmtTime(m.starts_at)}</span> {t.common.wib}
          </Row>
          <Row label={t.match.duration}>{t.match.hours(m.duration_hours)}</Row>
          <Row label={t.match.location}>
            {/* only https links are rendered: the URL is typed in by a host */}
            {m.location_maps_url.startsWith("https://") ? (
              <a href={m.location_maps_url} target="_blank" rel="noopener noreferrer" className="link">
                {m.location_name} ↗<span className="sr-only"> {t.match.opensMaps}</span>
              </a>
            ) : (
              m.location_name
            )}
          </Row>
          <Row label={t.match.type}>{t.matchType[m.match_type]}</Row>
          <Row label={t.match.capacity}>
            <span className="mono">{t.match.seats(m.seats_taken, m.capacity)}</span> ·{" "}
            {t.match.seatsLeft(m.capacity - m.seats_taken)}
          </Row>
          <Row label={t.match.price}>
            <span className="mono">{rupiah(m.price_idr)}</span>
          </Row>
          <Row label={t.match.racket}>{m.racket_provided ? t.match.provided : t.match.bringOwn}</Row>
          <Row label={t.match.shuttlecock}>{m.shuttlecock_provided ? t.match.provided : t.match.bringOwn}</Row>
          {m.equipment_notes && <Row label={t.match.equipmentNotes}>{m.equipment_notes}</Row>}
          <Row label={t.match.host}>{m.host.full_name}</Row>
          {m.court_cost_per_hour_idr !== undefined && (
            <Row label={t.match.courtCost}>
              <span className="mono">{rupiah(m.court_cost_per_hour_idr)}</span>
            </Row>
          )}
        </dl>

        <aside className="card self-start p-5 lg:row-span-2">
          <JoinBox m={m} />
        </aside>

        <div className="space-y-8">
          {m.roster && <Roster m={m} editable={!!m.can_manage && started} />}
          {m.can_manage && m.requests && <Requests requests={m.requests} />}
          <MediaSection m={m} />
        </div>
      </div>

      <Dialog open={inviting} onClose={() => setInviting(false)} title={t.invite.matchTitle}>
        <InviteForm matchId={m.id} />
        <div className="mt-4 flex justify-end">
          <Button variant="tertiary" onClick={() => setInviting(false)}>
            {t.invite.close}
          </Button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t.match.cancelTitle}
        body={t.match.cancelBody}
        confirmLabel={t.match.cancel}
        action={{ mutate: () => cancel.mutate(), isPending: cancel.isPending, error: cancel.error }}
      />
    </>
  );
}

function JoinBox({ m }: { m: MatchDetail }) {
  const [note, setNote] = useState("");
  const join = useAct(() => api.post(`/matches/${m.id}/join-requests`, note.trim() ? { note: note.trim() } : {}));

  if (m.my_request) {
    return (
      <>
        <h3>{t.match.yourRequest}</h3>
        <p className="my-3">
          <Chip status={m.my_request.status} />
        </p>
        <Link
          href="/requests"
          className={buttonClass(m.my_request.status === "awaiting_payment" ? "primary" : "secondary")}
        >
          {t.match.seeRequests}
        </Link>
      </>
    );
  }
  if (m.status !== "scheduled") return <p className="text-muted">{t.match.closed}</p>;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        join.mutate();
      }}
    >
      <h3>{t.match.joinTitle}</h3>
      {m.seats_taken >= m.capacity && <p className="text-muted">{t.match.fullNote}</p>}
      <Input label={t.match.note} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      {join.isError && <ErrorAlert error={join.error} />}
      <Button type="submit" variant="primary" className="w-full" disabled={join.isPending}>
        {t.match.join}
      </Button>
    </form>
  );
}

function Roster({ m, editable }: { m: MatchDetail; editable: boolean }) {
  const roster = m.roster ?? [];
  const [games, setGames] = useState<Record<string, string>>({});
  const save = useAct(() =>
    api.put(
      `/matches/${m.id}/games`,
      roster.map((r) => ({
        join_request_id: r.join_request_id,
        games_played: Number(games[r.join_request_id] ?? r.games_played ?? 0),
      })),
    ),
  );
  return (
    <section>
      <h2 className="mb-2">{t.match.roster}</h2>
      {roster.length === 0 ? (
        <p className="text-muted">{t.match.rosterEmpty}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <ol>
            {roster.map((r, i) => (
              <li
                key={r.join_request_id}
                className="flex min-h-11 items-center justify-between gap-3 border-t border-border py-1"
              >
                <span>
                  <span className="mono mr-2 text-muted">{i + 1}</span>
                  {r.name}
                </span>
                {editable ? (
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    aria-label={t.match.gamesOf(r.name)}
                    className={`${controlClass} w-20! shrink-0 font-semibold tabular-nums`}
                    value={games[r.join_request_id] ?? r.games_played ?? ""}
                    onChange={(e) => setGames({ ...games, [r.join_request_id]: e.target.value })}
                  />
                ) : (
                  r.games_played !== null && <span className="mono">{t.match.games(r.games_played)}</span>
                )}
              </li>
            ))}
          </ol>
          {save.isError && <ErrorAlert error={save.error} />}
          {editable && (
            <Button type="submit" className="mt-3" disabled={save.isPending}>
              {t.match.saveGames}
            </Button>
          )}
        </form>
      )}
    </section>
  );
}

function Requests({ requests }: { requests: JoinRequest[] }) {
  const act = useAct(({ id, action }: { id: string; action: "approve" | "reject" }) =>
    api.post(`/join-requests/${id}/${action}`),
  );
  return (
    <section>
      <h2 className="mb-2">{t.match.requests}</h2>
      {requests.length === 0 && <p className="text-muted">{t.approvals.empty}</p>}
      {act.isError && <ErrorAlert error={act.error} />}
      <ul>
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 border-t border-border py-2">
            <div className="min-w-0">
              <p className="font-medium">
                {r.player.name}
                {r.player.kind === "guest" && <span className="caption text-muted"> · {t.common.guest}</span>}
              </p>
              <p className="caption text-muted">
                {fmtDateTime(r.created_at)}
                {r.note && ` · ${r.note}`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Chip status={r.status} />
              {/* an expired hold may be approved again (FEATURES.md §2) */}
              {(r.status === "pending" || r.status === "expired") && (
                <Button
                  variant="tertiary"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: r.id, action: "approve" })}
                >
                  {t.approvals.approve}
                </Button>
              )}
              {r.status === "pending" && (
                <Button
                  variant="tertiary"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: r.id, action: "reject" })}
                >
                  {t.approvals.reject}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MediaSection({ m }: { m: MatchDetail }) {
  const q = useQuery({
    queryKey: ["media", m.id],
    queryFn: () => api.get<Media[]>(`/matches/${m.id}/media`).then((r) => r.data),
    refetchInterval: false, // changes only through the upload and delete below
  });
  const upload = useAct((file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.post(`/matches/${m.id}/media`, form);
  });
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useAct(
    () => api.del(`/media/${deleting}`),
    () => setDeleting(null),
  );

  // Not allowed to view (403) or still loading: stay quiet.
  if (!q.data || (q.data.length === 0 && !m.can_manage)) return null;
  return (
    <section>
      <h2 className="mb-2">{t.media.title}</h2>
      {q.data.length === 0 && <p className="text-muted">{t.media.empty}</p>}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {q.data.map((item) => (
          <MediaItem key={item.id} item={item} onDelete={m.can_manage ? () => setDeleting(item.id) : undefined} />
        ))}
      </ul>
      {m.can_manage && (
        <>
          <label
            className={`${buttonClass()} mt-3 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent ${upload.isPending ? "opacity-40" : ""}`}
          >
            {upload.isPending ? t.media.uploading : t.media.upload}
            <input
              type="file"
              className="sr-only"
              accept="image/jpeg,image/png,image/webp,video/mp4"
              disabled={upload.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = "";
              }}
            />
          </label>
          <p className="caption mt-1 text-muted">{t.media.limits}</p>
          {upload.isError && <ErrorAlert error={upload.error} />}
        </>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t.media.deleteTitle}
        body={t.common.cannotUndo}
        confirmLabel={t.common.delete}
        action={{ mutate: () => remove.mutate(), isPending: remove.isPending, error: remove.error }}
      />
    </section>
  );
}

/** Files need the bearer header, so they are fetched as blobs and shown through object URLs. */
function MediaItem({ item, onDelete }: { item: Media; onDelete?: () => void }) {
  const photo = item.kind === "photo";
  const [wanted, setWanted] = useState(photo); // videos (up to 100 MB) load on request
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!wanted) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    fetchBlob(`/media/${item.id}/file`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setWanted(false));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [wanted, item.id]);

  return (
    <li className="relative aspect-square bg-border/40">
      {!wanted ? (
        <Button variant="tertiary" className="size-full flex-col" onClick={() => setWanted(true)}>
          {photo ? t.common.retry : t.media.play}
          <span className="mono">{t.media.size(item.size_bytes)}</span>
        </Button>
      ) : !url ? (
        <Skeleton className="size-full" />
      ) : photo ? (
        <img src={url} alt={t.media.photoAlt(fmtDate(item.created_at))} className="size-full object-cover" />
      ) : (
        <video src={url} controls autoPlay className="size-full bg-black" />
      )}
      {onDelete && (
        <Button className="absolute top-1 right-1 min-h-11 bg-surface" onClick={onDelete}>
          {t.common.delete}
        </Button>
      )}
    </li>
  );
}
