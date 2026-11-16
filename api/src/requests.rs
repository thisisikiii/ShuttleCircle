use crate::{
    auth::{Ident, Member, Role},
    error::*,
    notify::notify,
    payments, settle, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

/// Join request object of API.md §3.3. Append a WHERE clause.
pub const REQ_JSON: &str = "jsonb_build_object('id', j.id, 'match_id', j.match_id, 'match_title', m.title, \
    'match_starts_at', m.starts_at, 'price_idr', m.price_idr, \
    'player', jsonb_build_object('kind', CASE WHEN j.user_id IS NULL THEN 'guest' ELSE 'member' END, \
        'name', coalesce(u.full_name, j.guest_nickname), 'user_id', j.user_id), \
    'status', j.status, 'payment_method', j.payment_method, 'hold_expires_at', j.hold_expires_at, \
    'conversion_required', (j.status = 'awaiting_payment' AND j.user_id IS NULL), \
    'games_played', j.games_played, 'note', j.note, 'created_at', j.created_at) \
    FROM join_requests j JOIN matches m ON m.id = j.match_id LEFT JOIN users u ON u.id = j.user_id";

const OPEN: &str = "('pending','awaiting_payment','confirmed')";

async fn one(c: &mut PgConnection, id: Uuid) -> R<Value> {
    Ok(sqlx::query_scalar(&format!("SELECT {REQ_JSON} WHERE j.id = $1")).bind(id).fetch_one(&mut *c).await?)
}

/// Admins manage every match; a host only their own.
pub async fn can_manage(c: &mut PgConnection, match_id: Uuid, m: &Member) -> R<()> {
    let host: Uuid = sqlx::query_scalar("SELECT host_id FROM matches WHERE id = $1").bind(match_id).fetch_one(&mut *c).await?;
    if m.role >= Role::Admin || host == m.id { Ok(()) } else { Err(e403("FORBIDDEN", "Bukan pertandingan Anda")) }
}

/// Attaches a guest's requests to the account they just created or signed into (AC-F1-05).
pub async fn link_guest(c: &mut PgConnection, user: Uuid, sid: Uuid) -> R<()> {
    // The member may already have their own open request for the same match: keep that one.
    sqlx::query(&format!(
        "UPDATE join_requests g SET status = 'cancelled', hold_expires_at = NULL, updated_at = now() \
         WHERE g.guest_sid = $2 AND g.user_id IS NULL AND g.status IN {OPEN} \
           AND EXISTS (SELECT 1 FROM join_requests o WHERE o.match_id = g.match_id AND o.user_id = $1 AND o.status IN {OPEN})"
    ))
    .bind(user)
    .bind(sid)
    .execute(&mut *c)
    .await?;
    sqlx::query("UPDATE join_requests SET user_id = $1, updated_at = now() WHERE guest_sid = $2 AND user_id IS NULL").bind(user).bind(sid).execute(&mut *c).await?;
    settle::settle_held(c, user).await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct NoteIn {
    note: Option<String>,
}

pub async fn create(State(st): State<AppState>, who: Ident, Path(match_id): Path<Uuid>, Json(b): Json<NoteIn>) -> R<(StatusCode, Json<Value>)> {
    let mut tx = st.db.begin().await?;
    let open: bool = sqlx::query_scalar("SELECT cancelled_at IS NULL AND starts_at > now() FROM matches WHERE id = $1").bind(match_id).fetch_one(&mut *tx).await?;
    if !open {
        return Err(e409("MATCH_NOT_OPEN", "Pertandingan sudah tidak menerima permintaan"));
    }
    let (user, sid) = who.keys();
    let nickname = match &who {
        Ident::Guest { nickname, .. } => Some(nickname.as_str()),
        Ident::Member(_) => None,
    };
    if let Some(sid) = sid {
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM join_requests WHERE guest_sid = $1 AND user_id IS NULL AND status IN {OPEN}"))
            .bind(sid)
            .fetch_one(&mut *tx)
            .await?;
        if n >= 3 {
            return Err(e409("GUEST_LIMIT", "Tamu maksimal 3 permintaan aktif. Buat akun untuk lebih banyak."));
        }
    }
    let note = b.note.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let id: Uuid = sqlx::query_scalar("INSERT INTO join_requests(match_id, user_id, guest_sid, guest_nickname, note) VALUES ($1, $2, $3, $4, $5) RETURNING id")
        .bind(match_id)
        .bind(user)
        .bind(sid)
        .bind(nickname)
        .bind(note)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => e409("DUPLICATE_REQUEST", "Kamu sudah punya permintaan untuk pertandingan ini"),
            _ => e.into(),
        })?;
    let v = one(&mut *tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, ok(v)))
}

