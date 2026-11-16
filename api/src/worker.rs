//! Background jobs (ARCHITECTURE.md §4). Each job is one idempotent step driven by the
//! database clock, so a crash or restart loses nothing.

use crate::{notify, AppState};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::time::Duration;
use uuid::Uuid;

pub async fn run(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(30));
    loop {
        tick.tick().await;
        let jobs: [(&str, sqlx::Result<()>); 5] = [
            ("expire_holds", expire_holds(&st).await),
            ("close_started", close_started(&st).await),
            ("rewards", rewards(&st).await),
            ("email_outbox", email_outbox(&st).await),
            ("housekeeping", housekeeping(&st).await),
        ];
        for (name, res) in jobs {
            if let Err(e) = res {
                tracing::error!(job = name, error = %e, "worker job failed");
            }
        }
    }
}

/// DEC-003: an unpaid hold expires; nothing is promoted.
async fn expire_holds(st: &AppState) -> sqlx::Result<()> {
    sqlx::query(
        "WITH e AS (UPDATE join_requests SET status = 'expired', hold_expires_at = NULL, updated_at = now() \
                    WHERE status = 'awaiting_payment' AND hold_expires_at <= now() RETURNING user_id, match_id) \
         INSERT INTO notifications(user_id, kind, payload) \
         SELECT e.user_id, 'hold_expired', jsonb_build_object('title', 'Waktu pembayaran habis', \
                'body', 'Kursi di ' || m.title || ' dilepas karena belum dibayar dalam 30 menit.') \
         FROM e JOIN matches m ON m.id = e.match_id WHERE e.user_id IS NOT NULL",
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

/// Requests still undecided or unpaid when the match starts are closed.
async fn close_started(st: &AppState) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE join_requests j SET status = 'cancelled', hold_expires_at = NULL, updated_at = now() FROM matches m \
         WHERE m.id = j.match_id AND j.status IN ('pending','awaiting_payment') AND m.starts_at <= now()",
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

/// AC-F8-01: after a match ends, each attendee with 5 attended matches inside the 2 months ending
/// at this match, none already counted for an earlier reward, earns one free seat.
async fn rewards(st: &AppState) -> sqlx::Result<()> {
    const END: &str = "m.starts_at + make_interval(hours => m.duration_hours)";
    let ended: Vec<(Uuid, DateTime<Utc>)> = sqlx::query_as(&format!(
        "SELECT m.id, {END} FROM matches m WHERE m.cancelled_at IS NULL AND m.rewards_processed_at IS NULL AND {END} <= now() ORDER BY 2"
    ))
    .fetch_all(&st.db)
    .await?;
    for (match_id, end) in ended {
        let mut tx = st.db.begin().await?;
        let enabled: bool = sqlx::query_scalar("SELECT reward_enabled FROM settings").fetch_one(&mut *tx).await?;
        let players: Vec<Uuid> = if enabled {
            sqlx::query_scalar("SELECT user_id FROM join_requests WHERE match_id = $1 AND status = 'confirmed' AND user_id IS NOT NULL").bind(match_id).fetch_all(&mut *tx).await?
        } else {
            vec![]
        };
        for user in players {
            let attended: i64 = sqlx::query_scalar(&format!(
                "SELECT count(*) FROM join_requests j JOIN matches m ON m.id = j.match_id \
                 WHERE j.user_id = $1 AND j.status = 'confirmed' AND m.cancelled_at IS NULL AND {END} <= $2 \
                   AND {END} > greatest($2 - interval '2 months', \
                         coalesce((SELECT max(counted_until) FROM rewards WHERE user_id = $1), '-infinity'::timestamptz))"
            ))
            .bind(user)
            .bind(end)
            .fetch_one(&mut *tx)
            .await?;
            if attended >= 5 {
                let new = sqlx::query(
                    "INSERT INTO rewards(user_id, earned_match_id, counted_until, expires_at) VALUES ($1, $2, $3, $3 + interval '1 month') \
                     ON CONFLICT (user_id, earned_match_id) DO NOTHING",
                )
                .bind(user)
                .bind(match_id)
                .bind(end)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if new > 0 {
                    notify::notify(&mut *tx, user, "reward_earned", "Kamu dapat 1 kursi gratis", "5 pertandingan dalam 2 bulan. Kursi gratis berlaku 1 bulan dan dipakai otomatis saat permintaan berikutnya disetujui.").await?;
                }
            }
        }
        sqlx::query("UPDATE matches SET rewards_processed_at = now() WHERE id = $1").bind(match_id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}

/// AC-F9-04: send due notification emails; retry after 1, 5, 30, 120 minutes, give up after 5 attempts.
async fn email_outbox(st: &AppState) -> sqlx::Result<()> {
    let Some(smtp) = &st.cfg.smtp else { return Ok(()) };
    let due: Vec<(Uuid, String, Value)> = sqlx::query_as(
        "SELECT n.id, u.email, n.payload FROM notifications n JOIN users u ON u.id = n.user_id \
         WHERE n.email_sent_at IS NULL AND n.email_next_at <= now() ORDER BY n.email_next_at LIMIT 20",
    )
    .fetch_all(&st.db)
    .await?;
    for (id, email, payload) in due {
        let subject = payload["title"].as_str().unwrap_or("ShuttleCircle");
        let body = format!("{}\n\n{}", payload["body"].as_str().unwrap_or_default(), st.cfg.public_url);
        match notify::send_mail(smtp, &email, subject, &body).await {
            Ok(()) => sqlx::query("UPDATE notifications SET email_sent_at = now() WHERE id = $1").bind(id).execute(&st.db).await?,
            Err(e) => {
                tracing::warn!(error = %e, "notification email failed");
                sqlx::query(
                    "UPDATE notifications SET email_attempts = email_attempts + 1, \
                       email_next_at = CASE WHEN email_attempts + 1 >= 5 THEN NULL \
                         ELSE now() + (ARRAY[1, 5, 30, 120])[email_attempts + 1] * interval '1 minute' END WHERE id = $1",
                )
                .bind(id)
                .execute(&st.db)
                .await?
            }
        };
    }
    Ok(())
}

async fn housekeeping(st: &AppState) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'").execute(&st.db).await?;
    sqlx::query("DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day'").execute(&st.db).await?;
    sqlx::query("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at < now() - interval '1 hour'").execute(&st.db).await?;
    Ok(())
}
