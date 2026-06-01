pub mod embedding;
pub mod persistence;
pub mod presets;
pub mod pricing;
pub mod rag;
pub mod registry;
pub mod registry_translate;
mod static_assets;

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use api::{
    context_window_for_model, max_tokens_for_model, resolve_model_alias, ContentBlockDelta,
    ImageSource, InputContentBlock as ApiInputContentBlock, InputMessage, MessageRequest,
    MessageResponse, OutputContentBlock, ProviderClient, StreamEvent as ApiStreamEvent,
    ToolDefinition, ToolResultContentBlock,
};
use async_stream::stream;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use commands::{slash_command_specs, SlashCommandCategory, SlashCommandSpec};
use runtime::{
    compact_session, estimate_session_tokens, ApiClient, ApiRequest, AssistantEvent,
    AttachmentKind, CompactionConfig, ConfigSource, ContentBlock, ConversationMessage,
    ConversationRuntime, ManagedMcpTool, McpServerConfig, McpServerManager, McpStdioServerConfig,
    MessageAttachment, MessageRole, PermissionMode, PermissionPolicy, PermissionPromptDecision,
    PermissionPrompter, PermissionRequest as RuntimePermissionRequest, ProjectContext,
    RuntimeError, ScopedMcpServerConfig, Session as RuntimeSession, SystemPromptBuilder,
    TokenUsage, ToolError, ToolExecutor, TurnObserver,
    UserQuestionAnswer, UserQuestionRequest, UserQuestioner,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::sync::Mutex as StdMutex;
use tokio::sync::{broadcast, oneshot, RwLock};
use tokio::task::JoinHandle;
use tools::{execute_tool as execute_catalog_tool, mvp_tool_specs, ToolSpec};

pub type SessionId = String;
pub type SessionStore = Arc<RwLock<HashMap<SessionId, Session>>>;
pub type SharedTurnDriver = Arc<dyn TurnDriver>;
pub type SharedServerConfig = Arc<RwLock<ServerConfig>>;
pub type ProviderCredStore = Arc<RwLock<HashMap<String, ProviderCreds>>>;

/// One pending prompt waiting on the user.
///
/// `sender` is the oneshot the runtime is parked on; dropping it causes
/// `blocking_recv()` to Err and lets the runtime thread exit cleanly
/// (without this, tokio's abort cannot pre-empt the spawn_blocking OS
/// thread). `replay_event` is a clone of the original SSE we broadcast
/// when the prompt was raised — we store it so a client that subscribes
/// AFTER the prompt was raised (reconnect / switch session) can be
/// shown the prompt instead of seeing a stuck turn with no UI.
pub struct PendingEntry<T> {
    pub session_id: SessionId,
    pub sender: oneshot::Sender<T>,
    pub replay_event: SessionEvent,
}

pub type PendingPermissionStore =
    Arc<StdMutex<HashMap<String, PendingEntry<PermissionPromptDecision>>>>;

pub type PendingQuestionStore =
    Arc<StdMutex<HashMap<String, PendingEntry<UserQuestionAnswer>>>>;

const BROADCAST_CAPACITY: usize = 64;
// `prompt` is the new safe default — every tool call surfaces a UI
// confirmation. Old default was `danger-full-access` which is fine for
// the dev's own machine but a footgun for a downloaded client where
// the user hasn't yet seen what the agent wants to do. They can flip
// it from the MODE badge in the ChatInput once they trust the setup.
const DEFAULT_PERMISSION_MODE: &str = "prompt";

/// Stored API credentials for a provider. Never serialized to clients — only
/// `configured: true/false` + optional base_url is exposed.
#[derive(Debug, Clone)]
pub struct ProviderCreds {
    pub api_key: String,
    pub base_url: Option<String>,
}

/// Runtime + persistable description of a stdio MCP server the user has installed.
#[derive(Debug, Clone)]
pub struct McpServerEntry {
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    /// Whether the server is currently enabled. Disabled entries stay in
    /// persistence (so the toggle can be flipped back later) but are skipped
    /// when registering with the runtime — no subprocess is spawned, no
    /// tools are surfaced.
    pub enabled: bool,
}

impl McpServerEntry {
    fn to_scoped_config(&self) -> ScopedMcpServerConfig {
        ScopedMcpServerConfig {
            scope: ConfigSource::User,
            config: McpServerConfig::Stdio(McpStdioServerConfig {
                command: self.command.clone(),
                args: self.args.clone(),
                env: self.env.clone(),
            }),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    sessions: SessionStore,
    next_session_id: Arc<AtomicU64>,
    turn_driver: SharedTurnDriver,
    config: SharedServerConfig,
    provider_creds: ProviderCredStore,
    persist_path: Option<Arc<PathBuf>>,
    pending_permissions: PendingPermissionStore,
    next_permission_id: Arc<AtomicU64>,
    pending_questions: PendingQuestionStore,
    next_question_id: Arc<AtomicU64>,
    mcp_records: Arc<RwLock<HashMap<String, McpServerEntry>>>,
    /// Live MCP process manager. Wrapped in tokio Mutex because tool dispatch needs
    /// `&mut self` and we want to share it with the executor running in spawn_blocking.
    mcp_manager: Arc<tokio::sync::Mutex<McpServerManager>>,
    /// Snapshot of discovered tools — refreshed after every successful discovery.
    /// Cheap to read from sync contexts (no manager lock needed for /tools).
    mcp_tools: Arc<StdMutex<Vec<ManagedMcpTool>>>,
    /// `true` while a `refresh_mcp_tools()` call is in flight. Lets the
    /// `/mcp/servers` endpoint report `discovery_status="discovering"` for
    /// servers whose tools list is still being fetched, instead of conflating
    /// "still starting" with "failed to start".
    mcp_discovery_in_flight: Arc<AtomicBool>,
    /// HTTP client + cache for the official MCP registry. Owned by AppState
    /// so the in-memory cache survives across request handlers.
    registry_client: registry::RegistryClient,
    /// RAG library store — sqlite-vec-backed knowledge bases the user can
    /// attach to a session for auto-retrieval before each turn.
    library_store: rag::LibraryStore,
    /// Live permission mode shared with in-flight turns. A turn's
    /// `PermissionPolicy` reads this atomic before each tool call, so a
    /// PATCH /config mode change takes effect at the next tool boundary
    /// instead of only on the following turn. Kept in sync with
    /// `config.permission_mode` by the PATCH /config handler.
    permission_mode: Arc<AtomicU8>,
}

impl AppState {
    #[must_use]
    pub fn new() -> Self {
        Self::with_parts(
            Arc::new(DefaultTurnDriver),
            ServerConfig::default(),
            HashMap::new(),
            None,
        )
    }

    #[must_use]
    pub fn with_turn_driver(turn_driver: SharedTurnDriver) -> Self {
        Self::with_parts(turn_driver, ServerConfig::default(), HashMap::new(), None)
    }

    #[must_use]
    pub fn with_config(config: ServerConfig) -> Self {
        Self::with_parts(Arc::new(DefaultTurnDriver), config, HashMap::new(), None)
    }

    /// Builds an `AppState` that persists `config` + provider credentials to `path`.
    /// On every mutation the new state is atomically written to disk (Unix mode 0600).
    #[must_use]
    pub fn with_persistence(
        path: PathBuf,
        config: ServerConfig,
        providers: HashMap<String, ProviderCreds>,
    ) -> Self {
        Self::with_parts(Arc::new(DefaultTurnDriver), config, providers, Some(path))
    }

    fn with_parts(
        turn_driver: SharedTurnDriver,
        config: ServerConfig,
        providers: HashMap<String, ProviderCreds>,
        persist_path: Option<PathBuf>,
    ) -> Self {
        Self::with_full_parts(turn_driver, config, providers, persist_path, HashMap::new())
    }

    /// Hydrated constructor used by the binary: takes MCP server records too. Tests
    /// keep using `with_*` constructors which default to an empty MCP set.
    #[must_use]
    pub fn with_full_persistence(
        path: PathBuf,
        config: ServerConfig,
        providers: HashMap<String, ProviderCreds>,
        mcp_servers: HashMap<String, McpServerEntry>,
    ) -> Self {
        Self::with_full_parts(
            Arc::new(DefaultTurnDriver),
            config,
            providers,
            Some(path),
            mcp_servers,
        )
    }

    fn with_full_parts(
        turn_driver: SharedTurnDriver,
        config: ServerConfig,
        providers: HashMap<String, ProviderCreds>,
        persist_path: Option<PathBuf>,
        mcp_servers: HashMap<String, McpServerEntry>,
    ) -> Self {
        let scoped: std::collections::BTreeMap<String, ScopedMcpServerConfig> = mcp_servers
            .iter()
            .map(|(name, entry)| (name.clone(), entry.to_scoped_config()))
            .collect();
        let manager = McpServerManager::from_servers(&scoped);
        // Use the configured embedding dim for sqlite-vec DDL. Falls back
        // to OpenAI default (1536) when nothing's configured yet — same
        // dim the OpenAI fallback path uses for embedding.
        let embedding_dim = config
            .embedding_provider
            .as_ref()
            .map(|p| p.dimensions as usize)
            .unwrap_or(rag::DEFAULT_EMBEDDING_DIM);
        let initial_permission_mode = parse_permission_mode(&config.permission_mode)
            .unwrap_or(PermissionMode::Prompt)
            .as_u8();
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            next_session_id: Arc::new(AtomicU64::new(1)),
            turn_driver,
            config: Arc::new(RwLock::new(config)),
            provider_creds: Arc::new(RwLock::new(providers)),
            persist_path: persist_path.map(Arc::new),
            pending_permissions: Arc::new(StdMutex::new(HashMap::new())),
            next_permission_id: Arc::new(AtomicU64::new(1)),
            pending_questions: Arc::new(StdMutex::new(HashMap::new())),
            next_question_id: Arc::new(AtomicU64::new(1)),
            mcp_records: Arc::new(RwLock::new(mcp_servers)),
            mcp_manager: Arc::new(tokio::sync::Mutex::new(manager)),
            mcp_tools: Arc::new(StdMutex::new(Vec::new())),
            // Start `true` because bootstrap spawns a refresh before any HTTP
            // request can be served — flipping it false on completion lets
            // the very first /mcp/servers hit reflect reality.
            mcp_discovery_in_flight: Arc::new(AtomicBool::new(true)),
            registry_client: registry::RegistryClient::new(),
            library_store: rag::LibraryStore::new(
                rag::LibraryStore::default_root(),
                embedding_dim,
            ),
            permission_mode: Arc::new(AtomicU8::new(initial_permission_mode)),
        }
    }

    /// Discover tools across all configured MCP servers. Logs and continues on per-server
    /// failures so one broken server doesn't prevent the others from being usable.
    /// Caches the result in `mcp_tools` so the sync `/tools` endpoint can read it cheaply.
    pub async fn refresh_mcp_tools(&self) {
        self.mcp_discovery_in_flight.store(true, Ordering::SeqCst);
        let mut manager = self.mcp_manager.lock().await;
        let report = manager.discover_tools().await;
        let tool_count = report.tools.len();
        let failure_count = report.failures.len();
        if let Ok(mut guard) = self.mcp_tools.lock() {
            *guard = report.tools;
        }
        for failure in &report.failures {
            tracing::warn!(
                server = %failure.server_name,
                error = %failure.error,
                "MCP server discovery failed",
            );
        }
        tracing::info!(
            mcp_tool_count = tool_count,
            failed_servers = failure_count,
            "MCP discovery sweep complete",
        );
        self.mcp_discovery_in_flight.store(false, Ordering::SeqCst);
    }

    /// Rebuild the manager from the current records map. Call after a /mcp/servers
    /// mutation. Old subprocesses are best-effort shutdown. Tool discovery runs in the
    /// background because spawning a fresh MCP server and waiting for its initialize +
    /// tools/list response can take many seconds (npm download, slow language runtime,
    /// …) and we don't want to block the PUT response on that.
    async fn rebuild_mcp_manager(&self) {
        let scoped: std::collections::BTreeMap<String, ScopedMcpServerConfig> = {
            let records = self.mcp_records.read().await;
            records
                .iter()
                .filter(|(_, entry)| entry.enabled)
                .map(|(name, entry)| (name.clone(), entry.to_scoped_config()))
                .collect()
        };
        let new_manager = McpServerManager::from_servers(&scoped);
        {
            let mut guard = self.mcp_manager.lock().await;
            // Best-effort shutdown of the previous manager's subprocesses before swapping.
            let _ = guard.shutdown().await;
            *guard = new_manager;
        }
        let bg = self.clone();
        tokio::spawn(async move {
            bg.refresh_mcp_tools().await;
        });
    }


    fn allocate_session_id(&self) -> SessionId {
        let id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        format!("session-{id}")
    }

    async fn persist_now(&self) {
        let Some(path) = self.persist_path.clone() else {
            return;
        };
        let state = self.persisted_snapshot().await;
        let outcome = tokio::task::spawn_blocking(move || persistence::save(&path, &state)).await;
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "failed to persist server state");
            }
            Err(error) => {
                tracing::warn!(%error, "persistence task panicked");
            }
        }
    }

    async fn persisted_snapshot(&self) -> persistence::PersistedState {
        let config = self.config.read().await.clone();
        let providers = self
            .provider_creds
            .read()
            .await
            .iter()
            .map(|(name, creds)| (name.clone(), creds.clone().into()))
            .collect();
        let mcp_servers = self
            .mcp_records
            .read()
            .await
            .iter()
            .map(|(name, entry)| {
                (
                    name.clone(),
                    persistence::McpServerRecord {
                        command: entry.command.clone(),
                        args: entry.args.clone(),
                        env: entry.env.clone(),
                        enabled: entry.enabled,
                    },
                )
            })
            .collect();
        persistence::PersistedState {
            config,
            providers,
            mcp_servers,
        }
    }

    /// Directory for per-session files, or `None` when persistence is
    /// disabled (`CLAW_SERVER_STATE_PATH` empty / unset).
    fn sessions_dir(&self) -> Option<PathBuf> {
        self.persist_path
            .as_ref()
            .map(|path| persistence::sessions_dir(path))
    }

    /// Snapshot one session to disk. No-op when persistence is off or the
    /// session is gone. The blocking write runs off the async executor and
    /// failures are logged, never propagated — a persistence hiccup must
    /// not fail the user's turn.
    async fn persist_session(&self, id: &SessionId) {
        let Some(dir) = self.sessions_dir() else {
            return;
        };
        let persisted = {
            let sessions = self.sessions.read().await;
            let Some(session) = sessions.get(id) else {
                return;
            };
            session.to_persisted()
        };
        let outcome =
            tokio::task::spawn_blocking(move || persistence::save_session(&dir, &persisted)).await;
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(%error, session = %id, "failed to persist session"),
            Err(error) => tracing::warn!(%error, session = %id, "session persist task panicked"),
        }
    }

    /// Delete a session's on-disk file. No-op when persistence is off.
    async fn forget_session(&self, id: &SessionId) {
        let Some(dir) = self.sessions_dir() else {
            return;
        };
        let id_owned = id.clone();
        let outcome =
            tokio::task::spawn_blocking(move || persistence::delete_session(&dir, &id_owned)).await;
        if let Ok(Err(error)) = outcome {
            tracing::warn!(%error, session = %id, "failed to delete persisted session");
        }
    }

    /// Load persisted sessions from disk into the in-memory store at
    /// startup, and bump `next_session_id` past the highest restored id so
    /// freshly created sessions don't collide. No-op when persistence is
    /// off or no session files exist.
    pub async fn restore_persisted_sessions(&self) {
        let Some(dir) = self.sessions_dir() else {
            return;
        };
        let restored =
            match tokio::task::spawn_blocking(move || persistence::load_sessions(&dir)).await {
                Ok(list) => list,
                Err(error) => {
                    tracing::warn!(%error, "session restore task panicked");
                    return;
                }
            };
        if restored.is_empty() {
            return;
        }
        let count = restored.len();
        let mut max_id = 0u64;
        {
            let mut sessions = self.sessions.write().await;
            for persisted in restored {
                if let Some(n) = persisted
                    .id
                    .strip_prefix("session-")
                    .and_then(|suffix| suffix.parse::<u64>().ok())
                {
                    max_id = max_id.max(n);
                }
                let session = Session::from_persisted(persisted);
                sessions.insert(session.id.clone(), session);
            }
        }
        if max_id >= self.next_session_id.load(Ordering::Relaxed) {
            self.next_session_id.store(max_id + 1, Ordering::Relaxed);
        }
        tracing::info!(count, "restored persisted sessions");
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Session {
    pub id: SessionId,
    pub created_at: u64,
    pub conversation: RuntimeSession,
    events: broadcast::Sender<SessionEvent>,
    current_turn: Option<JoinHandle<()>>,
    /// Per-session set of MCP server names that are "attached" — i.e. their
    /// tool schemas are exposed to the LLM and their tools can be called.
    /// Defaults to empty so a fresh session pays zero MCP token tax. The
    /// model attaches what it needs via the `attach_mcp_server` meta-tool.
    /// Shared via Arc<Mutex> so the in-turn tool executor can mutate it
    /// while the HTTP handler holds a read lock on the sessions store.
    pub attached_mcps: Arc<StdMutex<std::collections::BTreeSet<String>>>,
    /// RAG library bound to this session — when `Some(name)`, every user
    /// turn auto-retrieves top-K chunks before the LLM call and the
    /// chunks ride along with the user message as `retrieved_context`.
    /// Per-session so concurrent sessions can target different libraries.
    pub attached_library: Arc<StdMutex<Option<String>>>,
    /// Cooperative cancel flag, set by `cancel_turn` and checked by the
    /// runtime at iter boundaries. `tokio::spawn_blocking` can't be
    /// aborted from outside (the OS thread keeps running), so this is
    /// the only way to bring a long-running turn to a clean stop.
    /// Reset to `false` whenever a new turn starts.
    pub cancel_signal: Arc<AtomicBool>,
    /// "Allow always" approvals the user granted this session. Each key is a
    /// command prefix (`bash:<program>`) or a tool name; a permission prompt
    /// whose key is present is auto-approved instead of re-asking. Shared via
    /// Arc<Mutex> so the in-turn `ServerPrompter` reads it and the HTTP
    /// decision handler writes it. In-memory only — deliberately NOT persisted,
    /// so approvals reset on restart.
    pub allow_rules: Arc<StdMutex<std::collections::BTreeSet<String>>>,
}

impl Session {
    fn new(id: SessionId) -> Self {
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            id,
            created_at: unix_timestamp_millis(),
            conversation: RuntimeSession::new(),
            events,
            current_turn: None,
            attached_mcps: Arc::new(StdMutex::new(std::collections::BTreeSet::new())),
            attached_library: Arc::new(StdMutex::new(None)),
            cancel_signal: Arc::new(AtomicBool::new(false)),
            allow_rules: Arc::new(StdMutex::new(std::collections::BTreeSet::new())),
        }
    }

    /// Rebuild a session from its on-disk form. The broadcast channel,
    /// turn handle, and cancel flag are runtime-only and recreated fresh —
    /// a restored session is never mid-turn.
    fn from_persisted(persisted: persistence::PersistedSession) -> Self {
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            id: persisted.id,
            created_at: persisted.created_at,
            conversation: persisted.conversation,
            events,
            current_turn: None,
            attached_mcps: Arc::new(StdMutex::new(persisted.attached_mcps)),
            attached_library: Arc::new(StdMutex::new(persisted.attached_library)),
            cancel_signal: Arc::new(AtomicBool::new(false)),
            // Allow-always approvals are in-memory only; a restored session
            // starts with none, so the user re-approves after a restart.
            allow_rules: Arc::new(StdMutex::new(std::collections::BTreeSet::new())),
        }
    }

    /// Snapshot the serializable parts of this session for persistence.
    fn to_persisted(&self) -> persistence::PersistedSession {
        let attached_mcps = self
            .attached_mcps
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default();
        let attached_library = self.attached_library.lock().ok().and_then(|g| g.clone());
        persistence::PersistedSession {
            id: self.id.clone(),
            created_at: self.created_at,
            conversation: self.conversation.clone(),
            attached_mcps,
            attached_library,
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    fn turn_in_flight(&self) -> bool {
        self.current_turn
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
    }
}

pub struct TurnExecution {
    pub session: RuntimeSession,
    pub events: Vec<SessionEvent>,
}

/// Bundle of MCP runtime state passed into a turn. The manager dispatches `mcp__*`
/// tool calls; the snapshot is the JSON schemas we hand to the provider so it knows
/// the tools exist.
#[derive(Clone)]
pub struct McpRuntimeBundle {
    pub manager: Arc<tokio::sync::Mutex<McpServerManager>>,
    /// Every discovered MCP tool's JSON schema. Filtered down to the
    /// attached subset before being sent to the provider on each turn.
    pub tool_definitions: Vec<ToolDefinition>,
    /// Raw `ManagedMcpTool` list — fed into the executor so the
    /// `list_mcp_servers` meta-tool can answer with stable group-by-server
    /// info without re-acquiring the global lock mid-turn.
    pub tools_snapshot: Vec<ManagedMcpTool>,
    /// Per-session "currently attached" set. Cloned (Arc) so the in-turn
    /// executor can mutate it and the next turn picks up the change.
    pub attached_mcps: Arc<StdMutex<std::collections::BTreeSet<String>>>,
}

pub trait TurnDriver: Send + Sync + 'static {
    #[allow(clippy::too_many_arguments)]
    fn run_turn(
        &self,
        session_id: SessionId,
        session: RuntimeSession,
        user_message: ConversationMessage,
        config: ServerConfig,
        creds: Option<ProviderCreds>,
        prompter: Option<Box<dyn PermissionPrompter + Send>>,
        questioner: Option<Box<dyn UserQuestioner>>,
        observer: Option<Box<dyn TurnObserver>>,
        mcp: Option<McpRuntimeBundle>,
        live_permission_mode: Arc<AtomicU8>,
    ) -> Result<TurnExecution, String>;
}

/// Streams runtime progress back to the server while a turn is still running. The
/// `ConversationRuntime` calls `on_message` immediately after pushing an assistant
/// message (which may contain tool_use blocks) or a tool_result message; the observer
/// (1) broadcasts the matching SSE events so the UI updates live, and (2) writes the
/// new message into the session store so a REST `/sessions/:id` poll mid-turn sees the
/// in-progress state. Without this, every event was buffered until `run_turn` returned.
pub struct ServerTurnObserver {
    session_id: SessionId,
    broadcaster: broadcast::Sender<SessionEvent>,
    sessions: SessionStore,
    /// Shared with `Session.cancel_signal` and `cancel_turn` — the
    /// runtime polls this at iter boundaries to bail out of long turns
    /// the spawn_blocking abort can't actually stop.
    cancel_signal: Arc<AtomicBool>,
}

impl TurnObserver for ServerTurnObserver {
    fn on_message(&mut self, message: &ConversationMessage) {
        // Write the message back into the session store so REST reads see it.
        // We're inside a blocking thread (spawn_blocking) so `blocking_write` is OK.
        let cloned = message.clone();
        let session_id = self.session_id.clone();
        let sessions = self.sessions.clone();
        let mut guard = sessions.blocking_write();
        if let Some(session) = guard.get_mut(&session_id) {
            session.conversation.messages.push(cloned);
        }
        drop(guard);

        for event in
            SessionEvent::from_conversation_message(self.session_id.clone(), message.clone())
        {
            let _ = self.broadcaster.send(event);
        }
    }

    fn cancel_signal(&self) -> Option<Arc<AtomicBool>> {
        Some(self.cancel_signal.clone())
    }

    fn delta_observer(&self) -> Option<Arc<dyn Fn(&AssistantEvent) + Send + Sync>> {
        // Build a closure that turns each AssistantEvent::TextDelta /
        // ReasoningDelta into a `SessionEvent` and broadcasts it. The
        // provider client calls this inside its streaming loop, so the
        // SSE receiver sees characters within a few ms of them arriving
        // from the LLM — vs. the previous model where the whole turn
        // had to finish before anything reached the UI.
        let broadcaster = self.broadcaster.clone();
        let session_id = self.session_id.clone();
        Some(Arc::new(move |event: &AssistantEvent| {
            match event {
                AssistantEvent::TextDelta(text) => {
                    let _ = broadcaster.send(SessionEvent::AssistantDelta {
                        session_id: session_id.clone(),
                        text: text.clone(),
                    });
                }
                AssistantEvent::ReasoningDelta(text) => {
                    let _ = broadcaster.send(SessionEvent::ReasoningDelta {
                        session_id: session_id.clone(),
                        text: text.clone(),
                    });
                }
                // Tool use, Usage, MessageStop don't stream as deltas —
                // they arrive at-once via on_message after the turn
                // builds the assistant message.
                _ => {}
            }
        }))
    }
}

/// Bridge between the synchronous runtime prompter trait and the async server. When the
/// conversation loop asks for permission we (1) generate a request id, (2) park a oneshot
/// sender keyed by that id, (3) broadcast a `permission_request` SSE event, and (4) block
/// the current thread on the oneshot. The matching `/sessions/:id/permissions/:request_id/decision`
/// endpoint pops the sender and resolves the future.
pub struct ServerPrompter {
    session_id: SessionId,
    pending: PendingPermissionStore,
    broadcaster: broadcast::Sender<SessionEvent>,
    next_id: Arc<AtomicU64>,
    /// "Allow always" approvals granted earlier this session. Cloned (Arc)
    /// from the session so the HTTP decision handler can add to it. When a
    /// request's rule key is already present we auto-approve without ever
    /// broadcasting a `permission_request` — that's what stops the hundreds
    /// of repeat prompts for the same command.
    allow_rules: Arc<StdMutex<std::collections::BTreeSet<String>>>,
}

impl ServerPrompter {
    fn next_request_id(&self) -> String {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("perm-{id}")
    }
}

impl PermissionPrompter for ServerPrompter {
    fn decide(&mut self, request: &RuntimePermissionRequest) -> PermissionPromptDecision {
        // Auto-approve if the user already chose "Allow always" for this
        // command prefix / tool earlier in the session.
        if let Some(key) = permission_rule_key(&request.tool_name, &request.input) {
            let remembered = self
                .allow_rules
                .lock()
                .map(|guard| guard.contains(&key))
                .unwrap_or(false);
            if remembered {
                return PermissionPromptDecision::Allow;
            }
        }
        let request_id = self.next_request_id();
        let (tx, rx) = oneshot::channel::<PermissionPromptDecision>();
        let event = SessionEvent::PermissionRequest {
            session_id: self.session_id.clone(),
            request_id: request_id.clone(),
            tool_name: request.tool_name.clone(),
            input: request.input.clone(),
            current_mode: request.current_mode.as_str().to_string(),
            required_mode: request.required_mode.as_str().to_string(),
        };
        {
            let mut pending = match self.pending.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            pending.insert(
                request_id.clone(),
                PendingEntry {
                    session_id: self.session_id.clone(),
                    sender: tx,
                    replay_event: event.clone(),
                },
            );
        }
        let _ = self.broadcaster.send(event);
        match rx.blocking_recv() {
            Ok(decision) => decision,
            Err(_) => {
                // Sender dropped — either the user cancelled the turn,
                // deleted the session, or the server is tearing down. In
                // all three the cleanup path has already pulled this
                // entry, but we double-check to keep the map tidy.
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&request_id);
                }
                PermissionPromptDecision::Deny {
                    reason: "permission decision channel closed (turn cancelled or session removed)".to_string(),
                }
            }
        }
    }
}

