use std::env;

pub struct Smtp {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub from: String,
}

pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub cookie_secret: String,
    /// Absolute origin used in emailed links and the Google redirect URI.
    pub public_url: String,
    pub media_dir: String,
    pub rate_per_min: u32,
    pub midtrans_server_key: Option<String>,
    pub midtrans_snap_url: String,
    pub google: Option<(String, String)>,
    pub smtp: Option<Smtp>,
    /// WAHA gateway base URL and API key.
    pub waha: Option<(String, String)>,
}

fn opt(k: &str) -> Option<String> {
    env::var(k).ok().filter(|v| !v.is_empty())
}

fn must(k: &str) -> String {
    opt(k).unwrap_or_else(|| panic!("{k} must be set"))
}

impl Config {
    pub fn from_env() -> Self {
        let production = opt("MIDTRANS_PRODUCTION").as_deref() == Some("true");
        Config {
            database_url: must("DATABASE_URL"),
            jwt_secret: must("JWT_SECRET"),
            cookie_secret: must("COOKIE_SECRET"),
            public_url: format!("https://{}", must("DOMAIN")),
            media_dir: opt("MEDIA_DIR").unwrap_or_else(|| "/media".into()),
            rate_per_min: opt("RATE_LIMIT_PER_MIN").and_then(|v| v.parse().ok()).unwrap_or(10),
            midtrans_server_key: opt("MIDTRANS_SERVER_KEY"),
            midtrans_snap_url: opt("MIDTRANS_SNAP_URL").unwrap_or_else(|| {
                if production { "https://app.midtrans.com" } else { "https://app.sandbox.midtrans.com" }.into()
            }),
            google: opt("GOOGLE_CLIENT_ID").zip(opt("GOOGLE_CLIENT_SECRET")),
            smtp: opt("SMTP_HOST").map(|host| Smtp {
                host,
                port: opt("SMTP_PORT").and_then(|v| v.parse().ok()).unwrap_or(587),
                user: opt("SMTP_USER"),
                password: opt("SMTP_PASSWORD"),
                from: must("MAIL_FROM"),
            }),
            waha: opt("WAHA_URL").zip(opt("WAHA_API_KEY")),
        }
    }
}
