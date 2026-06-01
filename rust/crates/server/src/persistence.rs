//! Optional on-disk persistence for the server's mutable state.
//!
//! Activated by setting `CLAW_SERVER_STATE_PATH=/some/file.json` on the binary.
//! When unset, the server runs purely in memory and restarts wipe state.
//!
//! The on-disk file holds the `ServerConfig` and provider credentials. It is
//! written atomically (write to `.tmp` next to the target, then rename) and
//! restricted to mode `0600` on Unix so API keys aren't world-readable.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use runtime::Session as RuntimeSession;
use serde::{Deserialize, Serialize};

use crate::{ProviderCreds, ServerConfig};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedState {
    #[serde(default)]
    pub config: ServerConfig,
    #[serde(default)]
    pub providers: HashMap<String, ProviderCredsRecord>,
    #[serde(default)]
    pub mcp_servers: HashMap<String, McpServerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerRecord {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Whether the server should be spawned at startup and routed to for
    /// tool calls. Defaults to `true` so existing on-disk state files (which
    /// never wrote this field) keep working as before.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCredsRecord {
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

impl From<ProviderCreds> for ProviderCredsRecord {
    fn from(value: ProviderCreds) -> Self {
        Self {
            api_key: value.api_key,
            base_url: value.base_url,
        }
    }
}

impl From<ProviderCredsRecord> for ProviderCreds {
    fn from(value: ProviderCredsRecord) -> Self {
        Self {
            api_key: value.api_key,
            base_url: value.base_url,
        }
    }
}

#[derive(Debug)]
pub enum PersistError {
    Io(io::Error),
    Format(serde_json::Error),
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Format(error) => write!(f, "json error: {error}"),
        }
    }
}

impl std::error::Error for PersistError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Format(error) => Some(error),
        }
    }
}

impl From<io::Error> for PersistError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for PersistError {
    fn from(value: serde_json::Error) -> Self {
        Self::Format(value)
    }
}

/// Read the state file at `path`. Returns `Ok(None)` if the file is missing.
pub fn load(path: &Path) -> Result<Option<PersistedState>, PersistError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Write `state` to `path` atomically. On Unix the resulting file is `0600`.
pub fn save(path: &Path, state: &PersistedState) -> Result<(), PersistError> {
    let json = serde_json::to_string_pretty(state)?;
    write_atomic(path, json.as_bytes())
}

/// Write `bytes` to `path` atomically (temp file + rename). On Unix the
/// resulting file is `0600` so API keys / transcripts aren't world-readable.
/// Shared by `save` (whole-server state) and `save_session` (per-session).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), PersistError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temp_path = temp_path_for(path);
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&temp_path)?;
        handle.write_all(bytes)?;
        handle.sync_all()?;
    }
    fs::rename(&temp_path, path)?;
    Ok(())
}

fn temp_path_for(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "claw-server-state".to_string());
    name.push_str(".tmp");
    path.with_file_name(name)
}

// ─────────────────────────── per-session persistence ───────────────────────
//
// Conversations live as one JSON file each under `sessions_dir(state_path)`
// (default `~/.claw/sessions/`) rather than inside `state.json`. Keeping them
// separate means a config/key change doesn't rewrite the whole transcript
// history, one session can be saved/deleted in isolation, and a single
// corrupt file can't take down the rest of the sidebar on load.

/// One persisted chat session. Mirrors the in-memory `server::Session` minus
/// the non-serializable runtime bits (broadcast channel, turn handle, cancel
/// flag), which are recreated when the session is restored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedSession {
    pub id: String,
    pub created_at: u64,
    pub conversation: RuntimeSession,
    #[serde(default)]
    pub attached_mcps: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attached_library: Option<String>,
}

/// Directory holding per-session files, derived from the state file path as
/// `<state_dir>/sessions/`. Co-locating with `state.json` keeps all persisted
/// server data under one root.
#[must_use]
pub fn sessions_dir(state_path: &Path) -> PathBuf {
    match state_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => dir.join("sessions"),
        None => PathBuf::from("sessions"),
    }
}

fn session_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Atomically write one session to `<dir>/<id>.json` (Unix mode 0600).
pub fn save_session(dir: &Path, session: &PersistedSession) -> Result<(), PersistError> {
    let json = serde_json::to_string_pretty(session)?;
    write_atomic(&session_file(dir, &session.id), json.as_bytes())
}

