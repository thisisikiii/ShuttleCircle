use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub fields: Option<Value>,
}

pub type R<T> = Result<T, AppError>;

pub fn err(status: StatusCode, code: &'static str, message: &str) -> AppError {
    AppError { status, code, message: message.into(), fields: None }
}
pub fn e401() -> AppError {
    err(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Sesi tidak valid")
}
pub fn e403(code: &'static str, message: &str) -> AppError {
    err(StatusCode::FORBIDDEN, code, message)
}
pub fn e404() -> AppError {
    err(StatusCode::NOT_FOUND, "NOT_FOUND", "Tidak ditemukan")
}
pub fn e409(code: &'static str, message: &str) -> AppError {
    err(StatusCode::CONFLICT, code, message)
}
pub fn e422(fields: Value) -> AppError {
    AppError { fields: Some(fields), ..err(StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION", "Data tidak valid") }
}
/// 422 for a single field.
pub fn invalid(field: &str, message: &str) -> AppError {
    e422(json!({ field: message }))
}
pub fn internal<E: std::fmt::Display>(e: E) -> AppError {
    tracing::error!(error = %e, "internal error");
    err(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "Terjadi kesalahan")
}
pub fn gateway_down() -> AppError {
    err(StatusCode::BAD_GATEWAY, "GATEWAY_UNAVAILABLE", "Gerbang pembayaran tidak tersedia")
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = json!({"error": {"code": self.code, "message": self.message, "fields": self.fields}});
        (self.status, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::RowNotFound => e404(),
            sqlx::Error::Database(d) if d.is_unique_violation() => e409("CONFLICT", "Sudah ada"),
            _ => internal(e),
        }
    }
}

pub fn ok(v: impl serde::Serialize) -> Json<Value> {
    Json(json!({ "data": v }))
}

#[derive(serde::Deserialize)]
pub struct Page {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

impl Page {
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 100)
    }
    /// A '+' in an unencoded query string arrives as a space; restore it.
    pub fn cursor(&self) -> Option<String> {
        self.cursor.as_ref().map(|c| c.replace(' ', "+"))
    }
}

/// `rows` holds limit + 1 items; the cursor is `key` of the last item kept.
pub fn paged(mut rows: Vec<Value>, limit: i64, key: &str) -> Json<Value> {
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next = if more { rows.last().and_then(|r| r.get(key).cloned()) } else { None };
    Json(json!({"data": rows, "meta": {"next_cursor": next}}))
}
