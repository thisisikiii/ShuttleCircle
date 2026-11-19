//! Court rotation (FR-19, FEATURES.md §11): fair turns on the courts while a match is on.
//! Confirmed players check in, the host fills each court with the players who have played least,
//! starts and finishes games, and the finished games update `join_requests.games_played`.

use crate::{
    auth::{Member, Role},
    error::*,
    requests, AppState,
};
use axum::{
    extract::{Path, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgConnection;
use std::collections::HashSet;
use uuid::Uuid;

// ---------- selection rules (pure, unit tested) ----------

#[derive(Clone, Debug)]
pub struct Cand {
    pub id: Uuid,
    /// Games counted for fairness: max(games played, floor taken when the player joined the queue).
    pub eff: i32,
    pub wait_since: DateTime<Utc>,
    pub arrived: DateTime<Utc>,
    pub gender: Option<char>,
    /// 1 beginner, 2 intermediate, 3 advanced; unset counts as beginner.
    pub level: i16,
}

/// Queue order: fewest games, then longest wait, then earliest arrival.
pub fn order(c: &mut [Cand]) {
    c.sort_by(|a, b| (a.eff, a.wait_since, a.arrived).cmp(&(b.eff, b.wait_since, b.arrived)));
}

fn mean(set: &[&Cand]) -> f32 {
    set.iter().map(|c| c.level as f32).sum::<f32>() / set.len() as f32
}

/// Picks `count` players from `eligible` (queue order). Level mode only reorders players who
/// have the same game count as the last one needed, so nobody who played more jumps the queue.
fn select<'a>(eligible: &[&'a Cand], count: usize, level: &str, chosen: &[&'a Cand]) -> Vec<&'a Cand> {
    if level == "off" {
        return eligible[..count].to_vec();
    }
    let cutoff = eligible[count - 1].eff;
    let mut out: Vec<&Cand> = eligible.iter().copied().filter(|c| c.eff < cutoff).collect();
    let mut pool: Vec<&Cand> = eligible.iter().copied().filter(|c| c.eff == cutoff).collect();
    while out.len() < count {
        let base: Vec<&Cand> = chosen.iter().chain(out.iter()).copied().collect();
        let i = if base.is_empty() {
            0
        } else {
            let m = mean(&base);
            let dist = |c: &Cand| (c.level as f32 - m).abs();
            // First index wins ties, which keeps queue order among equals.
            let mut best = 0;
            for (i, c) in pool.iter().enumerate() {
                let better = if level == "balanced" { dist(c) < dist(pool[best]) } else { dist(c) > dist(pool[best]) };
                if better {
                    best = i;
                }
            }
            best
        };
        out.push(pool.remove(i));
    }
    out
}

/// Returns (team A, team B) or a message saying how many players are missing.
pub fn pick(queue: &[Cand], singles: bool, gender: &str, level: &str) -> Result<(Vec<Uuid>, Vec<Uuid>), String> {
    let n = if singles { 2 } else { 4 };
    let quotas: Vec<(Option<char>, usize)> = match gender {
        "men" => vec![(Some('M'), n)],
        "women" => vec![(Some('F'), n)],
        "mixed" if !singles => vec![(Some('M'), 2), (Some('F'), 2)],
        _ => vec![(None, n)],
    };
    let mut chosen: Vec<&Cand> = vec![];
    for (g, count) in quotas {
        let eligible: Vec<&Cand> = queue.iter().filter(|c| g.is_none() || c.gender == g).collect();
        if eligible.len() < count {
            let who = match g {
                Some('M') => " putra",
                Some('F') => " putri",
                _ => "",
            };
            return Err(format!("Kurang {} pemain{who} yang menunggu", count - eligible.len()));
        }
        let got = select(&eligible, count, level, &chosen);
        chosen.extend(got);
    }
    // Back to queue order, so "first" and "fourth" mean queue positions.
    let pos = |c: &Cand| queue.iter().position(|q| q.id == c.id).unwrap_or(usize::MAX);
    chosen.sort_by_key(|c| pos(c));
    if level != "off" {
        chosen.sort_by(|a, b| b.level.cmp(&a.level)); // stable: equal levels keep queue order
    }
    let ids = |v: &[&Cand]| v.iter().map(|c| c.id).collect::<Vec<_>>();
    if singles {
        return Ok((vec![chosen[0].id], vec![chosen[1].id]));
    }
    if gender == "mixed" {
        let men: Vec<&Cand> = chosen.iter().copied().filter(|c| c.gender == Some('M')).collect();
        let women: Vec<&Cand> = chosen.iter().copied().filter(|c| c.gender == Some('F')).collect();
        return Ok((ids(&[men[0], women[1]]), ids(&[men[1], women[0]])));
    }
    // 1st + 4th against 2nd + 3rd: by queue order, or by level when levels count.
    Ok((ids(&[chosen[0], chosen[3]]), ids(&[chosen[1], chosen[2]])))
}

// ---------- state ----------

#[derive(sqlx::FromRow)]
struct PlayerRow {
    id: Uuid,
    name: String,
    state: Option<String>,
    gender: Option<String>,
    level: Option<i16>,
    arrived_at: Option<DateTime<Utc>>,
    wait_since: Option<DateTime<Utc>>,
    play_floor: Option<i32>,
    plays: i32,
    minutes: i32,
}

#[derive(sqlx::FromRow)]
struct GameRow {
    id: Uuid,
    court: i32,
    status: String,
    team_a: Vec<Uuid>,
    team_b: Vec<Uuid>,
    score_a: Option<i32>,
    score_b: Option<i32>,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
}

struct Snap {
    singles: bool,
    courts: Vec<(i32, String, String)>,
    players: Vec<PlayerRow>,
    games: Vec<GameRow>,
}

impl Snap {
    fn eff(p: &PlayerRow) -> i32 {
        p.plays.max(p.play_floor.unwrap_or(0))
    }
    /// Players in a game that is queued or on court.
    fn busy(&self) -> HashSet<Uuid> {
        self.games.iter().filter(|g| g.status != "done").flat_map(|g| g.team_a.iter().chain(&g.team_b).copied()).collect()
    }
    /// Waiting players not in any queued or running game, in queue order.
    fn queue(&self) -> Vec<Cand> {
        let busy = self.busy();
        let mut q: Vec<Cand> = self
            .players
            .iter()
            .filter(|p| p.state.as_deref() == Some("waiting") && !busy.contains(&p.id))
            .map(|p| Cand {
                id: p.id,
                eff: Self::eff(p),
                wait_since: p.wait_since.unwrap_or_default(),
                arrived: p.arrived_at.unwrap_or_default(),
                gender: p.gender.as_deref().and_then(|g| g.chars().next()),
                level: p.level.unwrap_or(1),
            })
            .collect();
        order(&mut q);
        q
    }
    /// Fewest games among the other players still in the session (rule: newcomers do not jump the queue).
    fn floor(&self, except: Uuid) -> i32 {
        self.players.iter().filter(|p| p.id != except && p.state.as_deref() == Some("waiting")).map(Self::eff).min().unwrap_or(0)
    }
    fn json(&self) -> Value {
        let busy = self.busy();
        let queue: Vec<Uuid> = self.queue().iter().map(|c| c.id).collect();
        let players: Vec<Value> = self
            .players
            .iter()
            .map(|p| {
                let state = match p.state.as_deref() {
                    None => "absent",
                    Some("waiting") if self.games.iter().any(|g| g.status == "playing" && (g.team_a.contains(&p.id) || g.team_b.contains(&p.id))) => "playing",
                    Some(s) => s,
                };
                json!({
                    "join_request_id": p.id, "name": p.name, "state": state, "gender": p.gender, "level": p.level,
                    "arrived_at": p.arrived_at, "wait_since": p.wait_since, "games": p.plays, "effective_games": Self::eff(p),
                    "minutes_played": p.minutes, "queued": busy.contains(&p.id) && state == "waiting",
                    "queue_position": queue.iter().position(|q| *q == p.id).map(|i| i + 1),
                })
            })
            .collect();
        let games: Vec<Value> = self
            .games
            .iter()
            .map(|g| {
                json!({"id": g.id, "court": g.court, "status": g.status, "team_a": g.team_a, "team_b": g.team_b,
                       "score_a": g.score_a, "score_b": g.score_b, "started_at": g.started_at, "ended_at": g.ended_at})
            })
            .collect();
        let courts: Vec<Value> = self.courts.iter().map(|(c, g, l)| json!({"court": c, "gender_mode": g, "level_mode": l})).collect();
        json!({"singles": self.singles, "courts": courts, "players": players, "games": games})
    }
}

async fn ensure_courts(c: &mut PgConnection, id: Uuid) -> R<()> {
    sqlx::query("INSERT INTO rotation_courts(match_id, court) SELECT $1, g FROM generate_series(1, 2) g WHERE NOT EXISTS (SELECT 1 FROM rotation_courts WHERE match_id = $1)")
        .bind(id)
        .execute(&mut *c)
        .await?;
    Ok(())
}

async fn load(c: &mut PgConnection, id: Uuid) -> R<Snap> {
    let singles: bool = sqlx::query_scalar("SELECT rotation_singles FROM matches WHERE id = $1").bind(id).fetch_one(&mut *c).await?;
    ensure_courts(c, id).await?;
    let courts = sqlx::query_as("SELECT court, gender_mode, level_mode FROM rotation_courts WHERE match_id = $1 ORDER BY court").bind(id).fetch_all(&mut *c).await?;
    let players = sqlx::query_as::<_, PlayerRow>(
        "SELECT j.id, u.full_name AS name, rp.state::text AS state, rp.gender::text AS gender, rp.level, rp.arrived_at, rp.wait_since, rp.play_floor, \
           (SELECT count(*) FROM rotation_games g WHERE g.match_id = j.match_id AND g.status = 'done' AND j.id = ANY(g.team_a || g.team_b))::int AS plays, \
           coalesce((SELECT sum(extract(epoch FROM g.ended_at - g.started_at)) / 60 FROM rotation_games g \
             WHERE g.match_id = j.match_id AND g.status = 'done' AND j.id = ANY(g.team_a || g.team_b)), 0)::int AS minutes \
         FROM join_requests j JOIN users u ON u.id = j.user_id LEFT JOIN rotation_players rp ON rp.join_request_id = j.id \
         WHERE j.match_id = $1 AND j.status = 'confirmed' ORDER BY rp.arrived_at NULLS LAST, u.full_name",
    )
    .bind(id)
    .fetch_all(&mut *c)
    .await?;
    let games = sqlx::query_as::<_, GameRow>(
        "SELECT id, court, status::text AS status, team_a, team_b, score_a, score_b, started_at, ended_at FROM rotation_games WHERE match_id = $1 ORDER BY created_at",
    )
    .bind(id)
    .fetch_all(&mut *c)
    .await?;
    Ok(Snap { singles, courts, players, games })
}

/// Locks the match for this transaction and checks the caller manages it and it is not cancelled.
async fn begin_manage(st: &AppState, m: &Member, id: Uuid) -> R<sqlx::Transaction<'static, sqlx::Postgres>> {
    m.need(Role::Host)?;
    let mut tx = st.db.begin().await?;
    let cancelled: bool = sqlx::query_scalar("SELECT cancelled_at IS NOT NULL FROM matches WHERE id = $1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await?;
    requests::can_manage(&mut *tx, id, m).await?;
    if cancelled {
        return Err(e409("MATCH_NOT_OPEN", "Pertandingan dibatalkan"));
    }
    Ok(tx)
}

async fn reply(mut tx: sqlx::Transaction<'static, sqlx::Postgres>, id: Uuid) -> R<Json<Value>> {
    let snap = load(&mut *tx, id).await?;
    tx.commit().await?;
    Ok(ok(snap.json()))
}

// ---------- handlers ----------

/// Any signed-in member may watch the rotation; only the host and admins change it.
pub async fn get(State(st): State<AppState>, _m: Member, Path(id): Path<Uuid>) -> R<Json<Value>> {
    let mut c = st.db.acquire().await?;
    Ok(ok(load(&mut *c, id).await?.json()))
}

#[derive(Deserialize)]
pub struct SettingsIn {
    courts: Option<i32>,
    singles: Option<bool>,
}

pub async fn settings(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>, Json(b): Json<SettingsIn>) -> R<Json<Value>> {
    let mut tx = begin_manage(&st, &m, id).await?;
    let snap = load(&mut *tx, id).await?;
    let active = |court: Option<i32>| snap.games.iter().any(|g| g.status != "done" && court.is_none_or(|c| g.court > c));
    if let Some(n) = b.courts {
        if !(1..=20).contains(&n) {
            return Err(invalid("courts", "1 sampai 20 lapangan"));
        }
        if active(Some(n)) {
            return Err(e409("COURT_BUSY", "Lapangan yang dihapus masih punya giliran atau sedang dipakai"));
        }
        sqlx::query("DELETE FROM rotation_courts WHERE match_id = $1 AND court > $2").bind(id).bind(n).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO rotation_courts(match_id, court) SELECT $1, g FROM generate_series(1, $2) g ON CONFLICT DO NOTHING").bind(id).bind(n).execute(&mut *tx).await?;
    }
    if let Some(s) = b.singles {
        if s != snap.singles && active(None) {
            return Err(e409("COURT_BUSY", "Selesaikan atau kosongkan semua giliran sebelum mengganti format"));
        }
        sqlx::query("UPDATE matches SET rotation_singles = $2 WHERE id = $1").bind(id).bind(s).execute(&mut *tx).await?;
    }
    reply(tx, id).await
}

#[derive(Deserialize)]
pub struct CourtIn {
    gender_mode: Option<String>,
    level_mode: Option<String>,
}

pub async fn court(State(st): State<AppState>, m: Member, Path((id, court)): Path<(Uuid, i32)>, Json(b): Json<CourtIn>) -> R<Json<Value>> {
    if b.gender_mode.as_deref().is_some_and(|g| !["any", "mixed", "men", "women"].contains(&g)) {
        return Err(invalid("gender_mode", "Mode tidak dikenal"));
    }
    if b.level_mode.as_deref().is_some_and(|l| !["off", "balanced", "mixed"].contains(&l)) {
        return Err(invalid("level_mode", "Mode tidak dikenal"));
    }
    let mut tx = begin_manage(&st, &m, id).await?;
    ensure_courts(&mut *tx, id).await?;
    let done = sqlx::query("UPDATE rotation_courts SET gender_mode = coalesce($3, gender_mode), level_mode = coalesce($4, level_mode) WHERE match_id = $1 AND court = $2")
        .bind(id)
        .bind(court)
        .bind(&b.gender_mode)
        .bind(&b.level_mode)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(e404());
    }
    reply(tx, id).await
}

#[derive(Deserialize)]
pub struct StateIn {
    join_request_ids: Vec<Uuid>,
    /// waiting (arrived or back from rest), resting, left, absent (undo an arrival with no games).
    state: String,
}

pub async fn players(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>, Json(b): Json<StateIn>) -> R<Json<Value>> {
    if !["waiting", "resting", "left", "absent"].contains(&b.state.as_str()) {
        return Err(invalid("state", "Status tidak dikenal"));
    }
    let mut tx = begin_manage(&st, &m, id).await?;
    for jr in &b.join_request_ids {
        let snap = load(&mut *tx, id).await?;
        let Some(p) = snap.players.iter().find(|p| p.id == *jr) else {
            return Err(invalid("join_request_ids", "Pemain tidak ada di daftar pertandingan ini"));
        };
        let game = snap.games.iter().find(|g| g.status != "done" && (g.team_a.contains(jr) || g.team_b.contains(jr)));
        if b.state != "waiting" {
            match game {
                Some(g) if g.status == "playing" => return Err(e409("PLAYER_ON_COURT", &format!("{} sedang main", p.name))),
                // Leaving the queue frees that court's next turn so it can be picked again.
                Some(g) => {
                    sqlx::query("DELETE FROM rotation_games WHERE id = $1").bind(g.id).execute(&mut *tx).await?;
                }
                None => {}
            }
        }
        match b.state.as_str() {
            "absent" => {
                if p.plays > 0 {
                    return Err(e409("PLAYER_HAS_GAMES", &format!("{} sudah tercatat main; tandai pulang saja", p.name)));
                }
                sqlx::query("DELETE FROM rotation_players WHERE join_request_id = $1").bind(jr).execute(&mut *tx).await?;
            }
            "waiting" if p.state.as_deref() == Some("waiting") => {}
            "waiting" => {
                sqlx::query(
                    "INSERT INTO rotation_players(join_request_id, match_id, play_floor) VALUES ($1, $2, $3) \
                     ON CONFLICT (join_request_id) DO UPDATE SET state = 'waiting', wait_since = now(), play_floor = $3",
                )
                .bind(jr)
                .bind(id)
                .bind(snap.floor(*jr))
                .execute(&mut *tx)
                .await?;
            }
            s => {
                // Resting or leaving before arrival still records the player as arrived.
                sqlx::query(
                    "INSERT INTO rotation_players(join_request_id, match_id, state) VALUES ($1, $2, $3::rotation_state) \
                     ON CONFLICT (join_request_id) DO UPDATE SET state = $3::rotation_state",
                )
                .bind(jr)
                .bind(id)
                .bind(s)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    reply(tx, id).await
}

#[derive(Deserialize)]
pub struct ProfileIn {
    /// "M", "F" or "" to clear.
    gender: Option<String>,
    /// 1 to 3, or 0 to clear.
    level: Option<i16>,
}

pub async fn player(State(st): State<AppState>, m: Member, Path((id, jr)): Path<(Uuid, Uuid)>, Json(b): Json<ProfileIn>) -> R<Json<Value>> {
    if b.gender.as_deref().is_some_and(|g| !["M", "F", ""].contains(&g)) {
        return Err(invalid("gender", "M, F atau kosong"));
    }
    if b.level.is_some_and(|l| !(0..=3).contains(&l)) {
        return Err(invalid("level", "0 sampai 3"));
    }
    let mut tx = begin_manage(&st, &m, id).await?;
    let done = sqlx::query(
        "UPDATE rotation_players SET \
           gender = CASE WHEN $3::text IS NULL THEN gender ELSE nullif($3, '') END, \
           level  = CASE WHEN $4::smallint IS NULL THEN level ELSE nullif($4, 0) END \
         WHERE join_request_id = $1 AND match_id = $2",
    )
    .bind(jr)
    .bind(id)
    .bind(&b.gender)
    .bind(b.level)
    .execute(&mut *tx)
    .await?;
    if done.rows_affected() == 0 {
        return Err(e409("PLAYER_NOT_ARRIVED", "Tandai pemain sudah datang lebih dulu"));
    }
    reply(tx, id).await
}

#[derive(Deserialize, Default)]
pub struct NextIn {
    team_a: Option<Vec<Uuid>>,
    team_b: Option<Vec<Uuid>>,
}

/// Sets the next turn of a court: picked by the rules, or chosen by the host. Replaces any earlier next turn.
pub async fn next(State(st): State<AppState>, m: Member, Path((id, court)): Path<(Uuid, i32)>, body: Option<Json<NextIn>>) -> R<Json<Value>> {
    let b = body.map(|Json(b)| b).unwrap_or_default();
    let mut tx = begin_manage(&st, &m, id).await?;
    sqlx::query("DELETE FROM rotation_games WHERE match_id = $1 AND court = $2 AND status = 'next'").bind(id).bind(court).execute(&mut *tx).await?;
    let snap = load(&mut *tx, id).await?;
    let Some((_, gender, level)) = snap.courts.iter().find(|c| c.0 == court) else {
        return Err(e404());
    };
    let queue = snap.queue();
    let (a, bt) = match (b.team_a, b.team_b) {
        (Some(a), Some(bt)) => {
            let size = if snap.singles { 1 } else { 2 };
            let all: HashSet<Uuid> = a.iter().chain(&bt).copied().collect();
            if a.len() != size || bt.len() != size || all.len() != size * 2 {
                return Err(invalid("team_a", &format!("Tiap tim berisi {size} pemain berbeda")));
            }
            if !all.iter().all(|p| queue.iter().any(|c| c.id == *p)) {
                return Err(invalid("team_a", "Hanya pemain yang sedang menunggu dan belum dapat giliran"));
            }
            (a, bt)
        }
        (None, None) => pick(&queue, snap.singles, gender, level).map_err(|msg| e409("NOT_ENOUGH_PLAYERS", &msg))?,
        _ => return Err(invalid("team_b", "Isi kedua tim atau kosongkan keduanya")),
    };
    sqlx::query("INSERT INTO rotation_games(match_id, court, team_a, team_b) VALUES ($1, $2, $3, $4)").bind(id).bind(court).bind(&a).bind(&bt).execute(&mut *tx).await?;
    reply(tx, id).await
}

async fn game_status(c: &mut PgConnection, id: Uuid, gid: Uuid) -> R<(i32, String)> {
    Ok(sqlx::query_as("SELECT court, status::text FROM rotation_games WHERE id = $1 AND match_id = $2").bind(gid).bind(id).fetch_one(&mut *c).await?)
}

/// Clears a next turn that has not started.
pub async fn clear(State(st): State<AppState>, m: Member, Path((id, gid)): Path<(Uuid, Uuid)>) -> R<Json<Value>> {
    let mut tx = begin_manage(&st, &m, id).await?;
    if game_status(&mut *tx, id, gid).await?.1 != "next" {
        return Err(e409("GAME_STARTED", "Pertandingan yang sudah mulai tidak bisa dikosongkan"));
    }
    sqlx::query("DELETE FROM rotation_games WHERE id = $1").bind(gid).execute(&mut *tx).await?;
    reply(tx, id).await
}

pub async fn start(State(st): State<AppState>, m: Member, Path((id, gid)): Path<(Uuid, Uuid)>) -> R<Json<Value>> {
    let mut tx = begin_manage(&st, &m, id).await?;
    let (court, status) = game_status(&mut *tx, id, gid).await?;
    if status != "next" {
        return Err(e409("GAME_STARTED", "Pertandingan sudah dimulai"));
    }
    let busy: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM rotation_games WHERE match_id = $1 AND court = $2 AND status = 'playing')")
        .bind(id)
        .bind(court)
        .fetch_one(&mut *tx)
        .await?;
    if busy {
        return Err(e409("COURT_BUSY", "Lapangan masih dipakai; selesaikan pertandingan yang berjalan dulu"));
    }
    sqlx::query("UPDATE rotation_games SET status = 'playing', started_at = now() WHERE id = $1").bind(gid).execute(&mut *tx).await?;
    reply(tx, id).await
}

#[derive(Deserialize)]
pub struct ScoreIn {
    score_a: Option<i32>,
    score_b: Option<i32>,
}

fn check_score(b: &ScoreIn) -> R<()> {
    if b.score_a.is_some_and(|s| s < 0) || b.score_b.is_some_and(|s| s < 0) {
        return Err(invalid("score_a", "Tidak boleh negatif"));
    }
    Ok(())
}

/// Ends a running game. Every player gets one more game; their wait starts now; `games_played` follows.
pub async fn finish(State(st): State<AppState>, m: Member, Path((id, gid)): Path<(Uuid, Uuid)>, body: Option<Json<ScoreIn>>) -> R<Json<Value>> {
    let b = body.map(|Json(b)| b).unwrap_or(ScoreIn { score_a: None, score_b: None });
    check_score(&b)?;
    let mut tx = begin_manage(&st, &m, id).await?;
    if game_status(&mut *tx, id, gid).await?.1 != "playing" {
        return Err(e409("GAME_NOT_PLAYING", "Pertandingan belum dimulai atau sudah selesai"));
    }
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE rotation_games SET status = 'done', ended_at = now(), score_a = $2, score_b = $3 WHERE id = $1 RETURNING team_a || team_b",
    )
    .bind(gid)
    .bind(b.score_a)
    .bind(b.score_b)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE rotation_players SET wait_since = now() WHERE join_request_id = ANY($1)").bind(&ids).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE join_requests j SET games_played = (SELECT count(*) FROM rotation_games g WHERE g.match_id = j.match_id AND g.status = 'done' AND j.id = ANY(g.team_a || g.team_b)) \
         WHERE j.id = ANY($1)",
    )
    .bind(&ids)
    .execute(&mut *tx)
    .await?;
    reply(tx, id).await
}

/// Adds or changes the result of a finished game.
pub async fn score(State(st): State<AppState>, m: Member, Path((id, gid)): Path<(Uuid, Uuid)>, Json(b): Json<ScoreIn>) -> R<Json<Value>> {
    check_score(&b)?;
    let mut tx = begin_manage(&st, &m, id).await?;
    if game_status(&mut *tx, id, gid).await?.1 != "done" {
        return Err(e409("GAME_NOT_DONE", "Hasil dicatat setelah pertandingan selesai"));
    }
    sqlx::query("UPDATE rotation_games SET score_a = $2, score_b = $3 WHERE id = $1").bind(gid).bind(b.score_a).bind(b.score_b).execute(&mut *tx).await?;
    reply(tx, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn t(min: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 19, 19, 0, 0).unwrap() + Duration::minutes(min)
    }
    /// Player n arrived at minute n and has waited since minute `wait`.
    fn c(n: u128, eff: i32, wait: i64, gender: Option<char>, level: i16) -> Cand {
        Cand { id: Uuid::from_u128(n), eff, wait_since: t(wait), arrived: t(n as i64), gender, level }
    }
    fn q(mut v: Vec<Cand>) -> Vec<Cand> {
        order(&mut v);
        v
    }
    fn n(v: &[Uuid]) -> Vec<u128> {
        v.iter().map(|u| u.as_u128()).collect()
    }

    #[test]
    fn first_and_fourth_against_second_and_third() {
        let queue = q((1..=6).map(|i| c(i, 0, i as i64, None, 1)).collect());
        let (a, b) = pick(&queue, false, "any", "off").unwrap();
        assert_eq!((n(&a), n(&b)), (vec![1, 4], vec![2, 3]));
    }

    #[test]
    fn fewest_games_then_longest_wait_then_arrival() {
        // 5 and 6 have not played; 1..4 played once and finished together at minute 30.
        let queue = q(vec![c(1, 1, 30, None, 1), c(2, 1, 30, None, 1), c(3, 1, 30, None, 1), c(4, 1, 30, None, 1), c(5, 0, 5, None, 1), c(6, 0, 6, None, 1)]);
        let (a, b) = pick(&queue, false, "any", "off").unwrap();
        assert_eq!((n(&a), n(&b)), (vec![5, 2], vec![6, 1]));
    }

    #[test]
    fn singles_and_shortage() {
        let queue = q(vec![c(1, 0, 1, None, 1), c(2, 0, 2, None, 1), c(3, 0, 3, None, 1)]);
        let (a, b) = pick(&queue, true, "any", "off").unwrap();
        assert_eq!((n(&a), n(&b)), (vec![1], vec![2]));
        assert_eq!(pick(&queue, false, "any", "off").unwrap_err(), "Kurang 1 pemain yang menunggu");
    }

    #[test]
    fn mixed_doubles_one_man_one_woman_per_team() {
        let queue = q(vec![c(1, 0, 1, Some('M'), 1), c(2, 0, 2, Some('M'), 1), c(3, 0, 3, Some('M'), 1), c(4, 0, 4, Some('F'), 1), c(5, 0, 5, None, 1), c(6, 0, 6, Some('F'), 1)]);
        let (a, b) = pick(&queue, false, "mixed", "off").unwrap();
        assert_eq!((n(&a), n(&b)), (vec![1, 6], vec![2, 4]));
        assert_eq!(pick(&queue[..4], false, "mixed", "off").unwrap_err(), "Kurang 1 pemain putri yang menunggu");
        assert!(pick(&queue, false, "women", "off").is_err());
    }

    #[test]
    fn level_never_lets_more_games_jump_the_queue() {
        // Player 1 has 0 games (beginner); the rest have 1. An advanced player with 2 games must not be picked.
        let queue = q(vec![c(1, 0, 1, None, 1), c(2, 1, 2, None, 3), c(3, 1, 3, None, 1), c(4, 1, 4, None, 1), c(5, 1, 5, None, 1), c(6, 2, 6, None, 3)]);
        let (a, b) = pick(&queue, false, "any", "balanced").unwrap();
        let mut all = [n(&a), n(&b)].concat();
        all.sort();
        assert_eq!(all, vec![1, 3, 4, 5], "balanced keeps the three beginners with player 1, skips the advanced one");
        let (a, b) = pick(&queue, false, "any", "mixed").unwrap();
        let mut all = [n(&a), n(&b)].concat();
        all.sort();
        assert_eq!(all, vec![1, 2, 3, 4], "mixed brings in the advanced player of the same game count");
        // Teams by level: strongest + weakest against the middle two.
        assert_eq!(n(&a), vec![2, 4]);
        assert_eq!(n(&b), vec![1, 3]);
    }
}
