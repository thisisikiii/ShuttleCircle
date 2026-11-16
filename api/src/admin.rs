use crate::{
    auth::{Member, Role},
    error::*,
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct UsersQ {
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

pub async fn users(State(st): State<AppState>, m: Member, Query(q): Query<UsersQ>) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    let page = Page { cursor: q.cursor, limit: q.limit };
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', u.id, 'email', u.email, 'full_name', u.full_name, 'role', u.role, 'status', u.status, \
           'wallet_balance_idr', w.balance_idr, 'created_at', u.created_at) \
         FROM users u JOIN wallets w ON w.user_id = u.id \
         WHERE ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%') \
           AND ($2::text IS NULL OR u.created_at < $2::timestamptz) ORDER BY u.created_at DESC LIMIT $3",
    )
    .bind(q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(page.cursor())
    .bind(page.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    Ok(paged(rows, page.limit(), "created_at"))
}

#[derive(Deserialize)]
pub struct UserIn {
    role: Option<String>,
    status: Option<String>,
}

pub async fn update_user(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>, Json(b): Json<UserIn>) -> R<StatusCode> {
    m.need(Role::Superadmin)?;
    if id == m.id {
        return Err(e409("SELF_CHANGE", "Tidak bisa mengubah peran atau status sendiri"));
    }
    if b.role.as_deref().is_some_and(|r| Role::parse(r).is_none()) {
        return Err(invalid("role", "Peran tidak dikenal"));
    }
    if b.status.as_deref().is_some_and(|s| s != "active" && s != "suspended") {
        return Err(invalid("status", "Status tidak dikenal"));
    }
    let mut tx = st.db.begin().await?;
    let n = sqlx::query("UPDATE users SET role = coalesce($2::user_role, role), status = coalesce($3::user_status, status) WHERE id = $1")
        .bind(id)
        .bind(&b.role)
        .bind(&b.status)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(e404());
    }
    // New role or suspension applies at the next refresh; ending sessions makes that immediate for suspension.
    if b.status.as_deref() == Some("suspended") {
        sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct RangeQ {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

/// AC-F10-01. Dates are Asia/Jakarta calendar days, inclusive; default is the current month to date.
pub async fn finance(State(st): State<AppState>, m: Member, Query(q): Query<RangeQ>) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    let v: Value = sqlx::query_scalar(
        "WITH d AS (SELECT coalesce($1::date, date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')::date) AS d1, \
                           coalesce($2::date, (now() AT TIME ZONE 'Asia/Jakarta')::date) AS d2), \
              r AS (SELECT d1, d2, d1::timestamp AT TIME ZONE 'Asia/Jakarta' AS a, (d2 + 1)::timestamp AT TIME ZONE 'Asia/Jakarta' AS b FROM d), \
              t AS (SELECT txn_type, sum(amount_idr) AS s FROM wallet_txns, r WHERE created_at >= r.a AND created_at < r.b GROUP BY 1) \
         SELECT jsonb_build_object( \
           'from', r.d1, 'to', r.d2, \
           'cash_in_idr', coalesce((SELECT sum(s) FROM t WHERE txn_type IN ('topup','manual_credit')), 0), \
           'fee_income_idr', coalesce(-(SELECT sum(s) FROM t WHERE txn_type IN ('match_payment','refund')), 0), \
           'membership_income_idr', coalesce(-(SELECT sum(s) FROM t WHERE txn_type = 'membership'), 0), \
           'donation_idr', coalesce(-(SELECT sum(s) FROM t WHERE txn_type = 'donation'), 0), \
           'court_cost_idr', coalesce((SELECT sum(court_cost_per_hour_idr * duration_hours) FROM matches \
               WHERE cancelled_at IS NULL AND starts_at >= r.a AND starts_at < least(r.b, now())), 0), \
           'expenses', (SELECT jsonb_build_object( \
               'drinking_water', coalesce(sum(amount_idr) FILTER (WHERE category = 'drinking_water'), 0), \
               'shuttlecock', coalesce(sum(amount_idr) FILTER (WHERE category = 'shuttlecock'), 0), \
               'other', coalesce(sum(amount_idr) FILTER (WHERE category = 'other'), 0)) \
             FROM expenses WHERE spent_on BETWEEN r.d1 AND r.d2), \
           'member_balance_idr', (SELECT coalesce(sum(balance_idr), 0) FROM wallets)) FROM r",
    )
    .bind(q.from)
    .bind(q.to)
    .fetch_one(&st.db)
    .await?;
    Ok(ok(v))
}

pub async fn expenses(State(st): State<AppState>, m: Member, Query(q): Query<RangeQ>) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'category', category, 'amount_idr', amount_idr, 'spent_on', spent_on, 'note', note) FROM expenses \
         WHERE spent_on >= coalesce($1::date, date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')::date) \
           AND spent_on <= coalesce($2::date, (now() AT TIME ZONE 'Asia/Jakarta')::date) ORDER BY spent_on DESC, created_at DESC",
    )
    .bind(q.from)
    .bind(q.to)
    .fetch_all(&st.db)
    .await?;
    Ok(ok(rows))
}

