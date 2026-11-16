use crate::{
    auth::{Ident, Member, Role},
    error::*,
    notify::notify,
    requests::{self, REQ_JSON},
    settle, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

/// Match object of API.md §3.2. Binds: $1 viewer user id, $2 viewer guest sid, $3 viewer is host or above.
/// Status is computed from the server clock, never stored (AC-F2-03).
const MATCH_JSON: &str = "jsonb_build_object('id', m.id, 'title', m.title, 'starts_at', m.starts_at, 'duration_hours', m.duration_hours, \
    'location_name', m.location_name, 'location_maps_url', m.location_maps_url, 'capacity', m.capacity, \
    'seats_taken', (SELECT count(*) FROM join_requests s WHERE s.match_id = m.id AND s.status IN ('awaiting_payment','confirmed')), \
    'match_type', m.match_type, 'racket_provided', m.racket_provided, 'shuttlecock_provided', m.shuttlecock_provided, \
    'equipment_notes', m.equipment_notes, 'price_idr', m.price_idr, \
    'court_cost_per_hour_idr', CASE WHEN $3 THEN m.court_cost_per_hour_idr END, \
    'status', CASE WHEN m.cancelled_at IS NOT NULL THEN 'cancelled' WHEN now() < m.starts_at THEN 'scheduled' \
        WHEN now() < m.starts_at + make_interval(hours => m.duration_hours) THEN 'ongoing' ELSE 'completed' END, \
    'host', jsonb_build_object('id', h.id, 'full_name', h.full_name), \
    'my_request', (SELECT jsonb_build_object('id', r.id, 'status', r.status, 'hold_expires_at', r.hold_expires_at) FROM join_requests r \
        WHERE r.match_id = m.id AND (r.user_id = $1 OR (r.user_id IS NULL AND r.guest_sid = $2)) ORDER BY r.created_at DESC LIMIT 1))";

const ENDED: &str = "m.starts_at + make_interval(hours => m.duration_hours) <= now()";

fn staff(who: &Ident) -> bool {
    matches!(who, Ident::Member(m) if m.role >= Role::Host)
}

#[derive(Deserialize)]
pub struct CalendarQ {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

pub async fn list(State(st): State<AppState>, who: Ident, Query(q): Query<CalendarQ>) -> R<Json<Value>> {
    let (user, sid) = who.keys();
    // greatest/least ignore NULL, so a missing bound falls back to the window edge (AC-F2-01).
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {MATCH_JSON} FROM matches m JOIN users h ON h.id = m.host_id \
         WHERE m.starts_at >= greatest($4::date::timestamptz, now() - interval '1 month') \
           AND m.starts_at <= least(($5::date + 1)::timestamptz, now() + interval '3 months') \
         ORDER BY m.starts_at"
    ))
    .bind(user)
    .bind(sid)
    .bind(staff(&who))
    .bind(q.from)
    .bind(q.to)
    .fetch_all(&st.db)
    .await?;
    Ok(ok(rows))
}

pub async fn detail(State(st): State<AppState>, who: Ident, Path(id): Path<Uuid>) -> R<Json<Value>> {
    let (user, sid) = who.keys();
    let mut v: Value = sqlx::query_scalar(&format!("SELECT {MATCH_JSON} FROM matches m JOIN users h ON h.id = m.host_id WHERE m.id = $4"))
        .bind(user)
        .bind(sid)
        .bind(staff(&who))
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    if let Ident::Member(m) = &who {
        let roster: Value = sqlx::query_scalar(
            "SELECT coalesce(jsonb_agg(jsonb_build_object('join_request_id', j.id, 'name', u.full_name, 'games_played', j.games_played) ORDER BY u.full_name), '[]') \
             FROM join_requests j JOIN users u ON u.id = j.user_id WHERE j.match_id = $1 AND j.status = 'confirmed'",
        )
        .bind(id)
        .fetch_one(&st.db)
        .await?;
        v["roster"] = roster;
        if m.role >= Role::Admin || v["host"]["id"].as_str() == Some(m.id.to_string().as_str()) {
            let reqs: Vec<Value> = sqlx::query_scalar(&format!("SELECT {REQ_JSON} WHERE j.match_id = $1 ORDER BY j.created_at")).bind(id).fetch_all(&st.db).await?;
            v["requests"] = json!(reqs);
            v["can_manage"] = json!(true);
        }
    }
    Ok(ok(v))
}

