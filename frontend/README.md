# Claw frontend

Minimal Vite + React + TS console for the `claw-server` HTTP API. Lets you observe sessions, send messages, watch SSE events live, cancel turns, and inspect tools / commands / config.

## Run

In one terminal, start the server:

```bash
cd ../rust
cargo run -p server --bin claw-server
# binds 127.0.0.1:8787 by default
# optional env:
#   CLAW_SERVER_BIND=0.0.0.0:8787
#   CLAW_SERVER_MODEL=deepseek      # uses ProviderTurnDriver instead of the local echo driver
#   DEEPSEEK_API_KEY=...            # required by the provider driver
#   RUST_LOG=info,server=debug
```

In another terminal, start the dev server:

```bash
cd frontend
npm install
npm run dev
# opens http://localhost:5173 (or 5174 if 5173 is taken)
```

Vite proxies `/api/*` to the Rust server. Override with `CLAW_SERVER_URL=http://host:port npm run dev`.

## What you can see

- **Session rail** — list sessions, create new ones, see live turn-in-flight indicators.
- **Transcript tab** — user / assistant / tool-use / tool-result bubbles, with streaming `assistant_delta` updates and cancel-aware "Cancel" button.
- **Events tab** — raw SSE payloads, click to expand. Useful for verifying event ordering and shape.
- **Tools tab** — built-in tool registry with required permission and description.
- **Commands tab** — slash command registry with category and argument hints.
- **Config tab** — read/write `permission_mode`; the server stores it, though the default turn driver does not yet consult it.
- **Side panel** — event count, tool calls, errors, last reported `usage`.

## Build / typecheck

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc + vite build, outputs to dist/
```