#[derive(Deserialize)]
pub struct ExpenseIn {
    category: String,
    amount_idr: i64,
    spent_on: NaiveDate,
    note: Option<String>,
}

pub async fn add_expense(State(st): State<AppState>, m: Member, Json(b): Json<ExpenseIn>) -> R<(StatusCode, Json<Value>)> {
    m.need(Role::Superadmin)?;
    if !["drinking_water", "shuttlecock", "other"].contains(&b.category.as_str()) {
        return Err(invalid("category", "Kategori tidak dikenal"));
    }
    if b.amount_idr <= 0 {
        return Err(invalid("amount_idr", "Jumlah harus lebih dari 0"));
    }
    let id: Uuid = sqlx::query_scalar("INSERT INTO expenses(category, amount_idr, spent_on, note, created_by) VALUES ($1::expense_category, $2, $3, $4, $5) RETURNING id")
        .bind(&b.category)
        .bind(b.amount_idr)
        .bind(b.spent_on)
        .bind(b.note.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .bind(m.id)
        .fetch_one(&st.db)
        .await?;
    Ok((StatusCode::CREATED, ok(json!({"id": id}))))
}

pub async fn delete_expense(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<StatusCode> {
    m.need(Role::Superadmin)?;
    let n = sqlx::query("DELETE FROM expenses WHERE id = $1").bind(id).execute(&st.db).await?.rows_affected();
    if n == 0 { Err(e404()) } else { Ok(StatusCode::NO_CONTENT) }
}

pub async fn settings(State(st): State<AppState>, m: Member) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    let v: Value = sqlx::query_scalar("SELECT to_jsonb(s) - 'id' FROM settings s").fetch_one(&st.db).await?;
    Ok(ok(v))
}

#[derive(Deserialize)]
pub struct SettingsIn {
    reward_enabled: Option<bool>,
    membership_price_idr: Option<i64>,
    min_topup_idr: Option<i64>,
}

/// Admins may flip the reward switch; prices are superadmin only (AC-F10-05).
/// A membership price of 0 stops selling memberships.
pub async fn update_settings(State(st): State<AppState>, m: Member, Json(b): Json<SettingsIn>) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    if b.membership_price_idr.is_some() || b.min_topup_idr.is_some() {
        m.need(Role::Superadmin)?;
    }
    if b.membership_price_idr.is_some_and(|p| p < 0) {
        return Err(invalid("membership_price_idr", "Tidak boleh negatif"));
    }
    if b.min_topup_idr.is_some_and(|p| p <= 0) {
        return Err(invalid("min_topup_idr", "Harus lebih dari 0"));
    }
    let v: Value = sqlx::query_scalar(
        "UPDATE settings s SET reward_enabled = coalesce($1, reward_enabled), \
           membership_price_idr = CASE WHEN $2::bigint IS NULL THEN membership_price_idr ELSE nullif($2, 0) END, \
           min_topup_idr = coalesce($3, min_topup_idr) RETURNING to_jsonb(s) - 'id'",
    )
    .bind(b.reward_enabled)
    .bind(b.membership_price_idr)
    .bind(b.min_topup_idr)
    .fetch_one(&st.db)
    .await?;
    Ok(ok(v))
}
