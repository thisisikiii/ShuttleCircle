use crate::{auth::Member, config::Smtp, error::*, AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use lettre::{transport::smtp::authentication::Credentials, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

/// Writes one notification row. Call inside the transaction of the event (AC-F9-03);
/// the worker emails it later. Title and body are final Indonesian text.
pub async fn notify(c: &mut PgConnection, user: Uuid, kind: &str, title: &str, body: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO notifications(user_id, kind, payload) VALUES ($1, $2, jsonb_build_object('title', $3::text, 'body', $4::text))")
        .bind(user)
        .bind(kind)
        .bind(title)
        .bind(body)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn send_mail(cfg: &Smtp, to: &str, subject: &str, body: &str) -> Result<(), String> {
    let e = |e: &dyn std::fmt::Display| e.to_string();
    let msg = Message::builder()
        .from(cfg.from.parse().map_err(|x| e(&x))?)
        .to(to.parse().map_err(|x| e(&x))?)
        .subject(subject)
        .body(body.to_string())
        .map_err(|x| e(&x))?;
    let mut b = match cfg.port {
        465 => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host).map_err(|x| e(&x))?,
        // Plain SMTP for local catchers such as Mailpit; real providers use 465 or 587.
        25 | 1025 => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host).map_err(|x| e(&x))?,
    }
    .port(cfg.port);
    if let (Some(u), Some(p)) = (&cfg.user, &cfg.password) {
        b = b.credentials(Credentials::new(u.clone(), p.clone()));
    }
    b.build().send(msg).await.map(|_| ()).map_err(|x| e(&x))
}

pub async fn list(State(st): State<AppState>, m: Member, Query(p): Query<Page>) -> R<Json<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'kind', kind, 'payload', payload, 'read_at', read_at, 'created_at', created_at) \
         FROM notifications WHERE user_id = $1 AND ($2::text IS NULL OR created_at < $2::timestamptz) \
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(m.id)
    .bind(p.cursor())
    .bind(p.limit() + 1)
    .fetch_all(&st.db)
    .await?;
    Ok(paged(rows, p.limit(), "created_at"))
}

#[derive(Deserialize)]
pub struct ReadIn {
    #[serde(default)]
    ids: Vec<Uuid>,
    #[serde(default)]
    all: bool,
}

pub async fn read(State(st): State<AppState>, m: Member, Json(b): Json<ReadIn>) -> R<StatusCode> {
    sqlx::query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2 OR id = ANY($3))")
        .bind(m.id)
        .bind(b.all)
        .bind(&b.ids)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
