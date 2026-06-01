use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command as StdCommand;

use server::persistence;
use server::{app, install_webfetch_summarizer, AppState, McpServerEntry, ProviderCreds, ServerConfig};
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

/// Parsed CLI flags. Intentionally bare — we don't pull `clap` because
/// the surface is 4 options and `clap` is a non-trivial compile-time
/// cost on cold builds. Anything fancier (subcommands, completions)
/// can earn `clap` later.
#[derive(Default)]
struct CliArgs {
    /// Auto-launch the system browser at the server URL after binding.
    open: bool,
    /// `0` means "pick a free port". Otherwise overrides CLAW_SERVER_BIND.
    port: Option<u16>,
    /// Host to bind, default 127.0.0.1 (localhost only). `--host 0.0.0.0`
    /// to expose on LAN — only do this if you trust your network.
    host: Option<String>,
    /// Print the resolved URL and exit (for scripting / smoke tests).
    print_url_and_exit: bool,
}

fn parse_args() -> Result<CliArgs, String> {
    let mut args = CliArgs::default();
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--open" => args.open = true,
            "--print-url" => args.print_url_and_exit = true,
            "--port" => {
                let v = iter.next().ok_or("--port expects a value")?;
                args.port = Some(v.parse().map_err(|e| format!("invalid --port: {e}"))?);
            }
            "--host" => {
                args.host = Some(iter.next().ok_or("--host expects a value")?);
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--version" | "-V" => {
                println!("claw-server {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => return Err(format!("unknown flag: {other}")),
        }
    }
    Ok(args)
}

