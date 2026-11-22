"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, Dialog, ErrorAlert, Input, Select, controlClass } from "@/components/ui";
import { api, useAct } from "@/lib/api";
import { fmtTime } from "@/lib/format";
import { t } from "@/lib/strings";
import type { GenderMode, LevelMode, Rotation, RotationGame, RotationPlayer } from "@/lib/types";

const r = t.rotation;
const minutesSince = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)) : 0);

/** Court rotation (FEATURES.md §11). Staff run it; other members watch it. */
export function RotationSection({ matchId, manage }: { matchId: string; manage: boolean }) {
  const base = `/matches/${matchId}/rotation`;
  const q = useQuery({
    queryKey: ["rotation", matchId],
    queryFn: () => api.get<Rotation>(base).then((res) => res.data),
    // players watch from their phones; the app polls (PRD §10), faster while a game's score is live
    refetchInterval: (query) => (query.state.data?.games.some((g) => g.status === "playing") ? 3_000 : 10_000),
  });
  const act = useAct(({ method, path, body }: { method: "post" | "patch" | "del"; path: string; body?: unknown }) =>
    method === "del" ? api.del(base + path) : api[method](base + path, body ?? {}),
  );
  const run = (method: "post" | "patch" | "del", path: string, body?: unknown) => act.mutate({ method, path, body });

  const data = q.data;
  if (!data) return q.isError ? <ErrorAlert error={q.error} onRetry={() => q.refetch()} /> : null;
  if (data.players.length === 0) return null;
  const byId = new Map(data.players.map((p) => [p.join_request_id, p]));
  const queue = data.players
    .filter((p) => p.queue_position !== null)
    .sort((a, b) => a.queue_position! - b.queue_position!);
  const absent = data.players.filter((p) => p.state === "absent");

  return (
    <section>
      <h2 className="mb-1">{r.title}</h2>
      <p className="caption mb-3 text-muted">{r.intro}</p>
      {act.isError && <ErrorAlert error={act.error} />}

      {manage && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Select
            label={r.format}
            className="w-36"
            value={data.singles ? "1" : "0"}
            disabled={act.isPending}
            onChange={(e) => run("patch", "", { singles: e.target.value === "1" })}
          >
            <option value="0">{r.doubles}</option>
            <option value="1">{r.singles}</option>
          </Select>
          <div>
            <p className="label mb-1.5">{r.courts}</p>
            <div className="flex items-center gap-1">
              <Button
                aria-label={r.fewer}
                disabled={act.isPending || data.courts.length <= 1}
                onClick={() => run("patch", "", { courts: data.courts.length - 1 })}
              >
                −
              </Button>
              <span className="mono w-8 text-center">{data.courts.length}</span>
              <Button
                aria-label={r.more}
                disabled={act.isPending || data.courts.length >= 20}
                onClick={() => run("patch", "", { courts: data.courts.length + 1 })}
              >
                +
              </Button>
            </div>
          </div>
          <Select
            label={r.sets}
            className="w-32"
            value={data.best_of}
            disabled={act.isPending}
            onChange={(e) => run("patch", "", { best_of: Number(e.target.value) })}
          >
            {[1, 3, 5].map((n) => (
              <option key={n} value={n}>
                {r.bestOf(n)}
              </option>
            ))}
          </Select>
          {(["points", "cap"] as const).map((k) => (
            <Input
              // remount when the saved value changes, so the field shows it
              key={`${k}-${data[k]}`}
              label={r[k]}
              className="w-28"
              type="number"
              min={k === "cap" ? data.points : 1}
              max={99}
              inputMode="numeric"
              defaultValue={data[k]}
              disabled={act.isPending}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v && v !== data[k]) run("patch", "", k === "points" ? { points: v, cap: Math.max(v, data.cap) } : { cap: v });
              }}
            />
          ))}
          <p className="caption w-full text-muted">
            {r.scoreRule(data.best_of, data.points, data.cap)} · {r.capHint}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {data.courts.map((c) => (
          <Court
            key={c.court}
            court={c}
            data={data}
            byId={byId}
            queue={queue}
            manage={manage}
            busy={act.isPending}
            run={run}
          />
        ))}
      </div>

      <h3 className="mt-6 mb-2">{r.players}</h3>
      {manage && absent.length > 0 && (
        <Button
          className="mb-2"
          disabled={act.isPending}
          onClick={() => run("post", "/players", { join_request_ids: absent.map((p) => p.join_request_id), state: "waiting" })}
        >
          {r.allArrived}
        </Button>
      )}
      <ul>
        {[...queue, ...data.players.filter((p) => p.queue_position === null)].map((p) => (
          <PlayerRow key={p.join_request_id} p={p} manage={manage} busy={act.isPending} run={run} />
        ))}
      </ul>

      <Leaderboard rows={data.leaderboard} />
      <Finished data={data} byId={byId} manage={manage} busy={act.isPending} run={run} />
    </section>
  );
}