/// Key under which an "Allow always" approval is remembered for a prompt.
/// Per the chosen "per command prefix" granularity: a bash command keys on
/// its leading program (`bash:git`, `bash:npm`) when it's a single simple
/// segment, so approving `git status` also covers later `git` calls. Compound
/// or redirected commands (anything with `&&`, `|`, `>`, `$(`, …) are too
/// risky to generalize, so they're remembered by exact text instead. Every
/// other tool keys on its name. `None` means "no stable key — never
/// auto-approve".
fn permission_rule_key(tool_name: &str, input: &str) -> Option<String> {
    if tool_name != "bash" {
        return Some(tool_name.to_string());
    }
    let command = serde_json::from_str::<JsonValue>(input)
        .ok()
        .and_then(|v| {
            v.get("command")
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    if is_simple_single_segment(trimmed) {
        let first = trimmed.split_whitespace().next()?;
        let basename = first.rsplit(['/', '\\']).next().unwrap_or(first);
        return Some(format!("bash:{basename}"));
    }
    Some(format!("bash:exact:{trimmed}"))
}

/// `true` when a bash command is a single segment with no shell operators —
/// safe to generalize an "Allow always" to its leading program. Errs toward
/// `false` (exact-match remembering) for anything containing chaining,
/// pipes, redirects, subshells, backgrounding, or newlines, even inside
/// quotes: over-conservative here only costs an extra prompt, never safety.
fn is_simple_single_segment(command: &str) -> bool {
    const OPERATORS: [&str; 8] = ["&&", "||", ";", "|", ">", "<", "$(", "`"];
    if command.contains('\n') {
        return false;
    }
    if OPERATORS.iter().any(|op| command.contains(op)) {
        return false;
    }
    // A bare `&` (backgrounding) also makes the command compound.
    !command.contains('&')
}

/// Async-to-sync bridge for the AskUser tool, structurally identical to
/// `ServerPrompter` above: generate a question id, park a oneshot sender
/// in the shared pending map, broadcast the SSE, then block until the
/// HTTP answer endpoint resolves it (or the channel drops on cancel).
pub struct ServerQuestioner {
    session_id: SessionId,
    pending: PendingQuestionStore,
    broadcaster: broadcast::Sender<SessionEvent>,
    next_id: Arc<AtomicU64>,
}

impl ServerQuestioner {
    fn next_question_id(&self) -> String {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("ask-{id}")
    }
}

impl UserQuestioner for ServerQuestioner {
    fn ask(&mut self, request: &UserQuestionRequest) -> UserQuestionAnswer {
        let question_id = self.next_question_id();
        let (tx, rx) = oneshot::channel::<UserQuestionAnswer>();
        // Translate options to the SSE-side shape (mostly identical, but
        // we don't want to leak the runtime trait into the wire schema).
        let options: Vec<SessionQuestionOption> = request
            .options
            .iter()
            .map(|opt| SessionQuestionOption {
                label: opt.label.clone(),
                description: opt.description.clone(),
            })
            .collect();
        let event = SessionEvent::UserQuestion {
            session_id: self.session_id.clone(),
            question_id: question_id.clone(),
            question: request.question.clone(),
            header: request.header.clone(),
            options,
            allow_other: request.allow_other,
        };
        {
            let mut pending = match self.pending.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            pending.insert(
                question_id.clone(),
                PendingEntry {
                    session_id: self.session_id.clone(),
                    sender: tx,
                    replay_event: event.clone(),
                },
            );
        }
        let _ = self.broadcaster.send(event);
        match rx.blocking_recv() {
            Ok(answer) => answer,
            Err(_) => {
                // Sender dropped without sending — turn was cancelled
                // or server is tearing down. Clean up the pending entry
                // (just in case) and surface a dismissal so the runtime
                // returns a clean tool_result instead of hanging.
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&question_id);
                }
                UserQuestionAnswer::Dismissed
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultTurnDriver;

impl TurnDriver for DefaultTurnDriver {
    fn run_turn(
        &self,
        session_id: SessionId,
        session: RuntimeSession,
        user_message: ConversationMessage,
        config: ServerConfig,
        creds: Option<ProviderCreds>,
        prompter: Option<Box<dyn PermissionPrompter + Send>>,
        questioner: Option<Box<dyn UserQuestioner>>,
        observer: Option<Box<dyn TurnObserver>>,
        mcp: Option<McpRuntimeBundle>,
        live_permission_mode: Arc<AtomicU8>,
    ) -> Result<TurnExecution, String> {
        // Set the process CWD to the configured workspace_root so file tools resolve
        // relative paths correctly and bash inherits it. This is process-wide so it
        // assumes one turn at a time; the server already rejects concurrent turns
        // on the same session, and cross-session workspace is currently shared.
        if let Some(root) = config.workspace_root.as_deref() {
            if !root.is_empty() {
                if let Err(err) = std::env::set_current_dir(root) {
                    return Err(format!(
                        "failed to enter workspace `{root}`: {err}"
                    ));
                }
            }
        }
        let permission_mode = parse_permission_mode(&config.permission_mode)?;
        let model = config.model.as_deref().filter(|value| !value.is_empty());
        // Resolve the iteration cap once here so both branches see the
        // same value. Zero in the config means "use default" — this lets
        // older persisted state files lacking the field fall back safely
        // instead of silently disabling the brake.
        let iter_cap = if config.max_tool_iterations_per_turn == 0 {
            default_max_iter()
        } else {
            config.max_tool_iterations_per_turn
        } as usize;
        match model {
            None => execute_turn(
                session_id,
                session,
                user_message,
                permission_mode,
                None,
                LocalEchoApiClient,
                prompter,
                questioner,
                observer,
                mcp,
                iter_cap,
                live_permission_mode,
            ),
            Some(model) => {
                let resolved = resolve_model_alias(model);
                // Hand the FULL MCP tool catalog + the shared attached set
                // to the client. It re-derives the filtered tool list each
                // iteration so attach/detach issued mid-turn show up in the
                // very next LLM call without waiting for the next user
                // message. The 3 meta-tools ride along whenever any MCP
                // server is configured.
                let (mcp_tool_definitions, attached_handle, expose_meta) =
                    if let Some(bundle) = mcp.as_ref() {
                        (
                            bundle.tool_definitions.clone(),
                            bundle.attached_mcps.clone(),
                            !bundle.tools_snapshot.is_empty(),
                        )
                    } else {
                        (
                            Vec::new(),
                            Arc::new(StdMutex::new(std::collections::BTreeSet::new())),
                            false,
                        )
                    };
                let model_name = resolved.to_string();
                // Pull the delta observer off the TurnObserver BEFORE the
                // observer is moved into execute_turn. Lets per-token
                // streaming reach the SSE broadcaster while the runtime
                // is still consuming the LLM stream.
                let delta_observer = observer.as_ref().and_then(|o| o.delta_observer());
                let mut client = ProviderRuntimeClient::new(
                    resolved,
                    creds,
                    mcp_tool_definitions,
                    attached_handle,
                    expose_meta,
                )?;
                if let Some(obs) = delta_observer {
                    client = client.with_delta_observer(obs);
                }
                execute_turn(
                    session_id,
                    session,
                    user_message,
                    permission_mode,
                    Some(model_name),
                    client,
                    prompter,
                    questioner,
                    observer,
                    mcp,
                    iter_cap,
                    live_permission_mode,
                )
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_turn<C: ApiClient>(
    session_id: SessionId,
    session: RuntimeSession,
    user_message: ConversationMessage,
    permission_mode: PermissionMode,
    model: Option<String>,
    api_client: C,
    mut prompter: Option<Box<dyn PermissionPrompter + Send>>,
    questioner: Option<Box<dyn UserQuestioner>>,
    observer: Option<Box<dyn TurnObserver>>,
    mcp: Option<McpRuntimeBundle>,
    iter_cap: usize,
    live_permission_mode: Arc<AtomicU8>,
) -> Result<TurnExecution, String> {
    let observer_present = observer.is_some();
    let original_message_count = session.messages.len();
    let workspace_root = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| ".".to_string());
    let executor = CombinedToolExecutor {
        mcp_manager: mcp
            .as_ref()
            .map(|bundle| bundle.manager.clone())
            .unwrap_or_else(|| {
                Arc::new(tokio::sync::Mutex::new(McpServerManager::from_servers(
                    &std::collections::BTreeMap::new(),
                )))
            }),
        attached_mcps: mcp
            .as_ref()
            .map(|bundle| bundle.attached_mcps.clone())
            .unwrap_or_else(|| Arc::new(StdMutex::new(std::collections::BTreeSet::new()))),
        mcp_tools_snapshot: mcp
            .as_ref()
            .map(|bundle| bundle.tools_snapshot.clone())
            .unwrap_or_default(),
    };
    let mut runtime = ConversationRuntime::new(
        session,
        api_client,
        executor,
        build_permission_policy(permission_mode, live_permission_mode),
        agent_system_prompt(
            permission_mode,
            &workspace_root,
            model.as_deref(),
            mcp.as_ref(),
        ),
    );
    runtime = runtime.with_max_iterations(iter_cap);
    runtime = runtime.with_model(model.clone());
    if let Some(observer) = observer {
        runtime = runtime.with_observer(observer);
    }
    if let Some(q) = questioner {
        runtime = runtime.with_questioner(q);
    }
    let prompter_arg = prompter.as_deref_mut().map(|p| p as &mut dyn PermissionPrompter);
    runtime
        .run_turn_with_message(user_message, prompter_arg)
        .map_err(|error| error.to_string())?;

    // If an observer is wired the SSE events were broadcast in real time, so we return
    // an empty event list to avoid duplicates. Without an observer, fall back to the
    // historical behaviour of collecting once at the end.
    let events = if observer_present {
        Vec::new()
    } else {
        runtime.session().messages[original_message_count..]
            .iter()
            .filter(|message| message.role != MessageRole::User)
            .cloned()
            .flat_map(|message| {
                SessionEvent::from_conversation_message(session_id.clone(), message)
            })
            .collect()
    };

    Ok(TurnExecution {
        session: runtime.into_session(),
        events,
    })
}

async fn resolve_creds_for_turn(state: &AppState, config: &ServerConfig) -> Option<ProviderCreds> {
    let model = config.model.as_deref()?.trim();
    if model.is_empty() {
        return None;
    }
    let provider_name = provider_name_for_model(model)?;
    let store = state.provider_creds.read().await;
    store.get(provider_name).cloned()
}

/// Maps a user-typed model string to the canonical provider key used in the creds store.
fn provider_name_for_model(model: &str) -> Option<&'static str> {
    let lower = model.trim().to_ascii_lowercase();
    if lower.starts_with("claude-") || lower == "opus" || lower == "sonnet" || lower == "haiku" {
        return Some("anthropic");
    }
    if lower.starts_with("deepseek") {
        return Some("deepseek");
    }
    if lower.starts_with("grok") {
        return Some("xai");
    }
    if lower == "openai-compatible"
        || lower.starts_with("openai-compat/")
        || lower.starts_with("openai-compatible/")
    {
        return Some("openai-compat");
    }
    if lower.starts_with("gpt-") || lower.starts_with("o1") || lower.starts_with("o3") {
        return Some("openai");
    }
    None
}

fn parse_permission_mode(mode: &str) -> Result<PermissionMode, String> {
    match mode {
        "read-only" => Ok(PermissionMode::ReadOnly),
        "workspace-write" => Ok(PermissionMode::WorkspaceWrite),
        "danger-full-access" => Ok(PermissionMode::DangerFullAccess),
        "prompt" => Ok(PermissionMode::Prompt),
        "allow" => Ok(PermissionMode::Allow),
        other => Err(format!("unknown permission mode `{other}`")),
    }
}

struct ProviderRuntimeClient {
    runtime: tokio::runtime::Runtime,
    client: ProviderClient,
    model: String,
    /// Full MCP tool catalog snapshot taken at turn start. Filtered down to
    /// the currently-attached subset on every `stream()` call so an attach
    /// done mid-turn (via meta-tool) takes effect on the very next iteration
    /// of the agent loop, not only on the next user turn.
    mcp_tool_definitions: Vec<ToolDefinition>,
    /// Shared with the executor — the meta-tool handlers mutate this set,
    /// and we re-read it each `stream()` to compute the filtered tool list.
    attached_mcps: Arc<StdMutex<std::collections::BTreeSet<String>>>,
    /// Whether to expose the 3 MCP meta-tools at all (only when at least one
    /// MCP server is configured).
    expose_meta_tools: bool,
    /// Per-delta hook. The runtime returns events to `run_turn_with_message`
    /// only after the whole LLM stream is consumed, but for the SSE
    /// pipeline we want characters to reach the user as they arrive.
    /// This closure (set by `send_message` before kicking off the turn)
    /// fires inside the stream loop for every TextDelta / ReasoningDelta
    /// so the broadcaster can emit live `assistant_delta` /
    /// `reasoning_delta` events.
    delta_observer: Option<Arc<dyn Fn(&AssistantEvent) + Send + Sync>>,
}

impl ProviderRuntimeClient {
    fn new(
        model: String,
        creds: Option<ProviderCreds>,
        mcp_tool_definitions: Vec<ToolDefinition>,
        attached_mcps: Arc<StdMutex<std::collections::BTreeSet<String>>>,
        expose_meta_tools: bool,
    ) -> Result<Self, String> {
        let client = match creds {
            Some(creds) => ProviderClient::from_model_with_credentials(
                &model,
                creds.api_key,
                creds.base_url,
            ),
            None => ProviderClient::from_model(&model),
        }
        .map_err(|error| error.to_string())?;
        Ok(Self {
            runtime: tokio::runtime::Runtime::new().map_err(|error| error.to_string())?,
            client,
            mcp_tool_definitions,
            attached_mcps,
            expose_meta_tools,
            model,
            delta_observer: None,
        })
    }

    fn with_delta_observer(
        mut self,
        observer: Arc<dyn Fn(&AssistantEvent) + Send + Sync>,
    ) -> Self {
        self.delta_observer = Some(observer);
        self
    }

    /// Re-compute the per-iteration tool list. Pulls in:
    ///   - builtin catalog (always)
    ///   - currently-attached MCP tool schemas (from the shared `attached_mcps` set)
    ///   - the 3 MCP meta-tools when any MCP server is configured
    fn current_extra_tools(&self) -> Vec<ToolDefinition> {
        let attached = self
            .attached_mcps
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let mut tools: Vec<ToolDefinition> = self
            .mcp_tool_definitions
            .iter()
            .filter(|def| {
                def.name
                    .strip_prefix("mcp__")
                    .and_then(|rest| rest.split("__").next())
                    .is_some_and(|server| attached.contains(server))
            })
            .cloned()
            .collect();
        if self.expose_meta_tools {
            tools.extend(mcp_meta_tool_definitions());
        }
        tools
    }
}

impl ApiClient for ProviderRuntimeClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let message_request = MessageRequest {
            model: self.model.clone(),
            max_tokens: max_tokens_for_model(&self.model),
            messages: convert_messages(&request.messages),
            system: (!request.system_prompt.is_empty()).then(|| request.system_prompt.join("\n\n")),
            tools: Some({
                let mut tools = builtin_tool_definitions();
                tools.extend(self.current_extra_tools());
                tools
            }),
            tool_choice: None,
            stream: true,
        };

        // Optional one-shot dump for inspecting exactly what the LLM sees.
        // Set CLAW_DUMP_REQUEST=<path> and the next outgoing payload is
        // written there as pretty JSON. The variable is consumed (cleared
        // after use) so a single inspection doesn't snowball into every
        // subsequent turn.
        if let Ok(path) = std::env::var("CLAW_DUMP_REQUEST") {
            if !path.is_empty() {
                match serde_json::to_string_pretty(&message_request) {
                    Ok(json) => {
                        if let Err(err) = std::fs::write(&path, &json) {
                            tracing::warn!(%err, "failed to write request dump to {path}");
                        } else {
                            tracing::info!("dumped outgoing request to {path}");
                        }
                    }
                    Err(err) => tracing::warn!(%err, "request serialise failed"),
                }
                std::env::remove_var("CLAW_DUMP_REQUEST");
            }
        }

        self.runtime.block_on(async {
            let mut stream = self
                .client
                .stream_message(&message_request)
                .await
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            let mut events = Vec::new();
            let mut pending_tools = HashMap::<u32, (String, String, String)>::new();
            let mut saw_stop = false;

            while let Some(event) = stream
                .next_event()
                .await
                .map_err(|error| RuntimeError::new(error.to_string()))?
            {
                match event {
                    ApiStreamEvent::MessageStart(start) => {
                        for block in start.message.content {
                            push_api_output_block(block, 0, &mut events, &mut pending_tools, true);
                        }
                    }
                    ApiStreamEvent::ContentBlockStart(start) => {
                        push_api_output_block(
                            start.content_block,
                            start.index,
                            &mut events,
                            &mut pending_tools,
                            true,
                        );
                    }
                    ApiStreamEvent::ContentBlockDelta(delta) => match delta.delta {
                        ContentBlockDelta::TextDelta { text } => {
                            if !text.is_empty() {
                                let event = AssistantEvent::TextDelta(text);
                                if let Some(observer) = self.delta_observer.as_ref() {
                                    observer(&event);
                                }
                                events.push(event);
                            }
                        }
                        ContentBlockDelta::InputJsonDelta { partial_json } => {
                            if let Some((_, _, input)) = pending_tools.get_mut(&delta.index) {
                                input.push_str(&partial_json);
                            }
                        }
                        ContentBlockDelta::ThinkingDelta { thinking } => {
                            if !thinking.is_empty() {
                                let event = AssistantEvent::ReasoningDelta(thinking);
                                if let Some(observer) = self.delta_observer.as_ref() {
                                    observer(&event);
                                }
                                events.push(event);
                            }
                        }
                        // Anthropic ships per-block signatures separately
                        // from the thinking text; we don't yet round-trip
                        // them and DeepSeek doesn't produce them, so
                        // they're silently dropped.
                        ContentBlockDelta::SignatureDelta { .. } => {}
                    },
                    ApiStreamEvent::ContentBlockStop(stop) => {
                        if let Some((id, name, input)) = pending_tools.remove(&stop.index) {
                            events.push(AssistantEvent::ToolUse { id, name, input });
                        }
                    }
                    ApiStreamEvent::MessageDelta(delta) => {
                        events.push(AssistantEvent::Usage(TokenUsage {
                            input_tokens: delta.usage.input_tokens,
                            output_tokens: delta.usage.output_tokens,
                            cache_creation_input_tokens: delta.usage.cache_creation_input_tokens,
                            cache_read_input_tokens: delta.usage.cache_read_input_tokens,
                        }));
                    }
                    ApiStreamEvent::MessageStop(_) => {
                        saw_stop = true;
                        events.push(AssistantEvent::MessageStop);
                    }
                }
            }

            if !saw_stop
                && events.iter().any(|event| {
                    matches!(event, AssistantEvent::TextDelta(text) if !text.is_empty())
                        || matches!(event, AssistantEvent::ToolUse { .. })
                })
            {
                events.push(AssistantEvent::MessageStop);
            }

            if events
                .iter()
                .any(|event| matches!(event, AssistantEvent::MessageStop))
            {
                return Ok(events);
            }

            let response = self
                .client
                .send_message(&MessageRequest {
                    stream: false,
                    ..message_request
                })
                .await
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            Ok(response_to_assistant_events(response))
        })
    }
}

struct LocalEchoApiClient;

impl ApiClient for LocalEchoApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let user_text = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == MessageRole::User)
            .and_then(first_text_block)
            .unwrap_or_default()
            .to_string();
        let input_tokens = estimate_token_count(&user_text).saturating_add(1);
        let response = format!("Received: {user_text}");
        let output_tokens = estimate_token_count(&response).saturating_add(1);

        Ok(vec![
            AssistantEvent::TextDelta(response),
            AssistantEvent::Usage(TokenUsage {
                input_tokens,
                output_tokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            }),
            AssistantEvent::MessageStop,
        ])
    }
}

/// Single AskUser choice as it goes out over the wire. Mirrors the
/// runtime UserQuestionOption but lives here so we don't leak the
/// runtime trait into the API surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionQuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Flattened wire shape for the AskUser answer event. Three discriminants
/// match the runtime UserQuestionAnswer enum 1:1; using string tags
/// keeps the JSON readable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserAnswerKind {
    Selected { index: usize, label: String },
    OtherText { text: String },
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    SessionSnapshot {
        session_id: SessionId,
        session: RuntimeSession,
    },
    TurnStarted {
        session_id: SessionId,
    },
    UserMessage {
        session_id: SessionId,
        message: ConversationMessage,
    },
    AssistantDelta {
        session_id: SessionId,
        text: String,
    },
    /// Streaming chunk of model chain-of-thought. Fires before / alongside
    /// `assistant_delta` while the LLM is "thinking" (DeepSeek
    /// reasoning_content, Anthropic native thinking). The frontend
    /// accumulates these into a separate streaming reasoning chip so the
    /// user can see the model working in real time, while still showing
    /// the final answer in the normal text bubble.
    ReasoningDelta {
        session_id: SessionId,
        text: String,
    },
    AssistantMessage {
        session_id: SessionId,
        message: ConversationMessage,
    },
    ToolUse {
        session_id: SessionId,
        id: String,
        name: String,
        input: String,
    },
    ToolResult {
        session_id: SessionId,
        tool_use_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    },
    PermissionRequest {
        session_id: SessionId,
        request_id: String,
        tool_name: String,
        input: String,
        current_mode: String,
        required_mode: String,
    },
    PermissionDecision {
        session_id: SessionId,
        request_id: String,
        allowed: bool,
        reason: Option<String>,
    },
    /// AskUser tool fired — frontend should surface a question prompt
    /// and POST back to `/sessions/{id}/questions/{question_id}/answer`.
    /// The runtime tool is blocked on a oneshot until that lands.
    UserQuestion {
        session_id: SessionId,
        question_id: String,
        question: String,
        header: Option<String>,
        options: Vec<SessionQuestionOption>,
        allow_other: bool,
    },
    /// Decision arrived — emitted so other subscribers (multi-tab) can
    /// dismiss their copy of the prompt. Same pattern as PermissionDecision.
    UserAnswer {
        session_id: SessionId,
        question_id: String,
        /// Mirrors the runtime QuestionAnswer enum but flattened for the wire.
        kind: UserAnswerKind,
    },
    Usage {
        session_id: SessionId,
        usage: TokenUsage,
    },
    Error {
        session_id: SessionId,
        message: String,
    },
    TurnFinished {
        session_id: SessionId,
    },
    TurnCancelled {
        session_id: SessionId,
    },
}

impl SessionEvent {
    fn event_name(&self) -> &'static str {
        match self {
            Self::SessionSnapshot { .. } => "session_snapshot",
            Self::TurnStarted { .. } => "turn_started",
            Self::UserMessage { .. } => "user_message",
            Self::AssistantDelta { .. } => "assistant_delta",
            Self::ReasoningDelta { .. } => "reasoning_delta",
            Self::AssistantMessage { .. } => "assistant_message",
            Self::ToolUse { .. } => "tool_use",
            Self::ToolResult { .. } => "tool_result",
            Self::PermissionRequest { .. } => "permission_request",
            Self::PermissionDecision { .. } => "permission_decision",
            Self::UserQuestion { .. } => "user_question",
            Self::UserAnswer { .. } => "user_answer",
            Self::Usage { .. } => "usage",
            Self::Error { .. } => "error",
            Self::TurnFinished { .. } => "turn_finished",
            Self::TurnCancelled { .. } => "turn_cancelled",
        }
    }

    fn to_sse_event(&self) -> Result<Event, serde_json::Error> {
        Ok(Event::default()
            .event(self.event_name())
            .data(serde_json::to_string(self)?))
    }
}

impl SessionEvent {
    #[must_use]
    pub fn from_conversation_message(
        session_id: SessionId,
        message: ConversationMessage,
    ) -> Vec<Self> {
        match message.role {
            MessageRole::User => vec![Self::UserMessage {
                session_id,
                message,
            }],
            MessageRole::Assistant => Self::from_assistant_message(session_id, message),
            MessageRole::Tool => Self::from_tool_message(session_id, &message),
            MessageRole::System => Vec::new(),
        }
    }

    #[must_use]
    pub fn from_assistant_message(
        session_id: SessionId,
        message: ConversationMessage,
    ) -> Vec<Self> {
        let mut events = Vec::new();
        for block in &message.blocks {
            match block {
                ContentBlock::Text { text } => events.push(Self::AssistantDelta {
                    session_id: session_id.clone(),
                    text: text.clone(),
                }),
                ContentBlock::ToolUse { id, name, input } => events.push(Self::ToolUse {
                    session_id: session_id.clone(),
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                }),
                ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    is_error,
                } => events.push(Self::ToolResult {
                    session_id: session_id.clone(),
                    tool_use_id: tool_use_id.clone(),
                    tool_name: tool_name.clone(),
                    output: output.clone(),
                    is_error: *is_error,
                }),
                // Reasoning blocks aren't re-broadcast as SSE events
                // here — they already streamed live via thinking_delta
                // and the frontend reads them from the persisted
                // message.blocks. Skipping the rebroadcast avoids
                // duplicating the chain-of-thought in the UI.
                ContentBlock::Reasoning { .. } => {}
            }
        }
        if let Some(usage) = message.usage {
            events.push(Self::Usage {
                session_id: session_id.clone(),
                usage,
            });
        }
        events.push(Self::AssistantMessage {
            session_id,
            message,
        });
        events
    }

    fn from_tool_message(session_id: SessionId, message: &ConversationMessage) -> Vec<Self> {
        message
            .blocks
            .iter()
            .filter_map(|block| {
                let ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    is_error,
                } = block
                else {
                    return None;
                };
                Some(Self::ToolResult {
                    session_id: session_id.clone(),
                    tool_use_id: tool_use_id.clone(),
                    tool_name: tool_name.clone(),
                    output: output.clone(),
                    is_error: *is_error,
                })
            })
            .collect()
    }
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

