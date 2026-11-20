"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
    refetchInterval: 10_000, // players watch from their phones; the app polls (PRD §10)
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
          {manage && (
            <Button variant="primary" className="mt-3" disabled={busy} onClick={() => setFinishing(true)}>
              {r.finish}
            </Button>
          )}
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
          initial={playing}
          title={r.finishTitle(n)}
          body={r.finishBody}
          onClose={() => setFinishing(false)}
          onSave={(body) => {
            run("post", `/games/${playing.id}/finish`, body);
            setFinishing(false);
          }}
        />
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

/** Live score of a running game. Hosts tap +1 per rally; everyone else sees it update on the 10 s poll. */
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
    const ids = x === "a" ? g.team_a : g.team_b;
    const score = (x === "a" ? g.score_a : g.score_b) ?? 0;
    return (
      <div className={`rounded-xl p-2 text-center ${g.winner === x ? "bg-accent text-on-accent" : "bg-surface"}`}>
        <p className="caption truncate font-medium">{ids.map((id) => byId.get(id)?.name ?? "?").join(" & ")}</p>
        <p className="mono text-4xl font-bold tabular-nums" aria-label={`${r.team(x)}: ${score}`}>
          {score}
        </p>
        {manage && (
          <div className="mt-1 flex justify-center gap-1">
            <Button
              variant="tertiary"
              aria-label={r.undoPoint(x)}
              disabled={busy || score === 0}
              onClick={() => run("post", `/games/${g.id}/point`, { team: x, delta: -1 })}
            >
              −1
            </Button>
            <Button
              variant="primary"
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
      <p className="caption mt-2 font-bold" role="status">
        {g.winner ? (
          <span className="text-success">{r.won(g.winner)}</span>
        ) : g.game_point.length > 0 ? (
          <span className="text-warning">{r.matchPoint(g.game_point.map(r.team).join(" & "))}</span>
        ) : (
          <span className="font-normal text-muted">{r.scoreRule}</span>
        )}
      </p>
    </>
  );
}

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
  initial?: RotationGame;
  onClose: () => void;
  onSave: (b: { score_a: number | null; score_b: number | null }) => void;
}) {
  const [a, setA] = useState(initial?.score_a?.toString() ?? "");
  const [b, setB] = useState(initial?.score_b?.toString() ?? "");
  const num = (v: string) => (v.trim() === "" ? null : Math.max(0, Number(v)));
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {body && <p className="mb-3">{body}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Input label={r.scoreA} type="number" min={0} inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} />
        <Input label={r.scoreB} type="number" min={0} inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} />
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="tertiary" onClick={onClose}>
          {t.common.back}
        </Button>
        <Button variant="primary" onClick={() => onSave({ score_a: num(a), score_b: num(b) })}>
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
              {g.score_a !== null && g.score_b !== null && (
                <span className="mono font-semibold">
                  {g.score_a}–{g.score_b}
                </span>
              )}
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
          initial={editing}
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
