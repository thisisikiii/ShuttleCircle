"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, fieldErrors, useAct } from "@/lib/api";
import { fmtDateTime, fromJakartaInput, rupiah, toJakartaInput, today } from "@/lib/format";
import { atLeast, useMe } from "@/lib/session";
import { t } from "@/lib/strings";
import type { Match, User } from "@/lib/types";
import { Button, Checkbox, ErrorAlert, Input, PageHeader, Select } from "./ui";

const FORM_ID = "match-form";

function initialFields(match?: Match) {
  return {
    title: match?.title ?? "",
    starts_at: match ? toJakartaInput(match.starts_at) : "",
    duration_hours: String(match?.duration_hours ?? ""),
    location_name: match?.location_name ?? "",
    location_maps_url: match?.location_maps_url ?? "",
    capacity: String(match?.capacity ?? ""),
    match_type: match?.match_type ?? "beginner_friendly",
    racket_provided: match?.racket_provided ?? false,
    shuttlecock_provided: match?.shuttlecock_provided ?? false,
    equipment_notes: match?.equipment_notes ?? "",
    price_idr: String(match?.price_idr ?? ""),
    court_cost_per_hour_idr: String(match?.court_cost_per_hour_idr ?? ""),
    host: match?.host ?? null, // null = the caller hosts (FR-06)
  };
}
type Fields = ReturnType<typeof initialFields>;

const toPayload = ({ host, ...f }: Fields): Record<string, unknown> => ({
  ...f,
  title: f.title.trim(),
  starts_at: fromJakartaInput(f.starts_at), // typed as Jakarta time
  duration_hours: Number(f.duration_hours),
  capacity: Number(f.capacity),
  equipment_notes: f.equipment_notes.trim() || null,
  price_idr: Number(f.price_idr),
  court_cost_per_hour_idr: Number(f.court_cost_per_hour_idr),
  ...(host && { host_id: host.id }),
});

