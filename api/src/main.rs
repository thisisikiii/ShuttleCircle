mod admin;
mod auth;
mod config;
mod error;
mod matches;
mod media;
mod notify;
mod payments;
mod requests;
mod rotation;
mod settle;
mod wallet;
mod whatsapp;
mod worker;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use config::Config;
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cfg: Arc<Config>,
    pub http: reqwest::Client,
    hits: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
}

/// Fixed-window limit per client IP and route group (first path segment).
/// shortcut: in-memory, so it only holds for a single API instance; move to the database or a proxy plugin if the API is ever scaled out.
async fn rate_limit(State(st): State<AppState>, req: Request, next: Next) -> Response {
    // Caddy overwrites X-Forwarded-For with the real client address, so it cannot be spoofed from outside.
    let ip = req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).unwrap_or("-").trim().to_string();
    let group = req.uri().path().trim_start_matches('/').split('/').next().unwrap_or_default().to_string();
    let now = Instant::now();
    let window = Duration::from_secs(60);
    let over = {
        let mut hits = st.hits.lock().unwrap();
        if hits.len() > 10_000 {
            hits.retain(|_, (t, _)| now.duration_since(*t) < window);
        }
        let e = hits.entry(format!("{ip}|{group}")).or_insert((now, 0));
        if now.duration_since(e.0) >= window {
            *e = (now, 0);
        }
        e.1 += 1;
        e.1 > st.cfg.rate_per_min
    };
    if over {
        return error::err(axum::http::StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED", "Terlalu banyak percobaan, coba lagi sebentar").into_response();
    }
    next.run(req).await
}

async fn healthz(State(st): State<AppState>) -> error::R<Json<Value>> {
    sqlx::query("SELECT 1").execute(&st.db).await?;
    Ok(Json(json!({"status": "ok", "features": {
        "gateway": st.cfg.midtrans_server_key.is_some(),
        "google": st.cfg.google.is_some(),
        "email": st.cfg.smtp.is_some(),
        "whatsapp": st.cfg.waha.is_some(),
    }})))
}

fn router(st: AppState) -> Router {
    let limited = Router::new()
        .route("/auth/guest", post(auth::guest))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/google/start", get(auth::google_start))
        .route("/auth/password/forgot", post(auth::forgot))
        .route("/auth/password/reset", post(auth::reset))
        .route("/auth/email/verify", post(auth::verify_email))
        .route("/matches/{id}/join-requests", post(requests::create))
        .route("/join-requests/{id}/pay", post(requests::pay))
        .route("/wallets/me/topups", post(wallet::topup))
        .route("/invitations", post(notify::invite))
        .route_layer(middleware::from_fn_with_state(st.clone(), rate_limit));

    let api = Router::new()
        .merge(limited)
        .route("/healthz", get(healthz))
        .route("/auth/google/callback", get(auth::google_callback))
        .route("/auth/refresh", post(auth::refresh))
        .route("/auth/logout", post(auth::logout))
        .route("/me", get(auth::me).patch(auth::update_me))
        .route("/me/join-requests", get(requests::mine))
        .route("/matches", get(matches::list).post(matches::create))
        .route("/matches/{id}", get(matches::detail).patch(matches::update))
        .route("/matches/{id}/cancel", post(matches::cancel))
        .route("/matches/{id}/games", put(matches::games))
        .route("/matches/{id}/media", get(media::list).post(media::upload).layer(DefaultBodyLimit::max(media::MAX_UPLOAD as usize + 1024 * 1024)))
        .route("/matches/{id}/rotation", get(rotation::get).patch(rotation::settings))
        .route("/matches/{id}/rotation/courts/{court}", patch(rotation::court))
        .route("/matches/{id}/rotation/courts/{court}/next", post(rotation::next))
        .route("/matches/{id}/rotation/players", post(rotation::players))
        .route("/matches/{id}/rotation/players/{jr}", patch(rotation::player))
        .route("/matches/{id}/rotation/games/{gid}", delete(rotation::clear).patch(rotation::score))
        .route("/matches/{id}/rotation/games/{gid}/start", post(rotation::start))
        .route("/matches/{id}/rotation/games/{gid}/finish", post(rotation::finish))
        .route("/matches/{id}/rotation/games/{gid}/point", post(rotation::point))
        .route("/media/{id}/file", get(media::file))
        .route("/media/{id}", delete(media::delete))
        .route("/join-requests", get(requests::queue))
        .route("/join-requests/{id}/approve", post(requests::approve))
        .route("/join-requests/{id}/reject", post(requests::reject))
        .route("/join-requests/{id}/cancel", post(requests::cancel))
        .route("/history", get(matches::history))
        .route("/wallets/me", get(wallet::my_wallet))
        .route("/wallets/me/transactions", get(wallet::my_txns))
        .route("/wallets/{user_id}", get(wallet::user_wallet))
        .route("/wallets/{user_id}/transactions", get(wallet::user_txns))
        .route("/wallets/{user_id}/credits", post(wallet::credit))
        .route("/wallets/{user_id}/adjustments", post(wallet::adjust))
        .route("/memberships", post(wallet::membership))
        .route("/donations", post(wallet::donate))
        .route("/webhooks/midtrans", post(payments::webhook))
        .route("/users", get(admin::users))
        .route("/users/{id}", patch(admin::update_user))
        .route("/finance/summary", get(admin::finance))
        .route("/finance/players", get(admin::players))
        .route("/finance/report.xlsx", get(admin::report_xlsx))
        .route("/expenses", get(admin::expenses).post(admin::add_expense))
        .route("/expenses/{id}", delete(admin::delete_expense))
        .route("/settings", get(admin::settings).patch(admin::update_settings))
        .route("/notifications", get(notify::list))
        .route("/notifications/read", post(notify::read))
        .route("/whatsapp", get(whatsapp::status))
        .route("/whatsapp/logout", post(whatsapp::logout));

    Router::new().nest("/api/v1", api).with_state(st)
}

/// `shuttlecircle create-superadmin --email <email>`: promotes an already registered account (DEC-020).
async fn create_superadmin(db: &PgPool, args: &[String]) {
    let email = match args {
        [flag, email] if flag == "--email" => email.trim().to_lowercase(),
        _ => {
            eprintln!("usage: shuttlecircle create-superadmin --email <email>");
            std::process::exit(2);
        }
    };
    let n = sqlx::query("UPDATE users SET role = 'superadmin' WHERE email = $1").bind(&email).execute(db).await.expect("update failed").rows_affected();
    if n == 0 {
        eprintln!("no account with email {email}; register on the site first, then run this again");
        std::process::exit(1);
    }
    println!("{email} is now superadmin (takes effect at next sign-in or within 15 minutes)");
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().json().init();
    let cfg = Arc::new(Config::from_env());
    let db = PgPoolOptions::new().max_connections(10).connect(&cfg.database_url).await.expect("database connection failed");
    sqlx::migrate!("./migrations").run(&db).await.expect("migration failed");

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("create-superadmin") {
        return create_superadmin(&db, &args[1..]).await;
    }

    tokio::fs::create_dir_all(&cfg.media_dir).await.expect("media dir not writable");
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client");
    let st = AppState { db, cfg, http, hits: Arc::default() };
    tokio::spawn(worker::run(st.clone()));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.expect("bind :8080");
    tracing::info!("listening on :8080");
    axum::serve(listener, router(st)).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .expect("server error");
}