#[derive(Deserialize)]
pub struct MatchIn {
    title: Option<String>,
    location_name: Option<String>,
    location_maps_url: Option<String>,
    starts_at: Option<DateTime<Utc>>,
    duration_hours: Option<i32>,
    capacity: Option<i32>,
    match_type: Option<String>,
    racket_provided: Option<bool>,
    shuttlecock_provided: Option<bool>,
    equipment_notes: Option<String>,
    court_cost_per_hour_idr: Option<i64>,
    price_idr: Option<i64>,
    host_id: Option<Uuid>,
}

/// AC-F3-01. With `creating`, every required field must be present; otherwise only given fields are checked.
fn validate(b: &MatchIn, creating: bool) -> R<()> {
    let mut f = Map::new();
    let mut bad = |k: &str, msg: &str| {
        f.insert(k.into(), msg.into());
    };
    let text = |v: &Option<String>| v.as_deref().map(|s| !s.trim().is_empty());
    match text(&b.title) {
        Some(false) => bad("title", "Wajib diisi"),
        None if creating => bad("title", "Wajib diisi"),
        _ => {}
    }
    match text(&b.location_name) {
        Some(false) => bad("location_name", "Wajib diisi"),
        None if creating => bad("location_name", "Wajib diisi"),
        _ => {}
    }
    match b.location_maps_url.as_deref().map(|u| u.starts_with("https://")) {
        Some(false) => bad("location_maps_url", "Harus tautan https"),
        None if creating => bad("location_maps_url", "Wajib diisi"),
        _ => {}
    }
    match b.starts_at.map(|t| t > Utc::now()) {
        Some(false) => bad("starts_at", "Harus di masa depan"),
        None if creating => bad("starts_at", "Wajib diisi"),
        _ => {}
    }
    match b.duration_hours.map(|d| (1..=12).contains(&d)) {
        Some(false) => bad("duration_hours", "1 sampai 12 jam"),
        None if creating => bad("duration_hours", "Wajib diisi"),
        _ => {}
    }
    match b.capacity.map(|c| c >= 1) {
        Some(false) => bad("capacity", "Minimal 1"),
        None if creating => bad("capacity", "Wajib diisi"),
        _ => {}
    }
    match b.match_type.as_deref().map(|t| t == "beginner_friendly" || t == "intermediate") {
        Some(false) => bad("match_type", "Tipe tidak dikenal"),
        None if creating => bad("match_type", "Wajib diisi"),
        _ => {}
    }
    match b.price_idr.map(|p| p >= 0) {
        Some(false) => bad("price_idr", "Tidak boleh negatif"),
        None if creating => bad("price_idr", "Wajib diisi"),
        _ => {}
    }
    if b.court_cost_per_hour_idr.is_some_and(|c| c < 0) {
        bad("court_cost_per_hour_idr", "Tidak boleh negatif");
    }
    if creating && b.racket_provided.is_none() {
        bad("racket_provided", "Wajib diisi");
    }
    if creating && b.shuttlecock_provided.is_none() {
        bad("shuttlecock_provided", "Wajib diisi");
    }
    if f.is_empty() { Ok(()) } else { Err(e422(Value::Object(f))) }
}

/// A host may only name themselves; admins may assign anyone with role host or above (AC-F3-03).
async fn check_host(st: &AppState, m: &Member, host: Uuid) -> R<()> {
    if host == m.id {
        return Ok(());
    }
    m.need(Role::Admin)?;
    let role: Option<String> = sqlx::query_scalar("SELECT role::text FROM users WHERE id = $1 AND status = 'active'").bind(host).fetch_optional(&st.db).await?;
    match role.as_deref() {
        Some("member") | None => Err(invalid("host_id", "Host harus pengguna aktif dengan peran host atau lebih tinggi")),
        _ => Ok(()),
    }
}