type Run = (method: "post" | "patch" | "del", path: string, body?: unknown) => void;

function Teams({ g, byId }: { g: RotationGame; byId: Map<string, RotationPlayer> }) {
  const names = (ids: string[]) => ids.map((id) => byId.get(id)?.name ?? "?").join(" & ");
  return (
    <p className="my-2 font-medium">
      {names(g.team_a)} <span className="caption text-muted">{r.vs}</span> {names(g.team_b)}
    </p>
  );
}

function Court({
  court,
  data,
  byId,
  queue,
  manage,
  busy,
  run,
}: {
  court: Rotation["courts"][number];
  data: Rotation;
  byId: Map<string, RotationPlayer>;
  queue: RotationPlayer[];
  manage: boolean;
  busy: boolean;
  run: Run;
}) {
  const n = court.court;
  const playing = data.games.find((g) => g.court === n && g.status === "playing");
  const next = data.games.find((g) => g.court === n && g.status === "next");
  const [finishing, setFinishing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [full, setFull] = useState(false);

  return (
    <div className="card p-4">
      <h3>{r.court(n)}</h3>
      {manage ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Select
            label={r.gender}
            value={court.gender_mode}
            disabled={busy}
            onChange={(e) => run("patch", `/courts/${n}`, { gender_mode: e.target.value })}
          >
            {(Object.keys(r.genderMode) as GenderMode[]).map((k) => (
              <option key={k} value={k}>
                {r.genderMode[k]}
              </option>
            ))}
          </Select>
          <Select
            label={r.level}
            value={court.level_mode}
            disabled={busy}
            onChange={(e) => run("patch", `/courts/${n}`, { level_mode: e.target.value })}
          >
            {(Object.keys(r.levelMode) as LevelMode[]).map((k) => (
              <option key={k} value={k}>
                {r.levelMode[k]}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <p className="caption text-muted">
          {r.genderMode[court.gender_mode]} · {r.levelMode[court.level_mode]}
        </p>
      )}

      {playing && (
        <div className="mt-3 rounded-xl bg-accent/10 p-3">
          <p className="label">
            {r.playing} · <span className="mono">{r.minutes(minutesSince(playing.started_at))}</span>
          </p>
          <Scoreboard g={playing} byId={byId} manage={manage} busy={busy} run={run} />
          <div className="mt-3 flex flex-wrap gap-1">
            <Button variant="primary" onClick={() => setFull(true)}>
              {r.fullscreen}
            </Button>
            {manage && (
              <Button disabled={busy} onClick={() => setFinishing(true)}>
                {r.finish}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="mt-3">
        <p className="label">{r.next}</p>
        {next ? (
          <>
            <Teams g={next} byId={byId} />
            {manage && (
              <div className="flex flex-wrap gap-1">
                <Button variant="primary" disabled={busy || !!playing} onClick={() => run("post", `/games/${next.id}/start`)}>
                  {r.start}
                </Button>
                <Button disabled={busy} onClick={() => run("post", `/courts/${n}/next`)}>
                  {r.repick}
                </Button>
                <Button variant="tertiary" disabled={busy} onClick={() => setChoosing(true)}>
                  {r.manual}
                </Button>
                <Button variant="tertiary" disabled={busy} onClick={() => run("del", `/games/${next.id}`)}>
                  {r.clear}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="my-2 text-muted">{r.empty}</p>
            {manage && (
              <div className="flex flex-wrap gap-1">
                <Button variant="primary" disabled={busy} onClick={() => run("post", `/courts/${n}/next`)}>
                  {r.pick}
                </Button>
                <Button disabled={busy} onClick={() => setChoosing(true)}>
                  {r.manual}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {playing && (
        <ScoreDialog
          // remount on open so the dialog starts from the current live score
          key={finishing ? "open" : "closed"}
          open={finishing}
          initial={[...playing.sets, [playing.score_a ?? 0, playing.score_b ?? 0]]}
          title={r.finishTitle(n)}
          body={r.finishBody}
          onClose={() => setFinishing(false)}
          onSave={(body) => {
            run("post", `/games/${playing.id}/finish`, body);
            setFinishing(false);
          }}
        />
      )}
      {playing && full && (
        <ScoreScreen g={playing} court={n} byId={byId} manage={manage} busy={busy} run={run} onClose={() => setFull(false)} />
      )}
      {choosing && (
        <ManualDialog
          court={n}
          singles={data.singles}
          // the court's own next turn is replaced, so its players are choosable too
          candidates={[...(next ? [...next.team_a, ...next.team_b].map((id) => byId.get(id)!) : []), ...queue]}
          onClose={() => setChoosing(false)}
          onSave={(body) => {
            run("post", `/courts/${n}/next`, body);
            setChoosing(false);
          }}
        />
      )}
    </div>
  );
}

const names = (g: RotationGame, x: "a" | "b", byId: Map<string, RotationPlayer>) =>
  (x === "a" ? g.team_a : g.team_b).map((id) => byId.get(id)?.name ?? "?").join(" & ");

/** Winner, match point, game point, or the scoring rule. */
function Status({ g }: { g: RotationGame }) {
  return g.winner ? (
    <span className="text-success">{r.won(g.winner)}</span>
  ) : g.match_point.length > 0 ? (
    <span className="text-warning">{r.matchPoint(g.match_point.map(r.team).join(" & "))}</span>
  ) : g.game_point.length > 0 ? (
    <span className="text-warning">{r.gamePoint(g.game_point.map(r.team).join(" & "))}</span>
  ) : (
    <span className="font-normal opacity-80">{r.scoreRule(g.best_of, g.points, g.cap)}</span>
  );
}

const setsText = (sets: [number, number][]) => sets.map(([a, b]) => `${a}–${b}`).join(" · ");
const sideColor = { a: "bg-blue-600", b: "bg-red-600" } as const;

/** Live score of a running game. Hosts tap +1 per rally; everyone else sees it update on the poll. */
function Scoreboard({
  g,
  byId,
  manage,
  busy,
  run,
}: {
  g: RotationGame;
  byId: Map<string, RotationPlayer>;
  manage: boolean;
  busy: boolean;
  run: Run;
}) {
  const side = (x: "a" | "b") => {
    const score = (x === "a" ? g.score_a : g.score_b) ?? 0;
    return (
      <div className={`rounded-xl p-2 text-center text-white ${sideColor[x]} ${g.winner === x ? "ring-4 ring-accent" : ""}`}>
        <p className="caption truncate font-medium">{names(g, x, byId)}</p>
        <p className="mono text-4xl font-bold tabular-nums" aria-label={`${r.team(x)}: ${score}`}>
          {score}
        </p>
        {g.best_of > 1 && (
          <p className="caption">
            {r.sets}: {g.sets_won[x === "a" ? 0 : 1]}
          </p>
        )}
        {manage && (
          <div className="mt-1 flex justify-center gap-1">
            <Button
              variant="tertiary"
              className="text-white!"
              aria-label={r.undoPoint(x)}
              disabled={busy || (score === 0 && g.sets.length === 0)}
              onClick={() => run("post", `/games/${g.id}/point`, { team: x, delta: -1 })}
            >
              −1
            </Button>
            <Button
              aria-label={r.addPoint(x)}
              disabled={busy || !!g.winner}
              onClick={() => run("post", `/games/${g.id}/point`, { team: x, delta: 1 })}
            >
              +1
            </Button>
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {side("a")}
        {side("b")}
      </div>
      {g.sets.length > 0 && (
        <p className="caption mono mt-2">
          {setsText(g.sets)}
          {!g.winner && ` · ${r.setNow(g.sets.length + 1)}`}
        </p>
      )}
      <p className="caption mt-2 font-bold" role="status">
        <Status g={g} />
      </p>
    </>
  );
}

/** Full-screen counter: tap a team's half for a point. Keeps the screen on and uses browser full screen where allowed. */
function ScoreScreen({
  g,
  court,
  byId,
  manage,
  busy,
  run,
  onClose,
}: {
  g: RotationGame;
  court: number;
  byId: Map<string, RotationPlayer>;
  manage: boolean;
  busy: boolean;
  run: Run;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    // iPhone Safari has no page full screen; the fixed overlay still covers the page there.
    document.documentElement.requestFullscreen?.().catch(() => {});
    (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      lock?.release().catch(() => {});
    };
  }, []);
  const point = (x: "a" | "b", delta: number) => run("post", `/games/${g.id}/point`, { team: x, delta });

  const half = (x: "a" | "b") => {
    const score = (x === "a" ? g.score_a : g.score_b) ?? 0;
    return (
      <div className={`relative flex min-h-0 ${sideColor[x]} text-white`}>
        <button
          type="button"
          className="flex w-full min-w-0 flex-col items-center justify-center gap-1 p-4 disabled:cursor-default"
          aria-label={`${r.addPoint(x)}: ${score}`}
          disabled={!manage || busy || !!g.winner}
          onClick={() => point(x, 1)}
        >
          <span className="max-w-full truncate text-lg font-semibold sm:text-2xl">{names(g, x, byId)}</span>
          <span className="mono text-[min(38vw,30vh)] leading-none font-bold tabular-nums landscape:text-[min(26vw,55vh)]">{score}</span>
          {g.best_of > 1 && (
            <span className="text-lg font-semibold">
              {r.sets}: {g.sets_won[x === "a" ? 0 : 1]}
            </span>
          )}
        </button>
        {manage && (
          <button
            type="button"
            className="absolute right-3 bottom-3 min-h-11 min-w-11 rounded-full bg-black/30 px-4 text-lg font-bold disabled:opacity-40"
            aria-label={r.undoPoint(x)}
            disabled={busy || (score === 0 && g.sets.length === 0)}
            onClick={() => point(x, -1)}
          >
            −1
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-white" role="region" aria-label={r.court(court)}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {r.court(court)} · {g.winner ? r.bestOf(g.best_of) : r.setNow(g.sets.length + 1)}
            {g.sets.length > 0 && <span className="mono ml-2 font-normal opacity-80">{setsText(g.sets)}</span>}
          </p>
          <p className="caption font-bold" role="status">
            <Status g={g} />
          </p>
        </div>
        {manage && (
          <Button variant="primary" disabled={busy} onClick={() => setSaving(true)}>
            {r.saveResult}
          </Button>
        )}
        <Button onClick={onClose}>{r.exitFullscreen}</Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 landscape:grid-cols-2 landscape:grid-rows-1">
        {half("a")}
        {half("b")}
      </div>
      <Dialog open={saving} onClose={() => setSaving(false)} title={r.saveTitle}>
        <p className="mb-3">{g.winner ? r.saveFinished(g.winner) : r.saveUnfinished}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="tertiary" onClick={() => setSaving(false)}>
            {t.common.back}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setSaving(false);
              run("post", `/games/${g.id}/finish`);
            }}
          >
            {r.saveResult}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** Result set by set. Rows with an empty field are left out; no rows means no score. */
function ScoreDialog({
  open,
  title,
  body,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  body?: string;
  initial: [number | null, number | null][];
  onClose: () => void;
  onSave: (b: { sets: [number, number][] }) => void;
}) {
  const [rows, setRows] = useState(() =>
    (initial.length ? initial : [[null, null]]).map(([a, b]) => [a?.toString() ?? "", b?.toString() ?? ""]),
  );
  const edit = (i: number, j: number, v: string) => setRows(rows.map((row, k) => (k === i ? row.map((c, l) => (l === j ? v : c)) : row)));
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {body && <p className="mb-3">{body}</p>}
      <div className="grid gap-2">
        {rows.map(([a, b], i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Input
              label={r.setScore(i + 1, "a")}
              type="number"
              min={0}
              max={99}
              inputMode="numeric"
              value={a}
              onChange={(e) => edit(i, 0, e.target.value)}
            />
            <Input
              label={r.setScore(i + 1, "b")}
              type="number"
              min={0}
              max={99}
              inputMode="numeric"
              value={b}
              onChange={(e) => edit(i, 1, e.target.value)}
            />
            <Button variant="tertiary" aria-label={r.removeSet(i + 1)} onClick={() => setRows(rows.filter((_, k) => k !== i))}>
              ×
            </Button>
          </div>
        ))}
      </div>
      {rows.length < 5 && (
        <Button variant="tertiary" className="mt-2" onClick={() => setRows([...rows, ["", ""]])}>
          {r.addSet}
        </Button>
      )}
      <p className="caption mt-2 text-muted">{r.noScore}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="tertiary" onClick={onClose}>
          {t.common.back}
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            onSave({
              sets: rows
                .filter(([a, b]) => a.trim() !== "" && b.trim() !== "")
                .map(([a, b]) => [Math.max(0, Number(a)), Math.max(0, Number(b))] as [number, number]),
            })
          }
        >
          {body ? r.finish : r.save}
        </Button>
      </div>
    </Dialog>
  );
}

function ManualDialog({
  court,
  singles,
  candidates,
  onClose,
  onSave,
}: {
  court: number;
  singles: boolean;
  candidates: RotationPlayer[];
  onClose: () => void;
  onSave: (b: { team_a: string[]; team_b: string[] }) => void;
}) {
  const size = singles ? 1 : 2;
  const [slots, setSlots] = useState<string[]>(Array(size * 2).fill(""));
  const chosen = slots.filter(Boolean);
  const complete = chosen.length === size * 2 && new Set(chosen).size === chosen.length;
  // Same reminder as the rules: someone with fewer games is left waiting.
  const minLeft = Math.min(...candidates.filter((c) => !chosen.includes(c.join_request_id)).map((c) => c.effective_games));
  const skips = chosen.some((id) => (candidates.find((c) => c.join_request_id === id)?.effective_games ?? 0) > minLeft);
  const labels = [...Array(size).keys()].map((i) => r.slot("A", i + 1)).concat([...Array(size).keys()].map((i) => r.slot("B", i + 1)));
  return (
    <Dialog open onClose={onClose} title={r.manualTitle(court)}>
      <div className="grid gap-2">
        {labels.map((label, i) => (
          <label key={label} className="grid gap-1">
            <span className="label">{label}</span>
            <select
              className={controlClass}
              value={slots[i]}
              onChange={(e) => setSlots(slots.map((s, j) => (j === i ? e.target.value : s)))}
            >
              <option value="">—</option>
              {candidates.map((c) => (
                <option key={c.join_request_id} value={c.join_request_id}>
                  {c.name} · {r.gamesShort(c.games)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {skips && <p className="caption mt-3 rounded-lg bg-warning/15 p-2 text-warning">{r.skipWarning}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="tertiary" onClick={onClose}>
          {t.common.back}
        </Button>
        <Button
          variant="primary"
          disabled={!complete}
          onClick={() => onSave({ team_a: slots.slice(0, size), team_b: slots.slice(size) })}
        >
          {r.save}
        </Button>
      </div>
    </Dialog>
  );
}

function PlayerRow({ p, manage, busy, run }: { p: RotationPlayer; manage: boolean; busy: boolean; run: Run }) {
  const set = (state: string) => run("post", "/players", { join_request_ids: [p.join_request_id], state });
  const arrived = p.state !== "absent";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2">
      <div className="min-w-0">
        <p className="font-medium">
          {p.queue_position !== null && <span className="mono mr-2 text-muted">#{p.queue_position}</span>}
          {p.name}
        </p>
        <p className="caption text-muted">
          {p.queued ? r.queued : r.state[p.state]} · {r.gamesShort(p.games)}
          {p.state === "waiting" && !p.queued && ` · ${r.waitedFor(minutesSince(p.wait_since))}`}
          {p.arrived_at && ` · ${fmtTime(p.arrived_at)}`}
        </p>
      </div>
      {manage && (
        <div className="flex flex-wrap items-center gap-1">
          {arrived && (
            <>
              <select
                aria-label={r.genderOf(p.name)}
                className={`${controlClass} w-16!`}
                value={p.gender ?? ""}
                disabled={busy}
                onChange={(e) => run("patch", `/players/${p.join_request_id}`, { gender: e.target.value })}
              >
                {(["", "M", "F"] as const).map((g) => (
                  <option key={g} value={g}>
                    {r.genderValue[g]}
                  </option>
                ))}
              </select>
              <select
                aria-label={r.levelOf(p.name)}
                className={`${controlClass} w-28!`}
                value={p.level ?? 0}
                disabled={busy}
                onChange={(e) => run("patch", `/players/${p.join_request_id}`, { level: Number(e.target.value) })}
              >
                {([0, 1, 2, 3] as const).map((l) => (
                  <option key={l} value={l}>
                    {r.levelValue[l]}
                  </option>
                ))}
              </select>
            </>
          )}
          {p.state === "absent" && (
            <Button variant="primary" disabled={busy} onClick={() => set("waiting")}>
              {r.arrive}
            </Button>
          )}
          {p.state === "waiting" && (
            <>
              <Button variant="tertiary" disabled={busy} onClick={() => set("resting")}>
                {r.rest}
              </Button>
              <Button variant="tertiary" disabled={busy} onClick={() => set("left")}>
                {r.leave}
              </Button>
            </>
          )}
          {(p.state === "resting" || p.state === "left") && (
            <Button disabled={busy} onClick={() => set("waiting")}>
              {r.back}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function Leaderboard({ rows }: { rows: Rotation["leaderboard"] }) {
  const num = "py-2 pr-3 text-right mono tabular-nums";
  return (
    <>
      <h3 className="mt-6 mb-2">{r.leaderboard}</h3>
      {rows.length === 0 ? (
        <p className="text-muted">{r.noLeaderboard}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="label">
                <th scope="col" className="py-2 pr-3">{r.lbRank}</th>
                <th scope="col" className="py-2 pr-3">{r.lbName}</th>
                <th scope="col" className="py-2 pr-3 text-right">{r.lbGames}</th>
                <th scope="col" className="py-2 pr-3 text-right">{r.lbWins}</th>
                <th scope="col" className="py-2 pr-3 text-right">{r.lbLosses}</th>
                <th scope="col" className="py-2 pr-3 text-right">{r.lbPoints}</th>
                <th scope="col" className="py-2 text-right">{r.lbDiff}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.join_request_id} className="border-t border-border">
                  <td className="mono py-2 pr-3 text-muted">{row.rank}</td>
                  <th scope="row" className="py-2 pr-3 font-medium">{row.name}</th>
                  <td className={num}>{row.games}</td>
                  <td className={`${num} font-bold`}>{row.wins}</td>
                  <td className={num}>{row.losses}</td>
                  <td className={num}>
                    {row.points_for}–{row.points_against}
                  </td>
                  <td className={`mono py-2 text-right tabular-nums ${row.point_diff > 0 ? "text-success" : row.point_diff < 0 ? "text-danger" : ""}`}>
                    {row.point_diff > 0 ? `+${row.point_diff}` : row.point_diff}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="caption mt-1 text-muted">{r.lbNote}</p>
    </>
  );
}

function Finished({
  data,
  byId,
  manage,
  busy,
  run,
}: {
  data: Rotation;
  byId: Map<string, RotationPlayer>;
  manage: boolean;
  busy: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState<RotationGame | null>(null);
  const done = data.games.filter((g) => g.status === "done").reverse();
  return (
    <>
      <h3 className="mt-6 mb-2">{r.history}</h3>
      {done.length === 0 && <p className="text-muted">{r.noHistory}</p>}
      <ul>
        {done.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2">
            <div className="min-w-0">
              <p className="caption text-muted">
                {r.court(g.court)} · {g.ended_at && fmtTime(g.ended_at)}
              </p>
              <Teams g={g} byId={byId} />
            </div>
            <div className="flex items-center gap-2">
              {g.sets.length > 0 && <span className="mono font-semibold">{setsText(g.sets)}</span>}
              {manage && (
                <Button variant="tertiary" disabled={busy} onClick={() => setEditing(g)}>
                  {r.editScore}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <ScoreDialog
          open
          title={r.editScore}
          initial={editing.sets}
          onClose={() => setEditing(null)}
          onSave={(body) => {
            run("patch", `/games/${editing.id}`, body);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
