//! Wallet ledger and the single settlement routine (FEATURES.md §2).
//! Lock order everywhere: match, then join request, then wallet.

use crate::notify::notify;
use sqlx::PgConnection;
use uuid::Uuid;

/// Appends one ledger entry and moves the cached balance in the same statement pair.
/// Returns None (and writes nothing) if there is no wallet or the balance would go negative.
#[allow(clippy::too_many_arguments)]
pub async fn ledger(
    c: &mut PgConnection,
    user: Uuid,
    amount: i64,
    txn_type: &str,
    payment: Option<Uuid>,
    request: Option<Uuid>,
    note: Option<&str>,
    by: Option<Uuid>,
) -> sqlx::Result<Option<(Uuid, i64)>> {
    let balance: Option<i64> = sqlx::query_scalar(
        "UPDATE wallets SET balance_idr = balance_idr + $2, updated_at = now() \
         WHERE user_id = $1 AND balance_idr + $2 >= 0 RETURNING balance_idr",
    )
    .bind(user)
    .bind(amount)
    .fetch_optional(&mut *c)
    .await?;
    let Some(balance) = balance else { return Ok(None) };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO wallet_txns(user_id, amount_idr, txn_type, payment_id, join_request_id, note, created_by) \
         VALUES ($1, $2, $3::txn_type, $4, $5, $6, $7) RETURNING id",
    )
    .bind(user)
    .bind(amount)
    .bind(txn_type)
    .bind(payment)
    .bind(request)
    .bind(note)
    .bind(by)
    .fetch_one(&mut *c)
    .await?;
    Ok(Some((id, balance)))
}

/// Tries to confirm a held request without the gateway: free match, membership, reward, wallet.
/// Only acts on a member's `awaiting_payment` request whose hold has not run out.
/// Returns whether the request is now `confirmed`.
pub async fn settle(c: &mut PgConnection, request: Uuid, via_gateway: bool) -> sqlx::Result<bool> {
    let row: Option<(Uuid, i64, String, bool)> = sqlx::query_as(
        "SELECT j.user_id, m.price_idr, m.title, \
                EXISTS (SELECT 1 FROM memberships ms WHERE ms.user_id = j.user_id \
                        AND ms.month = date_trunc('month', m.starts_at AT TIME ZONE 'Asia/Jakarta')::date) \
         FROM join_requests j JOIN matches m ON m.id = j.match_id \
         WHERE j.id = $1 AND j.status = 'awaiting_payment' AND j.user_id IS NOT NULL AND j.hold_expires_at > now() \
         FOR UPDATE OF j",
    )
    .bind(request)
    .fetch_optional(&mut *c)
    .await?;
    let Some((user, price, title, member)) = row else { return Ok(false) };

    let (method, paid) = if price == 0 {
        ("wallet", 0)
    } else if member {
        ("membership", 0)
    } else {
        let reward: Option<Uuid> = sqlx::query_scalar(
            "UPDATE rewards SET redeemed_request_id = $2 WHERE id = ( \
               SELECT id FROM rewards WHERE user_id = $1 AND redeemed_request_id IS NULL AND expires_at > now() \
               ORDER BY expires_at LIMIT 1 FOR UPDATE) RETURNING id",
        )
        .bind(user)
        .bind(request)
        .fetch_optional(&mut *c)
        .await?;
        if reward.is_some() {
            ("reward", 0)
        } else if ledger(c, user, -price, "match_payment", None, Some(request), None, None).await?.is_some() {
            (if via_gateway { "gateway" } else { "wallet" }, price)
        } else {
            return Ok(false);
        }
    };

    sqlx::query(
        "UPDATE join_requests SET status = 'confirmed', payment_method = $2::payment_method, paid_idr = $3, \
           hold_expires_at = NULL, updated_at = now() WHERE id = $1",
    )
    .bind(request)
    .bind(method)
    .bind(paid)
    .execute(&mut *c)
    .await?;
    notify(c, user, "payment_confirmed", "Kursi terkonfirmasi", &format!("Kamu terdaftar di pertandingan {title}.")).await?;
    Ok(true)
}

/// Locks and returns the user's held requests, oldest deadline first.
/// Call BEFORE crediting the wallet so the lock order stays request, then wallet.
pub async fn held(c: &mut PgConnection, user: Uuid) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar("SELECT id FROM join_requests WHERE user_id = $1 AND status = 'awaiting_payment' ORDER BY hold_expires_at FOR UPDATE")
        .bind(user)
        .fetch_all(&mut *c)
        .await
}

/// Settles whatever the user's balance, membership or reward now covers.
pub async fn settle_held(c: &mut PgConnection, user: Uuid) -> sqlx::Result<()> {
    for id in held(c, user).await? {
        settle(c, id, false).await?;
    }
    Ok(())
}