/** Create (no `match`) or edit form: single column with a sticky summary aside (DESIGN.md §6). */
export function MatchForm({ match }: { match?: Match }) {
  const me = useMe();
  const router = useRouter();
  const [f, setF] = useState(() => initialFields(match));
  const set = (patch: Partial<Fields>) => setF({ ...f, ...patch });

  const save = useAct(
    () => {
      const payload = toPayload(f);
      if (!match) return api.post<Match>("/matches", payload);
      // edit sends only what changed: the price is locked once a seat is held (AC-F3-04)
      const before = toPayload(initialFields(match));
      const changed = Object.entries(payload).filter(([key, value]) => value !== before[key]);
      return api.patch<Match>(`/matches/${match.id}`, Object.fromEntries(changed));
    },
    (r) => router.push(`/matches/${match?.id ?? r.data.id}`),
  );
  const errors = fieldErrors(save.error);

  return (
    <>
      <PageHeader title={match ? t.form.editTitle : t.form.createTitle} />
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,40rem)_18rem]">
        <form
          id={FORM_ID}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Input
            label={t.form.title}
            value={f.title}
            onChange={(e) => set({ title: e.target.value })}
            error={errors.title}
            required
            maxLength={100}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t.form.startsAt}
              type="datetime-local"
              value={f.starts_at}
              onChange={(e) => set({ starts_at: e.target.value })}
              error={errors.starts_at}
              min={`${today()}T00:00`}
              required
            />
            <Input
              label={t.form.duration}
              type="number"
              inputMode="numeric"
              min={1}
              max={12}
              value={f.duration_hours}
              onChange={(e) => set({ duration_hours: e.target.value })}
              error={errors.duration_hours}
              required
            />
          </div>
          <Input
            label={t.form.locationName}
            value={f.location_name}
            onChange={(e) => set({ location_name: e.target.value })}
            error={errors.location_name}
            required
          />
          <Input
            label={t.form.mapsUrl}
            type="url"
            pattern="https://.+"
            placeholder="https://maps.app.goo.gl/…"
            value={f.location_maps_url}
            onChange={(e) => set({ location_maps_url: e.target.value })}
            error={errors.location_maps_url}
            required
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t.form.capacity}
              type="number"
              inputMode="numeric"
              min={1}
              value={f.capacity}
              onChange={(e) => set({ capacity: e.target.value })}
              error={errors.capacity}
              required
            />
            <Select
              label={t.match.type}
              value={f.match_type}
              onChange={(e) => set({ match_type: e.target.value as Fields["match_type"] })}
              error={errors.match_type}
            >
              <option value="beginner_friendly">{t.matchType.beginner_friendly}</option>
              <option value="intermediate">{t.matchType.intermediate}</option>
            </Select>
            <Input
              label={t.form.price}
              type="number"
              inputMode="numeric"
              min={0}
              value={f.price_idr}
              onChange={(e) => set({ price_idr: e.target.value })}
              error={errors.price_idr}
              required
            />
            <Input
              label={t.form.courtCost}
              type="number"
              inputMode="numeric"
              min={0}
              value={f.court_cost_per_hour_idr}
              onChange={(e) => set({ court_cost_per_hour_idr: e.target.value })}
              error={errors.court_cost_per_hour_idr}
              required
            />
          </div>
          <fieldset>
            <legend className="caption">{t.form.equipment}</legend>
            <Checkbox
              label={t.form.racketProvided}
              checked={f.racket_provided}
              onChange={(e) => set({ racket_provided: e.target.checked })}
            />
            <Checkbox
              label={t.form.shuttlecockProvided}
              checked={f.shuttlecock_provided}
              onChange={(e) => set({ shuttlecock_provided: e.target.checked })}
            />
          </fieldset>
          <Input
            label={t.form.equipmentNotes}
            value={f.equipment_notes}
            onChange={(e) => set({ equipment_notes: e.target.value })}
            error={errors.equipment_notes}
          />
          {atLeast(me, "admin") && (
            <HostPicker host={f.host} onPick={(host) => set({ host })} error={errors.host_id} />
          )}
        </form>

        <aside className="border-t border-border pt-4 lg:sticky lg:top-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <h3 className="mb-2">{t.form.summary}</h3>
          <dl className="space-y-1">
            <SummaryRow label={t.form.title} value={f.title} />
            <SummaryRow
              label={t.match.time}
              value={f.starts_at && `${fmtDateTime(fromJakartaInput(f.starts_at))} ${t.common.wib}`}
            />
            <SummaryRow label={t.match.location} value={f.location_name} />
            <SummaryRow label={t.match.capacity} value={f.capacity} />
            <SummaryRow label={t.match.price} value={f.price_idr && rupiah(Number(f.price_idr))} />
            <SummaryRow
              label={t.form.courtTotal}
              value={
                f.court_cost_per_hour_idr &&
                f.duration_hours &&
                rupiah(Number(f.court_cost_per_hour_idr) * Number(f.duration_hours))
              }
            />
            <SummaryRow label={t.match.host} value={f.host?.full_name ?? t.form.hostSelf} />
          </dl>
          {save.isError && <ErrorAlert error={save.error} />}
          <Button type="submit" form={FORM_ID} variant="primary" className="mt-4 w-full" disabled={save.isPending}>
            {match ? t.common.save : t.calendar.create}
          </Button>
        </aside>
      </div>
    </>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="caption text-muted">{label}</dt>
      <dd className="text-right">{value || "—"}</dd>
    </div>
  );
}

/** Admins may assign any user with role host or higher (AC-F3-03). */
function HostPicker({
  host,
  onPick,
  error,
}: {
  host: Fields["host"];
  onPick: (host: Fields["host"]) => void;
  error?: string;
}) {
  const [term, setTerm] = useState("");
  const q = useQuery({
    queryKey: ["users", term],
    queryFn: () => api.get<User[]>(`/users?q=${encodeURIComponent(term)}`).then((r) => r.data),
    enabled: term.length >= 2,
    refetchInterval: false,
  });
  return (
    <div>
      <Input
        label={t.form.hostSearch}
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        error={error}
      />
      {q.isError && <ErrorAlert error={q.error} />}
      <ul>
        {q.data
          ?.filter((u) => u.role !== "member" && u.status === "active")
          .map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 border-b border-border">
              <span>
                {u.full_name} <span className="caption text-muted">· {t.role[u.role]}</span>
              </span>
              <Button
                variant="tertiary"
                onClick={() => {
                  onPick({ id: u.id, full_name: u.full_name });
                  setTerm("");
                }}
              >
                {t.form.pickHost}
              </Button>
            </li>
          ))}
      </ul>
      <p className="caption mt-1 text-muted">
        {t.match.host}: {host?.full_name ?? t.form.hostSelf}
      </p>
    </div>
  );
}
