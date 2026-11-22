//! Manual payment (FR-22, DEC-024): members pay by QRIS, e-wallet or bank transfer to the club's
//! accounts (set by a superadmin in Settings), then claim it; an admin confirms the claim, which
//! credits the wallet and settles held seats. Account details live only in the database.

use crate::{
    auth::{Member, Role},
    error::*,
    notify::notify,
    wallet, AppState,
};
use axum::{
    extract::{Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

const QRIS_MAX: usize = 3 * 1024 * 1024;

/// What a member needs to pay: accounts, holder name and whether a QRIS image is set.
pub async fn info(State(st): State<AppState>, _m: Member) -> R<Json<Value>> {
    let v: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('qris', pay_qris_path IS NOT NULL, 'holder', pay_holder, 'ewallet_number', pay_ewallet_number, \
           'ewallet_names', pay_ewallet_names, 'banks', pay_banks) FROM settings",
    )
    .fetch_one(&st.db)
    .await?;
    Ok(ok(v))
}

pub async fn qris(State(st): State<AppState>, _m: Member) -> R<impl IntoResponse> {
    let path: Option<String> = sqlx::query_scalar("SELECT pay_qris_path FROM settings").fetch_one(&st.db).await?;
    let path = path.ok_or_else(e404)?;
    let bytes = tokio::fs::read(format!("{}/{path}", st.cfg.media_dir)).await.map_err(|_| e404())?;
    let mime = infer::get(&bytes).map(|t| t.mime_type()).unwrap_or("application/octet-stream");
    Ok(([(header::CONTENT_TYPE, mime.to_string()), (header::CACHE_CONTROL, "private, max-age=300".to_string())], bytes))
}

/// Superadmin replaces the QRIS image (JPEG, PNG or WebP, at most 3 MB).
pub async fn upload_qris(State(st): State<AppState>, m: Member, mut mp: Multipart) -> R<Json<Value>> {
    m.need(Role::Superadmin)?;
    let bad = |_| invalid("file", "Unggahan tidak terbaca");
    let field = mp.next_field().await.map_err(bad)?.ok_or_else(|| invalid("file", "Berkas wajib diisi"))?;
    let bytes = field.bytes().await.map_err(bad)?;
    // Type comes from the bytes, never the file name.
    let ext = match infer::get(&bytes).map(|t| t.mime_type()) {
        Some("image/jpeg") => "jpg",
        Some("image/png") => "png",
        Some("image/webp") => "webp",
        _ => return Err(invalid("file", "Gambar JPEG, PNG atau WebP")),
    };
    if bytes.len() > QRIS_MAX {
        return Err(invalid("file", "Maksimal 3 MB"));
    }
    let name = format!("qris-{}.{ext}", Uuid::new_v4());
    tokio::fs::write(format!("{}/{name}", st.cfg.media_dir), &bytes).await.map_err(internal)?;
    let old: Option<String> = sqlx::query_scalar("SELECT pay_qris_path FROM settings").fetch_one(&st.db).await?;
    sqlx::query("UPDATE settings SET pay_qris_path = $1").bind(&name).execute(&st.db).await?;
    if let Some(old) = old {
        let _ = tokio::fs::remove_file(format!("{}/{old}", st.cfg.media_dir)).await;
    }
    Ok(ok(json!({"qris": true})))
}

#[derive(Deserialize)]
pub struct ClaimIn {
    amount_idr: i64,
    method: String,
    join_request_id: Option<Uuid>,
    note: Option<String>,
}

/// A member says they have paid. Admins are notified and confirm or reject it.
pub async fn claim(State(st): State<AppState>, m: Member, Json(b): Json<ClaimIn>) -> R<(StatusCode, Json<Value>)> {
    if b.amount_idr <= 0 {
        return Err(invalid("amount_idr", "Jumlah harus lebih dari 0"));
    }
    let method = b.method.trim();
    if method.is_empty() || method.len() > 40 {
        return Err(invalid("method", "Pilih cara bayar"));
    }
    let note = b.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.len() > 200) {
        return Err(invalid("note", "Maksimal 200 karakter"));
    }
    let mut tx = st.db.begin().await?;
    if let Some(jr) = b.join_request_id {
        let mine: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM join_requests WHERE id = $1 AND user_id = $2)").bind(jr).bind(m.id).fetch_one(&mut *tx).await?;
        if !mine {
            return Err(invalid("join_request_id", "Bukan permintaanmu"));
        }
    }
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_claims WHERE user_id = $1 AND status = 'pending'").bind(m.id).fetch_one(&mut *tx).await?;
    if pending >= 5 {
        return Err(e409("TOO_MANY_CLAIMS", "Masih ada 5 konfirmasi yang menunggu admin"));
    }
    let id: Uuid = sqlx::query_scalar("INSERT INTO payment_claims(user_id, join_request_id, amount_idr, method, note) VALUES ($1, $2, $3, $4, $5) RETURNING id")
        .bind(m.id)
        .bind(b.join_request_id)
        .bind(b.amount_idr)
        .bind(method)
        .bind(note)
        .fetch_one(&mut *tx)
        .await?;
    let (name,): (String,) = sqlx::query_as("SELECT full_name FROM users WHERE id = $1").bind(m.id).fetch_one(&mut *tx).await?;
    let admins: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE role IN ('admin','superadmin') AND status = 'active'").fetch_all(&mut *tx).await?;
    for a in admins {
        notify(&mut *tx, a, "payment_claim", "Konfirmasi pembayaran", &format!("{name} membayar Rp {} lewat {method}. Cek mutasi lalu konfirmasi di Admin > Pembayaran.", b.amount_idr)).await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, ok(json!({"id": id, "status": "pending"}))))
}

