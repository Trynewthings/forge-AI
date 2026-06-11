# Forge

> A local, terminal-first coding agent — Claude Code–inspired, clean-room implemented in safe Rust.

**Forge** (codebase name **Claw Code**) is a research and experimentation harness for a Claude Code–style coding agent. It runs entirely on your machine, works directly against your real workspace (files, shell, git), and can talk to several LLM providers. The interactive `claw` CLI is the primary surface; a local web UI served by `claw-server` is also available.

> **Status:** early `0.x`, source-build / `npx` distribution. Focused on macOS and Linux developer workstations. It is **not** a port or copy of Claude Code.

---

## Highlights

- **Terminal-first agent loop** — interactive REPL and one-shot prompts that read, write, edit, search, and run shell commands in the current workspace.
- **Multiple providers** — Anthropic-compatible, DeepSeek, xAI/Grok, and OpenAI-compatible endpoints, plus OAuth login.
- **Built-in tools** — shell, file read/write/edit, glob/grep search, web fetch/search, todos, and notebook editing, gated by a read-only / workspace-write / full-access permission model.
- **MCP support** — connect Model Context Protocol stdio servers and surface their tools to the agent.
- **Extensible** — plugins, skills, local subagents, and a rich slash-command surface (`/help`, `/status`, `/model`, `/permissions`, `/compact`, `/diff`, `/export`, `/session`, …).
- **Context features** — RAG over local libraries and cross-session context summarization.
- **Workspace-aware** — discovers `CLAW.md`, config files, permissions, and plugin settings from the project.

## Architecture

The canonical implementation is the Rust Cargo workspace under [`rust/`](rust/); a React UI under [`frontend/`](frontend/) talks to the server over `/api/...`.

| Component | Crate / dir | Role |
|---|---|---|
| CLI (`claw`) | `rust/crates/claw-cli` | Interactive REPL + one-shot prompts |
| Server (`claw-server`) | `rust/crates/server` | HTTP API + embedded web UI |
| Web UI | `frontend/` (`claw-frontend`) | React front-end for the server |
| Providers | `rust/crates/api` | Provider clients and streaming |
| Runtime | `rust/crates/runtime` | Sessions, config, permissions, prompts, agent loop |
| Tools | `rust/crates/tools` | Built-in tool implementations |
| Commands | `rust/crates/commands` | Slash-command registry and handlers |
| Plugins | `rust/crates/plugins` | Plugin discovery, registry, lifecycle |
| Others | `lsp`, `vecdb`, `rag-poc`, `compat-harness` | LSP helpers, vector store, RAG, compatibility tooling |

## Quick start

### Run via npx (no build)

```bash
npx @theforge-ai/forge
```

### Build and run from source

Prerequisites: Rust stable toolchain + Cargo (Node 18+ only if you rebuild the web UI).

```bash
cd rust

# Interactive CLI
cargo run --bin claw                              # start the REPL
cargo run --bin claw -- -p "summarize this repo"  # one-shot prompt
cargo build --release -p claw-cli                 # -> target/release/claw

# Local web server + embedded UI
cargo run --bin claw-server
```

### Authentication

```bash
cargo run --bin claw -- login          # OAuth login flow
# …or provide credentials via environment:
export ANTHROPIC_API_KEY="..."         # Anthropic-compatible models
export XAI_API_KEY="..."               # xAI / Grok models
```

See [`rust/README.md`](rust/README.md) for the full CLI reference, supported capabilities, and current limitations.

## Verify

```bash
cd rust
cargo fmt
cargo clippy --workspace --all-targets
cargo test --workspace
```

## Documentation

- [`rust/README.md`](rust/README.md) — CLI install/usage and capability details
- [`CLAW.md`](CLAW.md) — repository conventions and working agreement
- [`PARITY.md`](PARITY.md) — feature-gap analysis vs. the original TypeScript prototype

## License

Licensed under Apache-2.0 — see [`LICENSE`](LICENSE).
