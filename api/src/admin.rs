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
    Ok(ok(summary(&st, &q).await?))
}

async fn summary(st: &AppState, q: &RangeQ) -> R<Value> {
    let v: Value = sqlx::query_scalar(
        "WITH d AS (SELECT coalesce($1::date, date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')::date) AS d1, \
                           coalesce($2::date, (now() AT TIME ZONE 'Asia/Jakarta')::date) AS d2), \
              r AS (SELECT d1, d2, d1::timestamp AT TIME ZONE 'Asia/Jakarta' AS a, (d2 + 1)::timestamp AT TIME ZONE 'Asia/Jakarta' AS b FROM d), \
              t AS (SELECT txn_type, sum(amount_idr) AS s FROM wallet_txns, r WHERE created_at >= r.a AND created_at < r.b GROUP BY 1), \
              k AS (SELECT coalesce(sum(paid_idr), 0) AS s FROM join_requests, r \
                    WHERE payment_method = 'cash' AND status = 'confirmed' AND paid_at >= r.a AND paid_at < r.b) \
         SELECT jsonb_build_object( \
           'from', r.d1, 'to', r.d2, \
           'cash_in_idr', coalesce((SELECT sum(s) FROM t WHERE txn_type IN ('topup','manual_credit')), 0) + (SELECT s FROM k), \
           'fee_income_idr', coalesce(-(SELECT sum(s) FROM t WHERE txn_type IN ('match_payment','refund')), 0) + (SELECT s FROM k), \
           'membership_income_idr', coalesce(-(SELECT sum(s) FROM t WHERE txn_type = 'membership'), 0), \
           'donation_idr', coalesce(-(SELECT sum(s) FROM t WHERE txn_type = 'donation'), 0), \
           'court_cost_idr', coalesce((SELECT sum(court_cost_per_hour_idr * duration_hours) FROM matches \
               WHERE cancelled_at IS NULL AND starts_at >= r.a AND starts_at < least(r.b, now())), 0), \
           'expenses', (SELECT jsonb_build_object( \
               'drinking_water', coalesce(sum(amount_idr) FILTER (WHERE category = 'drinking_water'), 0), \
               'shuttlecock', coalesce(sum(amount_idr) FILTER (WHERE category = 'shuttlecock'), 0), \
               'other', coalesce(sum(amount_idr) FILTER (WHERE category = 'other'), 0)) \
             FROM expenses WHERE spent_on BETWEEN r.d1 AND r.d2), \
           'member_balance_idr', (SELECT coalesce(sum(balance_idr), 0) FROM wallets), \
           'discrepancy_idr', (SELECT coalesce(sum(amount_idr), 0) FROM wallet_txns) - (SELECT coalesce(sum(balance_idr), 0) FROM wallets)) FROM r",
    )
    .bind(q.from)
    .bind(q.to)
    .fetch_one(&st.db)
    .await?;
    Ok(v)
}

/// Players per week and per month (12 each, current period last): confirmed seats in matches
/// starting in the period, distinct players among them, and accounts created in the period.
pub async fn players(State(st): State<AppState>, m: Member) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    Ok(ok(player_buckets(&st).await?))
}

async fn player_buckets(st: &AppState) -> R<Value> {
    let mut out = serde_json::Map::new();
    for unit in ["week", "month"] {
        let rows: Value = sqlx::query_scalar(
            "WITH b AS (SELECT s, s + ('1 ' || $1)::interval AS e FROM generate_series( \
                 date_trunc($1, now() AT TIME ZONE 'Asia/Jakarta') - 11 * ('1 ' || $1)::interval, \
                 date_trunc($1, now() AT TIME ZONE 'Asia/Jakarta'), ('1 ' || $1)::interval) s), \
                  c AS (SELECT j.user_id, m.starts_at AT TIME ZONE 'Asia/Jakarta' AS at FROM join_requests j JOIN matches m ON m.id = j.match_id \
                        WHERE j.status = 'confirmed' AND m.cancelled_at IS NULL) \
             SELECT jsonb_agg(jsonb_build_object('start', b.s::date, \
               'seats', (SELECT count(*) FROM c WHERE c.at >= b.s AND c.at < b.e), \
               'players', (SELECT count(DISTINCT c.user_id) FROM c WHERE c.at >= b.s AND c.at < b.e), \
               'new_members', (SELECT count(*) FROM users u WHERE u.created_at AT TIME ZONE 'Asia/Jakarta' >= b.s AND u.created_at AT TIME ZONE 'Asia/Jakarta' < b.e)) \
             ORDER BY b.s) FROM b",
        )
        .bind(unit)
        .fetch_one(&st.db)
        .await?;
        out.insert(format!("{unit}s"), rows);
    }
    Ok(Value::Object(out))
}

