//! Bundles the Vite-built frontend (`frontend/dist`) into the server
//! binary so the whole product ships as a single executable. The macro
//! walks the folder at compile time; users must run `npm run build` in
//! `frontend/` BEFORE `cargo build` or the binary ships with no UI.
//!
//! The `fallback` handler below sits at the bottom of axum's router —
//! API routes are matched first, then we look up the requested path in
//! the embedded assets. Unknown SPA paths (deep links like `/sessions/abc`
//! that the client router handles) fall through to `index.html` so a
//! page refresh in the middle of the app still works.
//!
//! Dev workflow: when frontend/dist is empty (no `npm run build` yet),
//! `rust-embed` still compiles cleanly and we return a friendly hint
//! at `/` instead of a generic 404 — keeps `cargo run` ergonomic.

use axum::body::Body;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

/// `folder` is relative to this crate's `Cargo.toml`:
///   `rust/crates/server/` → `../../../frontend/dist`.
/// The macro inlines every file's bytes into the final binary. Adds
/// ~1-3 MB depending on the Vite bundle size — acceptable for a single-
/// binary distribution model.
#[derive(RustEmbed)]
#[folder = "../../../frontend/dist"]
struct FrontendAssets;

/// Axum fallback that serves the embedded SPA. Path resolution order:
///   1. Exact file (e.g. `/assets/index-abc.js`) → 200 + correct mime
///   2. Anything else → fall back to `index.html` (SPA client-router
///      will sort out what to render)
///   3. Empty dist (dev mode without a build) → 503 + hint
pub async fn serve_embedded_spa(uri: Uri) -> Response {
    // Strip leading slash — RustEmbed paths are repo-relative without it.
    let raw_path = uri.path().trim_start_matches('/');
    // Treat `/` and any non-asset path as index.html.
    let lookup = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };

    if let Some(file) = FrontendAssets::get(lookup) {
        return embedded_response(lookup, file.data.as_ref(), file.metadata.mimetype());
    }

    // SPA deep-link fallback — let the client router handle non-asset
    // paths. We only do this for paths that don't look like static
    // assets (i.e. no file extension); a missing `.js` should 404 so
    // broken script tags fail loudly instead of silently rendering HTML.
    if !raw_path.contains('.') {
        if let Some(file) = FrontendAssets::get("index.html") {
            return embedded_response("index.html", file.data.as_ref(), "text/html");
        }
    }

    // Truly missing — either bad URL or `frontend/dist` is empty.
    if FrontendAssets::iter().next().is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Frontend assets not bundled.\n\nRun `npm run build` inside `frontend/` and rebuild the server,\nor run the Vite dev server (`npm run dev`) on http://localhost:5173 and hit that instead.",
        )
            .into_response();
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn embedded_response(path: &str, bytes: &[u8], mime: &str) -> Response {
    let cache_control = if path == "index.html" {
        // Never cache the shell — Vite emits hashed asset filenames
        // referenced from index.html, so the shell itself MUST be
        // re-fetched after a release or users get stale `<script>` URLs
        // pointing at deleted asset files.
        "no-store"
    } else if path.starts_with("assets/") {
        // Hashed filenames → safe to cache aggressively. 1 year.
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, cache_control),
        ],
        Body::from(bytes.to_vec()),
    )
        .into_response()
}
