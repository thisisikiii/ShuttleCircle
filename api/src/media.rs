use crate::{
    auth::{Member, Role},
    error::*,
    requests, AppState,
};
use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const MB: u64 = 1024 * 1024;
pub const MAX_UPLOAD: u64 = 100 * MB;

/// View rights: admins, the match host, and players who attended (AC-F7-04).
async fn can_view(st: &AppState, m: &Member, match_id: Uuid) -> R<()> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT $3 OR m.host_id = $2 OR EXISTS (SELECT 1 FROM join_requests j WHERE j.match_id = m.id AND j.user_id = $2 AND j.status = 'confirmed') \
         FROM matches m WHERE m.id = $1",
    )
    .bind(match_id)
    .bind(m.id)
    .bind(m.role >= Role::Admin)
    .fetch_one(&st.db)
    .await?;
    if allowed { Ok(()) } else { Err(e403("FORBIDDEN", "Hanya untuk peserta pertandingan")) }
}

pub async fn list(State(st): State<AppState>, m: Member, Path(match_id): Path<Uuid>) -> R<Json<Value>> {
    can_view(&st, &m, match_id).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'kind', kind, 'size_bytes', size_bytes, 'created_at', created_at) FROM match_media WHERE match_id = $1 ORDER BY created_at",
    )
    .bind(match_id)
    .fetch_all(&st.db)
    .await?;
    Ok(ok(rows))
}

pub async fn upload(State(st): State<AppState>, m: Member, Path(match_id): Path<Uuid>, mut mp: Multipart) -> R<(StatusCode, Json<Value>)> {
    m.need(Role::Host)?;
    let mut c = st.db.acquire().await?;
    requests::can_manage(&mut *c, match_id, &m).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM match_media WHERE match_id = $1").bind(match_id).fetch_one(&mut *c).await?;
    if count >= 30 {
        return Err(e409("MEDIA_LIMIT", "Maksimal 30 berkas per pertandingan"));
    }
    drop(c);

    let bad = |_| invalid("file", "Unggahan tidak terbaca");
    let mut field = mp.next_field().await.map_err(bad)?.ok_or_else(|| invalid("file", "Berkas wajib diisi"))?;
    // Stream to disk so a 100 MB video never sits in memory; the name is random, never the client's.
    let id = Uuid::new_v4();
    let tmp = format!("{}/{id}.part", st.cfg.media_dir);
    let mut file = tokio::fs::File::create(&tmp).await.map_err(internal)?;
    let mut size: u64 = 0;
    let mut too_big = false;
    while let Some(chunk) = field.chunk().await.map_err(bad)? {
        size += chunk.len() as u64;
        if size > MAX_UPLOAD {
            too_big = true;
            break;
        }
        file.write_all(&chunk).await.map_err(internal)?;
    }
    file.flush().await.map_err(internal)?;
    drop(file);

    // Type comes from the file's own bytes, not its name or the client's header (AC-F7-05).
    let mime = infer::get_from_path(&tmp).ok().flatten().map(|t| t.mime_type());
    let spec = match mime {
        Some("image/jpeg") => Some(("photo", "jpg", 10 * MB)),
        Some("image/png") => Some(("photo", "png", 10 * MB)),
        Some("image/webp") => Some(("photo", "webp", 10 * MB)),
        Some("video/mp4") => Some(("video", "mp4", MAX_UPLOAD)),
        _ => None,
    };
    let (kind, ext, _) = match spec {
        Some(s) if !too_big && size <= s.2 => s,
        _ => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(invalid("file", "Foto JPEG/PNG/WebP maks 10 MB atau video MP4 maks 100 MB"));
        }
    };
    let path = format!("{id}.{ext}");
    tokio::fs::rename(&tmp, format!("{}/{path}", st.cfg.media_dir)).await.map_err(internal)?;
    sqlx::query("INSERT INTO match_media(id, match_id, uploaded_by, kind, path, size_bytes) VALUES ($1, $2, $3, $4::media_kind, $5, $6)")
        .bind(id)
        .bind(match_id)
        .bind(m.id)
        .bind(kind)
        .bind(&path)
        .bind(size as i64)
        .execute(&st.db)
        .await?;
    Ok((StatusCode::CREATED, ok(json!({"id": id, "kind": kind, "size_bytes": size}))))
}

pub async fn file(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<Response> {
    let (match_id, path): (Uuid, String) = sqlx::query_as("SELECT match_id, path FROM match_media WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    can_view(&st, &m, match_id).await?;
    let mime = match path.rsplit('.').next() {
        Some("jpg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "video/mp4",
    };
    let f = tokio::fs::File::open(format!("{}/{path}", st.cfg.media_dir)).await.map_err(|_| e404())?;
    let headers = [(header::CONTENT_TYPE, mime), (header::X_CONTENT_TYPE_OPTIONS, "nosniff"), (header::CACHE_CONTROL, "private, max-age=3600")];
    Ok((headers, Body::from_stream(ReaderStream::new(f))).into_response())
}

pub async fn delete(State(st): State<AppState>, m: Member, Path(id): Path<Uuid>) -> R<StatusCode> {
    m.need(Role::Host)?;
    let mut c = st.db.acquire().await?;
    let (match_id, path): (Uuid, String) = sqlx::query_as("SELECT match_id, path FROM match_media WHERE id = $1").bind(id).fetch_one(&mut *c).await?;
    requests::can_manage(&mut *c, match_id, &m).await?;
    sqlx::query("DELETE FROM match_media WHERE id = $1").bind(id).execute(&mut *c).await?;
    let _ = tokio::fs::remove_file(format!("{}/{path}", st.cfg.media_dir)).await;
    Ok(StatusCode::NO_CONTENT)
}