/// Excel workbook of the finance range: summary, ledger, expenses, players per week and month.
pub async fn report_xlsx(State(st): State<AppState>, m: Member, Query(q): Query<RangeQ>) -> R<impl axum::response::IntoResponse> {
    use axum::http::header;
    use rust_xlsxwriter::{Format, Workbook};
    m.need(Role::Admin)?;
    let sum = summary(&st, &q).await?;
    let (from, to) = (sum["from"].as_str().unwrap_or_default().to_string(), sum["to"].as_str().unwrap_or_default().to_string());
    let ledger: Vec<(chrono::DateTime<chrono::Utc>, String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT t.created_at, u.full_name, t.txn_type::text, t.amount_idr, t.note FROM wallet_txns t JOIN users u ON u.id = t.user_id \
         WHERE t.created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Jakarta' AND t.created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta' \
         ORDER BY t.created_at",
    )
    .bind(&from)
    .bind(&to)
    .fetch_all(&st.db)
    .await?;
    let expenses: Vec<(NaiveDate, String, i64, Option<String>)> =
        sqlx::query_as("SELECT spent_on, category::text, amount_idr, note FROM expenses WHERE spent_on BETWEEN $1::date AND $2::date ORDER BY spent_on")
            .bind(&from)
            .bind(&to)
            .fetch_all(&st.db)
            .await?;
    let buckets = player_buckets(&st).await?;

    let x = internal; // an xlsx error here is a bug or out of memory
    let bold = Format::new().set_bold();
    let idr = Format::new().set_num_format("#,##0");
    let n = |v: &Value| v.as_i64().unwrap_or(0) as f64;
    let mut wb = Workbook::new();
    {
        let ws = wb.add_worksheet().set_name("Ringkasan").map_err(x)?;
        ws.write_string_with_format(0, 0, "Laporan keuangan ShuttleCircle", &bold).map_err(x)?;
        ws.write_string(1, 0, format!("Periode {from} s.d. {to}")).map_err(x)?;
        let e = &sum["expenses"];
        let rows = [
            ("Kas masuk (top-up, kredit manual, kursi tunai)", n(&sum["cash_in_idr"])),
            ("Pendapatan biaya main", n(&sum["fee_income_idr"])),
            ("Pendapatan keanggotaan", n(&sum["membership_income_idr"])),
            ("Donasi", n(&sum["donation_idr"])),
            ("Sewa lapangan", n(&sum["court_cost_idr"])),
            ("Air minum", n(&e["drinking_water"])),
            ("Kok", n(&e["shuttlecock"])),
            ("Pengeluaran lain", n(&e["other"])),
            ("Total saldo dompet anggota (saat ini)", n(&sum["member_balance_idr"])),
            ("Selisih buku besar vs saldo (harus 0)", n(&sum["discrepancy_idr"])),
        ];
        for (i, (label, v)) in rows.iter().enumerate() {
            ws.write_string(3 + i as u32, 0, *label).map_err(x)?;
            ws.write_number_with_format(3 + i as u32, 1, *v, &idr).map_err(x)?;
        }
        ws.set_column_width(0, 42).map_err(x)?;
        ws.set_column_width(1, 16).map_err(x)?;
    }
    {
        let ws = wb.add_worksheet().set_name("Buku besar").map_err(x)?;
        for (c, h) in ["Waktu (WIB)", "Anggota", "Jenis", "Jumlah (Rp)", "Catatan"].iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *h, &bold).map_err(x)?;
        }
        for (i, (at, name, kind, amount, note)) in ledger.iter().enumerate() {
            let r = 1 + i as u32;
            let wib = *at + chrono::Duration::hours(7); // Asia/Jakarta has no daylight saving
            ws.write_string(r, 0, wib.format("%Y-%m-%d %H:%M").to_string()).map_err(x)?;
            ws.write_string(r, 1, name).map_err(x)?;
            ws.write_string(r, 2, kind).map_err(x)?;
            ws.write_number_with_format(r, 3, *amount as f64, &idr).map_err(x)?;
            ws.write_string(r, 4, note.as_deref().unwrap_or("")).map_err(x)?;
        }
        for (c, w) in [17, 24, 15, 14, 30].into_iter().enumerate() {
            ws.set_column_width(c as u16, w).map_err(x)?;
        }
    }
    {
        let ws = wb.add_worksheet().set_name("Pengeluaran").map_err(x)?;
        for (c, h) in ["Tanggal", "Kategori", "Jumlah (Rp)", "Catatan"].iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *h, &bold).map_err(x)?;
        }
        for (i, (on, cat, amount, note)) in expenses.iter().enumerate() {
            let r = 1 + i as u32;
            ws.write_string(r, 0, on.to_string()).map_err(x)?;
            ws.write_string(r, 1, cat).map_err(x)?;
            ws.write_number_with_format(r, 2, *amount as f64, &idr).map_err(x)?;
            ws.write_string(r, 3, note.as_deref().unwrap_or("")).map_err(x)?;
        }
        for (c, w) in [12, 16, 14, 30].into_iter().enumerate() {
            ws.set_column_width(c as u16, w).map_err(x)?;
        }
    }
    for (key, title) in [("weeks", "Pemain per minggu"), ("months", "Pemain per bulan")] {
        let ws = wb.add_worksheet().set_name(title).map_err(x)?;
        for (c, h) in ["Mulai periode", "Kursi terkonfirmasi", "Pemain unik", "Anggota baru"].iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *h, &bold).map_err(x)?;
        }
        for (i, b) in buckets[key].as_array().into_iter().flatten().enumerate() {
            let r = 1 + i as u32;
            ws.write_string(r, 0, b["start"].as_str().unwrap_or("")).map_err(x)?;
            ws.write_number(r, 1, n(&b["seats"])).map_err(x)?;
            ws.write_number(r, 2, n(&b["players"])).map_err(x)?;
            ws.write_number(r, 3, n(&b["new_members"])).map_err(x)?;
        }
        for (c, w) in [14, 18, 12, 13].into_iter().enumerate() {
            ws.set_column_width(c as u16, w).map_err(x)?;
        }
    }
    let bytes = wb.save_to_buffer().map_err(x)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"shuttlecircle-laporan-{from}-{to}.xlsx\"")),
        ],
        bytes,
    ))
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
    // Manual payment details (FR-22); "" clears a text field.
    pay_holder: Option<String>,
    pay_ewallet_number: Option<String>,
    pay_ewallet_names: Option<String>,
    pay_banks: Option<Vec<BankIn>>,
}