type ApiError = (StatusCode, Json<ErrorResponse>);
type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateSessionResponse {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: SessionId,
    pub created_at: u64,
    pub message_count: usize,
    pub turn_in_flight: bool,
    /// First-user-message-derived label so the UI shows what the chat is about
    /// instead of the opaque `session-N` id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

fn derive_session_title(session: &RuntimeSession) -> Option<String> {
    for message in &session.messages {
        if message.role != MessageRole::User {
            continue;
        }
        for block in &message.blocks {
            if let ContentBlock::Text { text } = block {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Collapse whitespace + cap at ~60 chars so the sidebar stays tidy.
                let collapsed: String = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
                let max = 60;
                let title = if collapsed.chars().count() > max {
                    let truncated: String = collapsed.chars().take(max - 1).collect();
                    format!("{truncated}…")
                } else {
                    collapsed
                };
                return Some(title);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerConfig {
    pub permission_mode: String,
    pub model: Option<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// Hard cap on tool_use iterations within a single turn. Prevents
    /// runaway loops where the agent keeps "trying one more thing"
    /// forever. 0 = use default (50). Reaching the cap finishes the turn
    /// with a synthetic notice; the user can send another message.
    #[serde(default = "default_max_iter")]
    pub max_tool_iterations_per_turn: u32,
    /// Soft per-session token budget. If set, the server refuses to start
    /// a new turn once cumulative input+output usage on the session
    /// exceeds the budget. `None` = unlimited (current behaviour). Useful
    /// for cost ceilings on autonomous / long-running sessions.
    #[serde(default)]
    pub max_session_tokens: Option<u64>,
    /// Embedding provider used by RAG ingest + retrieve. Decoupled from
    /// chat providers so the user can pick a cheaper / better embedding
    /// (DashScope `text-embedding-v4`, local BGE-m3, …) without
    /// affecting the model that drives the conversation. If `None`,
    /// falls back to OpenAI chat creds with default `text-embedding-3-
    /// small` 1536-dim.
    #[serde(default)]
    pub embedding_provider: Option<embedding::EmbeddingProvider>,
    /// Sub-LLM summarizer for WebFetch results. When set, `execute_tool`
    /// runs the fetched page through this model with the caller's
    /// `prompt`, returning a compact summary instead of the full ~120 KB
    /// of extracted text. The whole point is to keep the main session
    /// context from getting flooded by every web page the agent visits.
    /// Provider auth + base URL come from the model's standard env vars
    /// (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, etc.) — same as the
    /// main chat client. `None` disables the feature (raw `clean_text`
    /// returned, behaviour identical to pre-Tier-3).
    #[serde(default)]
    pub web_fetch_summarizer: Option<WebFetchSummarizerSettings>,
    /// Optional dedicated LLM for the cross-session "absorb" feature
    /// (`POST /sessions/{target}/absorb`). When `None`, the absorb endpoint
    /// falls back to the main `config.model` and surfaces a warning so
    /// the user knows the same-model bias risk applies. Setting this to
    /// a different model family is recommended for production use.
    #[serde(default)]
    pub session_summarizer: Option<SessionSummarizerSettings>,
}

/// Server-side persistence shape for the WebFetch summarizer config.
/// Persisted summarizer config. Carries the api_key in plaintext on
/// disk (same as embedding_provider does) — the file is in the user's
/// own state dir, not transmitted anywhere except back to the tools
/// crate at startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebFetchSummarizerSettings {
    /// Model id passed to the LLM client (e.g. `"deepseek-v4-flash"`,
    /// `"deepseek-chat"`). Provider is detected by prefix.
    pub model: String,
    /// Dedicated API key. Empty string means "not configured here —
    /// fall back to env var". Never echoed to GET /config responses
    /// (the View struct strips it).
    #[serde(default)]
    pub api_key: String,
    /// Optional base-URL override for OpenAI-compatible proxies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Max tokens for the summary itself. `None` → tools-crate default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Override the default system prompt. `None` → tools-crate default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

impl WebFetchSummarizerSettings {
    fn to_tools_config(&self) -> tools::WebFetchSummarizerConfig {
        tools::WebFetchSummarizerConfig {
            model: self.model.clone(),
            api_key: (!self.api_key.trim().is_empty()).then(|| self.api_key.clone()),
            base_url: self.base_url.clone(),
            max_tokens: self.max_tokens,
            system_prompt: self.system_prompt.clone(),
        }
    }
}

/// Sanitised view returned on GET /config — strips the api_key, exposes
/// a `configured` flag instead. Mirrors EmbeddingProviderView so the
/// frontend never receives the secret on round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebFetchSummarizerView {
    pub model: String,
    /// `true` iff a per-summarizer api_key is set server-side. Lets the
    /// UI distinguish "uses env-only auth" from "has dedicated key".
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

impl From<&WebFetchSummarizerSettings> for WebFetchSummarizerView {
    fn from(value: &WebFetchSummarizerSettings) -> Self {
        Self {
            model: value.model.clone(),
            configured: !value.api_key.trim().is_empty(),
            base_url: value.base_url.clone(),
            max_tokens: value.max_tokens,
            system_prompt: value.system_prompt.clone(),
        }
    }
}

/// Body shape for PATCH /config's `web_fetch_summarizer` field. The
/// `api_key` field is `None` when the client doesn't want to touch the
/// existing key (e.g. just changing model id), `Some("")` to clear,
/// `Some(real_key)` to update. Mirrors EmbeddingProviderPatch's
/// handling of the same constraint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebFetchSummarizerPatch {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

/// Push the current ServerConfig's summarizer settings into the tools
/// crate's global slot. Called at startup AND on every PATCH /config
/// that touches the field, so the live summarizer state is always in
/// sync with persisted config.
pub fn install_webfetch_summarizer(settings: Option<&WebFetchSummarizerSettings>) {
    tools::set_webfetch_summarizer(settings.map(WebFetchSummarizerSettings::to_tools_config));
}

// ─────────────── Session summarizer (cross-session absorb) ───────────────
// Optional dedicated LLM that condenses N source sessions' transcripts
// into a single structured markdown handoff. Mirrors WebFetchSummarizer
// in shape (model + api_key + base_url + caps + system_prompt) and in
// secret handling (`api_key: None` in patch = leave alone, `Some("")` =
// clear, `Some(real)` = update). When unset, the absorb endpoint falls
// back to the main `config.model` and emits a warning to the caller so
// the user knows the same-model bias risk applies.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummarizerSettings {
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummarizerView {
    pub model: String,
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

impl From<&SessionSummarizerSettings> for SessionSummarizerView {
    fn from(value: &SessionSummarizerSettings) -> Self {
        Self {
            model: value.model.clone(),
            configured: !value.api_key.trim().is_empty(),
            base_url: value.base_url.clone(),
            max_tokens: value.max_tokens,
            system_prompt: value.system_prompt.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummarizerPatch {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

/// Default 5-section structured markdown prompt for the absorb summarizer.
/// Keeping it as code (not a config file) so a fresh install gets useful
/// output without any setup. Users can override via the `system_prompt`
/// field on PATCH /config { session_summarizer }.
const DEFAULT_SESSION_SUMMARIZER_PROMPT: &str = "You are summarising one or more prior agent sessions so a fresh \
session can pick up the work without losing key context.

OUTPUT FORMAT — output exactly these five markdown sections, in order, \
with no preamble and no trailing prose:

## Task
One paragraph stating the original task / goal pulled from the source \
sessions. If multiple sessions had different goals, list them as a \
bulleted sub-list under this section instead.

## Established
- Concrete facts the prior agent has verified (file contents, command \
outputs, test results). One bullet per fact. Skip speculation.

## Decisions made
- Choices the prior agent committed to and the reason. Format each as \
`- Chose X over Y because Z`. Skip if no real decisions were made.

## Open / Stuck
- Currently unresolved questions, failing tests, blocked dependencies, \
or unverified assumptions. One bullet each.

## Recommended next step
One paragraph: what the receiving session should try first. Be specific \
(name files, commands, sub-tasks). Avoid generic advice.

Rules:
- Total output ≤ 800 words.
- Drop tool-call retries, transient errors, false starts. Keep the \
*resulting state* not the *journey*.
- If a source session ends mid-tool-call or with an unresolved permission \
prompt, note it in `Open / Stuck`.
- Use code spans (`like_this`) for file paths and identifiers.";

fn default_session_summarizer_prompt() -> String {
    DEFAULT_SESSION_SUMMARIZER_PROMPT.to_string()
}

fn default_max_iter() -> u32 {
    // Set generously — complex real-world tasks (multi-slide PPT with
    // images, large refactor, multi-doc analysis) commonly need 50+
    // iterations of legit work. The primary defence against runaway
    // loops is `max_session_tokens` (cost ceiling), plus the
    // no-progress detector inside the runtime. This cap is the final
    // safety net, not the first line.
    200
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageResponse {
    pub rows: Vec<UsageRow>,
    /// Aggregate across all rows (handy for the header in the UI).
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cost_usd: Option<f64>,
    pub total_turns: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageRow {
    /// "anthropic/claude-opus-4-6", "deepseek-v4-flash", "unknown" for
    /// historical messages from before model-tagging shipped.
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub turns: u32,
    /// USD estimate from the static pricing table. `None` when the model
    /// isn't priced (the UI shows `—`).
    pub estimated_cost_usd: Option<f64>,
}

/// Aggregate token usage across every live session, grouped by model.
/// Rows with no model tag (legacy / synthetic stop messages) roll up
/// under "unknown".
async fn get_usage(State(state): State<AppState>) -> Json<UsageResponse> {
    use std::collections::HashMap;

    let sessions = state.sessions.read().await;
    let mut buckets: HashMap<String, UsageRow> = HashMap::new();
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_turns: u32 = 0;
    for session in sessions.values() {
        for msg in &session.conversation.messages {
            let Some(usage) = msg.usage.as_ref() else {
                continue;
            };
            // Skip synthetic stops and any zero-usage entries — those
            // never hit the wire so they shouldn't be counted.
            if usage.input_tokens == 0 && usage.output_tokens == 0 {
                continue;
            }
            let key = msg
                .model
                .clone()
                .unwrap_or_else(|| "unknown".to_string());
            let entry = buckets.entry(key.clone()).or_insert_with(|| UsageRow {
                model: key,
                input_tokens: 0,
                output_tokens: 0,
                turns: 0,
                estimated_cost_usd: None,
            });
            entry.input_tokens = entry
                .input_tokens
                .saturating_add(u64::from(usage.input_tokens));
            entry.output_tokens = entry
                .output_tokens
                .saturating_add(u64::from(usage.output_tokens));
            entry.turns = entry.turns.saturating_add(1);
            total_input = total_input.saturating_add(u64::from(usage.input_tokens));
            total_output = total_output.saturating_add(u64::from(usage.output_tokens));
            total_turns = total_turns.saturating_add(1);
        }
    }

    // Estimate cost per row + roll up.
    let mut total_cost: Option<f64> = None;
    for row in buckets.values_mut() {
        row.estimated_cost_usd =
            pricing::estimate_cost(&row.model, row.input_tokens, row.output_tokens);
        if let Some(c) = row.estimated_cost_usd {
            *total_cost.get_or_insert(0.0) += c;
        }
    }

    let mut rows: Vec<UsageRow> = buckets.into_values().collect();
    // Sort by total tokens descending — most-used model first is the
    // useful ordering when scanning the list.
    rows.sort_by(|a, b| {
        (b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens))
    });

    Json(UsageResponse {
        rows,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cost_usd: total_cost,
        total_turns,
    })
}

/// Compute total tokens "spent" on a session for budget enforcement.
///
/// We count: sum of every assistant message's `output_tokens` + the
/// `input_tokens` recorded on the most recent assistant message (which
/// reflects the full conversation history sent on that turn — a superset
/// of every prior input). Cache tokens are excluded because they're
/// typically billed at lower rates and our budget knob is about a coarse
/// safety brake, not exact billing.
pub fn session_cumulative_tokens(messages: &[runtime::ConversationMessage]) -> u64 {
    let mut total_output: u64 = 0;
    let mut latest_input: u64 = 0;
    for msg in messages {
        if let Some(usage) = msg.usage.as_ref() {
            total_output = total_output.saturating_add(u64::from(usage.output_tokens));
            // Each assistant turn re-bills the full history; keep the
            // latest (largest) input number to avoid double counting.
            latest_input = latest_input.max(u64::from(usage.input_tokens));
        }
    }
    total_output.saturating_add(latest_input)
}

/// Per-turn token counts for the most recent turn, surfaced to the Usage panel.
#[derive(Debug, Clone, Serialize)]
pub struct TurnUsageView {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_read_input_tokens: u32,
    pub cache_creation_input_tokens: u32,
}

/// Token + (rough) cost summary for one session — drives Settings → Usage.
#[derive(Debug, Clone, Serialize)]
pub struct SessionUsageResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub turns: usize,
    /// Output + latest input (matches `/status`): the headline "context fill"
    /// number, which avoids double-counting the re-sent history.
    pub cumulative_tokens: u64,
    /// Per-turn input summed across the session — the basis for cost, since
    /// each turn re-bills the whole prompt.
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub cache_read_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<TurnUsageView>,
    /// Rough USD estimate from the static price table (sum of per-turn cost);
    /// `None` when the model isn't in the table. Cache discounts aren't modeled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_per_million: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u64>,
}

/// `GET /sessions/{id}/usage` — token counts + a rough cost estimate for the
/// session, used by the Usage settings tab. Read-only; no LLM call.
async fn session_usage(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
) -> ApiResult<Json<SessionUsageResponse>> {
    let (model, budget) = {
        let cfg = state.config.read().await;
        (
            cfg.model.clone().filter(|m| !m.is_empty()),
            cfg.max_session_tokens,
        )
    };
    let sessions = state.sessions.read().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
    let messages = &session.conversation.messages;

    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut cache_read = 0u64;
    let mut turns = 0usize;
    let mut cost = 0.0f64;
    let mut any_cost = false;
    let mut last_turn = None;
    for msg in messages {
        if let Some(u) = msg.usage.as_ref() {
            turns += 1;
            total_input = total_input.saturating_add(u64::from(u.input_tokens));
            total_output = total_output.saturating_add(u64::from(u.output_tokens));
            cache_read = cache_read.saturating_add(u64::from(u.cache_read_input_tokens));
            if let Some(m) = model.as_deref() {
                if let Some(c) =
                    pricing::estimate_cost(m, u64::from(u.input_tokens), u64::from(u.output_tokens))
                {
                    cost += c;
                    any_cost = true;
                }
            }
            last_turn = Some(TurnUsageView {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                cache_read_input_tokens: u.cache_read_input_tokens,
                cache_creation_input_tokens: u.cache_creation_input_tokens,
            });
        }
    }
    let price = model.as_deref().and_then(pricing::lookup);
    Ok(Json(SessionUsageResponse {
        model,
        turns,
        cumulative_tokens: session_cumulative_tokens(messages),
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        cache_read_tokens: cache_read,
        last_turn,
        estimated_cost_usd: any_cost.then_some(cost),
        input_per_million: price.map(|p| p.input_per_million),
        output_per_million: price.map(|p| p.output_per_million),
        budget_tokens: budget,
    }))
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            permission_mode: DEFAULT_PERMISSION_MODE.to_string(),
            model: None,
            workspace_root: None,
            max_tool_iterations_per_turn: default_max_iter(),
            max_session_tokens: None,
            embedding_provider: None,
            web_fetch_summarizer: None,
            session_summarizer: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConfigPatch {
    pub permission_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub model: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub workspace_root: Option<Option<String>>,
    #[serde(default)]
    pub max_tool_iterations_per_turn: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub max_session_tokens: Option<Option<u64>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub embedding_provider: Option<Option<embedding::EmbeddingProvider>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub web_fetch_summarizer: Option<Option<WebFetchSummarizerPatch>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub session_summarizer: Option<Option<SessionSummarizerPatch>>,
}

// Distinguishes "field absent" (None) from "field present and null" (Some(None)) so PATCH
// callers can explicitly clear a value without resetting other fields.
#[allow(clippy::option_option)]
fn deserialize_optional_field<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolSummary {
    pub name: String,
    pub description: String,
    pub required_permission: String,
    pub input_schema: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolsResponse {
    pub tools: Vec<ToolSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandSummary {
    pub name: String,
    pub aliases: Vec<String>,
    pub summary: String,
    pub argument_hint: Option<String>,
    pub resume_supported: bool,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandsResponse {
    pub commands: Vec<CommandSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CancelTurnResponse {
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderSummary {
    pub name: String,
    pub label: String,
    pub configured: bool,
    pub base_url: Option<String>,
    pub default_base_url: String,
    pub env_keys: Vec<String>,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProvidersResponse {
    pub providers: Vec<ProviderSummary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderCredsPayload {
    pub api_key: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PermissionDecisionRequest {
    pub allowed: bool,
    #[serde(default)]
    pub reason: Option<String>,
    /// When `true` on an allowed decision, remember the approval for this
    /// command prefix / tool so identical prompts auto-approve for the rest
    /// of the session (in-memory only). Ignored on denials.
    #[serde(default)]
    pub remember: Option<bool>,
}

/// Wire shape POSTed to `/sessions/{id}/questions/{qid}/answer`.
/// Tagged by `type` to keep the three answer modes distinct and
/// validatable on arrival. UserAnswerKind on the SSE side is the
/// broadcast mirror of this — different name to avoid the impression
/// that one struct is round-tripped through both.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QuestionAnswerRequest {
    Selected { index: usize, label: String },
    OtherText { text: String },
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // "file" | "dir"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceTreeResponse {
    pub root: String,
    pub relative: String,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceFileResponse {
    pub path: String,
    pub size: u64,
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspacePickerResponse {
    /// Absolute path the user selected, or `null` if they cancelled or no picker is
    /// available on this platform.
    pub path: Option<String>,
    /// `false` when the server couldn't even attempt a native dialog (unsupported OS,
    /// missing tooling). Frontend can fall back to the manual text input.
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpToolSummary {
    pub name: String,
    pub raw_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerSummary {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Whether the server is currently enabled — disabled servers stay in the
    /// list (so the toggle can flip them back on) but expose no tools.
    #[serde(default = "yes")]
    pub enabled: bool,
    pub tools: Vec<McpToolSummary>,
    /// One of: "ready" (tools present), "discovering" (refresh in flight,
    /// tools may still appear), "failed" (refresh finished but the server
    /// produced no tools — usually misconfigured), "disabled". Lets the UI
    /// show a meaningful state during the cold-start window of slow MCP
    /// servers (Python ones often take 5-10s).
    #[serde(default = "discovery_ready")]
    pub discovery_status: String,
}

fn yes() -> bool {
    true
}

fn discovery_ready() -> String {
    "ready".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServersResponse {
    pub servers: Vec<McpServerSummary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct McpServerPayload {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspacePathQuery {
    #[serde(default)]
    pub path: Option<String>,
}

const WORKSPACE_FILE_MAX_BYTES: u64 = 1024 * 1024; // 1 MiB
const WORKSPACE_TREE_MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListSessionsResponse {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionDetailsResponse {
    pub id: SessionId,
    pub created_at: u64,
    pub session: RuntimeSession,
    /// Names of MCP servers currently attached to this session. Empty by
    /// default; updated as the LLM calls the attach/detach meta-tools.
    #[serde(default)]
    pub attached_mcps: Vec<String>,
    /// Cumulative token usage on this session — drives the budget badge
    /// in the UI. Same calculation as the budget check at message-send
    /// time, so the displayed number matches the threshold the server
    /// enforces.
    #[serde(default)]
    pub cumulative_tokens: u64,
    /// RAG library bound to this session, if any. `None` means no
    /// auto-retrieval will happen on the next turn.
    #[serde(default)]
    pub attached_library: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SendMessageRequest {
    pub message: String,
    /// Files the user attached to this turn. Each is expanded into the
    /// user message text as a fenced code block right after the typed
    /// prompt. Validation (size, UTF-8) runs server-side before the
    /// message is recorded — bad attachments fail the whole request so
    /// the user can fix the input and retry without a half-filled turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AttachmentRef {
    File { path: String },
}

/// Soft limit per attachment — anything larger gets refused so a 5 GB
/// log file can't blow up the prompt by mistake. 2 MB is still ~500k
/// tokens of English text, which fits inside the larger models' context
/// windows but warns loudly on the smaller ones.
const MAX_ATTACHMENT_BYTES: u64 = 2 * 1024 * 1024;

/// Maximum dimension we let an image carry into the LLM payload. Anything
/// larger gets downsampled in-place so the user doesn't have to think about
/// "did I send a 4032×3024 phone photo just for a thumbnail check".
const IMAGE_RESIZE_MAX_EDGE: u32 = 2048;

/// Hard cap for image attachments BEFORE downsampling. Even with resize the
/// initial decode pulls the whole thing into memory, so refuse multi-hundred
/// MB photos outright.
const MAX_IMAGE_INPUT_BYTES: u64 = 30 * 1024 * 1024;

/// Sniff a file by leading magic bytes — extension is unreliable when users
/// rename downloaded screenshots. Returns the recognised mime if any.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

/// Decode an uploaded file's bytes into plain text for chunking + embedding.
/// Returns the extracted text plus a short label describing what we did
/// (used in error messages and logs).
///
/// Branches:
///   * PDF (magic `%PDF-`) → `pdf_extract::extract_text_from_mem`. Errors
///     if the PDF has no extractable text (scanned / image-only).
///   * Anything else → must be valid UTF-8; rejected otherwise. We don't
///     attempt charset detection — almost all relevant text formats
///     (markdown, code, plain text, csv) are UTF-8 in practice and
///     guessing is a worse failure mode than asking the user to convert.
fn decode_uploaded_text(bytes: &[u8], filename: &str) -> Result<(String, &'static str), ApiError> {
    if is_pdf(bytes) {
        let text = pdf_extract::extract_text_from_mem(bytes).map_err(|err| {
            bad_request(format!(
                "`{filename}`: failed to extract text from PDF ({err})"
            ))
        })?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(bad_request(format!(
                "`{filename}`: PDF contains no extractable text (scanned / image-only — OCR not supported in this phase)"
            )));
        }
        return Ok((text, "pdf"));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| {
            bad_request(format!(
                "`{filename}`: file isn't valid UTF-8 text or a PDF. Supported: text/markdown/code/csv (UTF-8) or PDF."
            ))
        })?
        .to_string();
    Ok((text, "text"))
}

/// Read a single attachment off disk and turn it into a `MessageAttachment`
/// suitable for storing in the user's `ConversationMessage`. Validation
/// (size, file type) happens here so a bad input fails the whole HTTP request
/// before any state is mutated. Three branches: image, PDF (extract text),
/// or UTF-8 text. Anything else is refused with a clear message.
fn read_attachment(attachment: &AttachmentRef) -> ApiResult<MessageAttachment> {
    let AttachmentRef::File { path } = attachment;
    let path_buf = std::path::PathBuf::from(path);
    let metadata = std::fs::metadata(&path_buf).map_err(|err| {
        bad_request(format!("attachment `{path}`: {err}"))
    })?;
    if !metadata.is_file() {
        return Err(bad_request(format!(
            "attachment `{path}` is not a regular file"
        )));
    }

    // Use a peek-then-read pattern so the size limit can vary by kind.
    let bytes = std::fs::read(&path_buf).map_err(|err| {
        bad_request(format!("attachment `{path}`: {err}"))
    })?;

    if let Some(mime) = sniff_image_mime(&bytes) {
        if (bytes.len() as u64) > MAX_IMAGE_INPUT_BYTES {
            return Err(bad_request(format!(
                "image `{path}` is {:.1} MB; cap before resize is {:.1} MB.",
                bytes.len() as f64 / 1_048_576.0,
                MAX_IMAGE_INPUT_BYTES as f64 / 1_048_576.0,
            )));
        }
        let (resized_bytes, final_mime) = downsample_image_if_needed(&bytes, mime, path)?;
        let encoded = base64_encode(&resized_bytes);
        return Ok(MessageAttachment {
            path: path.clone(),
            content: encoded,
            language: String::new(),
            kind: AttachmentKind::Image {
                media_type: final_mime.to_string(),
            },
        });
    }

    if is_pdf(&bytes) {
        let text = pdf_extract::extract_text_from_mem(&bytes).map_err(|err| {
            bad_request(format!(
                "attachment `{path}`: failed to extract text from PDF ({err})"
            ))
        })?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(bad_request(format!(
                "attachment `{path}`: PDF contains no extractable text (scanned / image-only?)"
            )));
        }
        return Ok(MessageAttachment {
            path: path.clone(),
            content: text,
            language: String::new(),
            kind: AttachmentKind::ExtractedText {
                source_format: "pdf".to_string(),
            },
        });
    }

    // Fall through to UTF-8 text path with the original size cap.
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(bad_request(format!(
            "attachment `{path}` is {:.1} MB; cap is {:.1} MB. Use read_file with offset/limit if you need a large file.",
            metadata.len() as f64 / 1_048_576.0,
            MAX_ATTACHMENT_BYTES as f64 / 1_048_576.0,
        )));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        bad_request(format!(
            "attachment `{path}` is not valid UTF-8 text and not a recognised image/PDF."
        ))
    })?;
    Ok(MessageAttachment {
        path: path.clone(),
        content: text.to_string(),
        language: guess_language_for_path(&path_buf).to_string(),
        kind: AttachmentKind::Text,
    })
}

/// If the image is larger than [`IMAGE_RESIZE_MAX_EDGE`] on its long side,
/// decode + resize down with a Lanczos3 filter and re-encode. We re-encode
/// PNG / JPEG / WebP back to PNG (lossless, predictable size). GIF is left
/// untouched because animated GIFs would lose frames in a naive resize.
fn downsample_image_if_needed(
    bytes: &[u8],
    mime: &str,
    path: &str,
) -> ApiResult<(Vec<u8>, &'static str)> {
    if mime == "image/gif" {
        return Ok((bytes.to_vec(), "image/gif"));
    }
    let img = image::load_from_memory(bytes).map_err(|err| {
        bad_request(format!("image `{path}`: decode failed ({err})"))
    })?;
    let (w, h) = (img.width(), img.height());
    let needs_resize = w.max(h) > IMAGE_RESIZE_MAX_EDGE;
    if !needs_resize {
        // No resize needed → keep the original bytes and mime to avoid an
        // unnecessary re-encode (which would also strip alpha for JPEG etc).
        let static_mime: &'static str = match mime {
            "image/png" => "image/png",
            "image/jpeg" => "image/jpeg",
            "image/webp" => "image/webp",
            _ => "image/png",
        };
        return Ok((bytes.to_vec(), static_mime));
    }
    let resized = img.resize(
        IMAGE_RESIZE_MAX_EDGE,
        IMAGE_RESIZE_MAX_EDGE,
        image::imageops::FilterType::Lanczos3,
    );
    let mut out: Vec<u8> = Vec::new();
    resized
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Png,
        )
        .map_err(|err| {
            bad_request(format!("image `{path}`: re-encode failed ({err})"))
        })?;
    tracing::info!(
        path = path,
        original_dims = format!("{w}x{h}"),
        original_bytes = bytes.len(),
        resized_bytes = out.len(),
        "downsampled image attachment"
    );
    Ok((out, "image/png"))
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(bytes)
}

/// Render the **text-bearing** attachment list as a markdown chunk suitable
/// to append to the user-typed prompt before handing it to the LLM. Image
/// attachments are intentionally skipped here — they're emitted as
/// dedicated `ApiInputContentBlock::Image` blocks in `convert_messages`.
fn render_attachments_for_llm(attachments: &[MessageAttachment]) -> String {
    let text_atts: Vec<&MessageAttachment> = attachments
        .iter()
        .filter(|a| !matches!(a.kind, AttachmentKind::Image { .. }))
        .collect();
    if text_atts.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    out.push_str("\n\n<!-- Attached files (added by user, full contents below) -->\n");
    for att in text_atts {
        let header = match &att.kind {
            AttachmentKind::ExtractedText { source_format } => {
                format!("## File: {} ({} text extract)", att.path, source_format)
            }
            _ => format!("## File: {}", att.path),
        };
        let max_ticks = att
            .content
            .split('\n')
            .map(|line| line.trim_start().chars().take_while(|c| *c == '`').count())
            .max()
            .unwrap_or(0);
        let fence = "`".repeat((max_ticks + 1).max(3));
        let trailing = if att.content.ends_with('\n') { "" } else { "\n" };
        out.push_str(&format!(
            "\n{header}\n{fence}{lang}\n{text}{trailing}{fence}\n",
            header = header,
            fence = fence,
            lang = att.language,
            text = att.content,
            trailing = trailing,
        ));
    }
    out
}

fn guess_language_for_path(path: &std::path::Path) -> &'static str {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "rs" => "rust",
        "py" => "python",
        "js" | "mjs" | "cjs" => "javascript",
        "ts" => "typescript",
        "tsx" => "tsx",
        "jsx" => "jsx",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hxx" => "cpp",
        "rb" => "ruby",
        "sh" | "bash" | "zsh" => "bash",
        "sql" => "sql",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" | "markdown" => "markdown",
        "html" | "htm" => "html",
        "css" => "css",
        "xml" => "xml",
        _ => "",
    }
}

#[must_use]
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/sessions", post(create_session).get(list_sessions))
        .route("/sessions/{id}", get(get_session).delete(delete_session_endpoint))
        .route("/sessions/{id}/events", get(stream_session_events))
        .route("/sessions/{id}/message", post(send_message))
        .route("/sessions/{id}/cancel", post(cancel_turn))
        .route("/sessions/{id}/compact", post(compact_session_endpoint))
        .route("/sessions/{id}/usage", get(session_usage))
        .route("/sessions/{id}/absorb", post(absorb_sessions_endpoint))
        .route(
            "/sessions/{id}/mcp/{name}/attached",
            post(set_session_mcp_attached),
        )
        .route("/sessions/{id}/rag/attach", post(set_session_library))
        .route(
            "/sessions/{id}/permissions/{request_id}/decision",
            post(decide_permission),
        )
        .route(
            "/sessions/{id}/questions/{question_id}/answer",
            post(answer_question),
        )
        .route("/tools", get(list_tools))
        .route("/commands", get(list_commands))
        .route("/config", get(get_config).patch(update_config))
        .route("/providers", get(list_providers))
        .route("/providers/{name}", put(put_provider).delete(delete_provider))
        .route("/providers/{name}/models/live", get(provider_models_live))
        .route("/browser/state", get(browser_state))
        .route("/workspace/tree", get(workspace_tree))
        .route("/workspace/file", get(workspace_file))
        .route("/workspace/picker", post(workspace_picker))
        .route("/workspace/pick-file", post(workspace_file_picker))
        .route("/workspace/attachment-stat", post(attachment_stat_endpoint))
        .route("/workspace/upload", post(workspace_upload_endpoint))
        .route("/mcp/servers", get(list_mcp_servers))
        .route(
            "/mcp/servers/{name}",
            put(put_mcp_server).delete(delete_mcp_server),
        )
        .route(
            "/mcp/servers/{name}/enabled",
            post(set_mcp_server_enabled),
        )
        .route("/mcp/presets", get(list_mcp_presets))
        .route("/mcp/presets/{id}/check-prereqs", post(check_preset_prereqs))
        .route("/mcp/presets/{id}/install", post(install_mcp_preset))
        .route("/mcp/check-prereqs", post(check_prereqs_endpoint))
        .route("/usage", get(get_usage))
        .route("/rag/libraries", get(list_libraries))
        .route(
            "/rag/libraries/{name}",
            post(create_library).delete(delete_library),
        )
        .route("/rag/libraries/{name}/ingest", post(ingest_library))
        .route("/rag/libraries/{name}/retrieve", post(retrieve_library))
        .route("/mcp/registry", get(list_registry_entries))
        .route("/mcp/registry/install", post(install_from_registry))
        .route("/skills", get(list_skills_endpoint).post(create_skill_endpoint))
        // Static routes registered BEFORE the catch-all `/skills/{name}` so
        // axum never matches "search" / "registry" as a delete-target name
        // (which would 405 GET requests with `allow: DELETE`).
        .route("/skills/registry", get(list_skill_registry_endpoint))
        .route("/skills/registry/install", post(install_skill_from_registry_endpoint))
        .route("/skills/search", get(search_skills_sh_endpoint))
        .route("/skills/install/skills-sh", post(install_via_skills_sh_endpoint))
        .route("/skills/{name}", delete(delete_skill_endpoint))
        .route("/health", get(health))
        // SPA fallback — sits at the bottom so all API routes win first.
        // Serves the embedded frontend bundle from `frontend/dist`. Any
        // path that isn't an API route AND isn't a known asset gets the
        // SPA shell so client-side router works on refresh. Defined in
        // src/static_assets.rs.
        .fallback(static_assets::serve_embedded_spa)
        .with_state(state)
}

// ───────────────────────── Skills (v1) ─────────────────────────
// Surface skills the Skill tool can load so the UI can list / create
// / delete them without filesystem fluency. Intentionally limited:
//   - Lists across the same standard roots the Skill tool already
//     searches (project .claw/skills first, then user ~/.claw/skills,
//     then ~/.codex/skills + a few legacy paths).
//   - Create only writes to ~/.claw/skills/ (user-level). Letting
//     POST drop files into <repo>/.claw/skills/ from the web UI feels
//     too easy to mis-aim, and project skills should land via a real
//     editor + git anyway.
//   - Delete only removes from ~/.claw/skills/ for the same reason.
//   - No multi-file skills, no allowed-tools frontmatter, no
//     enable/disable. Those land in phase B if this surface gets used.

#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: Option<String>,
    /// Human-readable label for which root the skill came from.
    /// e.g. `"project"`, `"user"`, `"codex-home"`, `"~/.codex/skills"`.
    pub origin: String,
    /// Absolute path of the SKILL.md or its parent dir. Display-only.
    pub path: String,
    /// `true` iff this skill is shadowed by an earlier higher-priority
    /// entry with the same name (case-insensitive). The Skill tool
    /// would resolve to the shadowing entry; this one is dead weight.
    pub shadowed: bool,
    /// `true` iff this skill lives in `~/.claw/skills/` — only those
    /// can be deleted via the UI. Lets the frontend disable the delete
    /// button for read-only entries (codex / opencode / project skills).
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillsResponse {
    pub skills: Vec<SkillInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSkillRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub prompt: String,
}

/// Roots scanned, in priority order. First one wins when names collide.
/// Mirrors the discovery logic in `tools::resolve_skill_path` and the
/// commands crate's `/skills` scanner — keeping the UI consistent with
/// what the Skill tool actually resolves at chat time.
struct SkillRootSpec {
    label: &'static str,
    path: PathBuf,
    /// `true` only for `~/.claw/skills/` — the single root we accept
    /// writes / deletes against from the web UI.
    editable: bool,
}

fn user_claw_skills_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claw").join("skills"))
}

fn skill_roots(cwd: &std::path::Path) -> Vec<SkillRootSpec> {
    let mut roots = Vec::new();
    // 1a. Project-level claw home.
    roots.push(SkillRootSpec {
        label: "project",
        path: cwd.join(".claw").join("skills"),
        editable: false,
    });
    // 1b. Project-level claude-code home — `npx skills add` (without -g,
    //     i.e. scope=project) writes skills under `<cwd>/.claude/skills/`.
    roots.push(SkillRootSpec {
        label: "project (claude)",
        path: cwd.join(".claude").join("skills"),
        editable: false,
    });
    // 2. The one editable home — under ~/.claw/skills/ for skills authored
    //    via the Create form. The UI's delete button only works here.
    if let Some(p) = user_claw_skills_dir() {
        roots.push(SkillRootSpec {
            label: "user",
            path: p,
            editable: true,
        });
    }
    // 3. Claude Code's user-level skills root. The `npx skills add -g`
    //    CLI writes here whenever a claude-code-family agent is detected
    //    on the host (which includes claw). Without this entry, anything
    //    installed via the Store tab (global scope) would silently
    //    disappear from the Installed list and the runtime's Skill tool
    //    wouldn't find it.
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        roots.push(SkillRootSpec {
            label: "claude-home",
            path: home.join(".claude").join("skills"),
            editable: false,
        });
    }
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        roots.push(SkillRootSpec {
            label: "codex-home",
            path: PathBuf::from(codex_home).join("skills"),
            editable: false,
        });
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        for (sub, label) in [
            (home.join(".codex").join("skills"), "~/.codex/skills"),
            (home.join(".agents").join("skills"), "~/.agents/skills"),
            (
                home.join(".config").join("opencode").join("skills"),
                "~/.config/opencode/skills",
            ),
        ] {
            roots.push(SkillRootSpec {
                label,
                path: sub,
                editable: false,
            });
        }
    }
    roots
}

/// Parse `name` and `description` out of a SKILL.md's YAML frontmatter.
/// Same shape as the commands crate's parser — we duplicate the 20-line
/// implementation here instead of taking a dependency on commands.
fn parse_skill_frontmatter(contents: &str) -> (Option<String>, Option<String>) {
    let mut lines = contents.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("name:") {
            let v = value.trim().trim_matches(['"', '\'']);
            if !v.is_empty() {
                name = Some(v.to_string());
            }
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            let v = value.trim().trim_matches(['"', '\'']);
            if !v.is_empty() {
                description = Some(v.to_string());
            }
        }
    }
    (name, description)
}

/// Walk every root, return one SkillInfo per `<root>/<name>/SKILL.md`
/// found. `shadowed` is set when a later-priority root contains the same
/// name we already accepted.
fn scan_skills(cwd: &std::path::Path) -> Vec<SkillInfo> {
    use std::collections::BTreeSet;
    let mut out = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for root in skill_roots(cwd) {
        let entries = match std::fs::read_dir(&root.path) {
            Ok(e) => e,
            Err(_) => continue, // missing root is fine — most users won't have them all
        };
        let mut here = Vec::<SkillInfo>::new();
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let (fm_name, fm_desc) = match std::fs::read_to_string(&skill_md) {
                Ok(s) => parse_skill_frontmatter(&s),
                Err(_) => (None, None),
            };
            let name = fm_name.unwrap_or(dir_name);
            let key = name.to_ascii_lowercase();
            let shadowed = seen.contains(&key);
            here.push(SkillInfo {
                name,
                description: fm_desc,
                origin: root.label.to_string(),
                path: skill_md.display().to_string(),
                shadowed,
                editable: root.editable,
            });
            // Don't add to `seen` yet — we want `shadowed` to reflect
            // "already accepted by a HIGHER-priority root", not
            // "duplicate within the same root".
        }
        // Stable sort within a root so the UI doesn't reshuffle on each
        // refresh just because readdir is order-unstable.
        here.sort_by(|a, b| a.name.cmp(&b.name));
        for s in &here {
            seen.insert(s.name.to_ascii_lowercase());
        }
        out.extend(here);
    }
    out
}

/// Lowercase alnum, dashes, underscores. 1–64 chars. Mirrors what most
/// tool-name validators reject in practice — keeps filenames safe and
/// stops users from creating skills like `../../etc/passwd`.
fn validate_skill_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("skill name must not be empty".to_string());
    }
    if trimmed.len() > 64 {
        return Err("skill name must be 64 characters or fewer".to_string());
    }
    if trimmed.starts_with('-') || trimmed.starts_with('.') {
        return Err("skill name must not start with '-' or '.'".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(
            "skill name may only contain letters, digits, dashes, and underscores".to_string(),
        );
    }
    Ok(())
}

async fn list_skills_endpoint(State(state): State<AppState>) -> Json<SkillsResponse> {
    // Project-level skill roots are resolved against `workspace_root` (so
    // project-scoped installs at `<ws>/.claude/skills/` show up here),
    // falling back to the launch CWD if no workspace is configured.
    let cwd = {
        let cfg = state.config.read().await;
        cfg.workspace_root
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };
    Json(SkillsResponse {
        skills: scan_skills(&cwd),
    })
}

async fn create_skill_endpoint(
    Json(req): Json<CreateSkillRequest>,
) -> ApiResult<Json<SkillInfo>> {
    validate_skill_name(&req.name).map_err(bad_request)?;
    let user_root = user_claw_skills_dir()
        .ok_or_else(|| bad_request("HOME not set — cannot resolve ~/.claw/skills/".to_string()))?;
    let skill_dir = user_root.join(&req.name);
    if skill_dir.exists() {
        return Err(bad_request(format!(
            "skill `{}` already exists at {}",
            req.name,
            skill_dir.display()
        )));
    }
    std::fs::create_dir_all(&skill_dir).map_err(|e| internal_error(e.to_string()))?;
    let skill_path = skill_dir.join("SKILL.md");

    // Compose SKILL.md with a YAML frontmatter the parser will round-trip.
    // We escape `"` in description to keep the YAML valid; everything else
    // we trust the user to write correctly (this is a single-user dev tool).
    let mut body = String::new();
    body.push_str("---\n");
    body.push_str(&format!("name: \"{}\"\n", req.name));
    if let Some(d) = &req.description {
        let escaped = d.replace('"', "\\\"");
        if !escaped.is_empty() {
            body.push_str(&format!("description: \"{escaped}\"\n"));
        }
    }
    body.push_str("---\n\n");
    body.push_str(&req.prompt);
    if !req.prompt.ends_with('\n') {
        body.push('\n');
    }
    std::fs::write(&skill_path, body).map_err(|e| internal_error(e.to_string()))?;

    Ok(Json(SkillInfo {
        name: req.name,
        description: req.description,
        origin: "user".to_string(),
        path: skill_path.display().to_string(),
        shadowed: false,
        editable: true,
    }))
}

async fn delete_skill_endpoint(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    validate_skill_name(&name).map_err(bad_request)?;

    // Scan known roots in the same priority order as `scan_skills` so the
    // delete matches whichever root the listing endpoint surfaced. This
    // covers all four shapes the UI can show:
    //   - `<workspace>/.claw/skills/<name>/`
    //   - `<workspace>/.claude/skills/<name>/`
    //   - `~/.claw/skills/<name>/`
    //   - `~/.claude/skills/<name>/` (where `npx skills add -g` writes)
    let cwd = {
        let cfg = state.config.read().await;
        cfg.workspace_root
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };
    let roots = skill_roots(&cwd);
    let candidate = roots
        .iter()
        .map(|r| r.path.join(&name))
        .find(|p| p.join("SKILL.md").exists());

    let skill_dir = candidate.ok_or_else(|| {
        bad_request(format!(
            "skill `{name}` not found in any known skills root",
        ))
    })?;

    // Safety: refuse to delete anything that resolves outside one of the
    // known roots (defence against name-based path-traversal and stray
    // symlinks). Canonicalise both sides so `..` / symlinks compare honestly.
    let canonical = std::fs::canonicalize(&skill_dir).map_err(|e| internal_error(e.to_string()))?;
    let safe = roots.iter().any(|r| {
        std::fs::canonicalize(&r.path)
            .map(|c| canonical.starts_with(&c))
            .unwrap_or(false)
    });
    if !safe {
        return Err(bad_request(format!(
            "skill `{name}` resolves outside known roots; refusing to delete",
        )));
    }
    std::fs::remove_dir_all(&skill_dir).map_err(|e| internal_error(e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

// ─────────────────── Skill registry (browse + install) ───────────────────
// Thin client over a GitHub-hosted registry.json (default
// `instructkr/claw-skills`). Honours `CLAW_SKILL_REGISTRY_URL` for
// overriding to a private mirror or local dev fixture (the smoke test
// uses a localhost fixture).
//
// Cache: single 10-minute in-memory entry keyed on (resolved registry
// URL). Refetch with `?refresh=1` in the query string. This matches the
// MCP registry's cache TTL so users don't see two different staleness
// behaviours across the app.

const DEFAULT_SKILL_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/instructkr/claw-skills/main/registry.json";
const SKILL_REGISTRY_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(600);
const SKILL_REGISTRY_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// On-the-wire shape from registry.json. We deliberately parse just
/// what we need so unknown fields (icons, screenshots, anything an
/// expanded schema adds later) don't crash the deserialise.
#[derive(Debug, Clone, Deserialize)]
struct RegistryFile {
    #[allow(dead_code)] // surfaced for forwards-compat — we don't gate on it yet
    #[serde(default)]
    registry_version: u32,
    #[serde(default)]
    skills: Vec<RegistryFileSkillEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryFileSkillEntry {
    name: String,
    description: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    homepage: Option<String>,
    /// Map of "filename written to disk" → "repo-relative path to fetch
    /// from". v1 only supports `{ "SKILL.md": "skills/<name>/SKILL.md" }`
    /// — multi-file is parsed but the install handler only honours
    /// SKILL.md to keep the surface area tight.
    files: std::collections::BTreeMap<String, String>,
}

/// What the frontend sees. No `files` map (that's an implementation
/// detail of the registry, not something the UI needs).
#[derive(Debug, Clone, Serialize)]
pub struct SkillRegistryEntry {
    pub name: String,
    pub description: String,
    pub category: Option<String>,
    pub version: Option<String>,
    pub tags: Vec<String>,
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillRegistryResponse {
    pub registry_url: String,
    pub entries: Vec<SkillRegistryEntry>,
    /// Wall-clock time the entries were fetched. Lets the UI surface
    /// "last refreshed N min ago" without us needing a separate /age
    /// endpoint.
    pub fetched_at_ms: u64,
}

fn resolve_skill_registry_url() -> String {
    std::env::var("CLAW_SKILL_REGISTRY_URL")
        .unwrap_or_else(|_| DEFAULT_SKILL_REGISTRY_URL.to_string())
}

/// Process-local cache. Single entry — if someone ever switches
/// CLAW_SKILL_REGISTRY_URL at runtime the cache key check forces a
/// refetch. Mutex (not RwLock) because writes happen exactly when
/// reads miss; contention is trivial.
fn skill_registry_cache(
) -> &'static tokio::sync::Mutex<Option<(String, Vec<RegistryFileSkillEntry>, std::time::Instant, u64)>>
{
    static CACHE: OnceLock<
        tokio::sync::Mutex<Option<(String, Vec<RegistryFileSkillEntry>, std::time::Instant, u64)>>,
    > = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

async fn fetch_registry_file(url: &str) -> Result<Vec<RegistryFileSkillEntry>, String> {
    let client = reqwest::Client::builder()
        .timeout(SKILL_REGISTRY_HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("registry fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "registry fetch returned HTTP {} for {url}",
            resp.status()
        ));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("registry read failed: {e}"))?;
    let parsed: RegistryFile = serde_json::from_slice(&body)
        .map_err(|e| format!("registry parse failed: {e} — is the URL pointing at a registry.json?"))?;
    Ok(parsed.skills)
}

#[derive(Debug, Deserialize)]
pub struct SkillRegistryQuery {
    #[serde(default)]
    refresh: Option<u8>,
}

async fn list_skill_registry_endpoint(
    Query(q): Query<SkillRegistryQuery>,
) -> ApiResult<Json<SkillRegistryResponse>> {
    let url = resolve_skill_registry_url();
    let force_refresh = matches!(q.refresh, Some(n) if n != 0);
    let now = std::time::Instant::now();

    let (raw_entries, fetched_at_ms) = {
        let mut guard = skill_registry_cache().lock().await;
        let fresh = match guard.as_ref() {
            Some((cached_url, _, ts, _)) if cached_url == &url => {
                !force_refresh && now.duration_since(*ts) < SKILL_REGISTRY_CACHE_TTL
            }
            _ => false,
        };
        if fresh {
            let cached = guard.as_ref().expect("cache present per match arm above");
            (cached.1.clone(), cached.3)
        } else {
            let fetched = fetch_registry_file(&url).await.map_err(bad_request)?;
            let fetched_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            *guard = Some((url.clone(), fetched.clone(), now, fetched_at_ms));
            (fetched, fetched_at_ms)
        }
    };

    let entries = raw_entries
        .into_iter()
        .map(|s| SkillRegistryEntry {
            name: s.name,
            description: s.description,
            category: s.category,
            version: s.version,
            tags: s.tags,
            homepage: s.homepage,
        })
        .collect();

    Ok(Json(SkillRegistryResponse {
        registry_url: url,
        entries,
        fetched_at_ms,
    }))
}

#[derive(Debug, Deserialize)]
pub struct InstallSkillFromRegistryRequest {
    pub name: String,
}

/// Given the registry URL (.../registry.json), compute the base URL
/// against which relative `files` paths are resolved. Strips back to
/// the last `/`. e.g. `https://x/y/registry.json` → `https://x/y/`.
fn registry_base_url(registry_url: &str) -> String {
    match registry_url.rfind('/') {
        Some(idx) => registry_url[..=idx].to_string(),
        None => registry_url.to_string(),
    }
}

async fn install_skill_from_registry_endpoint(
    Json(req): Json<InstallSkillFromRegistryRequest>,
) -> ApiResult<Json<SkillInfo>> {
    validate_skill_name(&req.name).map_err(bad_request)?;
    let url = resolve_skill_registry_url();

    // Always re-read the cache OR fetch — we want the install to be
    // honest about the version that's live on the registry right now,
    // not whatever the client last saw in its UI.
    let raw_entries = {
        let mut guard = skill_registry_cache().lock().await;
        let fresh = match guard.as_ref() {
            Some((cached_url, _, ts, _)) if cached_url == &url => {
                std::time::Instant::now().duration_since(*ts) < SKILL_REGISTRY_CACHE_TTL
            }
            _ => false,
        };
        if fresh {
            guard.as_ref().expect("present per match").1.clone()
        } else {
            let fetched = fetch_registry_file(&url).await.map_err(bad_request)?;
            let fetched_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            *guard = Some((
                url.clone(),
                fetched.clone(),
                std::time::Instant::now(),
                fetched_at_ms,
            ));
            fetched
        }
    };

    let entry = raw_entries
        .into_iter()
        .find(|e| e.name.eq_ignore_ascii_case(&req.name))
        .ok_or_else(|| bad_request(format!("skill `{}` not found in registry", req.name)))?;

    let user_root = user_claw_skills_dir()
        .ok_or_else(|| bad_request("HOME not set — cannot resolve ~/.claw/skills/".to_string()))?;
    let skill_dir = user_root.join(&entry.name);
    if skill_dir.exists() {
        return Err(bad_request(format!(
            "skill `{}` already installed at {} — uninstall first to reinstall",
            entry.name,
            skill_dir.display()
        )));
    }

    // v1 scope: only fetch SKILL.md. Multi-file support lands in phase B.
    let skill_md_path = entry
        .files
        .get("SKILL.md")
        .ok_or_else(|| bad_request(format!("registry entry `{}` is missing SKILL.md", entry.name)))?;
    let base = registry_base_url(&url);
    let file_url = if skill_md_path.starts_with("http://") || skill_md_path.starts_with("https://") {
        skill_md_path.clone()
    } else {
        format!("{base}{skill_md_path}")
    };

    let client = reqwest::Client::builder()
        .timeout(SKILL_REGISTRY_HTTP_TIMEOUT)
        .build()
        .map_err(|e| internal_error(format!("http client init failed: {e}")))?;
    let resp = client
        .get(&file_url)
        .send()
        .await
        .map_err(|e| internal_error(format!("SKILL.md fetch failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(internal_error(format!(
            "SKILL.md fetch returned HTTP {} for {file_url}",
            resp.status()
        )));
    }
    let content = resp
        .text()
        .await
        .map_err(|e| internal_error(format!("SKILL.md read failed: {e}")))?;

    std::fs::create_dir_all(&skill_dir).map_err(|e| internal_error(e.to_string()))?;
    let dest = skill_dir.join("SKILL.md");
    std::fs::write(&dest, content).map_err(|e| internal_error(e.to_string()))?;

    Ok(Json(SkillInfo {
        name: entry.name,
        description: Some(entry.description),
        origin: "user".to_string(),
        path: dest.display().to_string(),
        shadowed: false,
        editable: true,
    }))
}

// ─────────────────── Skill search via skills.sh proxy ───────────────────
// Server-side proxy because skills.sh has no browser CORS headers — a
// browser GET to https://skills.sh/api/search?q=… is rejected. Mirrors
// pi-web's Next.js /api/skills/search route (just the HTTP-first path,
// no npx fallback — that needs a separate "install via npx" endpoint
// which we don't ship yet).
//
// The response is passed through verbatim as JSON so we don't have to
// chase skills.sh schema changes server-side; the frontend normalises.
//
// Override the upstream via SKILLS_SH_URL (default https://skills.sh).

const SKILLS_SH_DEFAULT: &str = "https://skills.sh";
const SKILLS_SH_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub struct SkillsShSearchQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

fn resolve_skills_sh_base() -> String {
    std::env::var("SKILLS_SH_URL").unwrap_or_else(|_| SKILLS_SH_DEFAULT.to_string())
}

async fn search_skills_sh_endpoint(
    Query(q): Query<SkillsShSearchQuery>,
) -> ApiResult<Json<JsonValue>> {
    let raw_q = q.q.unwrap_or_default();
    let trimmed = raw_q.trim();
    if trimmed.is_empty() {
        return Ok(Json(json!({ "skills": [], "source": resolve_skills_sh_base() })));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let base = resolve_skills_sh_base();
    let url = format!("{base}/api/search");

    let client = reqwest::Client::builder()
        .timeout(SKILLS_SH_HTTP_TIMEOUT)
        .build()
        .map_err(|e| bad_gateway(format!("http client init failed: {e}")))?;
    let resp = client
        .get(&url)
        .query(&[("q", trimmed.to_string()), ("limit", limit.to_string())])
        .send()
        .await
        .map_err(|e| bad_gateway(format!("skills.sh fetch failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(bad_gateway(format!(
            "skills.sh returned HTTP {status} — {}",
            body.chars().take(200).collect::<String>()
        )));
    }
    let body: JsonValue = resp
        .json()
        .await
        .map_err(|e| bad_gateway(format!("skills.sh json parse failed: {e}")))?;
    // Stash the source URL alongside the upstream payload so the UI can
    // surface "powered by https://skills.sh" / detail links without
    // hard-coding it. If upstream already has a `source` we don't clobber.
    let merged = match body {
        JsonValue::Object(mut m) => {
            m.entry("source".to_string()).or_insert(JsonValue::String(base));
            JsonValue::Object(m)
        }
        other => json!({ "skills": other, "source": base }),
    };
    Ok(Json(merged))
}

// ─────────────────── Skill install via `npx skills add` ───────────────────
// Mirrors pi-web's /api/skills/install — shells out to the `skills` CLI
// (installed transparently via npx) which knows how to fetch + write
// SKILL.md and dependencies into the right roots for the requested
// agent. We always install globally to `~/.claw/skills/` so the result
// is editable through our normal Skills list.

#[derive(Debug, Deserialize)]
pub struct InstallViaSkillsShRequest {
    /// Full skills.sh id, e.g. `vercel-labs/agent-skills/vercel-react-best-practices`
    pub id: String,
    /// `"global"` (default) installs to the user-level claude-code skills
    /// dir; `"project"` runs the CLI inside `workspace_root` and the CLI
    /// places the skill under `<workspace_root>/.claude/skills/`.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InstallViaSkillsShResponse {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

async fn install_via_skills_sh_endpoint(
    State(state): State<AppState>,
    Json(req): Json<InstallViaSkillsShRequest>,
) -> ApiResult<Json<InstallViaSkillsShResponse>> {
    let id = req.id.trim();
    if id.is_empty() {
        return Err(bad_request("id is required".to_string()));
    }
    // Defensive: refuse anything that looks like a shell escape — `npx skills add`
    // takes a single package spec, no whitespace / quoting needed.
    if id.chars().any(|c| matches!(c, ' ' | ';' | '|' | '&' | '`' | '$' | '\n' | '\r' | '\t')) {
        return Err(bad_request(format!("invalid characters in id: {id}")));
    }

    // skills.sh ids look like `<owner>/<repo>/<skill-name>`. The CLI
    // wants `skills add <owner>/<repo> -s <skill-name>` — passing the
    // whole id as the source makes the CLI clone the wrong path and
    // report "No skills found". Split on the LAST slash; the owner-repo
    // pair before is the source, the trailing segment is the skill id.
    let (source, skill_name) = match id.rsplit_once('/') {
        Some((src, name)) if !src.is_empty() && !name.is_empty() && src.contains('/') => {
            (src, Some(name))
        }
        // Single-segment id (rare) or owner-only — pass through as source.
        _ => (id, None),
    };

    // Resolve install scope. Default = global. `project` requires the
    // server to have a workspace_root set; we run the CLI inside that
    // dir without `-g` so the skill lands at `<ws>/.claude/skills/`.
    let scope = req.scope.as_deref().unwrap_or("global").to_ascii_lowercase();
    let workspace_root = if scope == "project" {
        let config = state.config.read().await.clone();
        let root = config.workspace_root.ok_or_else(|| bad_request(
            "scope=project but no workspace_root is set — pick a workspace first".to_string()
        ))?;
        let trimmed = root.trim();
        if trimmed.is_empty() {
            return Err(bad_request(
                "scope=project but workspace_root is empty — pick a workspace first".to_string()
            ));
        }
        Some(std::path::PathBuf::from(trimmed))
    } else if scope != "global" {
        return Err(bad_request(format!(
            "unknown scope {scope:?}, expected `global` or `project`"
        )));
    } else {
        None
    };

    // claw is a claude-code fork, so the upstream skill repos' `claude-code`
    // subdirectory layout is what we consume. Honour CLAW_SKILLS_AGENT
    // for fork authors who want to publish under a custom agent slug.
    let agent = std::env::var("CLAW_SKILLS_AGENT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "claude-code".to_string());

    // NO_COLOR + FORCE_COLOR=0 + TERM=dumb together usually convince modern
    // CLIs to skip ANSI escapes. Keep belt-and-braces and also strip
    // any remaining sequences from the captured output below.
    let mut args: Vec<&str> = vec!["skills", "add", source, "-y", "--agent", &agent];
    if workspace_root.is_none() {
        // Only global installs get -g. For project scope we omit it and
        // rely on the CLI auto-detecting the project from cwd.
        args.push("-g");
    }
    if let Some(skill) = skill_name {
        args.push("-s");
        args.push(skill);
    }
    let mut cmd = tokio::process::Command::new("npx");
    cmd.args(&args)
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb");
    if let Some(ref cwd) = workspace_root {
        cmd.current_dir(cwd);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| bad_gateway(format!(
            "failed to spawn `npx skills add` — is npx on PATH? ({e})"
        )))?;

    let stdout_raw = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr_raw = String::from_utf8_lossy(&output.stderr).into_owned();
    let stdout = strip_ansi_escapes(&stdout_raw);
    let stderr = strip_ansi_escapes(&stderr_raw);
    let combined = format!("{stdout}\n{stderr}");
    // The skills CLI reports completion as 'Installation complete' or
    // 'Installed N skill(s)'. Anything else, including a non-zero exit,
    // counts as failure and surfaces stdout/stderr to the user.
    let success = output.status.success()
        && (combined.contains("Installation complete") || combined.contains("Installed"));

    if !success {
        // Surface only the human-readable tail of the output — the
        // spinner-frame churn at the top is just visual noise once ANSI
        // is stripped (it leaves trailing "Cloning repository.." lines).
        let cleaned = combined
            .lines()
            .map(str::trim_end)
            .filter(|line| !line.is_empty())
            // Drop the repeated spinner frames; keep one of each unique
            // line so the user sees the actual progression once.
            .fold(Vec::<String>::new(), |mut acc, line| {
                if acc.last().map(String::as_str) != Some(line) {
                    acc.push(line.to_string());
                }
                acc
            })
            .join("\n");
        let scope_label = if workspace_root.is_some() {
            format!("project={}", workspace_root.as_ref().unwrap().display())
        } else {
            "global".to_string()
        };
        return Err(bad_gateway(format!(
            "skills add failed (exit {:?}, agent={agent}, scope={scope_label}):\n{}",
            output.status.code(),
            cleaned.trim()
        )));
    }
    Ok(Json(InstallViaSkillsShResponse {
        success: true,
        stdout,
        stderr,
    }))
}

/// Minimal ANSI-escape stripper — handles CSI (`ESC [ … letter`) and OSC
/// (`ESC ] … BEL` or `ESC ] … ESC \`) sequences, plus the lone CSI/OSC
/// bytes. We don't pull in a crate for this since the input is small
/// and the schema is well-bounded.
fn strip_ansi_escapes(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'[' {
                // CSI: ESC [ params final-byte (final 0x40..=0x7e)
                i += 2;
                while i < bytes.len() {
                    let c = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&c) {
                        break;
                    }
                }
                continue;
            }
            if next == b']' {
                // OSC: ESC ] ... ( BEL | ESC \ )
                i += 2;
                while i < bytes.len() {
                    let c = bytes[i];
                    if c == 0x07 {
                        i += 1;
                        break;
                    }
                    if c == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            // Two-char ESC sequence (e.g. ESC =, ESC >, ESC c) — skip both.
            i += 2;
            continue;
        }
        out.push(b);
        i += 1;
    }
    // ANSI is ASCII-safe so the result is still valid UTF-8.
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

async fn health() -> Json<JsonValue> {
    Json(json!({ "status": "ok" }))
}

async fn create_session(
    State(state): State<AppState>,
) -> (StatusCode, Json<CreateSessionResponse>) {
    let session_id = state.allocate_session_id();
    let session = Session::new(session_id.clone());

    state
        .sessions
        .write()
        .await
        .insert(session_id.clone(), session);
    state.persist_session(&session_id).await;

    (
        StatusCode::CREATED,
        Json(CreateSessionResponse { session_id }),
    )
}

async fn list_sessions(State(state): State<AppState>) -> Json<ListSessionsResponse> {
    let sessions = state.sessions.read().await;
    let mut summaries = sessions
        .values()
        .map(|session| SessionSummary {
            id: session.id.clone(),
            created_at: session.created_at,
            message_count: session.conversation.messages.len(),
            turn_in_flight: session.turn_in_flight(),
            title: derive_session_title(&session.conversation),
        })
        .collect::<Vec<_>>();
    // Newest first — UX wants the recent session at the top of the sidebar.
    summaries.sort_by(|left, right| right.created_at.cmp(&left.created_at));

    Json(ListSessionsResponse {
        sessions: summaries,
    })
}

async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
) -> ApiResult<Json<SessionDetailsResponse>> {
    let sessions = state.sessions.read().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| not_found(format!("session `{id}` not found")))?;

    let attached_mcps = session
        .attached_mcps
        .lock()
        .map(|guard| guard.iter().cloned().collect())
        .unwrap_or_default();
    let attached_library = session
        .attached_library
        .lock()
        .ok()
        .and_then(|g| g.clone());
    let cumulative_tokens = session_cumulative_tokens(&session.conversation.messages);
    Ok(Json(SessionDetailsResponse {
        id: session.id.clone(),
        created_at: session.created_at,
        session: session.conversation.clone(),
        attached_mcps,
        cumulative_tokens,
        attached_library,
    }))
}

async fn send_message(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
    Json(payload): Json<SendMessageRequest>,
) -> ApiResult<StatusCode> {
    // Read each attachment off disk up front so any failure (missing file,
    // too large, binary) aborts the request before we mutate session state.
    let attachments: Vec<MessageAttachment> = payload
        .attachments
        .iter()
        .map(read_attachment)
        .collect::<ApiResult<Vec<_>>>()?;
    let user_input = payload.message;
    let mut user_message = ConversationMessage::user_with_attachments(
        user_input.clone(),
        attachments,
    );

    // Run RAG retrieval before we push the user message — that way the
    // persisted message carries `retrieved_context` and replays/exports
    // reflect what the LLM actually saw on this turn.
    //
    // Pulled out into its own scope so the early `read()` lock on
    // sessions drops before we grab the `write()` lock below.
    let attached_library: Option<String> = {
        let sessions = state.sessions.read().await;
        let session = sessions
            .get(&id)
            .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
        session
            .attached_library
            .lock()
            .ok()
            .and_then(|g| g.clone())
    };
    if let Some(library_name) = attached_library.as_deref() {
        // Retrieval failures are non-fatal — we log + continue without
        // injection. Killing the whole turn because a library is broken
        // would be a strictly worse UX than just degrading to no RAG.
        match retrieve_for_user_message(&state, library_name, &user_input).await {
            Ok(ctx) if !ctx.chunks.is_empty() => {
                user_message.retrieved_context = Some(ctx);
            }
            Ok(_) => {
                tracing::info!(library = %library_name, "RAG retrieval returned no chunks");
            }
            Err(e) => {
                tracing::warn!(library = %library_name, error = %e, "RAG retrieval failed; sending turn without injected context");
            }
        }
    }

    let (session_snapshot, broadcaster, turn_driver, attached_mcps_handle, cancel_signal, allow_rules_handle) = {
        let mut sessions = state.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
        if session.turn_in_flight() {
            return Err(conflict(format!(
                "session `{id}` already has a turn in progress"
            )));
        }
        let session_snapshot = session.conversation.clone();
        session.conversation.messages.push(user_message.clone());
        let attached_mcps_handle = session.attached_mcps.clone();
        // Reset the cancel flag at the start of every new turn — a
        // previous turn's cancel must not bleed into this one. We grab
        // the Arc so the observer + cancel_turn endpoint share state.
        session.cancel_signal.store(false, Ordering::Relaxed);
        let cancel_signal = session.cancel_signal.clone();
        let allow_rules_handle = session.allow_rules.clone();
        (
            session_snapshot,
            session.events.clone(),
            state.turn_driver.clone(),
            attached_mcps_handle,
            cancel_signal,
            allow_rules_handle,
        )
    };
    let turn_config = state.config.read().await.clone();

    // Enforce per-session token budget. We sum *output* tokens across all
    // assistant messages plus the input tokens billed on the latest one
    // (the prior input tokens are a subset of subsequent ones because the
    // whole history is re-sent each turn — counting just output + latest
    // input avoids overcounting). If the total would exceed the budget,
    // refuse the turn instead of starting one we'd have to kill mid-way.
    if let Some(budget) = turn_config.max_session_tokens {
        let used = session_cumulative_tokens(&session_snapshot.messages);
        if used >= budget {
            return Err(bad_request(format!(
                "session token budget reached: used {used} / {budget}. Start a new session or raise `max_session_tokens` to continue."
            )));
        }
    }

    let creds_for_turn = resolve_creds_for_turn(&state, &turn_config).await;
    let prompter_for_turn: Option<Box<dyn PermissionPrompter + Send>> = Some(Box::new(ServerPrompter {
        session_id: id.clone(),
        pending: state.pending_permissions.clone(),
        broadcaster: broadcaster.clone(),
        next_id: state.next_permission_id.clone(),
        allow_rules: allow_rules_handle,
    }));
    let questioner_for_turn: Option<Box<dyn UserQuestioner>> = Some(Box::new(ServerQuestioner {
        session_id: id.clone(),
        pending: state.pending_questions.clone(),
        broadcaster: broadcaster.clone(),
        next_id: state.next_question_id.clone(),
    }));
    let observer_for_turn: Option<Box<dyn TurnObserver>> = Some(Box::new(ServerTurnObserver {
        session_id: id.clone(),
        broadcaster: broadcaster.clone(),
        sessions: state.sessions.clone(),
        cancel_signal: cancel_signal.clone(),
    }));

    let turn_session_id = id.clone();
    let task_state = state.clone();
    let task_broadcaster = broadcaster.clone();
    let task_user_message = user_message.clone();
    let handle = tokio::spawn(async move {
        let _ = task_broadcaster.send(SessionEvent::TurnStarted {
            session_id: turn_session_id.clone(),
        });
        let _ = task_broadcaster.send(SessionEvent::UserMessage {
            session_id: turn_session_id.clone(),
            message: task_user_message.clone(),
        });

        let blocking_id = turn_session_id.clone();
        let blocking_config = turn_config.clone();
        let blocking_creds = creds_for_turn.clone();
        let blocking_prompter = prompter_for_turn;
        let blocking_questioner = questioner_for_turn;
        let blocking_observer = observer_for_turn;
        let blocking_permission_mode = task_state.permission_mode.clone();
        let tools_snapshot = task_state
            .mcp_tools
            .lock()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let tool_definitions = tools_snapshot
            .iter()
            .map(|tool| ToolDefinition {
                name: tool.qualified_name.clone(),
                description: tool.tool.description.clone(),
                input_schema: tool
                    .tool
                    .input_schema
                    .clone()
                    .unwrap_or_else(|| serde_json::json!({})),
            })
            .collect();
        let blocking_mcp = Some(McpRuntimeBundle {
            manager: task_state.mcp_manager.clone(),
            tool_definitions,
            tools_snapshot,
            attached_mcps: attached_mcps_handle,
        });
        let turn_result = tokio::task::spawn_blocking(move || {
            turn_driver.run_turn(
                blocking_id,
                session_snapshot,
                task_user_message,
                blocking_config,
                blocking_creds,
                blocking_prompter,
                blocking_questioner,
                blocking_observer,
                blocking_mcp,
                blocking_permission_mode,
            )
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(std::convert::identity);

        match turn_result {
            Ok(execution) => {
                {
                    let mut sessions = task_state.sessions.write().await;
                    if let Some(session) = sessions.get_mut(&turn_session_id) {
                        session.conversation = execution.session;
                    }
                }
                // Persist the completed turn (user + assistant + tool
                // messages) so it survives a restart.
                task_state.persist_session(&turn_session_id).await;
                for event in execution.events {
                    let _ = task_broadcaster.send(event);
                }
            }
            Err(error) => {
                let _ = task_broadcaster.send(SessionEvent::Error {
                    session_id: turn_session_id.clone(),
                    message: error,
                });
            }
        }

        let _ = task_broadcaster.send(SessionEvent::TurnFinished {
            session_id: turn_session_id,
        });
    });

    {
        let mut sessions = state.sessions.write().await;
        if let Some(session) = sessions.get_mut(&id) {
            session.current_turn = Some(handle);
        }
    }

    // Persist the just-pushed user message so a crash mid-turn doesn't lose
    // the prompt. The assistant reply is persisted again when the turn ends.
    state.persist_session(&id).await;

    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompactSessionResponse {
    pub removed_message_count: usize,
    pub before_tokens: usize,
    pub after_tokens: usize,
    pub kept_message_count: usize,
}

/// Force-compact the session's conversation: replace the leading messages
/// with a rule-based summary while preserving the most recent four. Pure CPU
/// — no LLM call. Broadcasts a `SessionSnapshot` so any connected client
/// re-syncs without polling.
async fn compact_session_endpoint(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
) -> ApiResult<Json<CompactSessionResponse>> {
    let (compact_result, broadcaster, before_tokens, snapshot) = {
        let mut sessions = state.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
        if session.turn_in_flight() {
            return Err(conflict(format!(
                "session `{id}` has a turn in progress; cancel it before compacting"
            )));
        }
        let before_tokens = estimate_session_tokens(&session.conversation);
        let result = compact_session(
            &session.conversation,
            CompactionConfig {
                max_estimated_tokens: 0,
                ..CompactionConfig::default()
            },
        );
        session.conversation = result.compacted_session.clone();
        let snapshot = session.conversation.clone();
        (result, session.events.clone(), before_tokens, snapshot)
    };

    let after_tokens = estimate_session_tokens(&snapshot);
    let _ = broadcaster.send(SessionEvent::SessionSnapshot {
        session_id: id.clone(),
        session: snapshot.clone(),
    });
    state.persist_session(&id).await;

    Ok(Json(CompactSessionResponse {
        removed_message_count: compact_result.removed_message_count,
        before_tokens,
        after_tokens,
        kept_message_count: snapshot.messages.len(),
    }))
}

// ─────────────── Cross-session absorb endpoint ───────────────
// POST /sessions/{target}/absorb
//
// Two-step usage from the UI:
//   1. preview  — body `{ source_session_ids, inject: false }` → returns
//      generated summary, no side effects on target session
//   2. inject   — body `{ source_session_ids: [], inject: true,
//                          override_summary: "<user-edited markdown>" }` →
//      skips LLM and just appends the edited summary as a system message
//      on the target session
//
// One-shot usage is also supported (`inject: true` without override_summary)
// for callers that don't need the preview/edit step.

#[derive(Debug, Clone, Deserialize)]
pub struct AbsorbRequest {
    /// Sessions whose transcripts feed the summarizer. Order matters —
    /// the summarizer sees them concatenated in this order, oldest-most-
    /// relevant first by convention.
    #[serde(default)]
    pub source_session_ids: Vec<SessionId>,
    /// When true, the resulting (or overridden) summary is appended as a
    /// system-role message on the target session.
    #[serde(default)]
    pub inject: bool,
    /// When supplied, bypass the LLM and use this text verbatim. Lets the
    /// user edit the preview before committing.
    #[serde(default)]
    pub override_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AbsorbResponse {
    pub summary: String,
    pub summarizer_model: String,
    /// `true` when no dedicated `session_summarizer` was configured and
    /// we fell back to the main `config.model`. The UI surfaces this as
    /// a warning ("same model summarising itself" bias risk).
    pub fallback_to_main_model: bool,
    pub injected: bool,
    /// Rough character count per source — cheap proxy for token cost
    /// without paying the per-provider tokenizer overhead in the request
    /// path.
    pub source_char_counts: BTreeMap<SessionId, usize>,
}

const SESSION_SUMMARIZER_DEFAULT_MAX_TOKENS: u32 = 2000;
const SESSION_SUMMARIZER_CALL_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(120);

async fn absorb_sessions_endpoint(
    State(state): State<AppState>,
    Path(target): Path<SessionId>,
    Json(req): Json<AbsorbRequest>,
) -> ApiResult<Json<AbsorbResponse>> {
    // Validate target exists; reject if it's mid-turn (the system message
    // append races with assistant_delta writes otherwise).
    {
        let sessions = state.sessions.read().await;
        let session = sessions
            .get(&target)
            .ok_or_else(|| not_found(format!("target session `{target}` not found")))?;
        if session.turn_in_flight() {
            return Err(conflict(format!(
                "session `{target}` has a turn in progress; cancel it before absorbing"
            )));
        }
    }

    // Resolve summarizer model + creds. Fall back to main config.model
    // when no dedicated summarizer is configured. Surface that fallback
    // in the response so the UI can warn the user.
    let (config_for_creds, fallback_to_main_model, summarizer_model, base_url, api_key, system_prompt, max_tokens) = {
        let cfg = state.config.read().await.clone();
        if let Some(s) = cfg.session_summarizer.clone() {
            (
                cfg,
                false,
                s.model.clone(),
                s.base_url.clone(),
                Some(s.api_key.clone()).filter(|k| !k.trim().is_empty()),
                s.system_prompt
                    .clone()
                    .unwrap_or_else(default_session_summarizer_prompt),
                s.max_tokens.unwrap_or(SESSION_SUMMARIZER_DEFAULT_MAX_TOKENS),
            )
        } else {
            let main_model = cfg.model.clone().ok_or_else(|| {
                bad_request(
                    "no session_summarizer configured and no fallback `model` set in config"
                        .to_string(),
                )
            })?;
            (
                cfg,
                true,
                main_model,
                None,
                None,
                default_session_summarizer_prompt(),
                SESSION_SUMMARIZER_DEFAULT_MAX_TOKENS,
            )
        }
    };

    // If we don't yet have an explicit api_key for this summarizer call,
    // look up the matching provider's stored credentials (api_key +
    // base_url) — same place a normal turn would resolve them via
    // resolve_creds_for_turn. Without this, the fallback path bypasses
    // the UI-configured creds and demands the OPENAI_COMPAT_API_KEY env
    // var even when the user already provided a key on Models tab.
    let (api_key, base_url) = if api_key.is_some() {
        (api_key, base_url)
    } else if let Some(name) = provider_name_for_model(&summarizer_model) {
        let store = state.provider_creds.read().await;
        match store.get(name).cloned() {
            Some(creds) => (Some(creds.api_key), base_url.or(creds.base_url)),
            None => (None, base_url),
        }
    } else {
        (None, base_url)
    };
    let _ = config_for_creds; // silence unused when no future use

    // Fail-fast on shape errors before touching the session store.
    if req.source_session_ids.is_empty() && req.override_summary.is_none() {
        return Err(bad_request(
            "either source_session_ids must be non-empty or override_summary must be provided"
                .to_string(),
        ));
    }
    // Reject self-reference: absorbing a session's own transcript into
    // itself would inject a summary of recent turns as a new system
    // message in the same session, immediately distorting subsequent
    // model output. Surface it as a 400 rather than silently doing it.
    if req.source_session_ids.iter().any(|sid| sid == &target) {
        return Err(bad_request(format!(
            "cannot absorb session `{target}` into itself — pick different source sessions"
        )));
    }

    // Read source transcripts. Compute per-source char counts as a cheap
    // budget proxy so the UI can show "you're absorbing ~12k chars from
    // 3 sessions" without us tokenising server-side.
    let (rendered_sources, source_char_counts) = {
        let sessions = state.sessions.read().await;
        let mut rendered = String::new();
        let mut counts = BTreeMap::new();
        for sid in &req.source_session_ids {
            let session = sessions
                .get(sid)
                .ok_or_else(|| not_found(format!("source session `{sid}` not found")))?;
            let block = render_session_for_summarizer(sid, &session.conversation);
            counts.insert(sid.clone(), block.len());
            rendered.push_str(&block);
        }
        (rendered, counts)
    };

    // Resolve the summary text — either user-supplied (edit-mode) or
    // generated by the LLM.
    let summary = if let Some(override_text) = req.override_summary.clone() {
        let trimmed = override_text.trim();
        if trimmed.is_empty() {
            return Err(bad_request(
                "override_summary was provided but is empty".to_string(),
            ));
        }
        override_text
    } else {
        let client = match api_key.as_ref() {
            Some(key) => ProviderClient::from_model_with_credentials(
                &summarizer_model,
                key.clone(),
                base_url.clone(),
            )
            .map_err(|e| bad_gateway(format!("summarizer client init failed: {e}")))?,
            None => ProviderClient::from_model(&summarizer_model)
                .map_err(|e| bad_gateway(format!("summarizer client init failed: {e}")))?,
        };

        let user_prompt = format!(
            "Summarise the following {} prior agent session(s):\n\n{}",
            req.source_session_ids.len(),
            rendered_sources
        );
        let request = MessageRequest {
            model: summarizer_model.clone(),
            max_tokens,
            messages: vec![InputMessage::user_text(user_prompt)],
            system: Some(system_prompt),
            tools: None,
            tool_choice: None,
            stream: false,
        };

        let response: MessageResponse =
            tokio::time::timeout(SESSION_SUMMARIZER_CALL_TIMEOUT, client.send_message(&request))
                .await
                .map_err(|_| {
                    bad_gateway(format!(
                        "session summarizer API call timed out after {}s",
                        SESSION_SUMMARIZER_CALL_TIMEOUT.as_secs()
                    ))
                })?
                .map_err(|e| bad_gateway(format!("session summarizer API call failed: {e}")))?;

        let mut buf = String::new();
        for block in response.content {
            if let OutputContentBlock::Text { text } = block {
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(&text);
            }
        }
        if buf.is_empty() {
            return Err(bad_gateway(
                "session summarizer returned empty response".to_string(),
            ));
        }
        buf
    };

    // Inject as a system-role message on the target if requested.
    let mut injected = false;
    if req.inject {
        let source_ids_label = req
            .source_session_ids
            .iter()
            .map(|s| format!("`{s}`"))
            .collect::<Vec<_>>()
            .join(", ");
        let header = if source_ids_label.is_empty() {
            "Absorbed summary (user-supplied)".to_string()
        } else {
            format!("Absorbed summary from {source_ids_label}")
        };
        let body = format!("[{header}]\n\n{summary}");
        let (broadcaster, snapshot) = {
            let mut sessions = state.sessions.write().await;
            let session = sessions
                .get_mut(&target)
                .ok_or_else(|| not_found(format!("target session `{target}` not found")))?;
            session.conversation.messages.push(runtime::ConversationMessage {
                role: runtime::MessageRole::System,
                blocks: vec![runtime::ContentBlock::Text { text: body }],
                usage: None,
                attachments: Vec::new(),
                model: None,
                retrieved_context: None,
            });
            (session.events.clone(), session.conversation.clone())
        };
        let _ = broadcaster.send(SessionEvent::SessionSnapshot {
            session_id: target.clone(),
            session: snapshot,
        });
        injected = true;
    }

    Ok(Json(AbsorbResponse {
        summary,
        summarizer_model,
        fallback_to_main_model,
        injected,
        source_char_counts,
    }))
}

/// Render one source session as text for the summarizer's user prompt.
/// Drops reasoning blocks (noise), tool result bodies (can be huge), and
/// retried tool calls' intermediate states. Keeps user text, assistant
/// text, and tool-call names/args (truncated) so the summarizer sees the
/// outline of the work without drowning in raw stdout.
fn render_session_for_summarizer(
    id: &SessionId,
    session: &runtime::Session,
) -> String {
    use runtime::{ContentBlock as CB, MessageRole as Role};
    let mut out = String::new();
    out.push_str(&format!(
        "\n=== Session `{id}` ({} messages) ===\n",
        session.messages.len()
    ));
    for msg in &session.messages {
        let role = match msg.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
            Role::System => "system",
        };
        for block in &msg.blocks {
            match block {
                CB::Text { text } => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        out.push_str(&format!("[{role}] {trimmed}\n"));
                    }
                }
                CB::ToolUse { name, input, .. } => {
                    let preview = input.replace('\n', " ");
                    let truncated: String = preview.chars().take(200).collect();
                    let ellipsis = if preview.chars().count() > 200 { "…" } else { "" };
                    out.push_str(&format!("[tool→{name}] {truncated}{ellipsis}\n"));
                }
                CB::ToolResult { tool_name, is_error, .. } => {
                    let marker = if *is_error { "error" } else { "ok" };
                    out.push_str(&format!("[tool←{tool_name}] {marker}\n"));
                }
                CB::Reasoning { .. } => { /* dropped — noise for summary */ }
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetSessionMcpAttachedPayload {
    pub attached: bool,
}

/// Mutate a session's `attached_mcps` set from the UI side (the LLM
/// already has the `attach_mcp_server` / `detach_mcp_server` meta-tools;
/// this endpoint is for human overrides). Validates the MCP name against
/// the live tool catalog so the UI can't desync against a server that
/// was deleted out from under it. Refuses while a turn is in flight to
/// avoid mutating state half-way through a tool list snapshot.
async fn set_session_mcp_attached(
    State(state): State<AppState>,
    Path((id, name)): Path<(SessionId, String)>,
    Json(payload): Json<SetSessionMcpAttachedPayload>,
) -> ApiResult<Json<SessionDetailsResponse>> {
    let known = state
        .mcp_tools
        .lock()
        .ok()
        .map(|guard| {
            guard
                .iter()
                .any(|tool| tool.server_name == name)
        })
        .unwrap_or(false);
    if payload.attached && !known {
        return Err(bad_request(format!(
            "mcp server `{name}` is not currently configured or discovered"
        )));
    }

    let sessions = state.sessions.read().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
    if session.turn_in_flight() {
        return Err(conflict(format!(
            "session `{id}` has a turn in progress; wait for it or cancel before toggling mcp attachment"
        )));
    }
    {
        let mut attached = session.attached_mcps.lock().map_err(|_| {
            internal_error("attached_mcps lock poisoned".to_string())
        })?;
        if payload.attached {
            attached.insert(name.clone());
        } else {
            attached.remove(&name);
        }
    }
    let attached_mcps: Vec<String> = session
        .attached_mcps
        .lock()
        .map(|guard| guard.iter().cloned().collect())
        .unwrap_or_default();
    // Broadcast a session_snapshot so every connected client picks up the
    // new attached set without polling. The conversation body is unchanged;
    // we send it for free since the frontend already wires session_snapshot
    // → setMessages(...). Keeps a single sync path for both LLM-driven
    // attach (via the meta-tool) and the human-driven endpoint.
    let _ = session.events.send(SessionEvent::SessionSnapshot {
        session_id: session.id.clone(),
        session: session.conversation.clone(),
    });
    let attached_library = session
        .attached_library
        .lock()
        .ok()
        .and_then(|g| g.clone());
    let cumulative_tokens = session_cumulative_tokens(&session.conversation.messages);
    let response = SessionDetailsResponse {
        id: session.id.clone(),
        created_at: session.created_at,
        session: session.conversation.clone(),
        attached_mcps,
        cumulative_tokens,
        attached_library,
    };
    // Drop the read guard before persisting — `persist_session` takes its
    // own read lock and we don't want to hold two across an await.
    drop(sessions);
    state.persist_session(&id).await;
    Ok(Json(response))
}

async fn cancel_turn(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
) -> ApiResult<Json<CancelTurnResponse>> {
    let (handle_opt, broadcaster, cancel_signal) = {
        let mut sessions = state.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
        let handle = session.current_turn.take();
        (handle, session.events.clone(), session.cancel_signal.clone())
    };

    let Some(handle) = handle_opt else {
        return Ok(Json(CancelTurnResponse { cancelled: false }));
    };
    if handle.is_finished() {
        return Ok(Json(CancelTurnResponse { cancelled: false }));
    }

    // Flip the cooperative cancel flag FIRST so the runtime loop sees
    // it at its next iter boundary. `abort()` is best-effort — it
    // marks the outer tokio task as cancelled but can't pre-empt the
    // spawn_blocking OS thread inside, so the flag is the real worker.
    cancel_signal.store(true, Ordering::Relaxed);
    handle.abort();
    // Reap any parked permission/question senders for this session — the
    // runtime thread is blocked on a oneshot that nobody is going to
    // answer now, so dropping the sender is the only way to unblock it.
    // Must run AFTER abort + cancel_signal so the runtime sees both
    // signals and exits cleanly (Err on recv + cancel flag at next iter).
    reap_pending_for_session(&state, &id);
    let _ = broadcaster.send(SessionEvent::TurnCancelled {
        session_id: id.clone(),
    });
    let _ = broadcaster.send(SessionEvent::TurnFinished { session_id: id });

    Ok(Json(CancelTurnResponse { cancelled: true }))
}

/// Reap every parked permission/question sender belonging to `session_id`.
/// Dropping the sender closes the channel, which unblocks the runtime
/// thread's `rx.blocking_recv()` with an Err — the runtime then yields a
/// clean Deny (permissions) or Dismissed (questions) and exits the turn
/// loop. Without this, cancelling a turn or deleting a session while a
/// prompt is parked leaks the OS thread inside spawn_blocking, since
/// tokio's `.abort()` cannot pre-empt it.
fn reap_pending_for_session(state: &AppState, session_id: &SessionId) {
    if let Ok(mut pending) = state.pending_permissions.lock() {
        pending.retain(|_id, entry| entry.session_id != *session_id);
    }
    if let Ok(mut pending) = state.pending_questions.lock() {
        pending.retain(|_id, entry| entry.session_id != *session_id);
    }
}

/// DELETE /sessions/{id} — drops the session from the in-memory store.
/// If a turn is in flight, we flip the cancel flag and abort the handle
/// so the runtime thread unwinds cleanly; we don't wait on it before
/// removing the session because the SSE subscribers have already
/// disconnected by the time the UI fires this.
async fn delete_session_endpoint(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
) -> ApiResult<StatusCode> {
    let session = {
        let mut sessions = state.sessions.write().await;
        sessions
            .remove(&id)
            .ok_or_else(|| not_found(format!("session `{id}` not found")))?
    };

    // Best-effort cancel — same dance as cancel_turn. We don't broadcast
    // TurnFinished here because the broadcaster is owned by the removed
    // session and there's no one left listening.
    session.cancel_signal.store(true, Ordering::Relaxed);
    if let Some(handle) = session.current_turn {
        handle.abort();
    }
    // Same cleanup as cancel_turn — if a permission/question prompt was
    // parked when the user deleted the session, dropping the sender lets
    // the runtime thread exit instead of hanging forever.
    reap_pending_for_session(&state, &id);
    state.forget_session(&id).await;

    Ok(StatusCode::NO_CONTENT)
}

async fn decide_permission(
    State(state): State<AppState>,
    Path((session_id, request_id)): Path<(SessionId, String)>,
    Json(payload): Json<PermissionDecisionRequest>,
) -> ApiResult<StatusCode> {
    let entry = {
        let mut pending = match state.pending_permissions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        pending.remove(&request_id)
    };
    let Some(entry) = entry else {
        return Err(not_found(format!(
            "no pending permission request `{request_id}`"
        )));
    };

    let decision = if payload.allowed {
        PermissionPromptDecision::Allow
    } else {
        PermissionPromptDecision::Deny {
            reason: payload
                .reason
                .clone()
                .unwrap_or_else(|| "denied by user".to_string()),
        }
    };
    let send_result = entry.sender.send(decision);
    if send_result.is_err() {
        // The runtime side dropped before we could deliver. Best effort cleanup.
        return Err(gone(format!(
            "permission request `{request_id}` is no longer awaiting a decision"
        )));
    }

    // "Allow always": remember this command prefix / tool for the session so
    // future identical prompts auto-approve. Derived from the parked request's
    // own tool_name + input (the replay event), so it can't be spoofed by the
    // POST body. In-memory only — never persisted.
    if payload.allowed && payload.remember.unwrap_or(false) {
        if let SessionEvent::PermissionRequest {
            tool_name, input, ..
        } = &entry.replay_event
        {
            if let Some(key) = permission_rule_key(tool_name, input) {
                let sessions = state.sessions.read().await;
                if let Some(session) = sessions.get(&session_id) {
                    if let Ok(mut rules) = session.allow_rules.lock() {
                        rules.insert(key);
                    }
                }
            }
        }
    }

    // Broadcast the decision so other UI tabs / observers stay in sync.
    let broadcaster = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).map(|s| s.events.clone())
    };
    if let Some(broadcaster) = broadcaster {
        let _ = broadcaster.send(SessionEvent::PermissionDecision {
            session_id,
            request_id,
            allowed: payload.allowed,
            reason: payload.reason,
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Sibling of `decide_permission` for the AskUser flow. Same shape:
/// pop the parked oneshot, hand it the user's answer, broadcast the
/// resolution so any other connected client dismisses its copy.
async fn answer_question(
    State(state): State<AppState>,
    Path((session_id, question_id)): Path<(SessionId, String)>,
    Json(payload): Json<QuestionAnswerRequest>,
) -> ApiResult<StatusCode> {
    let entry = {
        let mut pending = match state.pending_questions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        pending.remove(&question_id)
    };
    let Some(entry) = entry else {
        return Err(not_found(format!(
            "no pending question `{question_id}`"
        )));
    };

    // Translate the wire payload to the runtime answer enum. Reject
    // obviously bad combinations early so the model isn't given garbage.
    let (answer, broadcast_kind) = match payload {
        QuestionAnswerRequest::Selected { index, label } => (
            UserQuestionAnswer::Selected {
                index,
                label: label.clone(),
            },
            UserAnswerKind::Selected { index, label },
        ),
        QuestionAnswerRequest::OtherText { text } => {
            if text.trim().is_empty() {
                return Err(bad_request(
                    "other_text answer must not be empty".to_string(),
                ));
            }
            (
                UserQuestionAnswer::OtherText { text: text.clone() },
                UserAnswerKind::OtherText { text },
            )
        }
        QuestionAnswerRequest::Dismissed => {
            (UserQuestionAnswer::Dismissed, UserAnswerKind::Dismissed)
        }
    };

    if entry.sender.send(answer).is_err() {
        return Err(gone(format!(
            "question `{question_id}` is no longer awaiting an answer"
        )));
    }

    let broadcaster = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).map(|s| s.events.clone())
    };
    if let Some(broadcaster) = broadcaster {
        let _ = broadcaster.send(SessionEvent::UserAnswer {
            session_id,
            question_id,
            kind: broadcast_kind,
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn list_tools(State(state): State<AppState>) -> Json<ToolsResponse> {
    let mut tools = mvp_tool_specs()
        .into_iter()
        .map(tool_summary)
        .collect::<Vec<_>>();
    if let Ok(snapshot) = state.mcp_tools.lock() {
        for managed in snapshot.iter() {
            tools.push(ToolSummary {
                name: managed.qualified_name.clone(),
                description: managed
                    .tool
                    .description
                    .clone()
                    .unwrap_or_else(|| format!("(from mcp server `{}`)", managed.server_name)),
                required_permission: "danger-full-access".to_string(),
                input_schema: managed.tool.input_schema.clone().unwrap_or_else(|| serde_json::json!({})),
            });
        }
    }
    Json(ToolsResponse { tools })
}

async fn list_commands() -> Json<CommandsResponse> {
    let commands = slash_command_specs()
        .iter()
        .map(command_summary)
        .collect::<Vec<_>>();
    Json(CommandsResponse { commands })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerConfigView {
    pub permission_mode: String,
    pub model: Option<String>,
    pub workspace_root: Option<String>,
    /// Total input-context window in tokens for the active model. Derived
    /// from `model` via `context_window_for_model`; not persisted.
    pub context_window: u32,
    pub max_tool_iterations_per_turn: u32,
    pub max_session_tokens: Option<u64>,
    /// Sanitised view of the embedding provider — strips `api_key` so the
    /// frontend can render "model / dim / base_url" without ever
    /// receiving the secret. Re-supply on PATCH if changing the key.
    pub embedding_provider: Option<EmbeddingProviderView>,
    /// WebFetch sub-LLM summarizer settings — sanitised view, api_key
    /// stripped. Re-supply api_key on PATCH only if changing it.
    pub web_fetch_summarizer: Option<WebFetchSummarizerView>,
    /// Cross-session "absorb" summarizer settings — sanitised view, same
    /// secret-handling rules as `web_fetch_summarizer`.
    pub session_summarizer: Option<SessionSummarizerView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddingProviderView {
    pub base_url: String,
    pub model: String,
    pub dimensions: u32,
    /// `true` iff an api_key is set server-side. Lets the UI distinguish
    /// "not configured" from "configured (key hidden)".
    pub configured: bool,
}

impl From<ServerConfig> for ServerConfigView {
    fn from(value: ServerConfig) -> Self {
        let context_window = value
            .model
            .as_deref()
            .map_or_else(|| context_window_for_model(""), context_window_for_model);
        let embedding_provider = value.embedding_provider.map(|p| EmbeddingProviderView {
            base_url: p.base_url,
            model: p.model,
            dimensions: p.dimensions,
            configured: !p.api_key.trim().is_empty(),
        });
        Self {
            permission_mode: value.permission_mode,
            model: value.model,
            workspace_root: value.workspace_root,
            context_window,
            max_tool_iterations_per_turn: value.max_tool_iterations_per_turn,
            max_session_tokens: value.max_session_tokens,
            embedding_provider,
            web_fetch_summarizer: value
                .web_fetch_summarizer
                .as_ref()
                .map(WebFetchSummarizerView::from),
            session_summarizer: value
                .session_summarizer
                .as_ref()
                .map(SessionSummarizerView::from),
        }
    }
}

async fn get_config(State(state): State<AppState>) -> Json<ServerConfigView> {
    Json(ServerConfigView::from(state.config.read().await.clone()))
}

async fn update_config(
    State(state): State<AppState>,
    Json(patch): Json<ConfigPatch>,
) -> ApiResult<Json<ServerConfigView>> {
    if let Some(mode) = &patch.permission_mode {
        parse_permission_mode(mode).map_err(bad_request)?;
    }
    if let Some(Some(root)) = patch.workspace_root.as_ref() {
        let trimmed = root.trim();
        if !trimmed.is_empty() {
            let canonical = std::fs::canonicalize(trimmed).map_err(|err| {
                bad_request(format!("workspace_root `{trimmed}` is not accessible: {err}"))
            })?;
            if !canonical.is_dir() {
                return Err(bad_request(format!(
                    "workspace_root `{}` is not a directory",
                    canonical.display()
                )));
            }
        }
    }
    let updated = {
        let mut config = state.config.write().await;
        if let Some(mode) = patch.permission_mode {
            // Mirror into the live atomic so any in-flight turn re-reads the
            // new mode at its next tool boundary (validated above).
            if let Ok(parsed) = parse_permission_mode(&mode) {
                state.permission_mode.store(parsed.as_u8(), Ordering::Relaxed);
            }
            config.permission_mode = mode;
        }
        if let Some(model) = patch.model {
            config.model = model;
        }
        if let Some(root) = patch.workspace_root {
            // PATCH semantics: `null` clears, empty string also clears, real path canonicalises.
            config.workspace_root = root.and_then(|raw| {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return None;
                }
                Some(
                    std::fs::canonicalize(trimmed)
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|_| trimmed.to_string()),
                )
            });
        }
        if let Some(iter) = patch.max_tool_iterations_per_turn {
            // Clamp to a sane band — 0 falls back to default, anything
            // over 1000 is almost certainly a typo and would defeat the
            // safety brake the field exists for.
            config.max_tool_iterations_per_turn = if iter == 0 {
                default_max_iter()
            } else {
                iter.min(1000)
            };
        }
        if let Some(budget) = patch.max_session_tokens {
            config.max_session_tokens = budget;
        }
        if let Some(provider) = patch.embedding_provider {
            // Switching dim mid-flight is dangerous — the library_store
            // baked its dim at startup. We accept the patch (it's only a
            // restart away from being applied) but log the case loudly
            // so the user knows a restart + library wipe might be needed.
            let new_dim = provider.as_ref().map(|p| p.dimensions as usize);
            if let Some(d) = new_dim {
                if d != state.library_store.dim() {
                    tracing::warn!(
                        old_dim = state.library_store.dim(),
                        new_dim = d,
                        "embedding dim changed — restart the server (and delete existing libraries) to apply",
                    );
                }
            }
            config.embedding_provider = provider;
        }
        if let Some(summarizer_patch) = patch.web_fetch_summarizer {
            // Merge the patch into the existing settings. The key rule
            // for api_key: `None` in the patch means "leave it alone"
            // (so the client can update model/max_tokens without
            // re-sending the secret), `Some("")` clears it back to
            // env-fallback, `Some(real)` updates it.
            let merged = summarizer_patch.map(|p| {
                let existing_key = config
                    .web_fetch_summarizer
                    .as_ref()
                    .map(|s| s.api_key.clone())
                    .unwrap_or_default();
                let api_key = match p.api_key {
                    Some(k) => k,
                    None => existing_key,
                };
                WebFetchSummarizerSettings {
                    model: p.model,
                    api_key,
                    base_url: p.base_url,
                    max_tokens: p.max_tokens,
                    system_prompt: p.system_prompt,
                }
            });
            // Mirror the persisted change into the tools crate's global
            // slot so WebFetch picks it up on the very next call — no
            // server restart needed.
            install_webfetch_summarizer(merged.as_ref());
            config.web_fetch_summarizer = merged;
        }
        if let Some(summarizer_patch) = patch.session_summarizer {
            // Same secret-handling rule as web_fetch_summarizer.
            let merged = summarizer_patch.map(|p| {
                let existing_key = config
                    .session_summarizer
                    .as_ref()
                    .map(|s| s.api_key.clone())
                    .unwrap_or_default();
                let api_key = match p.api_key {
                    Some(k) => k,
                    None => existing_key,
                };
                SessionSummarizerSettings {
                    model: p.model,
                    api_key,
                    base_url: p.base_url,
                    max_tokens: p.max_tokens,
                    system_prompt: p.system_prompt,
                }
            });
            config.session_summarizer = merged;
        }
        config.clone()
    };
    state.persist_now().await;
    Ok(Json(ServerConfigView::from(updated)))
}

async fn list_providers(State(state): State<AppState>) -> Json<ProvidersResponse> {
    let store = state.provider_creds.read().await;
    let providers = PROVIDER_CATALOG
        .iter()
        .map(|entry| {
            let stored = store.get(entry.name);
            ProviderSummary {
                name: entry.name.to_string(),
                label: entry.label.to_string(),
                configured: stored.is_some(),
                base_url: stored.and_then(|c| c.base_url.clone()),
                default_base_url: entry.default_base_url.to_string(),
                env_keys: entry.env_keys.iter().map(|s| (*s).to_string()).collect(),
                models: entry.models.iter().map(|s| (*s).to_string()).collect(),
            }
        })
        .collect();
    Json(ProvidersResponse { providers })
}

async fn put_provider(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<ProviderCredsPayload>,
) -> ApiResult<StatusCode> {
    if !PROVIDER_CATALOG.iter().any(|entry| entry.name == name) {
        return Err(bad_request(format!("unknown provider `{name}`")));
    }
    let api_key = payload.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(bad_request("api_key must not be empty".to_string()));
    }
    let base_url = payload
        .base_url
        .and_then(|url| {
            let trimmed = url.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
    {
        let mut store = state.provider_creds.write().await;
        store.insert(name, ProviderCreds { api_key, base_url });
    }
    state.persist_now().await;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_provider(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    if !PROVIDER_CATALOG.iter().any(|entry| entry.name == name) {
        return Err(bad_request(format!("unknown provider `{name}`")));
    }
    state.provider_creds.write().await.remove(&name);
    state.persist_now().await;
    Ok(StatusCode::NO_CONTENT)
}

// `Eq` is intentionally not derived — the pricing fields are `f64`, which is
// only `PartialEq`. Equality is still available for tests via `PartialEq`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveModel {
    pub id: String,
    /// Reported by the upstream when available (Anthropic returns it).
    /// Falls back to our static `context_window_for_model` if absent.
    pub context_window: Option<u32>,
    /// USD per 1M input tokens from our static pricing table, when the model
    /// id matches a known tier. `None` for unpriced/unknown models — provider
    /// `/models` endpoints almost never return pricing, so this is best-effort.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_per_million: Option<f64>,
    /// USD per 1M output tokens; same source/caveats as `input_per_million`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_per_million: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveModelsResponse {
    pub provider: String,
    pub fetched_from: String,
    pub models: Vec<LiveModel>,
}

/// Build the model-listing URL for a given provider's base URL.
///
/// The OpenAI-compatible providers all expose `/v1/models`, but their
/// configured base URLs sometimes already include the `/v1` segment (OpenAI)
/// and sometimes don't (DeepSeek). Normalise by stripping a trailing `/v1`
/// then re-appending the full path.
fn models_endpoint_for(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    let stripped = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    format!("{stripped}/v1/models")
}

/// Fetch the upstream provider's model list. Anthropic uses a custom auth
/// header (`x-api-key` + `anthropic-version`) and exposes `max_input_tokens`
/// per model; every other provider in the catalog speaks OpenAI's `/v1/models`
/// format which only returns `id`. We surface both shapes through one
/// response so the UI can render a unified picker.
async fn provider_models_live(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<LiveModelsResponse>> {
    let entry = PROVIDER_CATALOG
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| bad_request(format!("unknown provider `{name}`")))?;
    let creds = {
        let store = state.provider_creds.read().await;
        store.get(&name).cloned()
    };
    let Some(creds) = creds else {
        return Err(bad_request(format!(
            "provider `{name}` has no api key configured"
        )));
    };
    let base = creds
        .base_url
        .clone()
        .unwrap_or_else(|| entry.default_base_url.to_string());
    let url = models_endpoint_for(&base);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|err| {
            tracing::warn!(%err, "failed to build http client for live models fetch");
            internal_error(format!("http client init failed: {err}"))
        })?;

    let mut request = client.get(&url);
    if entry.name == "anthropic" {
        request = request
            .header("x-api-key", &creds.api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        request = request.bearer_auth(&creds.api_key);
    }

    let response = request.send().await.map_err(|err| {
        bad_gateway(format!(
            "failed to reach provider `{name}` at {url}: {err}"
        ))
    })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(bad_gateway(format!(
            "provider `{name}` returned HTTP {status}: {}",
            body.chars().take(200).collect::<String>()
        )));
    }
    let payload: JsonValue = response
        .json()
        .await
        .map_err(|err| bad_gateway(format!("provider `{name}` returned non-JSON: {err}")))?;

    let models = parse_live_models(entry.name, &payload);
    Ok(Json(LiveModelsResponse {
        provider: name,
        fetched_from: url,
        models,
    }))
}

/// Parse the upstream JSON into a normalised LiveModel list. Tolerant of
/// either shape: Anthropic returns `{data: [{id, max_input_tokens, ...}]}`,
/// OpenAI-compatible returns `{data: [{id, ...}]}`. We bail out empty if
/// neither shape matches.
fn parse_live_models(provider: &str, payload: &JsonValue) -> Vec<LiveModel> {
    let Some(items) = payload.get("data").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let context_window = if provider == "anthropic" {
                item.get("max_input_tokens")
                    .and_then(JsonValue::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
            } else {
                None
            };
            // Merge in our static price table (substring match), so the picker
            // can show $/1M alongside each model. Upstream `/models` responses
            // don't carry pricing, hence the local lookup.
            let price = pricing::lookup(&id);
            Some(LiveModel {
                id,
                context_window,
                input_per_million: price.map(|p| p.input_per_million),
                output_per_million: price.map(|p| p.output_per_million),
            })
        })
        .collect()
}

/// Live observation snapshot for the Browser pane. `available` is false when no
/// browser MCP server has discovered its tools yet (so the pane shows a waiting
/// state rather than an error). `screenshot` is a `data:` URL; `snapshot` is the
/// (truncated) accessibility tree text; `url` is parsed from that snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct BrowserStateResponse {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Cap the a11y snapshot we ship to the pane — full trees on complex pages can
/// be tens of KB and we poll this. The agent still sees the untruncated tree
/// from its own tool call; the pane only needs a readable preview.
const BROWSER_SNAPSHOT_MAX_CHARS: usize = 6000;

/// `GET /browser/state` — drives the live Browser pane. Invokes the installed
/// Playwright-MCP `browser_take_screenshot` + `browser_snapshot` tools *outside*
/// a turn (both read-only, so interleaving with the agent's own calls is safe).
/// Two MCP round-trips per call — fine for a local, human-paced poll.
async fn browser_state(State(state): State<AppState>) -> Json<BrowserStateResponse> {
    // Resolve the qualified tool names from the discovered-tools snapshot.
    // Keyed on raw_name so it works regardless of the server's registered name.
    let (screenshot_tool, snapshot_tool) = {
        let guard = state.mcp_tools.lock();
        match guard {
            Ok(tools) => {
                let find = |raw: &str| {
                    tools
                        .iter()
                        .find(|t| t.raw_name == raw)
                        .map(|t| t.qualified_name.clone())
                };
                (find("browser_take_screenshot"), find("browser_snapshot"))
            }
            Err(_) => (None, None),
        }
    };
    // No discovered browser tools → not available yet (installed-but-starting,
    // or not installed). The pane renders a waiting state.
    let Some(screenshot_tool) = screenshot_tool else {
        return Json(BrowserStateResponse {
            available: false,
            url: None,
            snapshot: None,
            screenshot: None,
            error: None,
        });
    };

    let mut manager = state.mcp_manager.lock().await;

    // Screenshot (JPEG to keep the payload small).
    let screenshot = match manager
        .call_tool(&screenshot_tool, Some(serde_json::json!({ "type": "jpeg" })))
        .await
    {
        Ok(response) => response
            .result
            .as_ref()
            .and_then(extract_browser_screenshot),
        Err(err) => {
            return Json(BrowserStateResponse {
                available: true,
                url: None,
                snapshot: None,
                screenshot: None,
                error: Some(err.to_string()),
            });
        }
    };

    // Accessibility snapshot → page URL + a truncated tree preview.
    let (url, snapshot) = match snapshot_tool {
        Some(tool) => match manager.call_tool(&tool, None).await {
            Ok(response) => {
                let text = response
                    .result
                    .as_ref()
                    .map(extract_browser_text)
                    .unwrap_or_default();
                let url = parse_browser_page_url(&text);
                let snapshot = if text.is_empty() {
                    None
                } else {
                    Some(truncate_chars(&text, BROWSER_SNAPSHOT_MAX_CHARS))
                };
                (url, snapshot)
            }
            Err(_) => (None, None),
        },
        None => (None, None),
    };

    Json(BrowserStateResponse {
        available: true,
        url,
        snapshot,
        screenshot,
        error: None,
    })
}

/// Pull the first image content block out of an MCP tool result as a `data:` URL.
fn extract_browser_screenshot(result: &runtime::McpToolCallResult) -> Option<String> {
    result.content.iter().find_map(|block| {
        if block.kind != "image" {
            return None;
        }
        let data = block.data.get("data")?.as_str()?;
        let mime = block
            .data
            .get("mimeType")
            .and_then(|m| m.as_str())
            .unwrap_or("image/png");
        Some(format!("data:{mime};base64,{data}"))
    })
}

/// Concatenate the text content blocks of an MCP tool result.
fn extract_browser_text(result: &runtime::McpToolCallResult) -> String {
    result
        .content
        .iter()
        .filter_map(|block| {
            if block.kind == "text" {
                block.data.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `@playwright/mcp` snapshots lead with a `- Page URL: <url>` line. Pull it out
/// so the pane can show a URL bar without a separate tool call.
fn parse_browser_page_url(snapshot_text: &str) -> Option<String> {
    snapshot_text.lines().find_map(|line| {
        let line = line.trim().trim_start_matches('-').trim();
        line.strip_prefix("Page URL:")
            .map(|rest| rest.trim().to_string())
            .filter(|url| !url.is_empty())
    })
}

/// Truncate on a char boundary, appending an elision marker when cut.
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{truncated}\n… (truncated)")
}

async fn workspace_tree(
    State(state): State<AppState>,
    Query(query): Query<WorkspacePathQuery>,
) -> ApiResult<Json<WorkspaceTreeResponse>> {
    let root = resolve_workspace_root(&state).await?;
    let relative = query.path.unwrap_or_default();
    let target = resolve_within_workspace(&root, &relative)?;
    let metadata = std::fs::metadata(&target)
        .map_err(|err| not_found(format!("path not found: {err}")))?;
    if !metadata.is_dir() {
        return Err(bad_request(format!(
            "path `{}` is not a directory",
            target.display()
        )));
    }
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&target)
        .map_err(|err| bad_request(format!("read_dir failed: {err}")))?;
    for entry in read_dir.flatten() {
        if entries.len() >= WORKSPACE_TREE_MAX_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let entry_relative = match path.strip_prefix(&root) {
            Ok(rel) => rel.to_string_lossy().into_owned(),
            Err(_) => continue,
        };
        let kind = if path.is_dir() { "dir" } else { "file" };
        let size = if kind == "file" {
            entry.metadata().ok().map(|m| m.len())
        } else {
            None
        };
        entries.push(WorkspaceEntry {
            name,
            path: entry_relative,
            kind: kind.to_string(),
            size,
        });
    }
    entries.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(Json(WorkspaceTreeResponse {
        root: root.display().to_string(),
        relative,
        entries,
    }))
}

async fn workspace_file(
    State(state): State<AppState>,
    Query(query): Query<WorkspacePathQuery>,
) -> ApiResult<Json<WorkspaceFileResponse>> {
    let root = resolve_workspace_root(&state).await?;
    let relative = query.path.ok_or_else(|| bad_request("path is required".to_string()))?;
    if relative.trim().is_empty() {
        return Err(bad_request("path is required".to_string()));
    }
    let target = resolve_within_workspace(&root, &relative)?;
    let metadata = std::fs::metadata(&target)
        .map_err(|err| not_found(format!("file not found: {err}")))?;
    if !metadata.is_file() {
        return Err(bad_request(format!(
            "path `{}` is not a regular file",
            target.display()
        )));
    }
    let size = metadata.len();
    let truncated = size > WORKSPACE_FILE_MAX_BYTES;
    let read_size = std::cmp::min(size, WORKSPACE_FILE_MAX_BYTES) as usize;
    let raw = std::fs::read(&target)
        .map_err(|err| bad_request(format!("read failed: {err}")))?;
    let slice = &raw[..std::cmp::min(read_size, raw.len())];
    let (content, binary) = match std::str::from_utf8(slice) {
        Ok(text) => (text.to_string(), false),
        Err(_) => (
            "(binary file — not previewable)".to_string(),
            true,
        ),
    };
    Ok(Json(WorkspaceFileResponse {
        path: relative,
        size,
        content,
        truncated,
        binary,
    }))
}

/// Pops up a native folder-picker on the host running this server. macOS uses
/// `osascript`; Linux uses `zenity`. Browsers cannot give us absolute paths via
/// `showDirectoryPicker`, so we drive the OS dialog from the backend instead.
async fn list_mcp_servers(State(state): State<AppState>) -> Json<McpServersResponse> {
    let records = state.mcp_records.read().await.clone();
    let tools_snapshot = state
        .mcp_tools
        .lock()
        .ok()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let mut tools_by_server: HashMap<String, Vec<McpToolSummary>> = HashMap::new();
    for tool in tools_snapshot {
        tools_by_server
            .entry(tool.server_name.clone())
            .or_default()
            .push(McpToolSummary {
                name: tool.qualified_name,
                raw_name: tool.raw_name,
                description: tool.tool.description,
                input_schema: tool.tool.input_schema.unwrap_or_else(|| serde_json::json!({})),
            });
    }
    let discovery_in_flight = state
        .mcp_discovery_in_flight
        .load(Ordering::SeqCst);
    let mut servers: Vec<_> = records
        .into_iter()
        .map(|(name, entry)| {
            let tools = tools_by_server.remove(&name).unwrap_or_default();
            let discovery_status = if !entry.enabled {
                "disabled"
            } else if !tools.is_empty() {
                "ready"
            } else if discovery_in_flight {
                "discovering"
            } else {
                "failed"
            }
            .to_string();
            McpServerSummary {
                name: name.clone(),
                command: entry.command,
                args: entry.args,
                env: entry.env,
                enabled: entry.enabled,
                tools,
                discovery_status,
            }
        })
        .collect();
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    Json(McpServersResponse { servers })
}

async fn put_mcp_server(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<McpServerPayload>,
) -> ApiResult<Json<McpServersResponse>> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(bad_request("server name must not be empty".to_string()));
    }
    let command = payload.command.trim().to_string();
    if command.is_empty() {
        return Err(bad_request("command must not be empty".to_string()));
    }
    {
        let mut records = state.mcp_records.write().await;
        // Preserve the prior `enabled` flag if the same server is being
        // updated — a PUT is a "set the config" not "reset all metadata".
        // Newly created entries default to enabled.
        let previous_enabled = records.get(trimmed_name).map_or(true, |e| e.enabled);
        records.insert(
            trimmed_name.to_string(),
            McpServerEntry {
                command,
                args: payload.args,
                env: payload.env,
                enabled: previous_enabled,
            },
        );
    }
    state.rebuild_mcp_manager().await;
    state.persist_now().await;
    Ok(list_mcp_servers(State(state.clone())).await)
}

#[derive(Debug, Clone, Serialize)]
pub struct McpPresetsResponse {
    pub presets: Vec<presets::McpPreset>,
}

async fn list_mcp_presets() -> Json<McpPresetsResponse> {
    Json(McpPresetsResponse {
        presets: presets::catalog(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct PrereqCheckResponse {
    pub results: Vec<PrereqCheckResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrereqCheckResult {
    pub binary: String,
    /// "ok" | "missing" | "version_low" | "unknown_version"
    pub status: String,
    pub current_version: Option<String>,
    pub min_version: Option<String>,
    pub install_hint: String,
}

/// Run prerequisite checks for a given preset. For each declared binary we
/// (a) look it up on `PATH`, (b) run its version command, (c) parse a
/// SemVer-shape match out of the output, (d) compare against `min_version`.
/// All failures are reported as data — never a 500 — so the UI can render a
/// per-row diagnostic without retry logic.
async fn check_preset_prereqs(
    Path(id): Path<String>,
) -> ApiResult<Json<PrereqCheckResponse>> {
    let preset = presets::catalog()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| not_found(format!("preset `{id}` not found")))?;

    let mut results = Vec::with_capacity(preset.prerequisites.len());
    for prereq in &preset.prerequisites {
        results.push(check_one_prereq(prereq).await);
    }
    Ok(Json(PrereqCheckResponse { results }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckPrereqsBody {
    pub prerequisites: Vec<presets::Prerequisite>,
}

/// Body-form prereq check — used by the registry install flow (and any
/// future caller that doesn't have a preset ID). Same per-binary
/// semantics as the by-id endpoint; lifts the binary list out of the
/// preset lookup.
async fn check_prereqs_endpoint(
    Json(body): Json<CheckPrereqsBody>,
) -> Json<PrereqCheckResponse> {
    let mut results = Vec::with_capacity(body.prerequisites.len());
    for prereq in &body.prerequisites {
        results.push(check_one_prereq(prereq).await);
    }
    Json(PrereqCheckResponse { results })
}

async fn check_one_prereq(prereq: &presets::Prerequisite) -> PrereqCheckResult {
    use tokio::process::Command;

    let binary = prereq.binary.clone();
    let install_hint = prereq.install_hint.clone();
    let min_version = prereq.min_version.clone();

    // `which` resolution: we delegate to running the binary directly with
    // the version args — if it's not on PATH, Command::output() returns an
    // io error and we map that to "missing". Cheaper than a separate
    // `which` shellout and respects the same PATH the subprocess will see.
    if prereq.version_args.is_empty() {
        // Some binaries (e.g. ppt_mcp_server) don't have a --version flag —
        // just check it resolves.
        let resolved = Command::new(&binary).arg("--help").output().await;
        return match resolved {
            Ok(_) => PrereqCheckResult {
                binary,
                status: "ok".to_string(),
                current_version: None,
                min_version,
                install_hint,
            },
            Err(_) => PrereqCheckResult {
                binary,
                status: "missing".to_string(),
                current_version: None,
                min_version,
                install_hint,
            },
        };
    }

    let output = Command::new(&binary).args(&prereq.version_args).output().await;
    let Ok(output) = output else {
        return PrereqCheckResult {
            binary,
            status: "missing".to_string(),
            current_version: None,
            min_version,
            install_hint,
        };
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");
    let Some(version) = extract_semver(&combined) else {
        return PrereqCheckResult {
            binary,
            status: "unknown_version".to_string(),
            current_version: None,
            min_version,
            install_hint,
        };
    };

    let status = match &min_version {
        Some(min) if !semver_at_least(&version, min) => "version_low",
        _ => "ok",
    }
    .to_string();

    PrereqCheckResult {
        binary,
        status,
        current_version: Some(version),
        min_version,
        install_hint,
    }
}

/// Pull the first `<num>.<num>.<num>` (or `<num>.<num>`) token out of text.
/// Tolerant of prefixes like `v18.20.4` and suffixes like `-pre.1`.
fn extract_semver(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut dots = 0;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                if bytes[i] == b'.' {
                    dots += 1;
                }
                i += 1;
            }
            if dots >= 1 {
                // strip trailing dot if any
                let end = if bytes[i - 1] == b'.' { i - 1 } else { i };
                return Some(text[start..end].to_string());
            }
            continue;
        }
        i += 1;
    }
    None
}

/// `true` if `current >= min` under dotted-numeric semver. Treats missing
/// trailing components as zero. Patch suffixes (`-pre`, `+build`) are
/// stripped before comparison.
fn semver_at_least(current: &str, min: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        let core = s.split('-').next().unwrap_or(s).split('+').next().unwrap_or(s);
        core.split('.').map(|p| p.parse::<u32>().unwrap_or(0)).collect()
    };
    let c = parse(current);
    let m = parse(min);
    for i in 0..c.len().max(m.len()) {
        let cv = c.get(i).copied().unwrap_or(0);
        let mv = m.get(i).copied().unwrap_or(0);
        if cv > mv {
            return true;
        }
        if cv < mv {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct InstallPresetPayload {
    /// Server name the user wants to register the preset under. Independent
    /// of preset.id so the user can install the same preset twice with
    /// different configs (two filesystem roots, for instance).
    pub name: String,
    #[serde(default)]
    pub inputs: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegistryListQuery {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistryListingResponse {
    pub entries: Vec<registry_translate::RegistryListingEntry>,
    pub next_cursor: Option<String>,
    /// Total raw entries on this page from upstream — useful to surface
    /// "M of N installable" so the UI doesn't look broken when the first
    /// page filters down to 0 stdio entries.
    pub raw_count: u32,
    pub installable_count: u32,
}

async fn list_registry_entries(
    State(state): State<AppState>,
    Query(query): Query<RegistryListQuery>,
) -> ApiResult<Json<RegistryListingResponse>> {
    let response = state
        .registry_client
        .list_servers(query.search.as_deref(), query.cursor.as_deref())
        .await
        .map_err(|e| internal_error(e.to_string()))?;

    let raw_count = response.servers.len() as u32;
    let entries: Vec<registry_translate::RegistryListingEntry> = response
        .servers
        .iter()
        .filter_map(|env| {
            let mut entry = registry_translate::to_listing(&env.server)?;
            // Surface the active/deprecated flag from the envelope meta —
            // skipping the entry is too aggressive (some `deprecated`
            // entries still work and the user might want them), so we
            // just label them.
            if let Some(meta) = env.meta.as_ref().and_then(|m| m.official.as_ref()) {
                entry.status = meta.status.clone();
            }
            Some(entry)
        })
        .collect();
    let installable_count = entries.len() as u32;
    Ok(Json(RegistryListingResponse {
        entries,
        next_cursor: response.metadata.next_cursor,
        raw_count,
        installable_count,
    }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct InstallFromRegistryPayload {
    /// The reverse-DNS registry name, e.g. `com.pulsemcp/slack`. We re-
    /// fetch the entry by this name rather than trusting any client-side
    /// schema — keeps install honest if the user reloads after the
    /// registry updated.
    pub registry_name: String,
    /// Server name the user picks for the local MCP server entry. Mirrors
    /// the preset install endpoint.
    pub server_name: String,
    #[serde(default)]
    pub inputs: std::collections::BTreeMap<String, String>,
}

async fn install_from_registry(
    State(state): State<AppState>,
    Json(payload): Json<InstallFromRegistryPayload>,
) -> ApiResult<Json<McpServersResponse>> {
    let entry = state
        .registry_client
        .fetch_server(&payload.registry_name)
        .await
        .map_err(|e| match e {
            registry::RegistryError::NotFound { .. } => not_found(e.to_string()),
            _ => internal_error(e.to_string()),
        })?;
    let instantiable = registry_translate::to_instantiable(&entry).ok_or_else(|| {
        bad_request(format!(
            "registry entry `{}` is remote-only — install requires Phase-3 OAuth support",
            payload.registry_name
        ))
    })?;
    let result = instantiable.instantiate(&payload.inputs).map_err(bad_request)?;

    put_mcp_server(
        State(state),
        Path(payload.server_name),
        Json(McpServerPayload {
            command: result.command,
            args: result.args,
            env: result.env,
        }),
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetSessionLibraryPayload {
    /// `null` clears the binding; a name attaches the session to that
    /// library. We don't validate-existence here so a temporarily-deleted
    /// library can be re-attached after recreating it.
    pub library: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetSessionLibraryResponse {
    pub library: Option<String>,
}

async fn set_session_library(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
    Json(payload): Json<SetSessionLibraryPayload>,
) -> ApiResult<Json<SetSessionLibraryResponse>> {
    if let Some(name) = payload.library.as_deref() {
        rag::LibraryStore::validate_name(name).map_err(bad_request)?;
    }
    let sessions = state.sessions.read().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
    let handle = session.attached_library.clone();
    drop(sessions);
    if let Ok(mut guard) = handle.lock() {
        *guard = payload.library.clone();
    }
    state.persist_session(&id).await;
    Ok(Json(SetSessionLibraryResponse {
        library: payload.library,
    }))
}

/// Format retrieved RAG context for the LLM. Wraps the chunks in a clear
/// `<retrieved_context>` XML-ish block — distinct from prose so the model
/// (and an inspector) can tell what's user-typed vs. system-supplied.
/// Adds a trailing newline so the user's own prompt sits cleanly after.
fn render_retrieved_context_for_llm(ctx: &runtime::RetrievedContext) -> String {
    if ctx.chunks.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(512);
    out.push_str(&format!(
        "<retrieved_context library=\"{}\" chunks=\"{}\">\n",
        ctx.library,
        ctx.chunks.len(),
    ));
    for (i, chunk) in ctx.chunks.iter().enumerate() {
        out.push_str(&format!(
            "[chunk {} · source: {} · distance: {:.4}]\n{}\n\n",
            i + 1,
            chunk.source,
            chunk.distance,
            chunk.content,
        ));
    }
    out.push_str("</retrieved_context>\n\n");
    out
}

/// Build an embedding client from current server config, with a sensible
/// OpenAI fallback. Resolution order:
///   1. `config.embedding_provider` if set — provider explicitly chosen
///      by the user (DashScope, OpenAI, BGE-m3 over compat shim, …).
///   2. OpenAI chat-provider creds + `text-embedding-3-small` defaults —
///      keeps "I configured OpenAI" sessions working without a separate
///      embedding setup.
///   3. Error: nothing configured.
async fn build_embedding_client(state: &AppState) -> Result<embedding::EmbeddingClient, embedding::EmbeddingError> {
    let cfg = state.config.read().await;
    if let Some(provider) = cfg.embedding_provider.clone() {
        return embedding::EmbeddingClient::new(provider);
    }
    drop(cfg);
    let openai_creds = state
        .provider_creds
        .read()
        .await
        .get("openai")
        .cloned();
    let api_key = openai_creds
        .map(|c| c.api_key)
        .filter(|k| !k.trim().is_empty())
        .ok_or(embedding::EmbeddingError::NotConfigured)?;
    embedding::EmbeddingClient::new(embedding::EmbeddingProvider::openai_default(api_key))
}

/// Embed `query` and retrieve top-K chunks from `library`, packaging the
/// result into the persistence-ready shape `ConversationMessage` carries.
/// Errors bubble back to the caller, which logs and degrades to "no
/// retrieval" — a non-fatal failure mode at the turn level.
async fn retrieve_for_user_message(
    state: &AppState,
    library: &str,
    query: &str,
) -> Result<runtime::RetrievedContext, String> {
    const DEFAULT_K: usize = 5;
    let client = build_embedding_client(state).await.map_err(|e| e.to_string())?;
    let vectors = client
        .embed(&[query.to_string()])
        .await
        .map_err(|e| e.to_string())?;
    let query_vec = vectors
        .into_iter()
        .next()
        .ok_or_else(|| "embedding API returned no vector".to_string())?;
    let hits = state
        .library_store
        .retrieve(library, &query_vec, DEFAULT_K)
        .await?;
    Ok(runtime::RetrievedContext {
        library: library.to_string(),
        chunks: hits
            .into_iter()
            .map(|h| runtime::RetrievedChunk {
                source: h.source,
                content: h.content,
                distance: h.distance,
            })
            .collect(),
    })
}

// ---- RAG library endpoints ------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct LibrariesResponse {
    pub libraries: Vec<rag::LibrarySummary>,
}

async fn list_libraries(
    State(state): State<AppState>,
) -> ApiResult<Json<LibrariesResponse>> {
    let names = state.library_store.list().await.map_err(internal_error)?;
    let mut libraries = Vec::with_capacity(names.len());
    for name in names {
        match state.library_store.summary(&name).await {
            Ok(summary) => libraries.push(summary),
            Err(e) => tracing::warn!(%name, error = %e, "library summary failed"),
        }
    }
    Ok(Json(LibrariesResponse { libraries }))
}

/// Create an empty library. POST is idempotent — re-creating an existing
/// library is a no-op so the frontend doesn't need to check first.
async fn create_library(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<rag::LibrarySummary>> {
    rag::LibraryStore::validate_name(&name).map_err(bad_request)?;
    // `.open()` runs the DDL — that's the create path.
    state.library_store.open(&name).await.map_err(internal_error)?;
    let summary = state
        .library_store
        .summary(&name)
        .await
        .map_err(internal_error)?;
    Ok(Json(summary))
}

async fn delete_library(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    state
        .library_store
        .delete(&name)
        .await
        .map_err(internal_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Clone, Serialize)]
pub struct IngestResponse {
    pub chunks_written: u32,
    pub source: String,
}

/// Ingest a single file into a library. Reads the multipart upload,
/// chunks the text, embeds via OpenAI, writes to sqlite-vec.
///
/// Currently only plain UTF-8 text + markdown go through cleanly — PDF
/// and other binary formats are deferred to a later phase along with
/// per-format extraction.
async fn ingest_library(
    State(state): State<AppState>,
    Path(name): Path<String>,
    mut multipart: axum::extract::Multipart,
) -> ApiResult<Json<IngestResponse>> {
    rag::LibraryStore::validate_name(&name).map_err(bad_request)?;

    // Read the uploaded file out of the multipart payload.
    let mut source_name: Option<String> = None;
    let mut content: Option<String> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|err| bad_request(format!("multipart parse failed: {err}")))?
    {
        // Only the first `file` field is consumed; everything else is
        // ignored. Future: support a "source_url" field for ingest-by-
        // URL.
        let file_name = field.file_name().unwrap_or("upload").to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|err| bad_request(format!("upload read failed: {err}")))?;
        // pdf-extract is synchronous and CPU-bound; for a long PDF it
        // could block the worker for hundreds of ms. Push it to a
        // blocking thread so the runtime stays responsive.
        let file_name_clone = file_name.clone();
        let (text, kind) = tokio::task::spawn_blocking(move || {
            decode_uploaded_text(&bytes, &file_name_clone)
        })
        .await
        .map_err(|err| internal_error(format!("decode task panicked: {err}")))??;
        tracing::info!(library=%name, source=%file_name, kind=%kind, chars=text.len(), "decoded upload");
        source_name = Some(file_name);
        content = Some(text);
        break;
    }
    let source = source_name
        .ok_or_else(|| bad_request("no file field in multipart upload".to_string()))?;
    let content = content.unwrap_or_default();
    if content.is_empty() {
        return Err(bad_request("uploaded file is empty".to_string()));
    }

    // Chunk + embed. Chunking is local; embedding goes to OpenAI.
    let chunks_text = rag::chunk_text(&content);
    if chunks_text.is_empty() {
        return Err(bad_request("file produced no chunks after splitting".to_string()));
    }

    let client = build_embedding_client(&state)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    // Hard refuse a dim mismatch up-front: the vec0 table was DDL'd with
    // `library_store.dim()` and any insert with a different-sized vector
    // would corrupt the index. Cheaper to fail here with a clear hint.
    if client.dimensions() != state.library_store.dim() {
        return Err(bad_request(format!(
            "embedding dimension mismatch — provider returns {} but library store is configured for {}. Either pick a matching model or restart the server after updating embedding_provider.dimensions.",
            client.dimensions(),
            state.library_store.dim(),
        )));
    }
    let vectors = client
        .embed(&chunks_text)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    if vectors.len() != chunks_text.len() {
        return Err(internal_error(format!(
            "embedding count mismatch: {} chunks, {} vectors",
            chunks_text.len(),
            vectors.len()
        )));
    }
    let chunks: Vec<rag::ChunkWithEmbedding> = chunks_text
        .into_iter()
        .zip(vectors)
        .map(|(content, embedding)| rag::ChunkWithEmbedding { content, embedding })
        .collect();

    let written = state
        .library_store
        .ingest_chunks(&name, &source, &chunks)
        .await
        .map_err(internal_error)?;
    Ok(Json(IngestResponse {
        chunks_written: written,
        source,
    }))
}

#[derive(Debug, Clone, Deserialize)]
pub struct RetrievePayload {
    pub query: String,
    #[serde(default = "default_top_k")]
    pub k: usize,
}

fn default_top_k() -> usize {
    5
}

#[derive(Debug, Clone, Serialize)]
pub struct RetrieveResponse {
    pub chunks: Vec<RetrievedChunkView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RetrievedChunkView {
    pub source: String,
    pub content: String,
    pub distance: f32,
}

/// Debug / manual-test endpoint — embed a query, return top-K matching
/// chunks from a library. Used by the E2E test; also handy for tuning.
async fn retrieve_library(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<RetrievePayload>,
) -> ApiResult<Json<RetrieveResponse>> {
    rag::LibraryStore::validate_name(&name).map_err(bad_request)?;
    if payload.query.trim().is_empty() {
        return Err(bad_request("query must not be empty".to_string()));
    }

    let client = build_embedding_client(&state)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    let vectors = client
        .embed(&[payload.query.clone()])
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    let query_vec = vectors
        .into_iter()
        .next()
        .ok_or_else(|| internal_error("embedding API returned no vector".to_string()))?;

    let hits = state
        .library_store
        .retrieve(&name, &query_vec, payload.k)
        .await
        .map_err(internal_error)?;
    Ok(Json(RetrieveResponse {
        chunks: hits
            .into_iter()
            .map(|h| RetrievedChunkView {
                source: h.source,
                content: h.content,
                distance: h.distance,
            })
            .collect(),
    }))
}

// ---- MCP preset install (existing) ---------------------------------------

/// Install a preset: look up the schema, template the user's inputs into a
/// `{command, args, env}` triple, then delegate to the existing
/// `put_mcp_server` path so we reuse persistence, manager rebuild and
/// discovery refresh.
async fn install_mcp_preset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<InstallPresetPayload>,
) -> ApiResult<Json<McpServersResponse>> {
    let preset = presets::catalog()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| not_found(format!("preset `{id}` not found")))?;

    let instantiated = presets::instantiate(&preset, &payload.inputs)
        .map_err(bad_request)?;

    put_mcp_server(
        State(state),
        Path(payload.name),
        Json(McpServerPayload {
            command: instantiated.command,
            args: instantiated.args,
            env: instantiated.env,
        }),
    )
    .await
}

#[derive(Debug, Clone, Deserialize)]
pub struct McpServerEnablePayload {
    pub enabled: bool,
}

/// Flip a single MCP server's enabled flag without re-sending its full
/// command/args/env payload. Toggling rebuilds the manager so the change
/// takes effect immediately (subprocess spawned / shut down).
async fn set_mcp_server_enabled(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(payload): Json<McpServerEnablePayload>,
) -> ApiResult<Json<McpServersResponse>> {
    {
        let mut records = state.mcp_records.write().await;
        let Some(entry) = records.get_mut(&name) else {
            return Err(not_found(format!("mcp server `{name}` not found")));
        };
        if entry.enabled == payload.enabled {
            // No-op — skip rebuild to avoid pointlessly restarting subprocesses.
            return Ok(list_mcp_servers(State(state.clone())).await);
        }
        entry.enabled = payload.enabled;
    }
    state.rebuild_mcp_manager().await;
    state.persist_now().await;
    Ok(list_mcp_servers(State(state.clone())).await)
}

async fn delete_mcp_server(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    {
        let mut records = state.mcp_records.write().await;
        records.remove(&name);
    }
    state.rebuild_mcp_manager().await;
    state.persist_now().await;
    Ok(StatusCode::NO_CONTENT)
}

async fn workspace_picker() -> ApiResult<Json<WorkspacePickerResponse>> {
    let outcome = tokio::task::spawn_blocking(run_native_folder_picker)
        .await
        .map_err(|err| bad_request(format!("picker task join failed: {err}")))?;
    Ok(Json(outcome))
}

/// Request body for [`attachment_stat_endpoint`] — just a path. Modelled as
/// a separate POST (rather than a query string) so binary path characters
/// don't need URL escaping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentStatRequest {
    pub path: String,
}

/// Light-weight metadata for an attachment, served to the composer so it
/// can render token-budget hints on the chip BEFORE the message is sent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentStat {
    /// One of `text`, `image`, `extracted_text`. Errors return a 400.
    pub kind: String,
    pub size_bytes: u64,
    pub estimated_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

async fn attachment_stat_endpoint(
    Json(payload): Json<AttachmentStatRequest>,
) -> ApiResult<Json<AttachmentStat>> {
    let path = payload.path.clone();
    let stat = tokio::task::spawn_blocking(move || compute_attachment_stat(&path))
        .await
        .map_err(|err| bad_request(format!("stat task join failed: {err}")))??;
    Ok(Json(stat))
}

fn compute_attachment_stat(path: &str) -> ApiResult<AttachmentStat> {
    let path_buf = std::path::PathBuf::from(path);
    let metadata = std::fs::metadata(&path_buf).map_err(|err| {
        bad_request(format!("attachment `{path}`: {err}"))
    })?;
    if !metadata.is_file() {
        return Err(bad_request(format!(
            "attachment `{path}` is not a regular file"
        )));
    }
    let size = metadata.len();
    let bytes = std::fs::read(&path_buf).map_err(|err| {
        bad_request(format!("attachment `{path}`: {err}"))
    })?;
    if let Some(mime) = sniff_image_mime(&bytes) {
        // Images are roughly fixed cost across providers — Anthropic charges
        // ~1.5k per ~1MP image, OpenAI tile-based but typically in the
        // same ballpark. Flat 1500 is a useful rough budget hint without
        // touching the decoder.
        return Ok(AttachmentStat {
            kind: "image".to_string(),
            size_bytes: size,
            estimated_tokens: 1500,
            media_type: Some(mime.to_string()),
        });
    }
    if is_pdf(&bytes) {
        let text = pdf_extract::extract_text_from_mem(&bytes).map_err(|err| {
            bad_request(format!(
                "attachment `{path}`: failed to extract text from PDF ({err})"
            ))
        })?;
        return Ok(AttachmentStat {
            kind: "extracted_text".to_string(),
            size_bytes: size,
            estimated_tokens: (text.chars().count() as u64).div_ceil(4),
            media_type: None,
        });
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        bad_request(format!(
            "attachment `{path}` is not valid UTF-8 text and not a recognised image/PDF."
        ))
    })?;
    Ok(AttachmentStat {
        kind: "text".to_string(),
        size_bytes: size,
        estimated_tokens: (text.chars().count() as u64).div_ceil(4),
        media_type: None,
    })
}

/// Receive a file uploaded via multipart and store it under a per-process
/// uploads directory. Returns the absolute path so the existing attachment
/// flow (which references files by path) can pick it up. Used by the
/// frontend's drag-drop / paste-image handlers, where the browser sandbox
/// hides the real source path.
async fn workspace_upload_endpoint(
    mut multipart: axum::extract::Multipart,
) -> ApiResult<Json<WorkspacePickerResponse>> {
    while let Some(field) = multipart.next_field().await.map_err(|err| {
        bad_request(format!("multipart parse failed: {err}"))
    })? {
        let original_name = field.file_name().unwrap_or("upload").to_string();
        let data = field.bytes().await.map_err(|err| {
            bad_request(format!("upload read failed: {err}"))
        })?;
        let upload_dir = uploads_dir();
        std::fs::create_dir_all(&upload_dir).map_err(|err| {
            internal_error(format!("create upload dir: {err}"))
        })?;
        let prefix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let safe_name = original_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
            .collect::<String>();
        let dest = upload_dir.join(format!("{prefix}-{safe_name}"));
        std::fs::write(&dest, &data).map_err(|err| {
            internal_error(format!("write upload: {err}"))
        })?;
        return Ok(Json(WorkspacePickerResponse {
            path: Some(dest.display().to_string()),
            supported: true,
        }));
    }
    Err(bad_request(
        "no file field in multipart upload".to_string(),
    ))
}

fn uploads_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("claw-uploads")
}

/// Mirror of [`workspace_picker`] but opens a native FILE chooser instead of
/// a folder one. Used by the composer's `+ attach` flow to grab arbitrary
/// absolute paths off the user's machine (browsers' `<input type=file>`
/// never expose the real path, so we drive osascript/zenity from the server
/// — same machine since this is a local-dev tool).
async fn workspace_file_picker() -> ApiResult<Json<WorkspacePickerResponse>> {
    let outcome = tokio::task::spawn_blocking(run_native_file_picker)
        .await
        .map_err(|err| bad_request(format!("file picker task join failed: {err}")))?;
    Ok(Json(outcome))
}

fn run_native_file_picker() -> WorkspacePickerResponse {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let script = r#"try
    set chosen to choose file with prompt "Choose file to attach"
    POSIX path of chosen
on error number -128
    -- user cancelled
end try"#;
        match Command::new("osascript").arg("-e").arg(script).output() {
            Ok(output) if output.status.success() => {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                WorkspacePickerResponse {
                    path: if path.is_empty() { None } else { Some(path) },
                    supported: true,
                }
            }
            Ok(_) => WorkspacePickerResponse {
                path: None,
                supported: true,
            },
            Err(error) => {
                tracing::warn!(%error, "native file picker (osascript) failed");
                WorkspacePickerResponse {
                    path: None,
                    supported: false,
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        match Command::new("zenity")
            .args(["--file-selection", "--title=Choose file to attach"])
            .output()
        {
            Ok(output) if output.status.success() => {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                WorkspacePickerResponse {
                    path: if path.is_empty() { None } else { Some(path) },
                    supported: true,
                }
            }
            Ok(_) => WorkspacePickerResponse {
                path: None,
                supported: true,
            },
            Err(_) => WorkspacePickerResponse {
                path: None,
                supported: false,
            },
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        WorkspacePickerResponse {
            path: None,
            supported: false,
        }
    }
}

fn run_native_folder_picker() -> WorkspacePickerResponse {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let script = r#"try
    set chosen to choose folder with prompt "Choose workspace for claw"
    POSIX path of chosen
on error number -128
    -- user cancelled
end try"#;
        match Command::new("osascript").arg("-e").arg(script).output() {
            Ok(output) if output.status.success() => {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let path = path.trim_end_matches('/').to_string();
                WorkspacePickerResponse {
                    path: if path.is_empty() { None } else { Some(path) },
                    supported: true,
                }
            }
            Ok(_) => WorkspacePickerResponse { path: None, supported: true },
            Err(error) => {
                tracing::warn!(%error, "native folder picker (osascript) failed");
                WorkspacePickerResponse { path: None, supported: false }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        match Command::new("zenity")
            .args(["--file-selection", "--directory", "--title=Choose workspace for claw"])
            .output()
        {
            Ok(output) if output.status.success() => {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                WorkspacePickerResponse {
                    path: if path.is_empty() { None } else { Some(path) },
                    supported: true,
                }
            }
            Ok(_) => WorkspacePickerResponse { path: None, supported: true },
            Err(_) => WorkspacePickerResponse { path: None, supported: false },
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        WorkspacePickerResponse { path: None, supported: false }
    }
}

async fn resolve_workspace_root(state: &AppState) -> ApiResult<PathBuf> {
    let configured = state.config.read().await.workspace_root.clone();
    let root = configured.map(PathBuf::from).unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });
    if !root.is_dir() {
        return Err(bad_request(format!(
            "workspace_root `{}` is not a directory; set it via PATCH /config",
            root.display()
        )));
    }
    Ok(root)
}

/// Resolve `relative` against `root` and verify it doesn't escape via `..`. Refuses
/// absolute paths so the UI can't ask for `/etc/passwd` via the workspace API.
fn resolve_within_workspace(root: &std::path::Path, relative: &str) -> ApiResult<PathBuf> {
    let trimmed = relative.trim_start_matches('/');
    let candidate = if trimmed.is_empty() {
        root.to_path_buf()
    } else {
        root.join(trimmed)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|err| not_found(format!("path `{relative}` not accessible: {err}")))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|err| bad_request(format!("workspace root not accessible: {err}")))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(bad_request(format!(
            "path `{relative}` escapes the workspace root"
        )));
    }
    Ok(canonical)
}

struct ProviderCatalogEntry {
    name: &'static str,
    label: &'static str,
    default_base_url: &'static str,
    env_keys: &'static [&'static str],
    models: &'static [&'static str],
}

const PROVIDER_CATALOG: &[ProviderCatalogEntry] = &[
    ProviderCatalogEntry {
        name: "anthropic",
        label: "Anthropic",
        default_base_url: "https://api.anthropic.com",
        env_keys: &["ANTHROPIC_API_KEY"],
        models: &[
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-haiku-4-5-20251213",
            "opus",
            "sonnet",
            "haiku",
        ],
    },
    ProviderCatalogEntry {
        name: "openai",
        label: "OpenAI",
        default_base_url: "https://api.openai.com/v1",
        env_keys: &["OPENAI_API_KEY"],
        models: &["gpt-4o", "gpt-4o-mini", "o3-mini"],
    },
    ProviderCatalogEntry {
        name: "deepseek",
        label: "DeepSeek",
        default_base_url: "https://api.deepseek.com",
        env_keys: &["DEEPSEEK_API_KEY"],
        models: &["deepseek", "deepseek-chat", "deepseek-reasoner"],
    },
    ProviderCatalogEntry {
        name: "xai",
        label: "xAI",
        default_base_url: "https://api.x.ai/v1",
        env_keys: &["XAI_API_KEY"],
        models: &["grok", "grok-3", "grok-3-mini", "grok-2"],
    },
    ProviderCatalogEntry {
        name: "openai-compat",
        label: "OpenAI-compatible",
        default_base_url: "http://127.0.0.1:11434/v1",
        env_keys: &["OPENAI_COMPAT_API_KEY"],
        models: &["openai-compatible"],
    },
];

/// Default system prompt fed to the model on every turn. Models on the OpenAI-compatible
/// tool calling protocol already see the typed tool schemas via the `tools` array of the
/// request, so we keep this short and just frame the persona / when to reach for tools.
/// Build the per-turn system prompt for the web/server runtime.
///
/// Pre-refactor this was a hard-coded 5-paragraph string. We now route through
/// [`SystemPromptBuilder`] so the prompt picks up the same machinery the CLI
/// uses: today's date, OS, model identity, project context (workspace path
/// + git status + git diff), and crucially the workspace `CLAW.md` /
/// `.claw/instructions.md` content. Claw-specific framing + permission-mode
/// reminders are appended as extra sections.
fn agent_system_prompt(
    mode: PermissionMode,
    workspace_root: &str,
    model: Option<&str>,
    mcp: Option<&McpRuntimeBundle>,
) -> Vec<String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let project_context = ProjectContext::discover_with_git(workspace_root, today.clone())
        .unwrap_or_else(|err| {
            // Discovery is best-effort — if we can't read the workspace we
            // still want a sane prompt, just without git/instruction files.
            tracing::warn!(%err, "project context discovery failed; falling back");
            ProjectContext {
                cwd: std::path::PathBuf::from(workspace_root),
                current_date: today.clone(),
                git_status: None,
                git_diff: None,
                instruction_files: Vec::new(),
            }
        });

    let claw_identity =
        "You are claw, an interactive coding agent embedded in a web console. You have a \
set of tools that operate on the user's local workspace (read/write files, run shell \
commands, search the filesystem, fetch URLs, etc.); their exact schemas are provided to \
you through the tool-calling protocol. Default to taking action: call the relevant tool \
first instead of guessing. Chain tools when needed. When you do answer in text, be concise \
and reference filenames with paths.";

    let permission_reminder = format!(
        "The current permission mode is `{}`. Some tools may require user approval before \
running; if a tool result is a denial, do not retry — explain what was denied and move on.",
        mode.as_str()
    );

    let mut builder = SystemPromptBuilder::new()
        .with_os(std::env::consts::OS, "unknown")
        .with_project_context(project_context)
        .append_section(claw_identity)
        .append_section(permission_reminder);
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        builder = builder.with_model(model);
    }
    if let Some(catalog) = mcp.and_then(mcp_catalog_section) {
        builder = builder.append_section(catalog);
    }
    builder.build()
}

/// Render the MCP-catalog section that primes the LLM on which servers it
/// can attach. Returns `None` when there are no MCP servers configured, so
/// the prompt isn't padded with empty boilerplate. Kept deliberately compact:
/// names + tool count + first-tool hint per server, ~15-30 tokens each. The
/// LLM can call `list_mcp_servers` for the full schema dump on demand.
fn mcp_catalog_section(mcp: &McpRuntimeBundle) -> Option<String> {
    if mcp.tools_snapshot.is_empty() {
        return None;
    }
    let attached: std::collections::BTreeSet<String> = mcp
        .attached_mcps
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let mut by_server: std::collections::BTreeMap<&str, Vec<&ManagedMcpTool>> =
        std::collections::BTreeMap::new();
    for tool in &mcp.tools_snapshot {
        by_server
            .entry(tool.server_name.as_str())
            .or_default()
            .push(tool);
    }
    let mut lines: Vec<String> = vec![
        "# MCP servers".to_string(),
        "No MCP server is attached by default. Each adds its tool schemas to your tool list — call `attach_mcp_server(name=\"...\")` when you actually need its tools. Detach with `detach_mcp_server` when finished to free context. Use `list_mcp_servers` for full schemas.".to_string(),
        String::new(),
        "Available:".to_string(),
    ];
    for (name, tools) in by_server {
        let count = tools.len();
        let first_hint = tools
            .first()
            .and_then(|t| t.tool.description.as_deref())
            .map(|d| {
                let trimmed = d.trim();
                let first_line = trimmed.lines().next().unwrap_or(trimmed);
                let snippet = first_line.chars().take(80).collect::<String>();
                format!(" — e.g. {snippet}")
            })
            .unwrap_or_default();
        let status = if attached.contains(name) {
            " [attached]"
        } else {
            ""
        };
        lines.push(format!(" - {name} ({count} tools){status}{first_hint}"));
    }
    // Browser-usage guidance: reading a page does not need a real browser, and
    // the model can't see screenshots anyway — so don't reach for it to merely
    // fetch a URL, and never pop a window open unprompted.
    let has_browser = mcp
        .tools_snapshot
        .iter()
        .any(|t| t.raw_name.starts_with("browser_"));
    if has_browser {
        lines.push(String::new());
        lines.push(
            "For a URL that only needs reading or summarizing, use the `WebFetch` tool — do not open the browser. Use the `browser_*` tools ONLY when the user explicitly asks to operate a page (log in, click, type, fill a form, or step through a multi-page flow). Opening a real browser window is intrusive, so never launch it unprompted.".to_string(),
        );
    }
    Some(lines.join("\n"))
}

/// Try to repair common LLM-emitted invalid JSON. The most frequent failure is a
/// tool_use input truncated mid-string ("EOF while parsing a string at line 1
/// column N"); we also see trailing commas and unbalanced braces. We do a single
/// pass to track structural depth and string state, then append the minimum
/// suffix needed for the result to parse. Returns `None` if no targeted fix
/// applies or the patched text still does not parse.
fn try_repair_json(input: &str) -> Option<String> {
    if serde_json::from_str::<JsonValue>(input).is_ok() {
        return None;
    }

    let mut depth_brace: i32 = 0;
    let mut depth_bracket: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;

    for ch in input.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else {
            match ch {
                '"' => in_string = true,
                '{' => depth_brace += 1,
                '}' => depth_brace -= 1,
                '[' => depth_bracket += 1,
                ']' => depth_bracket -= 1,
                _ => {}
            }
        }
    }

    let mut repaired = input.to_string();
    if !in_string {
        // Drop the trailing-comma footgun (`{"a":1,`) — but only outside of a
        // string, since whitespace at the end of a real string value (e.g.
        // `"hello "`) is meaningful and must be preserved.
        loop {
            let trimmed = repaired.trim_end();
            if let Some(without_comma) = trimmed.strip_suffix(',') {
                repaired = without_comma.to_string();
            } else {
                break;
            }
        }
    }
    if in_string {
        repaired.push('"');
    }
    for _ in 0..depth_bracket.max(0) {
        repaired.push(']');
    }
    for _ in 0..depth_brace.max(0) {
        repaired.push('}');
    }

    if repaired == input {
        return None;
    }
    serde_json::from_str::<JsonValue>(&repaired)
        .ok()
        .map(|_| repaired)
}

/// Build the tool_result error returned to the LLM when input parsing finally
/// fails. We attach the expected `input_schema` (when known) and a small
/// context excerpt around the error position so the model can correct itself
/// on the next turn without another exploratory call.
fn format_tool_input_error(tool_name: &str, input: &str, error: &serde_json::Error) -> String {
    let mut msg = format!("invalid tool input json: {error}");
    if let Some(schema) = mvp_tool_specs()
        .into_iter()
        .find(|spec| spec.name == tool_name)
        .map(|spec| spec.input_schema)
    {
        if let Ok(rendered) = serde_json::to_string_pretty(&schema) {
            msg.push_str(&format!(
                "\nExpected input schema for `{tool_name}`:\n{rendered}"
            ));
        }
    }
    let column = error.column();
    if column > 0 {
        let start = column.saturating_sub(40);
        let end = (column + 40).min(input.len());
        if end > start && input.is_char_boundary(start) && input.is_char_boundary(end) {
            msg.push_str(&format!(
                "\nInput context (col {column}): …{}…",
                &input[start..end]
            ));
        }
    }
    msg
}

fn parse_or_repair_tool_input(tool_name: &str, input: &str) -> Result<JsonValue, ToolError> {
    match serde_json::from_str::<JsonValue>(input) {
        Ok(value) => Ok(value),
        Err(initial_error) => {
            if let Some(repaired) = try_repair_json(input) {
                if let Ok(value) = serde_json::from_str::<JsonValue>(&repaired) {
                    tracing::warn!(
                        tool = tool_name,
                        added = repaired.len().saturating_sub(input.len()),
                        "repaired malformed tool input"
                    );
                    return Ok(value);
                }
            }
            Err(ToolError::new(format_tool_input_error(
                tool_name,
                input,
                &initial_error,
            )))
        }
    }
}

/// Bridge from the runtime's `ToolExecutor` trait (strings) to the catalog implementation
/// in the `tools` crate (which executes against a typed JSON input). Without this every
/// conversation got "unknown tool: X" because `StaticToolExecutor::new()` is an empty
/// registry — none of the 19 catalog tools were wired into it.
struct CatalogToolExecutor;

impl ToolExecutor for CatalogToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        let value = parse_or_repair_tool_input(tool_name, input)?;
        execute_catalog_tool(tool_name, &value).map_err(ToolError::new)
    }
}

/// Routes `mcp__<server>__<tool>` calls to the live `McpServerManager`; falls back to
/// the static catalog for everything else. The runtime invokes us from inside
/// `spawn_blocking`, so we use `block_on` to wait on async MCP work.
struct CombinedToolExecutor {
    mcp_manager: Arc<tokio::sync::Mutex<McpServerManager>>,
    /// Per-session "which MCP servers can be called this turn" set. Shared
    /// with the HTTP layer so attach/detach mutations from meta-tools survive
    /// the turn and influence the *next* turn's tool list. Empty by default —
    /// the LLM has to opt in via `attach_mcp_server`.
    attached_mcps: Arc<StdMutex<std::collections::BTreeSet<String>>>,
    /// Snapshot of currently-discovered MCP tools at turn start. Used by
    /// `list_mcp_servers` so the meta-tool answer is consistent regardless
    /// of any concurrent rebuild churn.
    mcp_tools_snapshot: Vec<ManagedMcpTool>,
}

const META_LIST_MCP: &str = "list_mcp_servers";
const META_ATTACH_MCP: &str = "attach_mcp_server";
const META_DETACH_MCP: &str = "detach_mcp_server";

impl CombinedToolExecutor {
    fn handle_list_mcp_servers(&self) -> Result<String, ToolError> {
        let attached = self
            .attached_mcps
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        // Group tools by server name. BTreeMap keeps the output stable.
        let mut by_server: std::collections::BTreeMap<&str, Vec<&ManagedMcpTool>> =
            std::collections::BTreeMap::new();
        for tool in &self.mcp_tools_snapshot {
            by_server
                .entry(tool.server_name.as_str())
                .or_default()
                .push(tool);
        }

        let servers: Vec<JsonValue> = by_server
            .into_iter()
            .map(|(name, tools)| {
                let tool_descriptions: Vec<JsonValue> = tools
                    .iter()
                    .map(|t| {
                        serde_json::json!({
                            "name": t.raw_name,
                            "description": t.tool.description.clone().unwrap_or_default(),
                        })
                    })
                    .collect();
                serde_json::json!({
                    "name": name,
                    "attached": attached.contains(name),
                    "tool_count": tools.len(),
                    "tools": tool_descriptions,
                })
            })
            .collect();

        Ok(serde_json::to_string_pretty(
            &serde_json::json!({ "servers": servers }),
        )
        .unwrap_or_else(|_| "{}".to_string()))
    }

    fn handle_attach_mcp_server(&self, input: &str) -> Result<String, ToolError> {
        let value = parse_or_repair_tool_input(META_ATTACH_MCP, input)?;
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::new("attach_mcp_server requires `name` (string)".to_string()))?
            .trim()
            .to_string();
        if name.is_empty() {
            return Err(ToolError::new("`name` must not be empty".to_string()));
        }
        let exists = self
            .mcp_tools_snapshot
            .iter()
            .any(|t| t.server_name == name);
        if !exists {
            let available: Vec<&str> = {
                let mut s = self
                    .mcp_tools_snapshot
                    .iter()
                    .map(|t| t.server_name.as_str())
                    .collect::<Vec<_>>();
                s.sort_unstable();
                s.dedup();
                s
            };
            return Err(ToolError::new(format!(
                "unknown mcp server `{name}`. available: {}",
                if available.is_empty() {
                    "<none>".to_string()
                } else {
                    available.join(", ")
                }
            )));
        }
        let mut guard = self.attached_mcps.lock().map_err(|_| {
            ToolError::new("attached_mcps lock poisoned".to_string())
        })?;
        let inserted = guard.insert(name.clone());
        let count = self
            .mcp_tools_snapshot
            .iter()
            .filter(|t| t.server_name == name)
            .count();
        Ok(if inserted {
            format!(
                "attached mcp server `{name}` ({count} tools now available; call them directly in your next tool_use this same turn)."
            )
        } else {
            format!("mcp server `{name}` was already attached.")
        })
    }

    fn handle_detach_mcp_server(&self, input: &str) -> Result<String, ToolError> {
        let value = parse_or_repair_tool_input(META_DETACH_MCP, input)?;
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::new("detach_mcp_server requires `name` (string)".to_string()))?
            .trim()
            .to_string();
        let mut guard = self.attached_mcps.lock().map_err(|_| {
            ToolError::new("attached_mcps lock poisoned".to_string())
        })?;
        let removed = guard.remove(&name);
        Ok(if removed {
            format!("detached mcp server `{name}`.")
        } else {
            format!("mcp server `{name}` was not attached.")
        })
    }
}

impl ToolExecutor for CombinedToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        // Intercept MCP meta-tools first — they mutate session state instead
        // of dispatching to a subprocess.
        match tool_name {
            META_LIST_MCP => return self.handle_list_mcp_servers(),
            META_ATTACH_MCP => return self.handle_attach_mcp_server(input),
            META_DETACH_MCP => return self.handle_detach_mcp_server(input),
            _ => {}
        }

        if tool_name.starts_with("mcp__") {
            // Defence in depth: even if the model somehow conjures a
            // non-attached MCP tool (e.g. recalled from earlier in the
            // conversation), refuse and tell it how to recover. Without this
            // we'd silently dispatch to a server the user expects to be off.
            let server_name = tool_name
                .strip_prefix("mcp__")
                .and_then(|rest| rest.split("__").next())
                .unwrap_or("");
            let attached = self
                .attached_mcps
                .lock()
                .map(|guard| guard.contains(server_name))
                .unwrap_or(false);
            if !attached {
                return Err(ToolError::new(format!(
                    "mcp server `{server_name}` is not attached. \
Call `attach_mcp_server` with name=\"{server_name}\" first, \
then retry the tool call on the next turn."
                )));
            }

            let arguments: Option<JsonValue> = if input.trim().is_empty() {
                None
            } else {
                Some(parse_or_repair_tool_input(tool_name, input)?)
            };
            let handle = tokio::runtime::Handle::try_current().map_err(|_| {
                ToolError::new("no tokio runtime available for MCP dispatch".to_string())
            })?;
            let mcp_manager = self.mcp_manager.clone();
            let qualified = tool_name.to_string();
            let response = handle.block_on(async move {
                let mut guard = mcp_manager.lock().await;
                guard.call_tool(&qualified, arguments).await
            });
            let response = response
                .map_err(|error| ToolError::new(format!("mcp call failed: {error}")))?;
            if let Some(error) = response.error {
                return Err(ToolError::new(format!(
                    "mcp error {}: {}",
                    error.code, error.message
                )));
            }
            let result = response.result.ok_or_else(|| {
                ToolError::new("mcp response missing result payload".to_string())
            })?;
            let mut out = flatten_mcp_text(&result);
            if let Some(structured) = &result.structured_content {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&structured.to_string());
            }
            if result.is_error.unwrap_or(false) {
                return Err(ToolError::new(if out.is_empty() {
                    "(mcp reported error)".to_string()
                } else {
                    out
                }));
            }
            Ok(out)
        } else {
            CatalogToolExecutor.execute(tool_name, input)
        }
    }
}

fn flatten_mcp_text(result: &runtime::McpToolCallResult) -> String {
    let mut out = String::new();
    for piece in &result.content {
        if piece.kind == "text" {
            if let Some(serde_json::Value::String(text)) = piece.data.get("text") {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
    }
    out
}

/// Build a `PermissionPolicy` whose per-tool floor comes from the static catalog
/// (`mvp_tool_specs`). Without this seeding the policy treats every tool as needing
/// `DangerFullAccess`, which is wrong for read-only tools like `read_file`.
fn build_permission_policy(
    active_mode: PermissionMode,
    live_mode: Arc<AtomicU8>,
) -> PermissionPolicy {
    mvp_tool_specs()
        .into_iter()
        .fold(
            PermissionPolicy::new(active_mode).with_live_mode(live_mode),
            |policy, spec| policy.with_tool_requirement(spec.name, spec.required_permission),
        )
}

fn builtin_tool_definitions() -> Vec<ToolDefinition> {
    mvp_tool_specs()
        .into_iter()
        .map(|spec| ToolDefinition {
            name: spec.name.to_string(),
            description: Some(spec.description.to_string()),
            input_schema: spec.input_schema,
        })
        .collect()
}

/// Tool definitions for the three MCP meta-tools (`list_mcp_servers`,
/// `attach_mcp_server`, `detach_mcp_server`). These are conditionally added
/// to the LLM's tool list only when at least one MCP server is configured —
/// they would just confuse the model otherwise.
fn mcp_meta_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: META_LIST_MCP.to_string(),
            description: Some(
                "List all configured MCP servers, which tools each provides, and whether each is currently attached to this session. Call this when you don't know which MCP servers are available before attaching one.".to_string(),
            ),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
        },
        ToolDefinition {
            name: META_ATTACH_MCP.to_string(),
            description: Some(
                "Attach an MCP server to this session so its tools become callable. By default no MCP servers are attached — attach only when you actually need a tool the server provides. The new tools appear in your tool list on the next turn.".to_string(),
            ),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name of the MCP server to attach (use list_mcp_servers to discover names)."
                    }
                },
                "required": ["name"],
                "additionalProperties": false,
            }),
        },
        ToolDefinition {
            name: META_DETACH_MCP.to_string(),
            description: Some(
                "Detach an MCP server from this session. Use this once you're done with the server's tools to free context-window tokens.".to_string(),
            ),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name of the MCP server to detach."
                    }
                },
                "required": ["name"],
                "additionalProperties": false,
            }),
        },
    ]
}

fn tool_summary(spec: ToolSpec) -> ToolSummary {
    ToolSummary {
        name: spec.name.to_string(),
        description: spec.description.to_string(),
        required_permission: spec.required_permission.as_str().to_string(),
        input_schema: spec.input_schema,
    }
}

fn command_summary(spec: &SlashCommandSpec) -> CommandSummary {
    CommandSummary {
        name: spec.name.to_string(),
        aliases: spec.aliases.iter().map(|alias| (*alias).to_string()).collect(),
        summary: spec.summary.to_string(),
        argument_hint: spec.argument_hint.map(ToString::to_string),
        resume_supported: spec.resume_supported,
        category: command_category_label(spec.category).to_string(),
    }
}

const fn command_category_label(category: SlashCommandCategory) -> &'static str {
    match category {
        SlashCommandCategory::Core => "core",
        SlashCommandCategory::Workspace => "workspace",
        SlashCommandCategory::Session => "session",
        SlashCommandCategory::Git => "git",
        SlashCommandCategory::Automation => "automation",
    }
}


async fn stream_session_events(
    State(state): State<AppState>,
    Path(id): Path<SessionId>,
) -> ApiResult<impl IntoResponse> {
    let (snapshot, mut receiver, replay) = {
        let sessions = state.sessions.read().await;
        let session = sessions
            .get(&id)
            .ok_or_else(|| not_found(format!("session `{id}` not found")))?;
        let snapshot = SessionEvent::SessionSnapshot {
            session_id: session.id.clone(),
            session: session.conversation.clone(),
        };
        // Replay any prompts still waiting for this session — without
        // this a user who closed the tab / switched sessions mid-prompt
        // and came back would see a stuck turn with no UI affordance to
        // unstick it. We only have request_id and the original payload
        // for permissions; for questions we have to fall back to a
        // generic placeholder because the original UserQuestionRequest
        // isn't stored alongside the sender. Track those separately if
        // we ever need full fidelity on replay.
        let replay = build_pending_replay(&state, &id);
        (snapshot, session.subscribe(), replay)
    };

    let stream = stream! {
        if let Ok(event) = snapshot.to_sse_event() {
            yield Ok::<Event, Infallible>(event);
        }
        for event in replay {
            if let Ok(sse_event) = event.to_sse_event() {
                yield Ok::<Event, Infallible>(sse_event);
            }
        }

        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if let Ok(sse_event) = event.to_sse_event() {
                        yield Ok::<Event, Infallible>(sse_event);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

/// Build the list of prompt events to replay on SSE subscribe. We
/// stored the original `SessionEvent` payloads in PendingEntry exactly
/// for this — a reconnecting client gets the same prompt UI as the
/// original subscriber instead of a degraded placeholder.
fn build_pending_replay(state: &AppState, session_id: &SessionId) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    if let Ok(pending) = state.pending_permissions.lock() {
        for entry in pending.values() {
            if entry.session_id == *session_id {
                events.push(entry.replay_event.clone());
            }
        }
    }
    if let Ok(pending) = state.pending_questions.lock() {
        for entry in pending.values() {
            if entry.session_id == *session_id {
                events.push(entry.replay_event.clone());
            }
        }
    }
    events
}

fn unix_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_millis() as u64
}

fn first_text_block(message: &ConversationMessage) -> Option<&str> {
    message.blocks.iter().find_map(|block| match block {
        ContentBlock::Text { text } => Some(text.as_str()),
        // Reasoning is internal chain-of-thought, not message
        // headline — skip it when previewing a session.
        ContentBlock::ToolUse { .. }
        | ContentBlock::ToolResult { .. }
        | ContentBlock::Reasoning { .. } => None,
    })
}

fn convert_messages(messages: &[ConversationMessage]) -> Vec<InputMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
                MessageRole::Assistant => "assistant",
            };
            let mut content = message
                .blocks
                .iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => {
                        ApiInputContentBlock::Text { text: text.clone() }
                    }
                    ContentBlock::Reasoning { text, signature } => {
                        // Echo previous-turn reasoning back to the
                        // provider. DeepSeek requires it for multi-turn
                        // tool use coherence; other providers ignore
                        // the unknown field (or accept native Anthropic
                        // thinking blocks).
                        ApiInputContentBlock::Thinking {
                            thinking: text.clone(),
                            signature: signature.clone(),
                        }
                    }
                    ContentBlock::ToolUse { id, name, input } => ApiInputContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: serde_json::from_str(input)
                            .unwrap_or_else(|_| json!({ "raw": input })),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id,
                        output,
                        is_error,
                        ..
                    } => ApiInputContentBlock::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        content: vec![ToolResultContentBlock::Text {
                            text: output.clone(),
                        }],
                        is_error: *is_error,
                    },
                })
                .collect::<Vec<_>>();

            // Inline the user's RAG-retrieved chunks into the LLM-facing
            // payload BEFORE the typed prompt. Putting context first
            // gives the model a clear "here's what to consult" frame,
            // mirroring the convention most public RAG examples use.
            if message.role == MessageRole::User {
                if let Some(rag_ctx) = message.retrieved_context.as_ref() {
                    let prefix = render_retrieved_context_for_llm(rag_ctx);
                    if !prefix.is_empty() {
                        if let Some(ApiInputContentBlock::Text { text }) =
                            content.iter_mut().find(|c| matches!(c, ApiInputContentBlock::Text { .. }))
                        {
                            // Prepend so retrieved context appears before
                            // the user's typed prompt.
                            *text = format!("{prefix}{text}");
                        } else {
                            content.insert(0, ApiInputContentBlock::Text { text: prefix });
                        }
                    }
                }
            }

            // Inline the user's attachments into the outgoing payload. Text
            // attachments (including PDF extracts) get appended to the
            // existing text block as markdown. Image attachments become
            // dedicated `Image` content blocks — providers (Anthropic
            // native, OpenAI via `image_url` translation) take them from
            // there.
            if !message.attachments.is_empty() && message.role == MessageRole::User {
                let rendered = render_attachments_for_llm(&message.attachments);
                if !rendered.is_empty() {
                    if let Some(ApiInputContentBlock::Text { text }) = content
                        .iter_mut()
                        .rev()
                        .find(|c| matches!(c, ApiInputContentBlock::Text { .. }))
                    {
                        text.push_str(&rendered);
                    } else {
                        content.push(ApiInputContentBlock::Text { text: rendered });
                    }
                }
                // TODO(vision-fallback): some target models (e.g. DeepSeek)
                // are text-only and will silently drop these Image blocks.
                // Route through a dedicated vision model (gpt-4o-mini /
                // claude-haiku / a local VLM) to caption the image, then
                // inject the caption as text so the primary LLM can reason
                // about it. Gate by provider capability flag.
                for att in &message.attachments {
                    if let AttachmentKind::Image { media_type } = &att.kind {
                        content.push(ApiInputContentBlock::Image {
                            source: ImageSource {
                                kind: "base64".to_string(),
                                media_type: media_type.clone(),
                                data: att.content.clone(),
                            },
                        });
                    }
                }
            }

            (!content.is_empty()).then(|| InputMessage {
                role: role.to_string(),
                content,
            })
        })
        .collect()
}

fn push_api_output_block(
    block: OutputContentBlock,
    block_index: u32,
    events: &mut Vec<AssistantEvent>,
    pending_tools: &mut HashMap<u32, (String, String, String)>,
    streaming_tool_input: bool,
) {
    match block {
        OutputContentBlock::Text { text } => {
            if !text.is_empty() {
                events.push(AssistantEvent::TextDelta(text));
            }
        }
        OutputContentBlock::ToolUse { id, name, input } => {
            let initial_input = if streaming_tool_input
                && input.is_object()
                && input.as_object().is_some_and(serde_json::Map::is_empty)
            {
                String::new()
            } else {
                input.to_string()
            };
            pending_tools.insert(block_index, (id, name, initial_input));
        }
        OutputContentBlock::Thinking { .. } | OutputContentBlock::RedactedThinking { .. } => {}
    }
}

fn response_to_assistant_events(response: MessageResponse) -> Vec<AssistantEvent> {
    let mut events = Vec::new();
    let mut pending_tools = HashMap::new();

    for (index, block) in response.content.into_iter().enumerate() {
        let index = u32::try_from(index).expect("response block index overflow");
        push_api_output_block(block, index, &mut events, &mut pending_tools, false);
        if let Some((id, name, input)) = pending_tools.remove(&index) {
            events.push(AssistantEvent::ToolUse { id, name, input });
        }
    }

    events.push(AssistantEvent::Usage(TokenUsage {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
    }));
    events.push(AssistantEvent::MessageStop);
    events
}

fn estimate_token_count(text: &str) -> u32 {
    let rough_count = text.chars().count().saturating_add(3) / 4;
    u32::try_from(rough_count).unwrap_or(u32::MAX)
}

fn not_found(message: String) -> ApiError {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorResponse { error: message }),
    )
}

fn conflict(message: String) -> ApiError {
    (
        StatusCode::CONFLICT,
        Json(ErrorResponse { error: message }),
    )
}

fn bad_request(message: String) -> ApiError {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse { error: message }),
    )
}

fn gone(message: String) -> ApiError {
    (StatusCode::GONE, Json(ErrorResponse { error: message }))
}

fn bad_gateway(message: String) -> ApiError {
    (
        StatusCode::BAD_GATEWAY,
        Json(ErrorResponse { error: message }),
    )
}

fn internal_error(message: String) -> ApiError {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse { error: message }),
    )
}

