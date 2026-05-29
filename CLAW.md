# CLAW.md

This file provides guidance to Claw Code when working with code in this repository.

## Detected stack
- Languages: Rust (runtime + tools + HTTP server), TypeScript/React (frontend).

## Verification
- Run Rust verification from `rust/`: `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- Run frontend type-check from `frontend/`: `npx tsc --noEmit`

## Repository shape
- `rust/` — Rust workspace; the canonical implementation. Crates include `api-client`, `runtime`, `tools`, `commands`, `plugins`, `server`, `claw-cli`, `lsp`, `vecdb`, `compat-harness`.
- `frontend/` — React UI that talks to the Rust HTTP server at `/api/...`.
- `assets/` — static assets used by the README.
- `PARITY.md` — gap analysis vs. the original TypeScript implementation.

## Working agreement
- Prefer small, reviewable changes.
- Keep shared defaults in `.claw.json`; reserve `.claw/settings.local.json` for machine-local overrides.
- Do not overwrite existing `CLAW.md` content automatically; update it intentionally when repo workflows change.
