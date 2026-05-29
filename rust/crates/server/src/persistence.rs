//! Optional on-disk persistence for the server's mutable state.
//!
//! Activated by setting `CLAW_SERVER_STATE_PATH=/some/file.json` on the binary.
//! When unset, the server runs purely in memory and restarts wipe state.
//!
//! The on-disk file holds the `ServerConfig` and provider credentials. It is
//! written atomically (write to `.tmp` next to the target, then rename) and
//! restricted to mode `0600` on Unix so API keys aren't world-readable.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

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
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temp_path = temp_path_for(path);
    let json = serde_json::to_string_pretty(state)?;
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&temp_path)?;
        handle.write_all(json.as_bytes())?;
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
        std::env::temp_dir().join(format!("claw-persist-{name}-{}-{nanos}-{seq}", std::process::id()))
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
}
