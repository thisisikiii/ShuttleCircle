//! WhatsApp through a WAHA gateway container (DEC-011): one linked account, like WhatsApp Web.
//! The gateway is unofficial; WhatsApp may ban a number that messages strangers in bulk.

use crate::{
    auth::{Member, Role},
    error::*,
    AppState,
};
use axum::{extract::State, http::StatusCode, Json};
use reqwest::Method;
use serde_json::{json, Value};

const SESSION: &str = "default";

/// An Indonesian mobile number in any common spelling (0812…, 812…, +62 812…) as a WhatsApp chat id.
/// Numbers of other countries must be written with their country code.
pub fn chat_id(number: &str) -> Option<String> {
    let d: String = number.chars().filter(char::is_ascii_digit).collect();
    let d = match d.strip_prefix('0') {
        Some(rest) => format!("62{rest}"),
        None if d.starts_with('8') => format!("62{d}"),
        None => d,
    };
    (10..=15).contains(&d.len()).then(|| format!("{d}@c.us"))
}

async fn call(st: &AppState, method: Method, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
    let (url, key) = st.cfg.waha.as_ref().ok_or("WhatsApp belum diatur")?;
    let mut req = st.http.request(method, format!("{url}{path}")).header("X-Api-Key", key).header("Accept", "application/json");
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let code = res.status().as_u16();
    Ok((code, res.json().await.unwrap_or(Value::Null)))
}

/// True when the linked account is connected and can send.
pub async fn ready(st: &AppState) -> bool {
    matches!(call(st, Method::GET, &format!("/api/sessions/{SESSION}"), None).await, Ok((200, s)) if s["status"] == "WORKING")
}

pub async fn send(st: &AppState, number: &str, text: &str) -> Result<(), String> {
    let chat = chat_id(number).ok_or("Nomor WhatsApp tidak valid")?;
    let (code, body) = call(st, Method::POST, "/api/sendText", Some(json!({"session": SESSION, "chatId": chat, "text": text}))).await?;
    if code < 300 {
        return Ok(());
    }
    tracing::warn!(code, %body, "whatsapp send failed");
    Err(if body["status"].is_string() { "WhatsApp belum terhubung" } else { "WhatsApp gagal mengirim" }.into())
}

fn down(e: String) -> AppError {
    tracing::warn!(error = %e, "whatsapp gateway unreachable");
    gateway_down()
}

/// Link state for the admin screen. Starts the session when needed and returns the QR code to scan.
pub async fn status(State(st): State<AppState>, m: Member) -> R<Json<Value>> {
    m.need(Role::Superadmin)?;
    if st.cfg.waha.is_none() {
        return Ok(ok(json!({"enabled": false})));
    }
    let (code, s) = call(&st, Method::GET, &format!("/api/sessions/{SESSION}"), None).await.map_err(down)?;
    let mut state = s["status"].as_str().unwrap_or("STARTING").to_string();
    if code == 404 {
        call(&st, Method::POST, "/api/sessions", Some(json!({"name": SESSION, "start": true}))).await.map_err(down)?;
    } else if state == "STOPPED" || state == "FAILED" {
        call(&st, Method::POST, &format!("/api/sessions/{SESSION}/start"), None).await.map_err(down)?;
        state = "STARTING".into();
    }
    let qr = if state == "SCAN_QR_CODE" {
        let (_, q) = call(&st, Method::GET, &format!("/api/{SESSION}/auth/qr?format=image"), None).await.map_err(down)?;
        q["data"].as_str().map(|d| format!("data:image/png;base64,{d}"))
    } else {
        None
    };
    Ok(ok(json!({
        "enabled": true,
        "status": state,
        "number": s["me"]["id"].as_str().map(|id| id.split('@').next().unwrap_or(id)),
        "name": s["me"]["pushName"],
        "qr": qr,
    })))
}

/// Unlinks the account; the next status call shows a fresh QR code.
pub async fn logout(State(st): State<AppState>, m: Member) -> R<StatusCode> {
    m.need(Role::Superadmin)?;
    call(&st, Method::POST, &format!("/api/sessions/{SESSION}/logout"), None).await.map_err(down)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::chat_id;

    #[test]
    fn chat_id_normalises_indonesian_numbers() {
        for n in ["081234567890", "81234567890", "+62 812-3456-7890", "6281234567890"] {
            assert_eq!(chat_id(n).as_deref(), Some("6281234567890@c.us"), "{n}");
        }
        assert_eq!(chat_id("+65 9123 4567").as_deref(), Some("6591234567@c.us"));
        assert_eq!(chat_id("12345"), None);
        assert_eq!(chat_id("bukan nomor"), None);
    }
}
