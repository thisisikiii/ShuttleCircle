use crate::{
    auth::{Member, Role},
    config::Smtp,
    error::*,
    requests, whatsapp, AppState,
};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use lettre::{transport::smtp::authentication::Credentials, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;
use serde_json::{json, Value};
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

#[derive(Deserialize)]
pub struct InviteIn {
    match_id: Option<Uuid>,
    contacts: Vec<String>,
}

/// Invites people by email (the contact has an @) or WhatsApp (a phone number): to one match
/// when `match_id` is given, else to create an account. Nothing is stored; the reply lists
/// which contacts were reached.
pub async fn invite(State(st): State<AppState>, m: Member, Json(b): Json<InviteIn>) -> R<Json<Value>> {
    m.need(Role::Host)?;
    let contacts: Vec<&str> = b.contacts.iter().map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
    if contacts.is_empty() || contacts.len() > 20 {
        return Err(invalid("contacts", "Isi 1 sampai 20 email atau nomor WhatsApp"));
    }
    let mut c = st.db.acquire().await?;
    let inviter: String = sqlx::query_scalar("SELECT full_name FROM users WHERE id = $1").bind(m.id).fetch_one(&mut *c).await?;
    let url = &st.cfg.public_url;
    let (subject, text) = match b.match_id {
        Some(id) => {
            requests::can_manage(&mut *c, id, &m).await?;
            let (title, when, place): (String, String, String) =
                sqlx::query_as("SELECT title, to_char(starts_at AT TIME ZONE 'Asia/Jakarta', 'DD/MM/YYYY HH24:MI'), location_name FROM matches WHERE id = $1")
                    .bind(id)
                    .fetch_one(&mut *c)
                    .await?;
            (
                format!("Undangan main: {title}"),
                format!("{inviter} mengundang kamu main badminton di ShuttleCircle.

{title}
{when} WIB
{place}

Lihat dan minta gabung: {url}/matches/{id}"),
            )
        }
        None => {
            m.need(Role::Admin)?;
            (
                "Undangan bergabung di ShuttleCircle".to_string(),
                format!("{inviter} mengundang kamu bergabung di komunitas badminton ShuttleCircle.

Buat akun: {url}/register"),
            )
        }
    };
    drop(c);
    let mut results = Vec::new();
    let mut whatsapp_sent = false;
    for contact in contacts {
        let res = if contact.contains('@') {
            match &st.cfg.smtp {
                Some(smtp) => send_mail(smtp, contact, &subject, &text).await.map_err(|e| {
                    tracing::warn!(error = %e, "invitation email failed");
                    "Email gagal dikirim".to_string()
                }),
                None => Err("Email belum diatur".into()),
            }
        } else {
            // A pause between messages: bursts are what gets a linked number banned.
            if whatsapp_sent {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            whatsapp_sent = true;
            whatsapp::send(&st, contact, &format!("*{subject}*

{text}")).await
        };
        results.push(json!({"contact": contact, "sent": res.is_ok(), "error": res.err()}));
    }
    Ok(ok(results))
}
