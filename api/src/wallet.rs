use crate::{
    auth::{Member, Role},
    error::*,
    notify::notify,
    payments, settle, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

async fn balance(db: &PgPool, user: Uuid) -> R<Json<Value>> {
    let b: i64 = sqlx::query_scalar("SELECT balance_idr FROM wallets WHERE user_id = $1").bind(user).fetch_one(db).await?;
    Ok(ok(json!({"balance_idr": b})))
}

async fn txns(db: &PgPool, user: Uuid, p: Page) -> R<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'amount_idr', amount_idr, 'txn_type', txn_type, 'join_request_id', join_request_id, \
           'note', note, 'created_by', created_by, 'created_at', created_at) \
         FROM wallet_txns WHERE user_id = $1 AND ($2::text IS NULL OR created_at < $2::timestamptz) ORDER BY created_at DESC LIMIT $3",
    )
    .bind(user)
    .bind(p.cursor())
    .bind(p.limit() + 1)
    .fetch_all(db)
    .await?;
    Ok(paged(rows, p.limit(), "created_at"))
}

pub async fn my_wallet(State(st): State<AppState>, m: Member) -> R<Json<Value>> {
    balance(&st.db, m.id).await
}
pub async fn my_txns(State(st): State<AppState>, m: Member, Query(p): Query<Page>) -> R<Json<Value>> {
    txns(&st.db, m.id, p).await
}
pub async fn user_wallet(State(st): State<AppState>, m: Member, Path(user): Path<Uuid>) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    balance(&st.db, user).await
}
pub async fn user_txns(State(st): State<AppState>, m: Member, Path(user): Path<Uuid>, Query(p): Query<Page>) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    txns(&st.db, user, p).await
}

#[derive(Deserialize)]
pub struct AmountIn {
    amount_idr: i64,
    note: Option<String>,
}

impl AmountIn {
    fn note(&self) -> R<&str> {
        self.note.as_deref().map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| invalid("note", "Alasan wajib diisi"))
    }
}

pub async fn topup(State(st): State<AppState>, m: Member, Json(b): Json<AmountIn>) -> R<(StatusCode, Json<Value>)> {
    let min: i64 = sqlx::query_scalar("SELECT min_topup_idr FROM settings").fetch_one(&st.db).await?;
    if b.amount_idr < min {
        return Err(invalid("amount_idr", &format!("Minimal top-up Rp {min}")));
    }
    // No ledger entry here: the wallet is credited only by the settlement webhook (AC-F6-02).
    let payment = payments::create_snap(&st, m.id, "topup", None, b.amount_idr, Utc::now() + Duration::hours(24)).await?;
    Ok((StatusCode::CREATED, ok(json!({"payment": payment}))))
}

/// Manual credit for cash received offline (DEC-005). Also settles the member's held seats.
pub async fn credit(State(st): State<AppState>, m: Member, Path(user): Path<Uuid>, Json(b): Json<AmountIn>) -> R<(StatusCode, Json<Value>)> {
    m.need(Role::Admin)?;
    if b.amount_idr <= 0 {
        return Err(invalid("amount_idr", "Jumlah harus lebih dari 0"));
    }
    let note = b.note()?;
    let mut tx = st.db.begin().await?;
    let held = settle::held(&mut *tx, user).await?;
    let (txn, _) = settle::ledger(&mut *tx, user, b.amount_idr, "manual_credit", None, None, Some(note), Some(m.id)).await?.ok_or_else(e404)?;
    notify(&mut *tx, user, "manual_credit", "Saldo ditambahkan admin", &format!("Dompetmu dikredit Rp {}.", b.amount_idr)).await?;
    for h in held {
        settle::settle(&mut *tx, h, false).await?;
    }
    let bal: i64 = sqlx::query_scalar("SELECT balance_idr FROM wallets WHERE user_id = $1").bind(user).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, ok(json!({"txn_id": txn, "amount_idr": b.amount_idr, "created_by": m.id, "balance_idr": bal}))))
}

/// Signed correction by a superadmin; the ledger itself is never edited (AC-F6-05).
pub async fn adjust(State(st): State<AppState>, m: Member, Path(user): Path<Uuid>, Json(b): Json<AmountIn>) -> R<(StatusCode, Json<Value>)> {
    m.need(Role::Superadmin)?;
    if b.amount_idr == 0 {
        return Err(invalid("amount_idr", "Jumlah tidak boleh 0"));
    }
    let note = b.note()?;
    let mut tx = st.db.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM wallets WHERE user_id = $1)").bind(user).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(e404());
    }
    let (txn, bal) = settle::ledger(&mut *tx, user, b.amount_idr, "adjustment", None, None, Some(note), Some(m.id))
        .await?
        .ok_or_else(|| e409("INSUFFICIENT_BALANCE", "Saldo akan menjadi negatif"))?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, ok(json!({"txn_id": txn, "balance_idr": bal}))))
}

#[derive(Deserialize)]
pub struct MembershipIn {
    month: NaiveDate,
}

/// Monthly membership bought from the wallet (DEC-013).
pub async fn membership(State(st): State<AppState>, m: Member, Json(b): Json<MembershipIn>) -> R<(StatusCode, Json<Value>)> {
    let mut tx = st.db.begin().await?;
    let (price, allowed): (Option<i64>, bool) = sqlx::query_as(
        "SELECT membership_price_idr, \
           $1::date IN (date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')::date, \
                        (date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') + interval '1 month')::date) FROM settings",
    )
    .bind(b.month)
    .fetch_one(&mut *tx)
    .await?;
    let price = price.ok_or_else(|| e409("NOT_FOR_SALE", "Keanggotaan belum dijual"))?;
    if !allowed {
        return Err(invalid("month", "Hanya bulan ini atau bulan depan"));
    }
    let owned: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND month = $2)").bind(m.id).bind(b.month).fetch_one(&mut *tx).await?;
    if owned {
        return Err(e409("ALREADY_MEMBER", "Keanggotaan bulan itu sudah dimiliki"));
    }
    let held = settle::held(&mut *tx, m.id).await?;
    let (txn, bal) = settle::ledger(&mut *tx, m.id, -price, "membership", None, None, None, None)
        .await?
        .ok_or_else(|| e409("INSUFFICIENT_BALANCE", "Saldo dompet tidak cukup"))?;
    sqlx::query("INSERT INTO memberships(user_id, month, price_idr, wallet_txn_id) VALUES ($1, $2, $3, $4)").bind(m.id).bind(b.month).bind(price).bind(txn).execute(&mut *tx).await?;
    // A seat already on hold in that month is now covered.
    for h in held {
        settle::settle(&mut *tx, h, false).await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, ok(json!({"month": b.month, "price_idr": price, "balance_idr": bal}))))
}

/// Voluntary shuttlecock donation from the wallet (DEC-014).
pub async fn donate(State(st): State<AppState>, m: Member, Json(b): Json<AmountIn>) -> R<(StatusCode, Json<Value>)> {
    if b.amount_idr <= 0 {
        return Err(invalid("amount_idr", "Jumlah harus lebih dari 0"));
    }
    let mut tx = st.db.begin().await?;
    let (txn, bal) = settle::ledger(&mut *tx, m.id, -b.amount_idr, "donation", None, None, None, None)
        .await?
        .ok_or_else(|| e409("INSUFFICIENT_BALANCE", "Saldo dompet tidak cukup"))?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, ok(json!({"txn_id": txn, "balance_idr": bal}))))
}