fn print_help() {
    println!(
        r#"claw-server — Forge.ai backend (also serves the bundled UI)

USAGE:
    claw-server [OPTIONS]

OPTIONS:
    --open          Open the system browser at the server URL after start.
    --port <PORT>   Port to bind. Use 0 to auto-pick a free port. Defaults
                    to 8787 (or CLAW_SERVER_BIND if set).
    --host <HOST>   Address to bind. Defaults to 127.0.0.1 (loopback only).
                    Pass 0.0.0.0 to expose on the LAN — only do so on
                    networks you trust; this server runs shell commands.
    --print-url     Print the bound URL to stdout and exit. Useful for
                    integration tests.
    -h, --help      Show this help.
    -V, --version   Print version.

ENVIRONMENT:
    CLAW_SERVER_BIND          Legacy: `host:port`, overridden by --port/--host.
    CLAW_SERVER_STATE_PATH    Persistence path (default ~/.claw/state.json,
                              empty string disables).
    CLAW_SERVER_PERMISSION_MODE   One-off permission mode override.
    CLAW_SERVER_MODEL         One-off chat model override.
"#
    );
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let cli = match parse_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            eprintln!("run with --help for usage.");
            std::process::exit(2);
        }
    };

    // Resolve bind address: CLI flags > env var > default.
    let host = cli.host.unwrap_or_else(|| {
        std::env::var("CLAW_SERVER_BIND")
            .ok()
            .and_then(|v| v.split(':').next().map(str::to_string))
            .unwrap_or_else(|| "127.0.0.1".to_string())
    });
    let port = cli.port.unwrap_or_else(|| {
        std::env::var("CLAW_SERVER_BIND")
            .ok()
            .and_then(|v| v.rsplit(':').next()?.parse::<u16>().ok())
            .unwrap_or(8787)
    });
    let address: SocketAddr = format!("{host}:{port}").parse()?;

    // Persistence is on by default: ServerConfig + provider creds + MCP
    // servers round-trip through `~/.claw/state.json` so a restart doesn't
    // wipe the user's model / workspace / embedding choices. Override the
    // location with CLAW_SERVER_STATE_PATH, or set it to the empty string
    // to opt out entirely.
    let persist_path = match std::env::var("CLAW_SERVER_STATE_PATH").ok() {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        }
        None => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".claw").join("state.json")),
    };
    if let Some(path) = persist_path.as_ref() {
        if let Some(parent) = path.parent() {
            // Best-effort — if mkdir fails we let `persistence::save` surface
            // the real error later. Common case is the dir already exists.
            let _ = std::fs::create_dir_all(parent);
        }
    }

    let mut config = ServerConfig::default();
    let mut providers: HashMap<String, ProviderCreds> = HashMap::new();
    let mut mcp_servers: HashMap<String, McpServerEntry> = HashMap::new();

    if let Some(path) = persist_path.as_ref() {
        match persistence::load(path) {
            Ok(Some(state)) => {
                tracing::info!(?path, "loaded persisted server state");
                config = state.config;
                providers = state
                    .providers
                    .into_iter()
                    .map(|(name, record)| (name, record.into()))
                    .collect();
                mcp_servers = state
                    .mcp_servers
                    .into_iter()
                    .map(|(name, record)| {
                        (
                            name,
                            McpServerEntry {
                                command: record.command,
                                args: record.args,
                                env: record.env,
                                enabled: record.enabled,
                            },
                        )
                    })
                    .collect();
            }
            Ok(None) => {
                tracing::info!(?path, "no persisted state yet; starting fresh");
            }
            Err(error) => {
                tracing::warn!(%error, ?path, "failed to load persisted state; starting fresh");
            }
        }
    } else {
        tracing::info!("persistence disabled (CLAW_SERVER_STATE_PATH unset)");
    }

    // Environment overrides take precedence over the persisted state. This lets you do a
    // one-off `CLAW_SERVER_MODEL=deepseek` to force a model without rewriting the file.
    if let Ok(mode) = std::env::var("CLAW_SERVER_PERMISSION_MODE") {
        if !mode.is_empty() {
            config.permission_mode = mode;
        }
    }
    if let Ok(model) = std::env::var("CLAW_SERVER_MODEL") {
        if !model.is_empty() {
            config.model = Some(model);
        }
    }

    tracing::info!(
        permission_mode = %config.permission_mode,
        model = config.model.as_deref().unwrap_or("(echo)"),
        provider_count = providers.len(),
        "starting with config"
    );

    // Push the persisted summarizer settings (if any) into the tools
    // crate's global slot BEFORE constructing AppState. WebFetch reads
    // this slot on every call; if we delayed past `app(state).serve()`
    // there's no race in practice (no requests yet) but installing
    // up-front keeps the dependency direction obvious: bin owns the
    // global wiring, server lib owns the per-request handlers.
    install_webfetch_summarizer(config.web_fetch_summarizer.as_ref());

    let state = match persist_path {
        Some(path) => AppState::with_full_persistence(path, config, providers, mcp_servers),
        None => {
            if !providers.is_empty() || !mcp_servers.is_empty() {
                tracing::warn!(
                    "discarding loaded providers / mcp servers because persistence is disabled"
                );
            }
            AppState::with_config(config)
        }
    };
    // Restore persisted chat sessions into the in-memory store before we
    // start serving, so the sidebar shows prior history on first load.
    // No-op when persistence is disabled.
    state.restore_persisted_sessions().await;
    // Kick off MCP discovery in the background — it spawns subprocesses, calls
    // initialize + tools/list, and caches the result. We don't block startup on it.
    {
        let bootstrap_state = state.clone();
        tokio::spawn(async move {
            bootstrap_state.refresh_mcp_tools().await;
        });
    }
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let router = app(state).layer(cors).layer(TraceLayer::new_for_http());

    // Bind FIRST so port=0 can be resolved into a real port before we
    // print or open a browser. Otherwise the printed URL would be wrong.
    let listener = TcpListener::bind(address).await?;
    let bound = listener.local_addr()?;
    // Display URL — prefer `localhost` over `127.0.0.1` for the user-
    // facing string because some browsers treat localhost as secure
    // context while loopback IPs occasionally trip mixed-content guards.
    let display_host = if bound.ip().is_loopback() {
        "localhost".to_string()
    } else {
        bound.ip().to_string()
    };
    let url = format!("http://{display_host}:{}", bound.port());

    tracing::info!(%bound, %url, "claw-server listening");
    // Loud print so users running by double-click see the URL even if
    // they don't have a log subscriber configured.
    println!();
    println!("  Forge.ai is ready → {url}");
    println!("  Open this URL in your browser. Press Ctrl-C to stop.");
    println!();

    if cli.print_url_and_exit {
        // Drop listener so the port frees before exit (smoke-test friendly).
        drop(listener);
        return Ok(());
    }

    if cli.open {
        let url_for_open = url.clone();
        // Spawn so a slow `open` doesn't delay the server actually
        // accepting requests. If it fails (no GUI / wrong platform),
        // log and move on — the user can still click the URL manually.
        std::thread::spawn(move || {
            if let Err(err) = open_in_browser(&url_for_open) {
                tracing::warn!(%err, "failed to auto-open browser; copy the URL above instead");
            }
        });
    }

    // Serve until Ctrl-C. axum::serve's graceful_shutdown ensures
    // in-flight connections drain before exit; without it long-lived
    // SSE streams would just get RST'd.
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("server stopped cleanly");
    Ok(())
}

/// Fires when the user hits Ctrl-C (or sends SIGTERM on Unix). On
/// macOS/Linux we listen for both SIGINT and SIGTERM; on Windows just
/// Ctrl-C since the SIGTERM equivalent is shutdown-style.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    println!("\n  Shutting down…");
}

/// Cross-platform "open this URL in the user's default browser".
/// Uses `open` on macOS, `xdg-open` on Linux, `start` via cmd on
/// Windows. Returns the spawn error as a string so the caller can log
/// without pulling in a richer error type.
fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![url]);
    #[cfg(target_os = "linux")]
    let cmd = ("xdg-open", vec![url]);
    #[cfg(target_os = "windows")]
    let cmd: (&str, Vec<&str>) = ("cmd", vec!["/C", "start", "", url]);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let cmd: (&str, Vec<&str>) = ("xdg-open", vec![url]);

    StdCommand::new(cmd.0)
        .args(cmd.1)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