#[cfg(test)]
mod tests {
    use super::persistence::{self, PersistedState};
    use super::{
        app, parse_or_repair_tool_input, read_attachment, render_attachments_for_llm,
        session_cumulative_tokens, try_repair_json,
        AppState, AttachmentRef, CancelTurnResponse, CommandsResponse, CompactSessionResponse,
        CreateSessionResponse, ListSessionsResponse, ProvidersResponse, ServerConfig,
        SessionDetailsResponse, SessionEvent, SessionId, SetSessionMcpAttachedPayload,
        ToolsResponse, TurnDriver, TurnExecution, WorkspaceFileResponse, WorkspaceTreeResponse,
    };
    use runtime::PermissionPromptDecision;
    use reqwest::Client;
    use std::ffi::OsString;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::sync::{Mutex as StdMutex, OnceLock};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;
    use tokio::time::timeout;

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    struct EnvVarGuard {
        key: &'static str,
        original: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let original = std::env::var_os(key);
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    struct TestServer {
        address: SocketAddr,
        handle: JoinHandle<()>,
    }

    impl TestServer {
        async fn spawn() -> Self {
            Self::spawn_with_state(AppState::default()).await
        }

        async fn spawn_with_state(state: AppState) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("test listener should bind");
            let address = listener
                .local_addr()
                .expect("listener should report local address");
            let handle = tokio::spawn(async move {
                axum::serve(listener, app(state))
                    .await
                    .expect("server should run");
            });

            Self { address, handle }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{}", self.address, path)
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    async fn create_session(client: &Client, server: &TestServer) -> CreateSessionResponse {
        client
            .post(server.url("/sessions"))
            .send()
            .await
            .expect("create request should succeed")
            .error_for_status()
            .expect("create request should return success")
            .json::<CreateSessionResponse>()
            .await
            .expect("create response should parse")
    }

    async fn next_sse_frame(response: &mut reqwest::Response, buffer: &mut String) -> String {
        loop {
            if let Some(index) = buffer.find("\n\n") {
                let frame = buffer[..index].to_string();
                let remainder = buffer[index + 2..].to_string();
                *buffer = remainder;
                return frame;
            }

            let next_chunk = timeout(Duration::from_secs(5), response.chunk())
                .await
                .expect("SSE stream should yield within timeout")
                .expect("SSE stream should remain readable")
                .expect("SSE stream should stay open");
            buffer.push_str(&String::from_utf8_lossy(&next_chunk));
        }
    }

    #[tokio::test]
    async fn creates_and_lists_sessions() {
        let server = TestServer::spawn().await;
        let client = Client::new();

        // given
        let created = create_session(&client, &server).await;

        // when
        let sessions = client
            .get(server.url("/sessions"))
            .send()
            .await
            .expect("list request should succeed")
            .error_for_status()
            .expect("list request should return success")
            .json::<ListSessionsResponse>()
            .await
            .expect("list response should parse");
        let details = client
            .get(server.url(&format!("/sessions/{}", created.session_id)))
            .send()
            .await
            .expect("details request should succeed")
            .error_for_status()
            .expect("details request should return success")
            .json::<SessionDetailsResponse>()
            .await
            .expect("details response should parse");

        // then
        assert_eq!(created.session_id, "session-1");
        assert_eq!(sessions.sessions.len(), 1);
        assert_eq!(sessions.sessions[0].id, created.session_id);
        assert_eq!(sessions.sessions[0].message_count, 0);
        assert_eq!(details.id, "session-1");
        assert!(details.session.messages.is_empty());
    }

    #[tokio::test]
    async fn streams_message_events_and_persists_message_flow() {
        let server = TestServer::spawn().await;
        let client = Client::new();

        // given
        let created = create_session(&client, &server).await;
        let mut response = client
            .get(server.url(&format!("/sessions/{}/events", created.session_id)))
            .send()
            .await
            .expect("events request should succeed")
            .error_for_status()
            .expect("events request should return success");
        let mut buffer = String::new();
        let snapshot_frame = next_sse_frame(&mut response, &mut buffer).await;

        // when
        let send_status = client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "hello from test".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("message request should succeed")
            .status();
        let turn_started_frame = next_sse_frame(&mut response, &mut buffer).await;
        let message_frame = next_sse_frame(&mut response, &mut buffer).await;
        let assistant_delta_frame = next_sse_frame(&mut response, &mut buffer).await;
        let usage_frame = next_sse_frame(&mut response, &mut buffer).await;
        let assistant_message_frame = next_sse_frame(&mut response, &mut buffer).await;
        let turn_finished_frame = next_sse_frame(&mut response, &mut buffer).await;
        let details = client
            .get(server.url(&format!("/sessions/{}", created.session_id)))
            .send()
            .await
            .expect("details request should succeed")
            .error_for_status()
            .expect("details request should return success")
            .json::<SessionDetailsResponse>()
            .await
            .expect("details response should parse");

        // then
        assert_eq!(send_status, reqwest::StatusCode::ACCEPTED);
        assert!(snapshot_frame.contains("event: session_snapshot"));
        assert!(snapshot_frame.contains("\"session_id\":\"session-1\""));
        assert!(turn_started_frame.contains("event: turn_started"));
        assert!(message_frame.contains("event: user_message"));
        assert!(message_frame.contains("hello from test"));
        assert!(assistant_delta_frame.contains("event: assistant_delta"));
        assert!(assistant_delta_frame.contains("Received: hello from test"));
        assert!(usage_frame.contains("event: usage"));
        assert!(assistant_message_frame.contains("event: assistant_message"));
        assert!(turn_finished_frame.contains("event: turn_finished"));
        assert_eq!(details.session.messages.len(), 2);
        assert_eq!(
            details.session.messages[0],
            runtime::ConversationMessage::user_text("hello from test")
        );
        assert!(matches!(
            &details.session.messages[1].blocks[0],
            runtime::ContentBlock::Text { text } if text == "Received: hello from test"
        ));
    }

    #[tokio::test]
    async fn failed_turns_emit_error_and_keep_user_message() {
        struct FailingDriver;

        impl TurnDriver for FailingDriver {
            fn run_turn(
                &self,
                _session_id: SessionId,
                _session: runtime::Session,
                _user_input: super::ConversationMessage,
                _config: super::ServerConfig,
                _creds: Option<super::ProviderCreds>,
                _prompter: Option<Box<dyn runtime::PermissionPrompter + Send>>,
                _questioner: Option<Box<dyn runtime::UserQuestioner>>,
                _observer: Option<Box<dyn runtime::TurnObserver>>,
                _mcp: Option<super::McpRuntimeBundle>,
                _live_permission_mode: std::sync::Arc<std::sync::atomic::AtomicU8>,
            ) -> Result<TurnExecution, String> {
                Err("runtime failed".to_string())
            }
        }

        let server =
            TestServer::spawn_with_state(AppState::with_turn_driver(Arc::new(FailingDriver))).await;
        let client = Client::new();

        let created = create_session(&client, &server).await;
        let mut response = client
            .get(server.url(&format!("/sessions/{}/events", created.session_id)))
            .send()
            .await
            .expect("events request should succeed")
            .error_for_status()
            .expect("events request should return success");
        let mut buffer = String::new();
        let _snapshot_frame = next_sse_frame(&mut response, &mut buffer).await;

        let send_status = client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "will fail".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("message request should succeed")
            .status();
        let turn_started_frame = next_sse_frame(&mut response, &mut buffer).await;
        let user_message_frame = next_sse_frame(&mut response, &mut buffer).await;
        let error_frame = next_sse_frame(&mut response, &mut buffer).await;
        let turn_finished_frame = next_sse_frame(&mut response, &mut buffer).await;
        let details = client
            .get(server.url(&format!("/sessions/{}", created.session_id)))
            .send()
            .await
            .expect("details request should succeed")
            .error_for_status()
            .expect("details request should return success")
            .json::<SessionDetailsResponse>()
            .await
            .expect("details response should parse");

        assert_eq!(send_status, reqwest::StatusCode::ACCEPTED);
        assert!(turn_started_frame.contains("event: turn_started"));
        assert!(user_message_frame.contains("event: user_message"));
        assert!(error_frame.contains("event: error"));
        assert!(error_frame.contains("runtime failed"));
        assert!(turn_finished_frame.contains("event: turn_finished"));
        assert_eq!(details.session.messages.len(), 1);
        assert_eq!(
            details.session.messages[0],
            runtime::ConversationMessage::user_text("will fail")
        );
    }

    #[tokio::test]
    async fn provider_turn_driver_runs_against_openai_compatible_stream() {
        let _lock = env_lock();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock provider should bind");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("mock provider addr")
        );
        let handle = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept provider request");
            let mut buffer = [0_u8; 4096];
            let _ = socket.readable().await;
            let _ = socket.try_read(&mut buffer);
            let body = concat!(
                "data: {\"id\":\"chatcmpl_server\",\"model\":\"deepseek-chat\",\"choices\":[{\"delta\":{\"content\":\"Provider hello\"}}]}\n\n",
                "data: {\"id\":\"chatcmpl_server\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
                "data: [DONE]\n\n"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.writable().await.expect("provider socket writable");
            socket
                .try_write(response.as_bytes())
                .expect("write provider response");
        });

        let _api_key = EnvVarGuard::set("DEEPSEEK_API_KEY", Some("deepseek-test-key"));
        let _base_url = EnvVarGuard::set("DEEPSEEK_BASE_URL", Some(&base_url));
        let driver = super::DefaultTurnDriver;
        let config = ServerConfig {
            permission_mode: "danger-full-access".to_string(),
            model: Some("deepseek".to_string()),
            workspace_root: None,
            max_tool_iterations_per_turn: 50,
            max_session_tokens: None,
            embedding_provider: None,
            web_fetch_summarizer: None,
            session_summarizer: None,
        };

        let live_mode = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(
            super::parse_permission_mode(&config.permission_mode)
                .unwrap()
                .as_u8(),
        ));
        let execution = tokio::task::spawn_blocking(move || {
            driver.run_turn(
                "session-1".to_string(),
                runtime::Session::new(),
                runtime::ConversationMessage::user_text("hello"),
                config,
                None,
                None,
                None,
                None,
                None,
                live_mode,
            )
        })
        .await
        .expect("provider driver task should join")
        .expect("provider driver should succeed");