pub async fn create(State(st): State<AppState>, m: Member, Json(b): Json<MatchIn>) -> R<(StatusCode, Json<Value>)> {
    m.need(Role::Host)?;
    validate(&b, true)?;
    let host = b.host_id.unwrap_or(m.id);
    check_host(&st, &m, host).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO matches(host_id, created_by, title, location_name, location_maps_url, starts_at, duration_hours, capacity, \
           match_type, racket_provided, shuttlecock_provided, equipment_notes, court_cost_per_hour_idr, price_idr) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::match_type, $10, $11, nullif($12, ''), $13, $14) RETURNING id",
    )
    .bind(host)
    .bind(m.id)
    .bind(b.title.as_deref().map(str::trim))
    .bind(b.location_name.as_deref().map(str::trim))
    .bind(&b.location_maps_url)
    .bind(b.starts_at)
    .bind(b.duration_hours)
    .bind(b.capacity)
    .bind(&b.match_type)
    .bind(b.racket_provided)
    .bind(b.shuttlecock_provided)
    .bind(b.equipment_notes.as_deref().map(str::trim))
    .bind(b.court_cost_per_hour_idr.unwrap_or(0))
    .bind(b.price_idr)
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, ok(json!({"id": id, "status": "scheduled", "host_id": host}))))
}

pub async fn update(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>, Json(b): Json<MatchIn>) -> R<Json<Value>> {
    m.need(Role::Host)?;
    validate(&b, false)?;
    if let Some(host) = b.host_id {
        check_host(&st, &m, host).await?;
    }
    let mut tx = st.db.begin().await?;
    let (host, price, editable): (Uuid, i64, bool) =
        sqlx::query_as("SELECT host_id, price_idr, cancelled_at IS NULL AND starts_at > now() FROM matches WHERE id = $1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await?;
    if m.role < Role::Admin && host != m.id {
        return Err(e403("FORBIDDEN", "Bukan pertandingan Anda"));
    }
    if !editable {
        return Err(e409("MATCH_NOT_OPEN", "Pertandingan yang sudah dimulai atau dibatalkan tidak bisa diubah"));
    }
    let taken: i64 = sqlx::query_scalar("SELECT count(*) FROM join_requests WHERE match_id = $1 AND status IN ('awaiting_payment','confirmed')").bind(id).fetch_one(&mut *tx).await?;
    if b.capacity.is_some_and(|c| (c as i64) < taken) {
        return Err(e409("CAPACITY_BELOW_TAKEN", "Kapasitas di bawah jumlah kursi terisi"));
    }
    if taken > 0 && b.price_idr.is_some_and(|p| p != price) {
        return Err(e409("PRICE_LOCKED", "Harga tidak bisa diubah setelah ada kursi terisi"));
    }
    // An empty equipment_notes clears it.
    sqlx::query(
        "UPDATE matches SET host_id = coalesce($2, host_id), title = coalesce($3, title), location_name = coalesce($4, location_name), \
           location_maps_url = coalesce($5, location_maps_url), starts_at = coalesce($6, starts_at), duration_hours = coalesce($7, duration_hours), \
           capacity = coalesce($8, capacity), match_type = coalesce($9::match_type, match_type), racket_provided = coalesce($10, racket_provided), \
           shuttlecock_provided = coalesce($11, shuttlecock_provided), equipment_notes = nullif(coalesce($12, equipment_notes), ''), \
           court_cost_per_hour_idr = coalesce($13, court_cost_per_hour_idr), price_idr = coalesce($14, price_idr) WHERE id = $1",
    )
    .bind(id)
    .bind(b.host_id)
    .bind(b.title.as_deref().map(str::trim))
    .bind(b.location_name.as_deref().map(str::trim))
    .bind(&b.location_maps_url)
    .bind(b.starts_at)
    .bind(b.duration_hours)
    .bind(b.capacity)
    .bind(&b.match_type)
    .bind(b.racket_provided)
    .bind(b.shuttlecock_provided)
    .bind(b.equipment_notes.as_deref().map(str::trim))
    .bind(b.court_cost_per_hour_idr)
    .bind(b.price_idr)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ok(json!({"id": id})))
}