const CLAIM_JSON: &str = "jsonb_build_object('id', c.id, 'user', jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email), \
    'join_request_id', c.join_request_id, 'match_title', m.title, 'amount_idr', c.amount_idr, 'method', c.method, 'note', c.note, \
    'status', c.status, 'created_at', c.created_at, 'decided_at', c.decided_at) \
    FROM payment_claims c JOIN users u ON u.id = c.user_id LEFT JOIN join_requests j ON j.id = c.join_request_id LEFT JOIN matches m ON m.id = j.match_id";

#[derive(Deserialize)]
pub struct ClaimsQ {
    status: Option<String>,
}

/// Admins list claims (default: pending); members list their own.
pub async fn claims(State(st): State<AppState>, m: Member, Query(q): Query<ClaimsQ>) -> R<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT {CLAIM_JSON} WHERE ($1 OR c.user_id = $2) AND ($3::text IS NULL OR c.status = $3::claim_status) ORDER BY c.created_at DESC LIMIT 100"
    ))
    .bind(m.role >= Role::Admin)
    .bind(m.id)
    .bind(match q.status.as_deref() {
        Some("all") => None,
        Some(s) if ["pending", "confirmed", "rejected"].contains(&s) => Some(s),
        Some(_) => return Err(invalid("status", "Status tidak dikenal")),
        None if m.role >= Role::Admin => Some("pending"),
        None => None,
    })
    .fetch_all(&st.db)
    .await?;
    Ok(ok(rows))
}

async fn decide(st: &AppState, m: &Member, id: Uuid, confirm: bool) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    let mut tx = st.db.begin().await?;
    let (user, amount, method, status): (Uuid, i64, String, String) =
        sqlx::query_as("SELECT user_id, amount_idr, method, status::text FROM payment_claims WHERE id = $1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await?;
    if status != "pending" {
        return Err(e409("ALREADY_PROCESSED", "Konfirmasi ini sudah diproses"));
    }
    let txn = if confirm {
        Some(wallet::credit_in(&mut *tx, user, amount, &format!("Pembayaran {method} dikonfirmasi"), m.id).await?.0)
    } else {
        notify(&mut *tx, user, "payment_rejected", "Pembayaran belum diterima", &format!("Pembayaran Rp {amount} lewat {method} belum ditemukan. Hubungi admin.")).await?;
        None
    };
    sqlx::query("UPDATE payment_claims SET status = $2::claim_status, decided_by = $3, decided_at = now(), wallet_txn_id = $4 WHERE id = $1")
        .bind(id)
        .bind(if confirm { "confirmed" } else { "rejected" })
        .bind(m.id)
        .bind(txn)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"id": id, "status": if confirm { "confirmed" } else { "rejected" }})))
}

pub async fn confirm(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<Json<Value>> {
    decide(&st, &m, id, true).await
}

pub async fn reject(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<Json<Value>> {
    decide(&st, &m, id, false).await
}
