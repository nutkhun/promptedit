//! Browser development server: the app's backend commands over HTTP, plus local files with
//! Range support, so the UI can run and be tested in a plain browser (headless Chromium in CI).
//!
//!   cargo run -p promptedit --bin devserver      # http://127.0.0.1:1430
//!   pnpm dev                                      # http://localhost:1420 (uses it automatically)
//!
//! Never shipped: it binds to 127.0.0.1 only and exists for development and tests.

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use promptedit_lib::{AppState, dispatch};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

struct Dev {
    state: AppState,
    cache: PathBuf,
}

#[tokio::main]
async fn main() {
    let cache = std::env::temp_dir().join("promptedit-dev-cache");
    let dev = Arc::new(Dev { state: AppState::default(), cache });
    let app = Router::new()
        .route("/invoke/{cmd}", post(invoke))
        .route("/raw/{cmd}", post(invoke_raw))
        .route("/file", get(file))
        // Export streams encoded video through here; axum's default 2 MB limit is too small.
        .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(CorsLayer::very_permissive())
        .with_state(dev);
    let port = std::env::var("PROMPTEDIT_DEV_PORT").unwrap_or_else(|_| "1430".into());
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.expect("port free");
    eprintln!("PromptEdit dev server on http://127.0.0.1:{port}");
    axum::serve(listener, app).await.unwrap();
}

async fn invoke(State(dev): State<Arc<Dev>>, UrlPath(cmd): UrlPath<String>, Json(args): Json<serde_json::Value>) -> impl IntoResponse {
    let r = tokio::task::spawn_blocking(move || dispatch(&dev.state, &dev.cache, &cmd, args)).await.unwrap();
    match r {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::Value::String(e))).into_response(),
    }
}

/// Commands whose body is raw bytes (export frames), as Tauri's raw-body invoke.
async fn invoke_raw(UrlPath(cmd): UrlPath<String>, headers: axum::http::HeaderMap, body: axum::body::Bytes) -> impl IntoResponse {
    let r = tokio::task::spawn_blocking(move || {
        let header = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
        promptedit_lib::render::dispatch_raw(&cmd, &header, &body).unwrap_or_else(|| Err(format!("Unknown command {cmd}")))
    })
    .await
    .unwrap();
    match r {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::Value::String(e))).into_response(),
    }
}

async fn file(Query(q): Query<HashMap<String, String>>, req: Request<axum::body::Body>) -> impl IntoResponse {
    let Some(path) = q.get("path") else { return StatusCode::BAD_REQUEST.into_response() };
    ServeFile::new(path).oneshot(req).await.into_response()
}
