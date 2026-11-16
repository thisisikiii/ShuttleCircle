use crate::{error::*, notify, requests, AppState};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{FromRequestParts, Query, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chrono::{Duration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

// ---------- identity ----------

#[derive(Clone, Copy, PartialEq, PartialOrd, Debug)]
pub enum Role {
    Member,
    Host,
    Admin,
    Superadmin,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        Some(match s {
            "member" => Role::Member,
            "host" => Role::Host,
            "admin" => Role::Admin,
            "superadmin" => Role::Superadmin,
            _ => return None,
        })
    }
}

pub struct Member {
    pub id: Uuid,
    pub role: Role,
}

impl Member {
    pub fn need(&self, role: Role) -> R<()> {
        if self.role >= role { Ok(()) } else { Err(e403("FORBIDDEN", "Tidak diizinkan")) }
    }
}

pub enum Ident {
    Member(Member),
    Guest { sid: Uuid, nickname: String },
}

impl Ident {
    /// (user id, guest sid) for queries that match either kind of caller.
    pub fn keys(&self) -> (Option<Uuid>, Option<Uuid>) {
        match self {
            Ident::Member(m) => (Some(m.id), None),
            Ident::Guest { sid, .. } => (None, Some(*sid)),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    role: String,
    exp: usize,
}

impl FromRequestParts<AppState> for Ident {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> R<Self> {
        let bearer = parts.headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
        if let Some(token) = bearer {
            // An expired token must be a 401 (not a fall-through to guest) so the client refreshes.
            let key = DecodingKey::from_secret(st.cfg.jwt_secret.as_bytes());
            let c = jsonwebtoken::decode::<Claims>(token, &key, &Validation::default()).map_err(|_| e401())?.claims;
            return Ok(Ident::Member(Member { id: c.sub, role: Role::parse(&c.role).ok_or_else(e401)? }));
        }
        let (sid, nickname) = guest_of(&parts.headers, &st.cfg.cookie_secret).ok_or_else(e401)?;
        Ok(Ident::Guest { sid, nickname })
    }
}

impl FromRequestParts<AppState> for Member {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> R<Self> {
        match Ident::from_request_parts(parts, st).await? {
            Ident::Member(m) => Ok(m),
            Ident::Guest { .. } => Err(e401()),
        }
    }
}

// ---------- cookies and tokens ----------

pub fn get_cookie(h: &HeaderMap, name: &str) -> Option<String> {
    h.get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

fn cookie(name: &str, value: &str, path: &str, max_age: i64) -> HeaderValue {
    // Values are hex / base64url, so they are always valid header bytes.
    HeaderValue::from_str(&format!("{name}={value}; Path={path}; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax")).unwrap()
}

fn mac(secret: &str, data: &str) -> Hmac<Sha256> {
    let mut m = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    m.update(data.as_bytes());
    m
}

fn sign(secret: &str, v: &Value) -> String {
    let payload = B64.encode(v.to_string());
    let sig = hex::encode(mac(secret, &payload).finalize().into_bytes());
    format!("{payload}.{sig}")
}

fn unsign(secret: &str, s: &str) -> Option<Value> {
    let (payload, sig) = s.split_once('.')?;
    mac(secret, payload).verify_slice(&hex::decode(sig).ok()?).ok()?;
    serde_json::from_slice(&B64.decode(payload).ok()?).ok()
}

pub fn guest_of(h: &HeaderMap, secret: &str) -> Option<(Uuid, String)> {
    let v = unsign(secret, &get_cookie(h, "sc_guest")?)?;
    Some((v["sid"].as_str()?.parse().ok()?, v["nickname"].as_str()?.to_string()))
}

fn rand_token() -> String {
    hex::encode(rand::thread_rng().gen::<[u8; 32]>())
}

fn sha(s: &str) -> Vec<u8> {
    Sha256::digest(s.as_bytes()).to_vec()
}

async fn hash_pw(pw: String) -> R<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default().hash_password(pw.as_bytes(), &SaltString::generate(&mut OsRng)).map(|h| h.to_string())
    })
    .await
    .map_err(internal)?
    .map_err(internal)
}

async fn verify_pw(pw: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok()).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

fn jwt(st: &AppState, user: Uuid, role: &str) -> R<String> {
    let claims = Claims { sub: user, role: role.into(), exp: (Utc::now() + Duration::minutes(15)).timestamp() as usize };
    jsonwebtoken::encode(&Header::default(), &claims, &EncodingKey::from_secret(st.cfg.jwt_secret.as_bytes())).map_err(internal)
}

/// Issues a refresh cookie and an access token.
async fn session(st: &AppState, c: &mut PgConnection, user: Uuid, role: &str, out: &mut HeaderMap) -> R<Value> {
    let rt = rand_token();
    sqlx::query("INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '7 days')")
        .bind(user)
        .bind(sha(&rt))
        .execute(&mut *c)
        .await?;
    out.append(header::SET_COOKIE, cookie("sc_refresh", &rt, "/api/v1/auth", 7 * 86400));
    Ok(json!({"access_token": jwt(st, user, role)?, "expires_in": 900}))
}

/// Links guest requests to the user (AC-F1-05), clears the guest cookie, then issues the session.
async fn finish_login(st: &AppState, c: &mut PgConnection, req: &HeaderMap, user: Uuid, role: &str, out: &mut HeaderMap) -> R<Value> {
    if let Some((sid, _)) = guest_of(req, &st.cfg.cookie_secret) {
        requests::link_guest(c, user, sid).await?;
        out.append(header::SET_COOKIE, cookie("sc_guest", "", "/", 0));
    }
    session(st, c, user, role, out).await
}

/// Emails a single-use link. Does nothing without SMTP. Runs detached so it never delays the request.
fn send_token_mail(st: &AppState, user: Uuid, email: String, purpose: &'static str) {
    let st = st.clone();
    tokio::spawn(async move {
        let Some(smtp) = &st.cfg.smtp else { return };
        let token = rand_token();
        let (hours, path, subject) = match purpose {
            "reset" => (1, "reset", "Atur ulang password ShuttleCircle"),
            _ => (24, "verify", "Verifikasi email ShuttleCircle"),
        };
        let saved = sqlx::query("INSERT INTO email_tokens(token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3::email_token_purpose, now() + make_interval(hours => $4))")
            .bind(sha(&token))
            .bind(user)
            .bind(purpose)
            .bind(hours)
            .execute(&st.db)
            .await;
        if let Err(e) = saved {
            tracing::error!(error = %e, "email token insert failed");
            return;
        }
        let body = format!("Buka tautan ini untuk melanjutkan:\n{}/{path}?token={token}\n\nTautan berlaku {hours} jam.", st.cfg.public_url);
        if let Err(e) = notify::send_mail(smtp, &email, subject, &body).await {
            tracing::warn!(error = %e, "token mail failed");
        }
    });
}

// ---------- handlers ----------

#[derive(Deserialize)]
pub struct GuestIn {
    nickname: String,
}

pub async fn guest(State(st): State<AppState>, h: HeaderMap, Json(b): Json<GuestIn>) -> R<(HeaderMap, Json<Value>)> {
    let nickname = b.nickname.trim().to_string();
    if !(2..=30).contains(&nickname.chars().count()) {
        return Err(invalid("nickname", "Nama panggilan 2–30 karakter"));
    }
    // Keep the sid of an existing cookie so earlier requests stay attached.
    let sid = guest_of(&h, &st.cfg.cookie_secret).map(|g| g.0).unwrap_or_else(Uuid::new_v4);
    let mut out = HeaderMap::new();
    let value = sign(&st.cfg.cookie_secret, &json!({"sid": sid, "nickname": nickname}));
    out.append(header::SET_COOKIE, cookie("sc_guest", &value, "/", 30 * 86400));
    Ok((out, ok(json!({"kind": "guest", "nickname": nickname}))))
}

#[derive(Deserialize)]
pub struct RegisterIn {
    email: String,
    password: String,
    full_name: String,
    whatsapp_number: Option<String>,
}

pub async fn register(State(st): State<AppState>, h: HeaderMap, Json(b): Json<RegisterIn>) -> R<(HeaderMap, Json<Value>)> {
    let email = b.email.trim().to_lowercase();
    let mut f = Map::new();
    if !email.contains('@') || email.len() > 254 {
        f.insert("email".into(), "Email tidak valid".into());
    }
    if b.password.len() < 8 {
        f.insert("password".into(), "Password minimal 8 karakter".into());
    }
    if b.full_name.trim().is_empty() {
        f.insert("full_name".into(), "Nama wajib diisi".into());
    }
    if !f.is_empty() {
        return Err(e422(Value::Object(f)));
    }
    let hash = hash_pw(b.password).await?;
    let mut tx = st.db.begin().await?;
    let id: Uuid = sqlx::query_scalar("INSERT INTO users(email, password_hash, full_name, whatsapp_number) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(&email)
        .bind(hash)
        .bind(b.full_name.trim())
        .bind(b.whatsapp_number.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => e409("EMAIL_TAKEN", "Email sudah terdaftar, silakan masuk"),
            _ => e.into(),
        })?;
    sqlx::query("INSERT INTO wallets(user_id) VALUES ($1)").bind(id).execute(&mut *tx).await?;
    let mut out = HeaderMap::new();
    let data = finish_login(&st, &mut *tx, &h, id, "member", &mut out).await?;
    tx.commit().await?;
    send_token_mail(&st, id, email, "verify");
    Ok((out, ok(data)))
}

#[derive(Deserialize)]
pub struct LoginIn {
    email: String,
    password: String,
}

pub async fn login(State(st): State<AppState>, h: HeaderMap, Json(b): Json<LoginIn>) -> R<(HeaderMap, Json<Value>)> {
    let bad = || err(StatusCode::UNAUTHORIZED, "BAD_CREDENTIALS", "Email atau password salah");
    let row: Option<(Uuid, Option<String>, String, String)> =
        sqlx::query_as("SELECT id, password_hash, role::text, status::text FROM users WHERE email = $1")
            .bind(b.email.trim().to_lowercase())
            .fetch_optional(&st.db)
            .await?;
    let (id, hash, role, status) = row.ok_or_else(bad)?;
    if !verify_pw(b.password, hash.ok_or_else(bad)?).await {
        return Err(bad());
    }
    if status != "active" {
        return Err(err(StatusCode::UNAUTHORIZED, "SUSPENDED", "Akun dinonaktifkan"));
    }
    let mut tx = st.db.begin().await?;
    let mut out = HeaderMap::new();
    let data = finish_login(&st, &mut *tx, &h, id, &role, &mut out).await?;
    tx.commit().await?;
    Ok((out, ok(data)))
}

pub async fn refresh(State(st): State<AppState>, h: HeaderMap) -> R<(HeaderMap, Json<Value>)> {
    let rt = get_cookie(&h, "sc_refresh").ok_or_else(e401)?;
    let mut tx = st.db.begin().await?;
    let row: Option<(Uuid, Uuid, bool, bool, String, String)> = sqlx::query_as(
        "SELECT t.id, t.user_id, t.expires_at <= now(), \
                coalesce(t.revoked_at < now() - interval '30 seconds', false), u.role::text, u.status::text \
         FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 FOR UPDATE OF t",
    )
    .bind(sha(&rt))
    .fetch_optional(&mut *tx)
    .await?;
    let (tid, uid, expired, reused, role, status) = row.ok_or_else(e401)?;
    if reused {
        // A token rotated more than 30 s ago is being replayed: assume theft and end every session.
        // Within 30 s it is most likely a second browser tab racing the first, so only this call fails.
        sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL").bind(uid).execute(&mut *tx).await?;
        tx.commit().await?;
        return Err(e401());
    }
    let rotated: bool = sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM refresh_tokens WHERE id = $1").bind(tid).fetch_one(&mut *tx).await?;
    if expired || rotated || status != "active" {
        return Err(e401());
    }
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1").bind(tid).execute(&mut *tx).await?;
    let mut out = HeaderMap::new();
    let data = session(&st, &mut *tx, uid, &role, &mut out).await?;
    tx.commit().await?;
    Ok((out, ok(data)))
}

pub async fn logout(State(st): State<AppState>, h: HeaderMap) -> R<(HeaderMap, StatusCode)> {
    if let Some(rt) = get_cookie(&h, "sc_refresh") {
        sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL").bind(sha(&rt)).execute(&st.db).await?;
    }
    let mut out = HeaderMap::new();
    out.append(header::SET_COOKIE, cookie("sc_refresh", "", "/api/v1/auth", 0));
    Ok((out, StatusCode::NO_CONTENT))
}

#[derive(Deserialize)]
pub struct ForgotIn {
    email: String,
}

/// Always 204 so the response does not reveal whether the email exists.
pub async fn forgot(State(st): State<AppState>, Json(b): Json<ForgotIn>) -> R<StatusCode> {
    let email = b.email.trim().to_lowercase();
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&st.db).await?;
    if let Some(id) = id {
        send_token_mail(&st, id, email, "reset");
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn use_token(c: &mut PgConnection, token: &str, purpose: &str) -> R<Uuid> {
    sqlx::query_scalar(
        "UPDATE email_tokens SET used_at = now() \
         WHERE token_hash = $1 AND purpose = $2::email_token_purpose AND used_at IS NULL AND expires_at > now() RETURNING user_id",
    )
    .bind(sha(token))
    .bind(purpose)
    .fetch_optional(&mut *c)
    .await?
    .ok_or_else(|| e409("TOKEN_INVALID", "Tautan tidak berlaku atau sudah dipakai"))
}

#[derive(Deserialize)]
pub struct ResetIn {
    token: String,
    password: String,
}

pub async fn reset(State(st): State<AppState>, Json(b): Json<ResetIn>) -> R<StatusCode> {
    if b.password.len() < 8 {
        return Err(invalid("password", "Password minimal 8 karakter"));
    }
    let hash = hash_pw(b.password).await?;
    let mut tx = st.db.begin().await?;
    let user = use_token(&mut *tx, &b.token, "reset").await?;
    // Receiving the reset mail also proves ownership of the address.
    sqlx::query("UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1").bind(user).bind(hash).execute(&mut *tx).await?;
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL").bind(user).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct VerifyIn {
    token: String,
}

pub async fn verify_email(State(st): State<AppState>, Json(b): Json<VerifyIn>) -> R<StatusCode> {
    let mut tx = st.db.begin().await?;
    let user = use_token(&mut *tx, &b.token, "verify").await?;
    sqlx::query("UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1").bind(user).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(State(st): State<AppState>, who: Ident) -> R<Json<Value>> {
    let m = match who {
        Ident::Guest { nickname, .. } => return Ok(ok(json!({"kind": "guest", "nickname": nickname}))),
        Ident::Member(m) => m,
    };
    let v: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('kind', 'member', 'id', u.id, 'email', u.email, 'full_name', u.full_name, \
           'whatsapp_number', u.whatsapp_number, 'role', u.role, 'email_verified', u.email_verified_at IS NOT NULL, \
           'wallet_balance_idr', w.balance_idr, \
           'membership_months', (SELECT coalesce(jsonb_agg(month ORDER BY month), '[]') FROM memberships \
              WHERE user_id = u.id AND month >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')::date), \
           'rewards', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'expires_at', expires_at) ORDER BY expires_at), '[]') FROM rewards \
              WHERE user_id = u.id AND redeemed_request_id IS NULL AND expires_at > now()), \
           'unread_notifications', (SELECT count(*) FROM notifications WHERE user_id = u.id AND read_at IS NULL)) \
         FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.id = $1",
    )
    .bind(m.id)
    .fetch_one(&st.db)
    .await?;
    Ok(ok(v))
}

#[derive(Deserialize)]
pub struct MeIn {
    full_name: Option<String>,
    whatsapp_number: Option<String>,
}

pub async fn update_me(State(st): State<AppState>, m: Member, Json(b): Json<MeIn>) -> R<StatusCode> {
    if b.full_name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Err(invalid("full_name", "Nama wajib diisi"));
    }
    // An empty whatsapp_number clears it.
    sqlx::query("UPDATE users SET full_name = coalesce($2, full_name), whatsapp_number = nullif(coalesce($3, whatsapp_number), '') WHERE id = $1")
        .bind(m.id)
        .bind(b.full_name.as_deref().map(str::trim))
        .bind(b.whatsapp_number.as_deref().map(str::trim))
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- Google sign-in ----------

fn google_redirect(st: &AppState) -> String {
    format!("{}/api/v1/auth/google/callback", st.cfg.public_url)
}

pub async fn google_start(State(st): State<AppState>) -> R<Response> {
    let (client_id, _) = st.cfg.google.as_ref().ok_or_else(e404)?;
    let (state, verifier) = (rand_token(), rand_token());
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    let url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", &google_redirect(&st)),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(internal)?;
    let mut out = HeaderMap::new();
    let saved = sign(&st.cfg.cookie_secret, &json!({"s": state, "v": verifier}));
    out.append(header::SET_COOKIE, cookie("sc_oauth", &saved, "/api/v1/auth", 600));
    Ok((out, Redirect::to(url.as_str())).into_response())
}

#[derive(Deserialize)]
pub struct GoogleCb {
    code: Option<String>,
    state: Option<String>,
}

pub async fn google_callback(State(st): State<AppState>, Query(q): Query<GoogleCb>, h: HeaderMap) -> R<Response> {
    let (client_id, client_secret) = st.cfg.google.as_ref().ok_or_else(e404)?;
    let saved = get_cookie(&h, "sc_oauth").and_then(|c| unsign(&st.cfg.cookie_secret, &c)).ok_or_else(e401)?;
    let (code, state) = q.code.zip(q.state).ok_or_else(e401)?;
    if Some(state.as_str()) != saved["s"].as_str() {
        return Err(e401());
    }
    let token: Value = st
        .http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", &google_redirect(&st)),
            ("grant_type", "authorization_code"),
            ("code_verifier", saved["v"].as_str().unwrap_or_default()),
        ])
        .send()
        .await
        .map_err(internal)?
        .json()
        .await
        .map_err(internal)?;
    let access = token["access_token"].as_str().ok_or_else(e401)?;
    // The profile comes straight from Google over TLS with the token just issued to us,
    // so no local ID-token signature check is needed.
    let info: Value = st.http.get("https://openidconnect.googleapis.com/v1/userinfo").bearer_auth(access).send().await.map_err(internal)?.json().await.map_err(internal)?;
    let (Some(sub), Some(email)) = (info["sub"].as_str(), info["email"].as_str()) else { return Err(e401()) };
    if info["email_verified"].as_bool() != Some(true) {
        return Err(e401());
    }
    let email = email.to_lowercase();

    let mut tx = st.db.begin().await?;
    let mut user: Option<(Uuid, String, String)> =
        sqlx::query_as("SELECT id, role::text, status::text FROM users WHERE google_sub = $1").bind(sub).fetch_optional(&mut *tx).await?;
    if user.is_none() {
        // Same verified email: sign into that account. If its email was never verified,
        // the password may belong to someone else, so drop it (AC-F1-06).
        user = sqlx::query_as(
            "UPDATE users SET google_sub = $1, \
               password_hash = CASE WHEN email_verified_at IS NULL THEN NULL ELSE password_hash END, \
               email_verified_at = coalesce(email_verified_at, now()) \
             WHERE email = $2 RETURNING id, role::text, status::text",
        )
        .bind(sub)
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    }
    let (id, role, status) = match user {
        Some(u) => u,
        None => {
            let name = info["name"].as_str().unwrap_or(&email);
            let id: Uuid = sqlx::query_scalar("INSERT INTO users(email, google_sub, full_name, email_verified_at) VALUES ($1, $2, $3, now()) RETURNING id")
                .bind(&email)
                .bind(sub)
                .bind(name)
                .fetch_one(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO wallets(user_id) VALUES ($1)").bind(id).execute(&mut *tx).await?;
            (id, "member".to_string(), "active".to_string())
        }
    };
    if status != "active" {
        return Err(err(StatusCode::UNAUTHORIZED, "SUSPENDED", "Akun dinonaktifkan"));
    }
    let mut out = HeaderMap::new();
    finish_login(&st, &mut *tx, &h, id, &role, &mut out).await?;
    tx.commit().await?;
    out.append(header::SET_COOKIE, cookie("sc_oauth", "", "/api/v1/auth", 0));
    Ok((out, Redirect::to("/")).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_cookie_round_trip_and_tamper() {
        let v = json!({"sid": "x", "nickname": "Budi"});
        let s = sign("k", &v);
        assert_eq!(unsign("k", &s), Some(v));
        assert_eq!(unsign("other", &s), None);
        assert_eq!(unsign("k", &s.replace('.', "A.")), None);
    }

    #[test]
    fn role_order() {
        assert!(Role::Superadmin > Role::Admin && Role::Admin > Role::Host && Role::Host > Role::Member);
    }
}