#[derive(Deserialize, serde::Serialize)]
pub struct BankIn {
    bank: String,
    number: String,
}

/// Admins may flip the reward switch; prices and payment details are superadmin only (AC-F10-05).
/// A membership price of 0 stops selling memberships.
pub async fn update_settings(State(st): State<AppState>, m: Member, Json(b): Json<SettingsIn>) -> R<Json<Value>> {
    m.need(Role::Admin)?;
    let pay = b.pay_holder.is_some() || b.pay_ewallet_number.is_some() || b.pay_ewallet_names.is_some() || b.pay_banks.is_some();
    if b.membership_price_idr.is_some() || b.min_topup_idr.is_some() || pay {
        m.need(Role::Superadmin)?;
    }
    let digits = |s: &str| (5..=30).contains(&s.len()) && s.chars().all(|c| c.is_ascii_digit());
    if b.pay_ewallet_number.as_deref().is_some_and(|n| !n.is_empty() && !digits(n)) {
        return Err(invalid("pay_ewallet_number", "5 sampai 30 angka"));
    }
    for t in [&b.pay_holder, &b.pay_ewallet_names] {
        if t.as_deref().is_some_and(|s| s.len() > 80) {
            return Err(invalid("pay_holder", "Maksimal 80 karakter"));
        }
    }
    if let Some(banks) = &b.pay_banks {
        if banks.len() > 10 || banks.iter().any(|x| x.bank.trim().is_empty() || x.bank.len() > 40 || !digits(x.number.trim())) {
            return Err(invalid("pay_banks", "Maksimal 10 rekening; nama bank wajib, nomor 5 sampai 30 angka"));
        }
    }
    if pay {
        let banks = b.pay_banks.as_ref().map(|v| json!(v.iter().map(|x| json!({"bank": x.bank.trim(), "number": x.number.trim()})).collect::<Vec<_>>()));
        sqlx::query(
            "UPDATE settings SET pay_holder = CASE WHEN $1::text IS NULL THEN pay_holder ELSE nullif(trim($1), '') END, \
               pay_ewallet_number = CASE WHEN $2::text IS NULL THEN pay_ewallet_number ELSE nullif($2, '') END, \
               pay_ewallet_names = CASE WHEN $3::text IS NULL THEN pay_ewallet_names ELSE nullif(trim($3), '') END, \
               pay_banks = coalesce($4, pay_banks)",
        )
        .bind(&b.pay_holder)
        .bind(&b.pay_ewallet_number)
        .bind(&b.pay_ewallet_names)
        .bind(banks)
        .execute(&st.db)
        .await?;
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