pub async fn mine(State(st): State<AppState>, who: Ident) -> R<Json<Value>> {
    let (user, sid) = who.keys();
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {REQ_JSON} WHERE (j.user_id = $1 OR (j.user_id IS NULL AND j.guest_sid = $2)) ORDER BY j.created_at DESC LIMIT 100"
    ))
    .bind(user)
    .bind(sid)
    .fetch_all(&st.db)
    .await?;
    Ok(ok(rows))
}

#[derive(Deserialize)]
pub struct QueueQ {
    status: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

pub async fn queue(State(st): State<AppState>, m: Member, Query(q): Query<QueueQ>) -> R<Json<Value>> {
    m.need(Role::Host)?;
    let page = Page { cursor: q.cursor, limit: q.limit };
    let status = q.status.as_deref().unwrap_or("pending");
    if !["pending", "awaiting_payment", "confirmed", "rejected", "cancelled", "expired"].contains(&status) {
        return Err(invalid("status", "Status tidak dikenal"));
    }
    // Oldest first: the queue is worked from the top.
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {REQ_JSON} WHERE j.status = $1::request_status AND ($2 OR m.host_id = $3) \
           AND m.cancelled_at IS NULL AND m.starts_at > now() \
           AND ($4::text IS NULL OR j.created_at > $4::timestamptz) ORDER BY j.created_at LIMIT $5"
    ))
    .bind(status)
    .bind(m.role >= Role::Admin)
    .bind(m.id)
    .bind(page.cursor())
    .bind(page.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    Ok(paged(rows, page.limit(), "created_at"))
}