/// Superadmin cancels a match: refund confirmed players to wallet, restore used rewards,
/// close open requests, notify everyone with an account (DEC-016).
pub async fn cancel(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<Json<Value>> {
    m.need(Role::Superadmin)?;
    let mut tx = st.db.begin().await?;
    let (title, cancelled, ended): (String, bool, bool) =
        sqlx::query_as(&format!("SELECT m.title, m.cancelled_at IS NOT NULL, {ENDED} FROM matches m WHERE m.id = $1 FOR UPDATE")).bind(id).fetch_one(&mut *tx).await?;
    if cancelled || ended {
        return Err(e409("MATCH_NOT_OPEN", "Pertandingan sudah selesai atau sudah dibatalkan"));
    }
    sqlx::query("UPDATE matches SET cancelled_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    let open: Vec<(Uuid, Option<Uuid>, String, i64)> = sqlx::query_as(
        "SELECT id, user_id, status::text, paid_idr FROM join_requests WHERE match_id = $1 AND status IN ('pending','awaiting_payment','confirmed') FOR UPDATE",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    for (req, user, status, paid) in &open {
        let Some(user) = *user else { continue };
        if status == "confirmed" && *paid > 0 {
            settle::ledger(&mut *tx, user, *paid, "refund", None, Some(*req), Some("Pertandingan dibatalkan"), Some(m.id)).await?.ok_or_else(|| internal("wallet missing for refund"))?;
        }
        notify(&mut *tx, user, "match_cancelled", "Pertandingan dibatalkan", &format!("{title} dibatalkan. Biaya yang sudah dibayar dikembalikan ke dompet.")).await?;
    }
    sqlx::query("UPDATE rewards SET redeemed_request_id = NULL WHERE redeemed_request_id IN (SELECT id FROM join_requests WHERE match_id = $1)").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE join_requests SET status = 'cancelled', hold_expires_at = NULL, updated_at = now() WHERE match_id = $1 AND status IN ('pending','awaiting_payment','confirmed')")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"id": id, "status": "cancelled", "refunded": open.iter().filter(|o| o.2 == "confirmed" && o.3 > 0).count()})))
}

#[derive(Deserialize)]
pub struct GameIn {
    join_request_id: Uuid,
    games_played: i32,
}

pub async fn games(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>, Json(b): Json<Vec<GameIn>>) -> R<StatusCode> {
    m.need(Role::Host)?;
    let mut tx = st.db.begin().await?;
    requests::can_manage(&mut *tx, id, &m).await?;
    let started: bool = sqlx::query_scalar("SELECT starts_at <= now() AND cancelled_at IS NULL FROM matches WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
    if !started {
        return Err(e409("MATCH_NOT_STARTED", "Jumlah game diisi setelah pertandingan dimulai"));
    }
    for g in &b {
        if g.games_played < 0 {
            return Err(invalid("games_played", "Tidak boleh negatif"));
        }
        sqlx::query("UPDATE join_requests SET games_played = $3 WHERE id = $1 AND match_id = $2 AND status = 'confirmed'")
            .bind(g.join_request_id)
            .bind(id)
            .bind(g.games_played)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct HistoryQ {
    scope: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

/// Members: matches they attended (DEC-012), no time limit. Admins with scope=all: every match of the last 3 months.
pub async fn history(State(st): State<AppState>, m: Member, Query(q): Query<HistoryQ>) -> R<Json<Value>> {
    let all = q.scope.as_deref() == Some("all");
    let page = Page { cursor: q.cursor, limit: q.limit };
    if all {
        m.need(Role::Admin)?;
    }
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {MATCH_JSON} || jsonb_build_object( \
           'players', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', u.full_name, 'games_played', j.games_played) ORDER BY u.full_name), '[]') \
              FROM join_requests j JOIN users u ON u.id = j.user_id WHERE j.match_id = m.id AND j.status = 'confirmed'), \
           'media_count', (SELECT count(*) FROM match_media mm WHERE mm.match_id = m.id)) \
         FROM matches m JOIN users h ON h.id = m.host_id \
         WHERE m.cancelled_at IS NULL AND {ENDED} \
           AND (($4 AND m.starts_at >= now() - interval '3 months') \
             OR (NOT $4 AND EXISTS (SELECT 1 FROM join_requests a WHERE a.match_id = m.id AND a.user_id = $1 AND a.status = 'confirmed'))) \
           AND ($5::text IS NULL OR m.starts_at < $5::timestamptz) \
         ORDER BY m.starts_at DESC LIMIT $6"
    ))
    .bind(m.id)
    .bind(None::<Uuid>)
    .bind(m.role >= Role::Host)
    .bind(all)
    .bind(page.cursor())
    .bind(page.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    Ok(paged(rows, page.limit(), "starts_at"))
}