/// Remove one session's file. A missing file is treated as success so a
/// double-delete (or deleting a never-persisted empty session) is harmless.
pub fn delete_session(dir: &Path, id: &str) -> Result<(), PersistError> {
    match fs::remove_file(session_file(dir, id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Load every `*.json` session file from `dir`. Returns an empty vec when the
/// directory doesn't exist yet. Files that fail to read or parse are skipped
/// (with a warning) rather than aborting — one corrupt session must not wipe
/// the rest of the restored history.
#[must_use]
pub fn load_sessions(dir: &Path) -> Vec<PersistedSession> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read_to_string(&path)
            .map_err(PersistError::from)
            .and_then(|text| serde_json::from_str::<PersistedSession>(&text).map_err(Into::into))
        {
            Ok(session) => sessions.push(session),
            Err(error) => tracing::warn!(?path, %error, "skipping unreadable session file"),
        }
    }
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "claw-persist-{name}-{}-{nanos}-{seq}",
            std::process::id()
        ))
    }

    #[test]
    fn load_missing_file_returns_none() {
        let path = tmp_path("missing");
        assert!(load(&path).expect("load").is_none());
    }

    #[test]
    fn save_and_load_round_trip() {
        let path = tmp_path("roundtrip");
        let mut providers = HashMap::new();
        providers.insert(
            "deepseek".to_string(),
            ProviderCredsRecord {
                api_key: "sk-xyz".to_string(),
                base_url: Some("https://example.test".to_string()),
            },
        );
        let original = PersistedState {
            config: ServerConfig {
                permission_mode: "read-only".to_string(),
                model: Some("deepseek".to_string()),
                workspace_root: None,
                max_tool_iterations_per_turn: 50,
                max_session_tokens: None,
                embedding_provider: None,
                web_fetch_summarizer: None,
                session_summarizer: None,
            },
            providers,
            mcp_servers: HashMap::new(),
        };
        save(&path, &original).expect("save");
        let read = load(&path).expect("load").expect("present");
        assert_eq!(read, original);
        let _ = fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn save_writes_with_0600_mode() {
        use std::os::unix::fs::PermissionsExt;
        let path = tmp_path("mode");
        save(&path, &PersistedState::default()).expect("save");
        let mode = fs::metadata(&path).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600 perms, got {mode:o}");
        let _ = fs::remove_file(&path);
    }

    fn sample_session(id: &str, created_at: u64) -> PersistedSession {
        PersistedSession {
            id: id.to_string(),
            created_at,
            conversation: RuntimeSession::new(),
            attached_mcps: BTreeSet::new(),
            attached_library: None,
        }
    }

    #[test]
    fn sessions_dir_is_sibling_of_state_file() {
        assert_eq!(
            sessions_dir(Path::new("/home/u/.claw/state.json")),
            PathBuf::from("/home/u/.claw/sessions"),
        );
        // Bare filename (no parent) falls back to a relative `sessions/`.
        assert_eq!(sessions_dir(Path::new("state.json")), PathBuf::from("sessions"));
    }

    #[test]
    fn session_save_load_delete_round_trip() {
        let dir = tmp_path("sessions");
        let mut s1 = sample_session("session-1", 100);
        s1.attached_mcps.insert("fs".to_string());
        s1.attached_mcps.insert("git".to_string());
        s1.attached_library = Some("docs".to_string());
        let s2 = sample_session("session-2", 200);

        save_session(&dir, &s1).expect("save s1");
        save_session(&dir, &s2).expect("save s2");

        let mut loaded = load_sessions(&dir);
        loaded.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(loaded, vec![s1, s2.clone()]);

        delete_session(&dir, "session-1").expect("delete s1");
        assert_eq!(load_sessions(&dir), vec![s2]);

        // Deleting a missing file is a no-op, not an error.
        delete_session(&dir, "session-1").expect("double delete is ok");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_sessions_missing_dir_is_empty() {
        let dir = tmp_path("absent-sessions");
        assert!(load_sessions(&dir).is_empty());
    }

    #[test]
    fn load_sessions_skips_corrupt_files() {
        let dir = tmp_path("corrupt-sessions");
        save_session(&dir, &sample_session("session-1", 1)).expect("save good");
        fs::write(dir.join("session-2.json"), b"{ not valid json").expect("write junk");
        // The good session loads; the corrupt one is skipped, not fatal.
        let loaded = load_sessions(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "session-1");
        let _ = fs::remove_dir_all(&dir);
    }
}
