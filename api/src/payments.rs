use crate::{error::*, notify::notify, settle, AppState};
use axum::{extract::State, Json};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use uuid::Uuid;

/// Midtrans notification signature: SHA512(order_id + status_code + gross_amount + server key).
fn signature(order_id: &str, status_code: &str, gross_amount: &str, key: &str) -> String {
    hex::encode(Sha512::digest(format!("{order_id}{status_code}{gross_amount}{key}")))
}

/// Records a payment and opens a Midtrans Snap transaction for it. Returns the `payment` object of API.md.
pub async fn create_snap(st: &AppState, user: Uuid, purpose: &str, request: Option<Uuid>, amount: i64, expires: DateTime<Utc>) -> R<Value> {
    let key = st.cfg.midtrans_server_key.as_ref().ok_or_else(gateway_down)?;
    let (email, name): (String, String) = sqlx::query_as("SELECT email, full_name FROM users WHERE id = $1").bind(user).fetch_one(&st.db).await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO payments(user_id, purpose, join_request_id, amount_idr, expires_at) VALUES ($1, $2::payment_purpose, $3, $4, $5) RETURNING id")
        .bind(user)
        .bind(purpose)
        .bind(request)
        .bind(amount)
        .bind(expires)
        .fetch_one(&st.db)
        .await?;
    let minutes = ((expires - Utc::now()).num_seconds() / 60).max(1);
    let res = st
        .http
        .post(format!("{}/snap/v1/transactions", st.cfg.midtrans_snap_url))
        .basic_auth(key, Some(""))
        .json(&json!({
            "transaction_details": {"order_id": format!("SC-{id}"), "gross_amount": amount},
            "expiry": {"unit": "minutes", "duration": minutes},
            "customer_details": {"email": email, "first_name": name},
        }))
        .send()
        .await;
    let body: Option<Value> = match res {
        Ok(r) if r.status().is_success() => r.json().await.ok(),
        Ok(r) => {
            tracing::warn!(status = %r.status(), "midtrans rejected the transaction");
            None
        }
        Err(e) => {
            tracing::warn!(error = %e, "midtrans unreachable");
            None
        }
    };
    let pair = body.as_ref().and_then(|b| Some((b["token"].as_str()?, b["redirect_url"].as_str()?)));
    let Some((token, url)) = pair else {
        sqlx::query("UPDATE payments SET status = 'failed' WHERE id = $1").bind(id).execute(&st.db).await?;
        return Err(gateway_down());
    };
    sqlx::query("UPDATE payments SET snap_token = $2, redirect_url = $3 WHERE id = $1").bind(id).bind(token).bind(url).execute(&st.db).await?;
    Ok(json!({"id": id, "amount_idr": amount, "snap_token": token, "redirect_url": url, "expires_at": expires}))
}

/// API.md §3.5. Every gateway payment is credited to the wallet first; a seat fee is then
/// debited by settlement, so a late payment simply stays as balance (DEC-010).
pub async fn webhook(State(st): State<AppState>, Json(b): Json<Value>) -> R<Json<Value>> {
    let s = |k: &str| b[k].as_str().unwrap_or_default();
    let key = st.cfg.midtrans_server_key.as_deref().unwrap_or_default();
    if key.is_empty() || signature(s("order_id"), s("status_code"), s("gross_amount"), key) != s("signature_key") {
        return Err(e403("BAD_SIGNATURE", "Tanda tangan tidak valid"));
    }
    let id: Uuid = s("order_id").strip_prefix("SC-").and_then(|v| v.parse().ok()).ok_or_else(e404)?;

    let mut tx = st.db.begin().await?;
    let (user, request, amount, status): (Uuid, Option<Uuid>, i64, String) =
        sqlx::query_as("SELECT user_id, join_request_id, amount_idr, status::text FROM payments WHERE id = $1 FOR UPDATE").bind(id).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE payments SET last_notification = $2 WHERE id = $1").bind(id).bind(&b).execute(&mut *tx).await?;

    let ts = s("transaction_status");
    let paid = ts == "settlement" || (ts == "capture" && s("fraud_status") == "accept");
    if status == "settled" {
        // Duplicate notification: already credited.
    } else if paid {
        if s("gross_amount").parse::<f64>().ok().map(|g| g.round() as i64) != Some(amount) {
            return Err(e409("AMOUNT_MISMATCH", "Jumlah tidak cocok"));
        }
        let held = settle::held(&mut *tx, user).await?;
        sqlx::query("UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
        settle::ledger(&mut *tx, user, amount, "topup", Some(id), None, None, None).await?.ok_or_else(|| internal("wallet missing for payment"))?;
        match request {
            Some(r) => {
                if !settle::settle(&mut *tx, r, true).await? {
                    notify(&mut *tx, user, "late_payment", "Pembayaran masuk ke dompet", "Waktu tahan kursi sudah habis, jadi pembayaranmu disimpan sebagai saldo dompet.").await?;
                }
            }
            None => notify(&mut *tx, user, "topup_received", "Top-up berhasil", &format!("Saldo dompet bertambah Rp {amount}.")).await?,
        }
        for h in held.into_iter().filter(|h| Some(*h) != request) {
            settle::settle(&mut *tx, h, false).await?;
        }
    } else if matches!(ts, "expire" | "cancel" | "deny") {
        let to = if ts == "expire" { "expired" } else { "failed" };
        sqlx::query("UPDATE payments SET status = $2::payment_status WHERE id = $1").bind(id).bind(to).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(ok(json!({"received": true})))
}

#[cfg(test)]
mod tests {
    #[test]
    fn signature_matches_sha512sum() {
        // printf 'SC-120050000.00key' | sha512sum
        assert_eq!(super::signature("SC-1", "200", "50000.00", "key"), "4a90461e3c3c569cc4a8f1487a85c1448dc3b299293b726550958c850919390efcfcb97b3e736e6d76fc2de297ef5d99141f31dbcaae2385bb35201e940edd79");
    }
}