pub async fn approve(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<Json<Value>> {
    m.need(Role::Host)?;
    let mut tx = st.db.begin().await?;
    let match_id: Uuid = sqlx::query_scalar("SELECT match_id FROM join_requests WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
    // Lock the match first: this serialises every approval for it, so the seat count below is exact.
    let (host, capacity, open, title): (Uuid, i32, bool, String) =
        sqlx::query_as("SELECT host_id, capacity, cancelled_at IS NULL AND starts_at > now(), title FROM matches WHERE id = $1 FOR UPDATE")
            .bind(match_id)
            .fetch_one(&mut *tx)
            .await?;
    if m.role < Role::Admin && host != m.id {
        return Err(e403("FORBIDDEN", "Bukan pertandingan Anda"));
    }
    let (status, user): (String, Option<Uuid>) =
        sqlx::query_as("SELECT status::text, user_id FROM join_requests WHERE id = $1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await?;
    if status != "pending" && status != "expired" {
        return Err(e409("ALREADY_PROCESSED", "Permintaan sudah diproses"));
    }
    if !open {
        return Err(e409("MATCH_NOT_OPEN", "Pertandingan sudah dimulai atau dibatalkan"));
    }
    let taken: i64 = sqlx::query_scalar("SELECT count(*) FROM join_requests WHERE match_id = $1 AND status IN ('awaiting_payment','confirmed')")
        .bind(match_id)
        .fetch_one(&mut *tx)
        .await?;
    if taken >= capacity as i64 {
        return Err(e409("MATCH_FULL", "Kursi sudah penuh"));
    }
    // DEC-002 / DEC-009: the 30-minute hold starts now, for members and guests alike.
    // Re-approving an expired request can collide with a newer open request: the unique index turns that into 409.
    sqlx::query("UPDATE join_requests SET status = 'awaiting_payment', hold_expires_at = now() + interval '30 minutes', decided_by = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(m.id)
        .execute(&mut *tx)
        .await?;
    if !settle::settle(&mut *tx, id, false).await? {
        if let Some(user) = user {
            notify(&mut *tx, user, "request_approved", "Permintaan disetujui", &format!("Bayar dalam 30 menit untuk mengamankan kursi di {title}.")).await?;
        }
    }
    let v = one(&mut *tx, id).await?;
    tx.commit().await?;
    Ok(ok(v))
}

pub async fn reject(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<Json<Value>> {
    m.need(Role::Host)?;
    let mut tx = st.db.begin().await?;
    let (match_id, status, user, title): (Uuid, String, Option<Uuid>, String) = sqlx::query_as(
        "SELECT j.match_id, j.status::text, j.user_id, m.title FROM join_requests j JOIN matches m ON m.id = j.match_id WHERE j.id = $1 FOR UPDATE OF j",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    can_manage(&mut *tx, match_id, &m).await?;
    if status != "pending" {
        return Err(e409("ALREADY_PROCESSED", "Permintaan sudah diproses"));
    }
    sqlx::query("UPDATE join_requests SET status = 'rejected', decided_by = $2, updated_at = now() WHERE id = $1").bind(id).bind(m.id).execute(&mut *tx).await?;
    if let Some(user) = user {
        notify(&mut *tx, user, "request_rejected", "Permintaan ditolak", &format!("Permintaan gabung ke {title} tidak disetujui.")).await?;
    }
    let v = one(&mut *tx, id).await?;
    tx.commit().await?;
    Ok(ok(v))
}

/// Locks the caller's own request and returns (status, price, hold deadline).
async fn own(c: &mut PgConnection, id: Uuid, who: &Ident) -> R<(String, i64, Option<DateTime<Utc>>)> {
    let (user, sid) = who.keys();
    let row: Option<(String, i64, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT j.status::text, m.price_idr, j.hold_expires_at FROM join_requests j JOIN matches m ON m.id = j.match_id \
         WHERE j.id = $1 AND (j.user_id = $2 OR (j.user_id IS NULL AND j.guest_sid = $3)) FOR UPDATE OF j",
    )
    .bind(id)
    .bind(user)
    .bind(sid)
    .fetch_optional(&mut *c)
    .await?;
    row.ok_or_else(e404)
}

pub async fn cancel(State(st): State<AppState>, who: Ident, Path(id): Path<Uuid>) -> R<Json<Value>> {
    let mut tx = st.db.begin().await?;
    let (status, ..) = own(&mut *tx, id, &who).await?;
    if status != "pending" && status != "awaiting_payment" {
        return Err(e409("ALREADY_PROCESSED", "Permintaan tidak bisa dibatalkan"));
    }
    sqlx::query("UPDATE join_requests SET status = 'cancelled', hold_expires_at = NULL, updated_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    let v = one(&mut *tx, id).await?;
    tx.commit().await?;
    Ok(ok(v))
}

pub async fn pay(State(st): State<AppState>, who: Ident, Path(id): Path<Uuid>) -> R<Json<Value>> {
    let mut tx = st.db.begin().await?;
    let (status, price, hold) = own(&mut *tx, id, &who).await?;
    let user = match &who {
        Ident::Member(m) => m.id,
        Ident::Guest { .. } => return Err(e403("CONVERSION_REQUIRED", "Buat akun dulu untuk membayar")),
    };
    let hold = hold.filter(|h| status == "awaiting_payment" && *h > Utc::now()).ok_or_else(|| e409("HOLD_EXPIRED", "Waktu pembayaran sudah habis"))?;
    // The wallet may have been credited since approval.
    if settle::settle(&mut *tx, id, false).await? {
        tx.commit().await?;
        return Ok(ok(json!({"status": "confirmed"})));
    }
    let existing: Option<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'amount_idr', amount_idr, 'snap_token', snap_token, 'redirect_url', redirect_url, 'expires_at', expires_at) \
         FROM payments WHERE join_request_id = $1 AND status = 'pending' AND snap_token IS NOT NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    let payment = match existing {
        Some(p) => p,
        None => payments::create_snap(&st, user, "match", Some(id), price, hold).await?,
    };
    Ok(ok(json!({"status": "awaiting_payment", "payment": payment})))
}