        handle.await.expect("mock provider should finish");
        assert_eq!(execution.session.messages.len(), 2);
        assert!(execution.events.iter().any(|event| matches!(
            event,
            SessionEvent::AssistantDelta { text, .. } if text == "Provider hello"
        )));
        assert!(execution.events.iter().any(|event| matches!(
            event,
            SessionEvent::Usage { usage, .. } if usage.input_tokens == 5
        )));
    }

    #[test]
    fn assistant_messages_expand_to_typed_events() {
        let message = runtime::ConversationMessage::assistant_with_usage(
            vec![
                runtime::ContentBlock::Text {
                    text: "working".to_string(),
                },
                runtime::ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "read_file".to_string(),
                    input: r#"{"path":"Cargo.toml"}"#.to_string(),
                },
            ],
            Some(runtime::TokenUsage {
                input_tokens: 10,
                output_tokens: 3,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            }),
        );

        let events = SessionEvent::from_assistant_message("session-1".to_string(), message.clone());

        assert!(matches!(
            &events[0],
            SessionEvent::AssistantDelta { text, .. } if text == "working"
        ));
        assert!(matches!(
            &events[1],
            SessionEvent::ToolUse { name, input, .. }
                if name == "read_file" && input.contains("Cargo.toml")
        ));
        assert!(matches!(
            &events[2],
            SessionEvent::Usage { usage, .. } if usage.input_tokens == 10
        ));
        assert_eq!(
            events.last(),
            Some(&SessionEvent::AssistantMessage {
                session_id: "session-1".to_string(),
                message,
            })
        );
    }

    #[tokio::test]
    async fn lists_builtin_tools_and_slash_commands() {
        let server = TestServer::spawn().await;
        let client = Client::new();

        let tools = client
            .get(server.url("/tools"))
            .send()
            .await
            .expect("tools request should succeed")
            .error_for_status()
            .expect("tools request should return success")
            .json::<ToolsResponse>()
            .await
            .expect("tools response should parse");
        let commands = client
            .get(server.url("/commands"))
            .send()
            .await
            .expect("commands request should succeed")
            .error_for_status()
            .expect("commands request should return success")
            .json::<CommandsResponse>()
            .await
            .expect("commands response should parse");

        assert!(tools.tools.iter().any(|tool| tool.name == "bash"));
        let read_file = tools
            .tools
            .iter()
            .find(|tool| tool.name == "read_file")
            .expect("read_file tool should be present");
        assert_eq!(read_file.required_permission, "read-only");
        assert!(read_file.input_schema.is_object());

        assert!(commands.commands.iter().any(|cmd| cmd.name == "help"));
        let permissions = commands
            .commands
            .iter()
            .find(|cmd| cmd.name == "permissions")
            .expect("permissions slash command should be present");
        assert_eq!(permissions.category, "core");
        assert!(permissions.argument_hint.is_some());
    }

    #[tokio::test]
    async fn reads_and_patches_server_config() {
        let server = TestServer::spawn().await;
        let client = Client::new();

        let initial = client
            .get(server.url("/config"))
            .send()
            .await
            .expect("config request should succeed")
            .error_for_status()
            .expect("config request should return success")
            .json::<ServerConfig>()
            .await
            .expect("config response should parse");
        assert_eq!(initial.permission_mode, "prompt");
        assert!(initial.model.is_none());

        let patched = client
            .patch(server.url("/config"))
            .json(&serde_json::json!({
                "permission_mode": "workspace-write",
                "model": "deepseek",
            }))
            .send()
            .await
            .expect("patch should succeed")
            .error_for_status()
            .expect("patch should return success")
            .json::<ServerConfig>()
            .await
            .expect("patch response should parse");
        assert_eq!(patched.permission_mode, "workspace-write");
        assert_eq!(patched.model.as_deref(), Some("deepseek"));

        let cleared = client
            .patch(server.url("/config"))
            .json(&serde_json::json!({ "model": null }))
            .send()
            .await
            .expect("patch clear should succeed")
            .error_for_status()
            .expect("patch clear should return success")
            .json::<ServerConfig>()
            .await
            .expect("patch clear response should parse");
        assert_eq!(cleared.permission_mode, "workspace-write");
        assert!(cleared.model.is_none());

        let bad = client
            .patch(server.url("/config"))
            .json(&serde_json::json!({ "permission_mode": "bogus" }))
            .send()
            .await
            .expect("bad patch should send");
        assert_eq!(bad.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn patching_permission_mode_takes_effect_for_in_flight_turn() {
        use std::sync::atomic::Ordering;

        // Fix C: a turn captures the live permission-mode atomic, and a PATCH
        // /config issued WHILE that turn runs must change authorization at the
        // next tool boundary — without rebuilding the policy.
        let state = AppState::with_config(ServerConfig {
            permission_mode: "danger-full-access".to_string(),
            ..ServerConfig::default()
        });
        // The handle send_message would hand to the running turn.
        let live = state.permission_mode.clone();
        assert_eq!(
            live.load(Ordering::Relaxed),
            runtime::PermissionMode::DangerFullAccess.as_u8()
        );

        // The in-flight turn's policy carries that live handle.
        let policy = super::build_permission_policy(
            runtime::PermissionMode::DangerFullAccess,
            live.clone(),
        );
        // write_file (workspace-write floor) is allowed under danger-full-access.
        assert!(matches!(
            policy.authorize("write_file", r#"{"path":"a.txt","content":"x"}"#, None),
            runtime::PermissionOutcome::Allow
        ));

        // Operator flips to read-only mid-turn via PATCH /config.
        let _ = super::update_config(
            axum::extract::State(state.clone()),
            axum::Json(super::ConfigPatch {
                permission_mode: Some("read-only".to_string()),
                model: None,
                workspace_root: None,
                max_tool_iterations_per_turn: None,
                max_session_tokens: None,
                embedding_provider: None,
                web_fetch_summarizer: None,
                session_summarizer: None,
            }),
        )
        .await
        .expect("patch should succeed");

        // The live atomic now reflects read-only...
        assert_eq!(
            live.load(Ordering::Relaxed),
            runtime::PermissionMode::ReadOnly.as_u8()
        );
        // ...and the SAME, unrebuilt policy now denies the write.
        assert!(matches!(
            policy.authorize("write_file", r#"{"path":"a.txt","content":"x"}"#, None),
            runtime::PermissionOutcome::Deny { .. }
        ));
    }

    #[test]
    fn permission_rule_key_keys_bash_on_program_and_others_by_name() {
        use super::permission_rule_key;

        // Simple single-segment bash keys on the leading program basename —
        // approving one `git` call covers later `git` calls (the chosen
        // "per command prefix" granularity).
        assert_eq!(
            permission_rule_key("bash", r#"{"command": "ls -la"}"#).as_deref(),
            Some("bash:ls")
        );
        assert_eq!(
            permission_rule_key("bash", r#"{"command": "git status"}"#).as_deref(),
            Some("bash:git")
        );
        assert_eq!(
            permission_rule_key("bash", r#"{"command": "/usr/bin/find . -name x"}"#).as_deref(),
            Some("bash:find")
        );
        // Compound / redirected commands are NOT generalized — remembered by
        // exact text so an approval can't smuggle in extra operators.
        assert_eq!(
            permission_rule_key("bash", r#"{"command": "ls && rm -rf build"}"#).as_deref(),
            Some("bash:exact:ls && rm -rf build")
        );
        assert_eq!(
            permission_rule_key("bash", r#"{"command": "cat f > out.txt"}"#).as_deref(),
            Some("bash:exact:cat f > out.txt")
        );
        // Non-bash tools key on the tool name.
        assert_eq!(
            permission_rule_key("read_file", r#"{"path": "a.txt"}"#).as_deref(),
            Some("read_file")
        );
        // Unparseable / empty bash input yields no stable key.
        assert_eq!(permission_rule_key("bash", "not json"), None);
        assert_eq!(permission_rule_key("bash", r#"{"command": "   "}"#), None);
    }

    #[test]
    fn server_prompter_auto_approves_remembered_rule() {
        use runtime::PermissionPrompter;

        // Pre-seed an "Allow always" approval for `bash:ls`.
        let mut allow = std::collections::BTreeSet::new();
        allow.insert("bash:ls".to_string());
        let allow_rules = Arc::new(StdMutex::new(allow));
        let pending: super::PendingPermissionStore =
            Arc::new(StdMutex::new(std::collections::HashMap::new()));
        let (broadcaster, _rx) = tokio::sync::broadcast::channel(8);
        let mut prompter = super::ServerPrompter {
            session_id: "session-1".to_string(),
            pending: pending.clone(),
            broadcaster,
            next_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            allow_rules: allow_rules.clone(),
        };

        // A matching `ls` request auto-approves WITHOUT parking a pending
        // request (so no UI prompt, no blocking wait).
        let request = runtime::PermissionRequest {
            tool_name: "bash".to_string(),
            input: r#"{"command": "ls -la"}"#.to_string(),
            current_mode: runtime::PermissionMode::Prompt,
            required_mode: runtime::PermissionMode::ReadOnly,
        };
        assert!(matches!(
            prompter.decide(&request),
            runtime::PermissionPromptDecision::Allow
        ));
        assert!(
            pending.lock().unwrap().is_empty(),
            "remembered approval must not park a pending request"
        );
    }

    #[tokio::test]
    async fn rejects_concurrent_turns_on_same_session() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        struct BlockingDriver {
            barrier: Arc<Barrier>,
            started: Arc<AtomicUsize>,
        }

        impl TurnDriver for BlockingDriver {
            fn run_turn(
                &self,
                _session_id: SessionId,
                session: runtime::Session,
                _user_input: super::ConversationMessage,
                _config: super::ServerConfig,
                _creds: Option<super::ProviderCreds>,
                _prompter: Option<Box<dyn runtime::PermissionPrompter + Send>>,
                _questioner: Option<Box<dyn runtime::UserQuestioner>>,
                _observer: Option<Box<dyn runtime::TurnObserver>>,
                _mcp: Option<super::McpRuntimeBundle>,
                _live_permission_mode: std::sync::Arc<std::sync::atomic::AtomicU8>,
            ) -> Result<TurnExecution, String> {
                self.started.fetch_add(1, Ordering::SeqCst);
                self.barrier.wait();
                Ok(TurnExecution {
                    session,
                    events: Vec::new(),
                })
            }
        }

        let barrier = Arc::new(Barrier::new(2));
        let started = Arc::new(AtomicUsize::new(0));
        let driver = Arc::new(BlockingDriver {
            barrier: barrier.clone(),
            started: started.clone(),
        });
        let server =
            TestServer::spawn_with_state(AppState::with_turn_driver(driver.clone())).await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        let first = client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "first".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("first send should succeed");
        assert_eq!(first.status(), reqwest::StatusCode::ACCEPTED);

        // wait for the spawned task to enter the blocking driver
        for _ in 0..100 {
            if started.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(started.load(Ordering::SeqCst) > 0, "turn should have started");

        let second = client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "second".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("second send should round-trip");
        assert_eq!(second.status(), reqwest::StatusCode::CONFLICT);

        // unblock the in-flight turn so the spawned task can complete
        tokio::task::spawn_blocking(move || barrier.wait())
            .await
            .expect("barrier release should join");
    }

    #[tokio::test]
    async fn patching_config_flows_into_next_turn() {
        use std::sync::Mutex as StdMutex;

        #[derive(Default)]
        struct CapturingDriver {
            seen: Arc<StdMutex<Vec<ServerConfig>>>,
        }

        impl TurnDriver for CapturingDriver {
            fn run_turn(
                &self,
                _session_id: SessionId,
                session: runtime::Session,
                _user_input: super::ConversationMessage,
                config: super::ServerConfig,
                _creds: Option<super::ProviderCreds>,
                _prompter: Option<Box<dyn runtime::PermissionPrompter + Send>>,
                _questioner: Option<Box<dyn runtime::UserQuestioner>>,
                _observer: Option<Box<dyn runtime::TurnObserver>>,
                _mcp: Option<super::McpRuntimeBundle>,
                _live_permission_mode: std::sync::Arc<std::sync::atomic::AtomicU8>,
            ) -> Result<TurnExecution, String> {
                self.seen.lock().unwrap().push(config);
                Ok(TurnExecution {
                    session,
                    events: Vec::new(),
                })
            }
        }

        let seen = Arc::new(StdMutex::new(Vec::<ServerConfig>::new()));
        let driver = Arc::new(CapturingDriver { seen: seen.clone() });
        let server =
            TestServer::spawn_with_state(AppState::with_turn_driver(driver.clone())).await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        // first turn uses the default config (danger-full-access, no model)
        let mut events = client
            .get(server.url(&format!("/sessions/{}/events", created.session_id)))
            .send()
            .await
            .expect("events request should succeed")
            .error_for_status()
            .expect("events request should return success");
        let mut buffer = String::new();
        let _snapshot = next_sse_frame(&mut events, &mut buffer).await;

        client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "first".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("first send should succeed")
            .error_for_status()
            .expect("first send should return 202");
        // drain frames until turn_finished so the captured config is committed
        loop {
            let frame = next_sse_frame(&mut events, &mut buffer).await;
            if frame.contains("event: turn_finished") {
                break;
            }
        }

        // patch config
        client
            .patch(server.url("/config"))
            .json(&serde_json::json!({
                "permission_mode": "read-only",
                "model": "deepseek",
            }))
            .send()
            .await
            .expect("patch should succeed")
            .error_for_status()
            .expect("patch should return success");

        // second turn must see the patched config
        client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "second".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("second send should succeed")
            .error_for_status()
            .expect("second send should return 202");
        loop {
            let frame = next_sse_frame(&mut events, &mut buffer).await;
            if frame.contains("event: turn_finished") {
                break;
            }
        }

        let captured = seen.lock().unwrap().clone();
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[0].permission_mode, "prompt");
        assert!(captured[0].model.is_none());
        assert_eq!(captured[1].permission_mode, "read-only");
        assert_eq!(captured[1].model.as_deref(), Some("deepseek"));
    }

    #[tokio::test]
    async fn cancels_in_flight_turn_and_broadcasts_event() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        struct BlockingDriver {
            barrier: Arc<Barrier>,
            started: Arc<AtomicUsize>,
        }

        impl TurnDriver for BlockingDriver {
            fn run_turn(
                &self,
                _session_id: SessionId,
                session: runtime::Session,
                _user_input: super::ConversationMessage,
                _config: super::ServerConfig,
                _creds: Option<super::ProviderCreds>,
                _prompter: Option<Box<dyn runtime::PermissionPrompter + Send>>,
                _questioner: Option<Box<dyn runtime::UserQuestioner>>,
                _observer: Option<Box<dyn runtime::TurnObserver>>,
                _mcp: Option<super::McpRuntimeBundle>,
                _live_permission_mode: std::sync::Arc<std::sync::atomic::AtomicU8>,
            ) -> Result<TurnExecution, String> {
                self.started.fetch_add(1, Ordering::SeqCst);
                self.barrier.wait();
                Ok(TurnExecution {
                    session,
                    events: Vec::new(),
                })
            }
        }

        let barrier = Arc::new(Barrier::new(2));
        let started = Arc::new(AtomicUsize::new(0));
        let driver = Arc::new(BlockingDriver {
            barrier: barrier.clone(),
            started: started.clone(),
        });
        let server =
            TestServer::spawn_with_state(AppState::with_turn_driver(driver.clone())).await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        let mut events = client
            .get(server.url(&format!("/sessions/{}/events", created.session_id)))
            .send()
            .await
            .expect("events request should succeed")
            .error_for_status()
            .expect("events request should return success");
        let mut buffer = String::new();
        let _snapshot = next_sse_frame(&mut events, &mut buffer).await;

        let send = client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "long running".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("send should succeed");
        assert_eq!(send.status(), reqwest::StatusCode::ACCEPTED);

        let _turn_started = next_sse_frame(&mut events, &mut buffer).await;
        let _user_message = next_sse_frame(&mut events, &mut buffer).await;

        for _ in 0..100 {
            if started.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let cancel = client
            .post(server.url(&format!("/sessions/{}/cancel", created.session_id)))
            .send()
            .await
            .expect("cancel should round-trip")
            .error_for_status()
            .expect("cancel should return success")
            .json::<CancelTurnResponse>()
            .await
            .expect("cancel response should parse");
        assert!(cancel.cancelled);

        let cancelled_frame = next_sse_frame(&mut events, &mut buffer).await;
        assert!(cancelled_frame.contains("event: turn_cancelled"));

        // a follow-up cancel after the turn is gone reports nothing to cancel
        let again = client
            .post(server.url(&format!("/sessions/{}/cancel", created.session_id)))
            .send()
            .await
            .expect("second cancel should round-trip")
            .error_for_status()
            .expect("second cancel should return success")
            .json::<CancelTurnResponse>()
            .await
            .expect("second cancel response should parse");
        assert!(!again.cancelled);

        // release the blocking driver so the aborted task can finish cleanly
        tokio::task::spawn_blocking(move || barrier.wait())
            .await
            .expect("barrier release should join");
    }

    #[tokio::test]
    async fn persistence_writes_through_on_put_and_patch() {
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicU64 as StdAtomicU64, Ordering as StdOrdering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static SEQ: StdAtomicU64 = StdAtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, StdOrdering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "claw-server-state-{}-{}-{seq}.json",
            std::process::id(),
            nanos
        ));

        let state = AppState::with_persistence(path.clone(), ServerConfig::default(), HashMap::new());
        let server = TestServer::spawn_with_state(state).await;
        let client = Client::new();

        // PUT a provider — file should appear and contain the key
        client
            .put(server.url("/providers/deepseek"))
            .json(&serde_json::json!({"api_key": "sk-persist-test", "base_url": "https://example.test"}))
            .send()
            .await
            .expect("put")
            .error_for_status()
            .expect("204");

        // give the spawn_blocking write a moment to flush
        for _ in 0..50 {
            if path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let loaded = persistence::load(&path).expect("load").expect("file exists");
        let stored = loaded.providers.get("deepseek").expect("entry");
        assert_eq!(stored.api_key, "sk-persist-test");
        assert_eq!(stored.base_url.as_deref(), Some("https://example.test"));

        // PATCH /config — model + permission_mode should land in the file too
        client
            .patch(server.url("/config"))
            .json(&serde_json::json!({"model": "deepseek", "permission_mode": "read-only"}))
            .send()
            .await
            .expect("patch")
            .error_for_status()
            .expect("ok");

        // Wait for the next disk flush to overwrite the previous file
        let updated = loop {
            let snapshot = persistence::load(&path).expect("load").expect("present");
            if snapshot.config.model.as_deref() == Some("deepseek")
                && snapshot.config.permission_mode == "read-only"
            {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(updated.config.model.as_deref(), Some("deepseek"));
        assert_eq!(updated.config.permission_mode, "read-only");
        assert!(updated.providers.contains_key("deepseek"));

        // DELETE clears the entry on disk
        client
            .delete(server.url("/providers/deepseek"))
            .send()
            .await
            .expect("delete")
            .error_for_status()
            .expect("ok");
        let after_delete = loop {
            let snapshot = persistence::load(&path).expect("load").expect("present");
            if !snapshot.providers.contains_key("deepseek") {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(after_delete.providers.is_empty());

        // Round-trip the on-disk shape directly so we know the schema is stable
        let _: PersistedState = persistence::load(&path).expect("load").expect("present");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn sessions_survive_restart_via_persistence() {
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicU64 as StdAtomicU64, Ordering as StdOrdering};
        use std::time::{SystemTime, UNIX_EPOCH};

        // Unique state dir per test run so concurrent tests don't collide.
        static SEQ: StdAtomicU64 = StdAtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, StdOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "claw-server-sessions-{}-{}-{seq}",
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).expect("mkdir state dir");
        let path = dir.join("state.json");

        // --- First "process": create a session, give it history, persist it.
        let state = AppState::with_persistence(path.clone(), ServerConfig::default(), HashMap::new());
        let id = state.allocate_session_id();
        {
            let mut session = super::Session::new(id.clone());
            session
                .conversation
                .messages
                .push(runtime::ConversationMessage::user_text("remember me across restarts"));
            *session.attached_library.lock().unwrap() = Some("docs".to_string());
            session
                .attached_mcps
                .lock()
                .unwrap()
                .insert("filesystem".to_string());
            state.sessions.write().await.insert(id.clone(), session);
        }
        state.persist_session(&id).await;

        // The on-disk file should exist now that the blocking write joined.
        let sessions_dir = persistence::sessions_dir(&path);
        let restored_disk = persistence::load_sessions(&sessions_dir);
        assert_eq!(restored_disk.len(), 1, "exactly one session file on disk");

        // --- Second "process": fresh AppState, same path. Starts empty,
        // then restore_persisted_sessions pulls the session back in.
        let restarted =
            AppState::with_persistence(path.clone(), ServerConfig::default(), HashMap::new());
        assert!(
            restarted.sessions.read().await.is_empty(),
            "fresh state has no in-memory sessions before restore"
        );
        restarted.restore_persisted_sessions().await;

        {
            let sessions = restarted.sessions.read().await;
            let session = sessions.get(&id).expect("session restored into store");
            assert_eq!(session.id, id);
            assert_eq!(session.conversation.messages.len(), 1);
            assert_eq!(
                session.attached_library.lock().unwrap().as_deref(),
                Some("docs")
            );
            assert!(session
                .attached_mcps
                .lock()
                .unwrap()
                .contains("filesystem"));
        }

        // next_session_id must advance past the restored id so a freshly
        // allocated session can't collide with the one we just loaded.
        let next_id = restarted.allocate_session_id();
        assert_ne!(next_id, id, "allocator must not re-issue a restored id");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn permission_prompter_round_trips_through_sse_and_decision_endpoint() {
        use std::sync::Mutex as StdMutex;

        // Driver that simulates the conversation runtime asking the prompter once,
        // then stashes the resulting decision so the test can assert on it.
        struct AskingDriver {
            captured: Arc<StdMutex<Option<PermissionPromptDecision>>>,
        }

        impl TurnDriver for AskingDriver {
            fn run_turn(
                &self,
                _session_id: SessionId,
                session: runtime::Session,
                _user_input: super::ConversationMessage,
                _config: super::ServerConfig,
                _creds: Option<super::ProviderCreds>,
                prompter: Option<Box<dyn runtime::PermissionPrompter + Send>>,
                _questioner: Option<Box<dyn runtime::UserQuestioner>>,
                _observer: Option<Box<dyn runtime::TurnObserver>>,
                _mcp: Option<super::McpRuntimeBundle>,
                _live_permission_mode: std::sync::Arc<std::sync::atomic::AtomicU8>,
            ) -> Result<TurnExecution, String> {
                let mut prompter = prompter.ok_or("prompter not provided")?;
                let request = runtime::PermissionRequest {
                    tool_name: "bash".to_string(),
                    input: "{\"command\":\"ls\"}".to_string(),
                    current_mode: runtime::PermissionMode::Prompt,
                    required_mode: runtime::PermissionMode::DangerFullAccess,
                };
                let decision = prompter.decide(&request);
                self.captured.lock().unwrap().replace(decision.clone());
                Ok(TurnExecution {
                    session,
                    events: Vec::new(),
                })
            }
        }

        let captured: Arc<StdMutex<Option<PermissionPromptDecision>>> =
            Arc::new(StdMutex::new(None));
        let driver = Arc::new(AskingDriver {
            captured: captured.clone(),
        });
        let server =
            TestServer::spawn_with_state(AppState::with_turn_driver(driver.clone())).await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        // subscribe to events first so we can race the message handler
        let mut events = client
            .get(server.url(&format!("/sessions/{}/events", created.session_id)))
            .send()
            .await
            .expect("events")
            .error_for_status()
            .expect("ok");
        let mut buffer = String::new();
        let _snapshot = next_sse_frame(&mut events, &mut buffer).await;

        client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "please run ls".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("send")
            .error_for_status()
            .expect("202");

        // walk frames until we see the permission_request and pluck the request_id
        let mut request_id: Option<String> = None;
        for _ in 0..10 {
            let frame = next_sse_frame(&mut events, &mut buffer).await;
            if frame.contains("event: permission_request") {
                let payload = frame
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .expect("data line");
                let json: serde_json::Value =
                    serde_json::from_str(payload).expect("parse permission_request");
                assert_eq!(json["tool_name"].as_str(), Some("bash"));
                assert_eq!(json["current_mode"].as_str(), Some("prompt"));
                assert_eq!(json["required_mode"].as_str(), Some("danger-full-access"));
                request_id = Some(json["request_id"].as_str().unwrap().to_string());
                break;
            }
            assert!(
                !frame.contains("event: turn_finished"),
                "turn finished before any permission_request was emitted"
            );
        }
        let request_id = request_id.expect("permission_request never arrived");

        // approve it
        client
            .post(server.url(&format!(
                "/sessions/{}/permissions/{}/decision",
                created.session_id, request_id
            )))
            .json(&serde_json::json!({"allowed": true}))
            .send()
            .await
            .expect("decision")
            .error_for_status()
            .expect("204");

        // drain to turn_finished and also observe the permission_decision broadcast
        let mut saw_decision = false;
        loop {
            let frame = next_sse_frame(&mut events, &mut buffer).await;
            if frame.contains("event: permission_decision") {
                assert!(frame.contains("\"allowed\":true"));
                saw_decision = true;
            }
            if frame.contains("event: turn_finished") {
                break;
            }
        }
        assert!(saw_decision, "permission_decision was not broadcast");
        let outcome = captured.lock().unwrap().clone().expect("driver captured");
        assert!(matches!(outcome, PermissionPromptDecision::Allow));

        // a follow-up POST for the same id should now 404 (or 410 if the future already resolved)
        let stale = client
            .post(server.url(&format!(
                "/sessions/{}/permissions/{}/decision",
                created.session_id, request_id
            )))
            .json(&serde_json::json!({"allowed": false}))
            .send()
            .await
            .expect("stale post");
        assert!(stale.status() == reqwest::StatusCode::NOT_FOUND
            || stale.status() == reqwest::StatusCode::GONE);
    }

    #[tokio::test]
    async fn provider_creds_roundtrip_through_api() {
        let server = TestServer::spawn().await;
        let client = Client::new();

        // initial list — everyone unconfigured, key never present in payload
        let initial = client
            .get(server.url("/providers"))
            .send()
            .await
            .expect("list providers")
            .error_for_status()
            .expect("ok")
            .json::<ProvidersResponse>()
            .await
            .expect("parse");
        assert!(initial.providers.iter().any(|p| p.name == "deepseek"));
        for entry in &initial.providers {
            assert!(!entry.configured, "{} should not be configured initially", entry.name);
        }
        // raw text — make sure no field named api_key exists in the response
        let raw = client
            .get(server.url("/providers"))
            .send()
            .await
            .expect("list raw")
            .text()
            .await
            .expect("body");
        assert!(!raw.contains("api_key"), "response leaked an api_key field");

        // unknown provider → 400
        let bad = client
            .put(server.url("/providers/martian"))
            .json(&serde_json::json!({"api_key": "x"}))
            .send()
            .await
            .expect("bad put");
        assert_eq!(bad.status(), reqwest::StatusCode::BAD_REQUEST);

        // empty api_key → 400
        let empty = client
            .put(server.url("/providers/deepseek"))
            .json(&serde_json::json!({"api_key": "   "}))
            .send()
            .await
            .expect("empty put");
        assert_eq!(empty.status(), reqwest::StatusCode::BAD_REQUEST);

        // good put → 204
        let good = client
            .put(server.url("/providers/deepseek"))
            .json(&serde_json::json!({"api_key": "sk-test-xyz", "base_url": "https://example.test"}))
            .send()
            .await
            .expect("good put");
        assert_eq!(good.status(), reqwest::StatusCode::NO_CONTENT);

        let after = client
            .get(server.url("/providers"))
            .send()
            .await
            .expect("list after")
            .json::<ProvidersResponse>()
            .await
            .expect("parse after");
        let deepseek = after
            .providers
            .iter()
            .find(|p| p.name == "deepseek")
            .expect("deepseek present");
        assert!(deepseek.configured);
        assert_eq!(deepseek.base_url.as_deref(), Some("https://example.test"));

        // delete → 204, then unconfigured again
        let removed = client
            .delete(server.url("/providers/deepseek"))
            .send()
            .await
            .expect("delete");
        assert_eq!(removed.status(), reqwest::StatusCode::NO_CONTENT);
        let final_list = client
            .get(server.url("/providers"))
            .send()
            .await
            .expect("list final")
            .json::<ProvidersResponse>()
            .await
            .expect("parse final");
        let deepseek = final_list
            .providers
            .iter()
            .find(|p| p.name == "deepseek")
            .expect("deepseek present");
        assert!(!deepseek.configured);
    }

    #[tokio::test]
    async fn stored_provider_creds_drive_turn() {
        // Spin a fake OpenAI-compatible endpoint that replies with one chunk.
        let _lock = env_lock();
        // ensure ambient env keys don't satisfy the fallback path
        let _api_clear = EnvVarGuard::set("DEEPSEEK_API_KEY", None);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("provider listener");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("provider addr")
        );
        let handle = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            let mut buffer = [0_u8; 4096];
            let _ = socket.readable().await;
            let _ = socket.try_read(&mut buffer);
            let body = concat!(
                "data: {\"id\":\"chatcmpl_a\",\"choices\":[{\"delta\":{\"content\":\"hi from creds\"}}]}\n\n",
                "data: {\"id\":\"chatcmpl_a\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n",
                "data: [DONE]\n\n"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.writable().await.expect("writable");
            socket.try_write(response.as_bytes()).expect("write");
        });

        let server = TestServer::spawn().await;
        let client = Client::new();

        // configure deepseek through the API (no env vars set)
        client
            .put(server.url("/providers/deepseek"))
            .json(&serde_json::json!({"api_key": "sk-runtime", "base_url": base_url}))
            .send()
            .await
            .expect("put creds")
            .error_for_status()
            .expect("204");

        // tell the runtime to use deepseek
        client
            .patch(server.url("/config"))
            .json(&serde_json::json!({"model": "deepseek"}))
            .send()
            .await
            .expect("patch")
            .error_for_status()
            .expect("ok");

        // round-trip a turn
        let created = create_session(&client, &server).await;
        let mut events = client
            .get(server.url(&format!("/sessions/{}/events", created.session_id)))
            .send()
            .await
            .expect("events")
            .error_for_status()
            .expect("ok");
        let mut buffer = String::new();
        let _snapshot = next_sse_frame(&mut events, &mut buffer).await;

        client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "ping".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("send")
            .error_for_status()
            .expect("202");

        let mut saw_delta = false;
        loop {
            let frame = next_sse_frame(&mut events, &mut buffer).await;
            if frame.contains("hi from creds") {
                saw_delta = true;
            }
            if frame.contains("event: turn_finished") {
                break;
            }
            if frame.contains("event: error") {
                panic!("turn errored: {frame}");
            }
        }
        assert!(saw_delta, "expected assistant_delta with provider payload");
        handle.await.expect("mock provider should finish");
    }

    #[tokio::test]
    async fn list_sessions_derives_title_from_first_user_message() {
        let server = TestServer::spawn().await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        // Before any message, no title yet.
        let initial = client
            .get(server.url("/sessions"))
            .send()
            .await
            .expect("list")
            .json::<ListSessionsResponse>()
            .await
            .expect("parse");
        assert!(initial.sessions[0].title.is_none());

        // Subscribe BEFORE sending so we don't miss user_message.
        let mut events = client
            .get(server.url(&format!("/sessions/{}/events", created.session_id)))
            .send()
            .await
            .expect("events")
            .error_for_status()
            .expect("ok");
        let mut buffer = String::new();
        let _snap = next_sse_frame(&mut events, &mut buffer).await;

        // Send something long with whitespace to verify collapsing + truncation.
        let body = "  \n  this is the very first user message and it should become the title for the session  in the sidebar without showing the whole thing  ";
        client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: body.to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("send")
            .error_for_status()
            .expect("202");

        for _ in 0..6 {
            let frame = next_sse_frame(&mut events, &mut buffer).await;
            if frame.contains("event: user_message") {
                break;
            }
        }

        let after = client
            .get(server.url("/sessions"))
            .send()
            .await
            .expect("list 2")
            .json::<ListSessionsResponse>()
            .await
            .expect("parse 2");
        let title = after.sessions[0].title.as_deref().unwrap_or("");
        assert!(title.starts_with("this is the very first user message"));
        assert!(title.chars().count() <= 60);
        assert!(!title.contains('\n'));
    }

    #[tokio::test]
    async fn workspace_endpoints_tree_file_and_escape_protection() {
        use std::sync::atomic::{AtomicU64 as StdAtomicU64, Ordering as StdOrdering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static SEQ: StdAtomicU64 = StdAtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, StdOrdering::Relaxed);
        let workspace = std::env::temp_dir().join(format!(
            "claw-workspace-{}-{nanos}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(workspace.join("src")).expect("mkdir");
        std::fs::write(workspace.join("README.md"), "hello workspace\n").expect("write");
        std::fs::write(workspace.join("src").join("lib.rs"), "fn main() {}\n").expect("write");
        let canonical_root = workspace.canonicalize().expect("canonical").display().to_string();

        let server = TestServer::spawn().await;
        let client = Client::new();

        // 1) Without workspace_root, the endpoints fall back to the server's CWD.
        //    Configure the workspace explicitly so the test is hermetic.
        client
            .patch(server.url("/config"))
            .json(&serde_json::json!({"workspace_root": canonical_root.clone()}))
            .send()
            .await
            .expect("patch")
            .error_for_status()
            .expect("ok");

        // 2) GET /workspace/tree returns the root entries, dirs first.
        let tree = client
            .get(server.url("/workspace/tree"))
            .send()
            .await
            .expect("tree")
            .error_for_status()
            .expect("ok")
            .json::<WorkspaceTreeResponse>()
            .await
            .expect("parse tree");
        assert_eq!(tree.root, canonical_root);
        let names: Vec<_> = tree.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["src".to_string(), "README.md".to_string()]);
        let src_entry = tree.entries.iter().find(|e| e.name == "src").unwrap();
        assert_eq!(src_entry.kind, "dir");
        let readme_entry = tree.entries.iter().find(|e| e.name == "README.md").unwrap();
        assert_eq!(readme_entry.kind, "file");
        assert_eq!(readme_entry.size, Some("hello workspace\n".len() as u64));

        // 3) GET nested
        let nested = client
            .get(server.url("/workspace/tree?path=src"))
            .send()
            .await
            .expect("nested")
            .error_for_status()
            .expect("ok")
            .json::<WorkspaceTreeResponse>()
            .await
            .expect("parse nested");
        let nested_names: Vec<_> = nested.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(nested_names, vec!["lib.rs".to_string()]);

        // 4) GET /workspace/file returns content
        let file = client
            .get(server.url("/workspace/file?path=src/lib.rs"))
            .send()
            .await
            .expect("file")
            .error_for_status()
            .expect("ok")
            .json::<WorkspaceFileResponse>()
            .await
            .expect("parse file");
        assert_eq!(file.content, "fn main() {}\n");
        assert!(!file.binary);
        assert!(!file.truncated);

        // 5) Escape attempts: relative `..` and absolute outside both rejected.
        let escape = client
            .get(server.url("/workspace/tree?path=../"))
            .send()
            .await
            .expect("escape");
        assert!(escape.status().is_client_error(), "expected escape rejection");
        let absolute = client
            .get(server.url("/workspace/file?path=/etc/passwd"))
            .send()
            .await
            .expect("abs");
        assert!(
            absolute.status() == reqwest::StatusCode::BAD_REQUEST
                || absolute.status() == reqwest::StatusCode::NOT_FOUND
        );

        // 6) Missing query param to /file
        let missing_path = client
            .get(server.url("/workspace/file"))
            .send()
            .await
            .expect("missing");
        assert_eq!(missing_path.status(), reqwest::StatusCode::BAD_REQUEST);

        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn try_repair_json_returns_none_when_already_valid() {
        assert!(try_repair_json(r#"{"a": 1}"#).is_none());
    }

    #[test]
    fn try_repair_json_closes_truncated_string() {
        // Mirrors the real failure observed in the wild: a tool_use payload
        // truncated mid-string with several unmatched closers still pending.
        let broken = r#"{"path":"/tmp/x.txt","content":"hello "#;
        let repaired = try_repair_json(broken).expect("should repair truncated string");
        let value: serde_json::Value =
            serde_json::from_str(&repaired).expect("repaired JSON parses");
        assert_eq!(value["path"], "/tmp/x.txt");
        assert_eq!(value["content"], "hello ");
    }

    #[test]
    fn try_repair_json_balances_unclosed_braces_and_brackets() {
        let broken = r#"{"items":[1,2,3"#;
        let repaired = try_repair_json(broken).expect("should balance brackets");
        let value: serde_json::Value =
            serde_json::from_str(&repaired).expect("repaired JSON parses");
        assert_eq!(value["items"], serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn try_repair_json_strips_trailing_comma() {
        let broken = r#"{"a":1,"b":2,"#;
        let repaired = try_repair_json(broken).expect("should strip trailing comma");
        let value: serde_json::Value =
            serde_json::from_str(&repaired).expect("repaired JSON parses");
        assert_eq!(value["a"], 1);
        assert_eq!(value["b"], 2);
    }

    #[test]
    fn try_repair_json_gives_up_on_unfixable_input() {
        // Garbage that no targeted patch can rescue should report failure.
        assert!(try_repair_json("not json at all }").is_none());
    }

    #[test]
    fn parse_or_repair_tool_input_returns_value_for_valid_json() {
        let value = parse_or_repair_tool_input("read_file", r#"{"path":"/tmp/x"}"#)
            .expect("valid input should parse");
        assert_eq!(value["path"], "/tmp/x");
    }

    #[test]
    fn parse_or_repair_tool_input_recovers_truncated_string() {
        let value = parse_or_repair_tool_input(
            "write_file",
            r#"{"path":"/tmp/x.txt","content":"hi "#,
        )
        .expect("truncated input should be repaired");
        assert_eq!(value["path"], "/tmp/x.txt");
        assert_eq!(value["content"], "hi ");
    }

    #[tokio::test]
    async fn compact_endpoint_replaces_history_with_summary() {
        // Build a session with enough turns that compaction has something to do
        // (default preserve_recent_messages is 4). Send 5 user messages so the
        // server records 10 ConversationMessage entries (user + assistant per
        // round, with the echo provider).
        let server = TestServer::spawn().await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        for i in 0..5 {
            client
                .post(server.url(&format!("/sessions/{}/message", created.session_id)))
                .json(&super::SendMessageRequest {
                    message: format!("turn {i} payload"),
                    attachments: Vec::new(),
                })
                .send()
                .await
                .expect("send_message");
            // Wait for the turn to fully process before sending the next one;
            // otherwise the server rejects with 409 turn-in-progress.
            for _ in 0..50 {
                let details = client
                    .get(server.url(&format!("/sessions/{}", created.session_id)))
                    .send()
                    .await
                    .unwrap()
                    .json::<SessionDetailsResponse>()
                    .await
                    .unwrap();
                if details.session.messages.len() == (i + 1) * 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        let before_details = client
            .get(server.url(&format!("/sessions/{}", created.session_id)))
            .send()
            .await
            .unwrap()
            .json::<SessionDetailsResponse>()
            .await
            .unwrap();
        assert_eq!(before_details.session.messages.len(), 10);

        let resp: CompactSessionResponse = client
            .post(server.url(&format!("/sessions/{}/compact", created.session_id)))
            .send()
            .await
            .expect("compact request")
            .error_for_status()
            .expect("compact should return 200")
            .json()
            .await
            .expect("compact json");

        assert!(
            resp.removed_message_count >= 6,
            "expected at least 6 messages compacted, got {}",
            resp.removed_message_count
        );
        // Default config preserves 4 recent + the 1 summary message prepended.
        assert_eq!(resp.kept_message_count, 5);
        // Both estimates should be non-zero; we don't assert that compaction
        // shrinks the token estimate because the rule-based summary carries
        // fixed overhead (analysis/timeline/key-file lines) that may exceed the
        // size of trivially-short test messages. With realistic content it
        // does shrink — that's covered by the runtime compact_session tests.
        assert!(resp.before_tokens > 0 && resp.after_tokens > 0);

        let after_details = client
            .get(server.url(&format!("/sessions/{}", created.session_id)))
            .send()
            .await
            .unwrap()
            .json::<SessionDetailsResponse>()
            .await
            .unwrap();
        assert_eq!(after_details.session.messages.len(), 5);
        assert_eq!(
            after_details.session.messages[0].role,
            runtime::MessageRole::System,
            "summary message should land at the head of the conversation"
        );
    }

    #[test]
    fn models_endpoint_for_normalises_v1_paths() {
        use super::models_endpoint_for;
        assert_eq!(
            models_endpoint_for("https://api.openai.com/v1"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            models_endpoint_for("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            models_endpoint_for("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/models"
        );
        assert_eq!(
            models_endpoint_for("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn parse_live_models_handles_openai_shape() {
        use super::parse_live_models;
        let payload = serde_json::json!({
            "data": [
                { "id": "deepseek-chat", "object": "model" },
                { "id": "deepseek-reasoner" },
                { "missing_id": true }
            ]
        });
        let models = parse_live_models("deepseek", &payload);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "deepseek-chat");
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[1].id, "deepseek-reasoner");
        // Pricing is merged from the static table by substring ("deepseek").
        assert_eq!(models[0].input_per_million, Some(0.27));
        assert_eq!(models[0].output_per_million, Some(1.10));
    }

    #[test]
    fn parse_live_models_extracts_anthropic_context_window() {
        use super::parse_live_models;
        let payload = serde_json::json!({
            "data": [
                { "id": "claude-opus-4-7", "max_input_tokens": 1_000_000 },
                { "id": "claude-haiku-4-5", "max_input_tokens": 200_000 }
            ]
        });
        let models = parse_live_models("anthropic", &payload);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].context_window, Some(1_000_000));
        assert_eq!(models[1].context_window, Some(200_000));
    }

    fn browser_content(kind: &str, pairs: &[(&str, serde_json::Value)]) -> runtime::McpToolCallContent {
        runtime::McpToolCallContent {
            kind: kind.to_string(),
            data: pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect(),
        }
    }

    #[test]
    fn extracts_browser_screenshot_as_data_url() {
        use super::extract_browser_screenshot;
        let result = runtime::McpToolCallResult {
            content: vec![
                browser_content("text", &[("text", serde_json::json!("ignored"))]),
                browser_content(
                    "image",
                    &[
                        ("data", serde_json::json!("QUJD")),
                        ("mimeType", serde_json::json!("image/jpeg")),
                    ],
                ),
            ],
            structured_content: None,
            is_error: None,
            meta: None,
        };
        assert_eq!(
            extract_browser_screenshot(&result).as_deref(),
            Some("data:image/jpeg;base64,QUJD")
        );
        // No image block → None.
        let textonly = runtime::McpToolCallResult {
            content: vec![browser_content("text", &[("text", serde_json::json!("x"))])],
            structured_content: None,
            is_error: None,
            meta: None,
        };
        assert_eq!(super::extract_browser_screenshot(&textonly), None);
    }

    #[test]
    fn extracts_browser_text_and_parses_page_url() {
        use super::{extract_browser_text, parse_browser_page_url};
        let result = runtime::McpToolCallResult {
            content: vec![browser_content(
                "text",
                &[(
                    "text",
                    serde_json::json!("- Page URL: https://example.com/x\n- Page Title: Example\n- heading \"Hi\""),
                )],
            )],
            structured_content: None,
            is_error: None,
            meta: None,
        };
        let text = extract_browser_text(&result);
        assert!(text.contains("Page Title: Example"));
        assert_eq!(
            parse_browser_page_url(&text).as_deref(),
            Some("https://example.com/x")
        );
        assert_eq!(parse_browser_page_url("no url here"), None);
    }

    #[test]
    fn truncate_chars_marks_elision() {
        use super::truncate_chars;
        assert_eq!(truncate_chars("hello", 10), "hello");
        assert_eq!(truncate_chars("hello", 3), "hel\n… (truncated)");
    }

    #[tokio::test]
    async fn provider_models_live_returns_400_for_unconfigured_provider() {
        let server = TestServer::spawn().await;
        let client = Client::new();
        let response = client
            .get(server.url("/providers/openai/models/live"))
            .send()
            .await
            .expect("request");
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        let body = response.text().await.unwrap();
        assert!(body.contains("no api key configured"), "unexpected: {body}");
    }

    #[tokio::test]
    async fn provider_models_live_returns_400_for_unknown_provider() {
        let server = TestServer::spawn().await;
        let client = Client::new();
        let response = client
            .get(server.url("/providers/totally-fake/models/live"))
            .send()
            .await
            .expect("request");
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn compact_endpoint_rejects_during_turn_in_flight() {
        // Use a TurnDriver that blocks indefinitely so we can observe the 409
        // response while a turn is still considered in-flight.
        struct PendingDriver;
        impl TurnDriver for PendingDriver {
            fn run_turn(
                &self,
                _session_id: SessionId,
                _session: runtime::Session,
                _user_input: super::ConversationMessage,
                _config: super::ServerConfig,
                _creds: Option<super::ProviderCreds>,
                _prompter: Option<Box<dyn runtime::PermissionPrompter + Send>>,
                _questioner: Option<Box<dyn runtime::UserQuestioner>>,
                _observer: Option<Box<dyn runtime::TurnObserver>>,
                _mcp: Option<super::McpRuntimeBundle>,
                _live_permission_mode: std::sync::Arc<std::sync::atomic::AtomicU8>,
            ) -> Result<TurnExecution, String> {
                std::thread::sleep(Duration::from_secs(2));
                Err("never finishes in time".to_string())
            }
        }

        let server =
            TestServer::spawn_with_state(AppState::with_turn_driver(Arc::new(PendingDriver))).await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        client
            .post(server.url(&format!("/sessions/{}/message", created.session_id)))
            .json(&super::SendMessageRequest {
                message: "stuck".to_string(),
                attachments: Vec::new(),
            })
            .send()
            .await
            .expect("send");
        // Give the runtime a moment to mark the turn in-flight.
        tokio::time::sleep(Duration::from_millis(80)).await;

        let resp = client
            .post(server.url(&format!("/sessions/{}/compact", created.session_id)))
            .send()
            .await
            .expect("compact during turn");
        assert_eq!(resp.status(), reqwest::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn set_session_mcp_attached_rejects_unknown_server() {
        // Without any configured MCP server, the manual-attach endpoint must
        // refuse — otherwise the UI could poison the attached set with a
        // name that will never resolve to real tools.
        let server = TestServer::spawn().await;
        let client = Client::new();
        let created = create_session(&client, &server).await;

        let resp = client
            .post(server.url(&format!(
                "/sessions/{}/mcp/nonexistent/attached",
                created.session_id
            )))
            .json(&SetSessionMcpAttachedPayload { attached: true })
            .send()
            .await
            .expect("attach request");
        assert_eq!(resp.status(), reqwest::StatusCode::BAD_REQUEST);

        // Detach is idempotent — removing a never-attached name is a no-op,
        // not an error.
        let resp = client
            .post(server.url(&format!(
                "/sessions/{}/mcp/nonexistent/attached",
                created.session_id
            )))
            .json(&SetSessionMcpAttachedPayload { attached: false })
            .send()
            .await
            .expect("detach request")
            .error_for_status()
            .expect("detach should be a no-op success");
        let details: SessionDetailsResponse = resp.json().await.expect("details json");
        assert!(details.attached_mcps.is_empty());
    }

    #[test]
    fn read_attachment_returns_utf8_with_language_hint() {
        let tmp = std::env::temp_dir().join(format!(
            "claw-attach-{}.py",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&tmp, "def hello():\n    return 'world'\n").unwrap();
        let att = read_attachment(&AttachmentRef::File {
            path: tmp.display().to_string(),
        })
        .unwrap();
        let _ = std::fs::remove_file(&tmp);

        assert_eq!(att.path, tmp.display().to_string());
        assert_eq!(att.language, "python");
        assert!(att.content.contains("def hello():"));
    }

    #[test]
    fn read_attachment_rejects_binary_payload() {
        let tmp = std::env::temp_dir().join(format!(
            "claw-attach-bin-{}.bin",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&tmp, [0u8, 159u8, 146u8, 150u8]).unwrap();
        let err = read_attachment(&AttachmentRef::File {
            path: tmp.display().to_string(),
        })
        .err()
        .expect("binary attachment must fail");
        let _ = std::fs::remove_file(&tmp);
        let (status, _) = err;
        assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn read_attachment_recognises_png_and_returns_image_kind() {
        // A 1x1 PNG (transparent) — the smallest valid PNG with required
        // chunks. We embed the raw bytes so the test doesn't need the
        // `image` crate's encoder to produce a fixture.
        let png: [u8; 67] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
            0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R',
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0A, b'I', b'D', b'A',
            b'T', 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, b'I', b'E', b'N', b'D', 0xAE,
            0x42, 0x60, 0x82,
        ];
        let tmp = std::env::temp_dir().join(format!(
            "claw-img-{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&tmp, png).unwrap();
        let att = read_attachment(&AttachmentRef::File {
            path: tmp.display().to_string(),
        })
        .unwrap();
        let _ = std::fs::remove_file(&tmp);

        match att.kind {
            runtime::AttachmentKind::Image { media_type } => {
                assert_eq!(media_type, "image/png");
            }
            other => panic!("expected Image, got {other:?}"),
        }
        assert!(!att.content.is_empty(), "base64 content must be populated");
        // Sanity: base64 of the 1x1 PNG is well above empty.
        assert!(att.content.len() > 40, "base64 too short: {}", att.content.len());
    }

    #[test]
    fn render_attachments_picks_wider_fence_when_file_has_triple_backticks() {
        // A file that already contains ``` would close the fence
        // prematurely if we used the same width. Make sure we escalate.
        let att = runtime::MessageAttachment {
            path: "/tmp/foo.md".to_string(),
            content: "Inline:\n```\ncode\n```\nend\n".to_string(),
            language: "markdown".to_string(),
            kind: runtime::AttachmentKind::Text,
        };
        let rendered = render_attachments_for_llm(&[att]);
        assert!(
            rendered.contains("````markdown"),
            "expected 4-tick fence to escape inner ```, got: {rendered}"
        );
    }

    #[test]
    fn parse_or_repair_tool_input_error_includes_schema_hint() {
        // Garbage input fails repair; the surfaced error should namedrop the
        // tool and include its expected input_schema so the LLM can recover
        // without another exploratory call.
        let err = parse_or_repair_tool_input("read_file", "not json at all }")
            .expect_err("unrepairable input should error");
        let msg = err.to_string();
        assert!(msg.contains("invalid tool input json"));
        assert!(
            msg.contains("Expected input schema for `read_file`"),
            "missing schema hint: {msg}"
        );
    }

    #[test]
    fn session_cumulative_tokens_counts_output_plus_latest_input() {
        use runtime::{ConversationMessage, ContentBlock, TokenUsage};

        // Construct a fake session with two assistant turns. Per-turn input
        // tokens grow because the whole history is re-sent — counting them
        // all would double-count the first turn's history. Our helper keeps
        // only the largest (latest) input total, plus the sum of outputs.
        let turn = |input: u32, output: u32| ConversationMessage::assistant_with_usage(
            vec![ContentBlock::Text { text: String::new() }],
            Some(TokenUsage {
                input_tokens: input,
                output_tokens: output,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            }),
        );
        let messages = vec![
            ConversationMessage::user_text("hi".to_string()),
            turn(100, 40),  // first assistant turn
            ConversationMessage::user_text("more".to_string()),
            turn(250, 60),  // second assistant turn — input grew (full history)
        ];
        // Expected: outputs 40 + 60 = 100, plus latest input 250 = 350.
        assert_eq!(session_cumulative_tokens(&messages), 350);
    }

    #[test]
    fn session_cumulative_tokens_empty_session_returns_zero() {
        assert_eq!(session_cumulative_tokens(&[]), 0);
    }

    #[test]
    fn session_cumulative_tokens_ignores_messages_without_usage() {
        // User messages and any assistant entries that never got billed
        // (e.g. an aborted turn) should contribute nothing.
        let messages = vec![
            runtime::ConversationMessage::user_text("hello".to_string()),
            runtime::ConversationMessage::assistant(vec![runtime::ContentBlock::Text {
                text: "hi".to_string(),
            }]),
        ];
        assert_eq!(session_cumulative_tokens(&messages), 0);
    }

    #[test]
    fn decode_uploaded_text_accepts_utf8_as_text() {
        let bytes = "# Heading\n\nplain markdown body".as_bytes();
        let (text, kind) = super::decode_uploaded_text(bytes, "doc.md").expect("ok");
        assert_eq!(kind, "text");
        assert!(text.contains("Heading"));
    }

    /// Helper to peek into the `ApiError` tuple — `(StatusCode, Json<…>)`
    /// has no `Display`, so we reach into the body's `error` string.
    fn err_message(err: &(axum::http::StatusCode, axum::Json<super::ErrorResponse>)) -> &str {
        &err.1.0.error
    }

    #[test]
    fn decode_uploaded_text_rejects_non_utf8_non_pdf_with_helpful_hint() {
        // 0xFF 0xFE is the BOM for UTF-16 LE — a real failure mode users
        // hit when they save .txt from Notepad. Should error clearly,
        // not panic, and point them at the supported formats.
        let bytes: &[u8] = &[0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00];
        let err = super::decode_uploaded_text(bytes, "weird.txt").expect_err("reject");
        let msg = err_message(&err);
        assert!(
            msg.contains("UTF-8") && msg.contains("PDF"),
            "error should mention both UTF-8 and PDF as supported: {msg}"
        );
    }

    #[test]
    fn decode_uploaded_text_routes_pdf_magic_to_pdf_branch() {
        // Bytes that LOOK like a PDF (magic prefix) but aren't valid
        // should still take the PDF branch and surface a clear "failed
        // to extract" error — not silently get treated as UTF-8 garbage.
        let bytes: &[u8] = b"%PDF-1.4\n<not a real pdf>";
        let err = super::decode_uploaded_text(bytes, "fake.pdf")
            .expect_err("invalid PDF must error");
        let msg = err_message(&err);
        // Either "failed to extract" (pdf-extract surfaced an error) or
        // "no extractable text" (pdf-extract returned empty). Either is
        // acceptable — the key thing is the user sees a PDF-aware
        // message, not "isn't valid UTF-8".
        assert!(
            !msg.contains("isn't valid UTF-8"),
            "PDF magic must route to PDF branch, got: {msg}"
        );
    }
}
