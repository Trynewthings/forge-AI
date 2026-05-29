//! Thin client for the official MCP Registry (registry.modelcontextprotocol.io).
//!
//! Surfaces just enough of the v0.1 API to browse and install: list servers
//! (search + cursor pagination), fetch a single entry, and a 10-minute
//! in-memory cache keyed on (search, cursor). Translation from the
//! registry's JSON shape into our `McpPreset`/`InstantiatedPreset` shapes
//! lives in `registry_translate`.
//!
//! Only deserialises the fields we actually use — registry entries carry
//! plenty of optional metadata (icons, vendor `_meta` blobs, …) we don't
//! need to surface and don't want to break on when the schema rolls
//! forward.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::Mutex;

const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io";
const CACHE_TTL: Duration = Duration::from_secs(600);
const PAGE_LIMIT: u32 = 100;

// ---- registry response shapes ---------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct RegistryListResponse {
    #[serde(default)]
    pub servers: Vec<RegistryEnvelope>,
    #[serde(default)]
    pub metadata: ListMetadata,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListMetadata {
    #[serde(default, rename = "nextCursor")]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub count: u32,
}

/// The registry wraps every entry in `{ "server": {...}, "_meta": {...} }`.
/// We only need the inner server payload — the meta envelope carries
/// publish/deprecation info we surface as a status flag.
#[derive(Debug, Clone, Deserialize)]
pub struct RegistryEnvelope {
    pub server: RegistryServer,
    #[serde(default, rename = "_meta")]
    pub meta: Option<RegistryEnvelopeMeta>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegistryEnvelopeMeta {
    #[serde(default, rename = "io.modelcontextprotocol.registry/official")]
    pub official: Option<OfficialMeta>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OfficialMeta {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "isLatest")]
    pub is_latest: Option<bool>,
    #[serde(default, rename = "publishedAt")]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegistryServer {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub repository: Option<Repository>,
    /// stdio packages — what we can install today. Entries with only
    /// `remotes[]` are filtered out before reaching the frontend.
    #[serde(default)]
    pub packages: Vec<RegistryPackage>,
    /// Remote HTTP / SSE endpoints — present on entries that require
    /// Phase-3 OAuth support; we keep the field so we can detect "remote
    /// only" and skip the entry, but don't expose remotes to the UI yet.
    #[serde(default)]
    pub remotes: Vec<serde_json::Value>,
    #[serde(default, rename = "websiteUrl")]
    pub website_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Repository {
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegistryPackage {
    #[serde(rename = "registryType")]
    pub registry_type: String,
    pub identifier: String,
    #[serde(default)]
    pub version: Option<String>,
    /// e.g. "npx" / "uvx" — the launcher binary to invoke. If absent we
    /// derive a sensible default from `registry_type`.
    #[serde(default, rename = "runtimeHint")]
    pub runtime_hint: Option<String>,
    #[serde(default)]
    pub transport: Option<TransportSpec>,
    #[serde(default, rename = "runtimeArguments")]
    pub runtime_arguments: Vec<RegistryArgument>,
    #[serde(default, rename = "packageArguments")]
    pub package_arguments: Vec<RegistryArgument>,
    #[serde(default, rename = "environmentVariables")]
    pub environment_variables: Vec<RegistryEnvVar>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransportSpec {
    #[serde(rename = "type", default)]
    pub kind: String,
}

/// Both `runtimeArguments` and `packageArguments` share this shape.
/// `type` is "positional" or "named" — positional args go on the command
/// line as-is (or with `value` substituted from user input); named ones
/// are flags like `--db-path <value>`.
#[derive(Debug, Clone, Deserialize)]
pub struct RegistryArgument {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default, rename = "isRequired")]
    pub is_required: Option<bool>,
    #[serde(default, rename = "isSecret")]
    pub is_secret: Option<bool>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub choices: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegistryEnvVar {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "isRequired")]
    pub is_required: Option<bool>,
    #[serde(default, rename = "isSecret")]
    pub is_secret: Option<bool>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub choices: Vec<String>,
}

// ---- client + cache --------------------------------------------------------

#[derive(Debug, Clone, Eq, Hash, PartialEq)]
struct CacheKey {
    search: String,
    cursor: String,
}

struct CacheEntry {
    fetched_at: Instant,
    response: RegistryListResponse,
}

#[derive(Clone)]
pub struct RegistryClient {
    http: reqwest::Client,
    cache: Arc<Mutex<HashMap<CacheKey, CacheEntry>>>,
}

impl RegistryClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// List servers with optional name-substring search and cursor.
    /// Cached for `CACHE_TTL` per (search, cursor); the freshness wins —
    /// concurrent callers hitting the same key block on the same lock but
    /// still issue at most one upstream request.
    pub async fn list_servers(
        &self,
        search: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<RegistryListResponse, RegistryError> {
        let key = CacheKey {
            search: search.unwrap_or("").to_string(),
            cursor: cursor.unwrap_or("").to_string(),
        };
        {
            let cache = self.cache.lock().await;
            if let Some(entry) = cache.get(&key) {
                if entry.fetched_at.elapsed() < CACHE_TTL {
                    return Ok(entry.response.clone());
                }
            }
        }
        let response = self.fetch_servers_uncached(search, cursor).await?;
        {
            let mut cache = self.cache.lock().await;
            cache.insert(
                key,
                CacheEntry {
                    fetched_at: Instant::now(),
                    response: response.clone(),
                },
            );
        }
        Ok(response)
    }

    async fn fetch_servers_uncached(
        &self,
        search: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<RegistryListResponse, RegistryError> {
        // Always force `version=latest` so we don't see N rows for the same
        // server across its release history.
        let mut url = format!(
            "{REGISTRY_BASE}/v0.1/servers?version=latest&limit={PAGE_LIMIT}",
        );
        if let Some(q) = search.filter(|s| !s.is_empty()) {
            url.push_str(&format!(
                "&search={}",
                urlencoding::encode_lite(q),
            ));
        }
        if let Some(c) = cursor.filter(|s| !s.is_empty()) {
            url.push_str(&format!(
                "&cursor={}",
                urlencoding::encode_lite(c),
            ));
        }

        let response = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(RegistryError::Http)?;
        if !response.status().is_success() {
            return Err(RegistryError::Status {
                status: response.status().as_u16(),
                url,
            });
        }
        response.json::<RegistryListResponse>().await.map_err(RegistryError::Http)
    }

    /// Fetch a single server at the latest version — used by the install
    /// endpoint to re-verify the entry rather than trusting whatever the
    /// frontend sends (cheap protection against a stale or tampered
    /// client-side cache).
    pub async fn fetch_server(
        &self,
        name: &str,
    ) -> Result<RegistryServer, RegistryError> {
        // Cursor pagination + name search is the only way to look up an
        // entry by full name — the registry's "?search=" is substring on
        // name and works for unique reverse-DNS slugs. We then exact-match
        // client-side because substring may return multiple hits.
        let response = self.list_servers(Some(name), None).await?;
        response
            .servers
            .into_iter()
            .find(|env| env.server.name == name)
            .map(|env| env.server)
            .ok_or_else(|| RegistryError::NotFound { name: name.to_string() })
    }
}

impl Default for RegistryClient {
    fn default() -> Self {
        Self::new()
    }
}

// ---- errors ----------------------------------------------------------------

#[derive(Debug)]
pub enum RegistryError {
    Http(reqwest::Error),
    Status { status: u16, url: String },
    NotFound { name: String },
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(e) => write!(f, "registry request failed: {e}"),
            Self::Status { status, url } => {
                write!(f, "registry returned HTTP {status} for {url}")
            }
            Self::NotFound { name } => write!(f, "registry entry `{name}` not found"),
        }
    }
}

impl std::error::Error for RegistryError {}

// ---- minimal urlencoding (no extra crate) ---------------------------------

/// `urlencoding` crate avoidance — we only encode query values, which need
/// `%XX` for non-alphanumeric ASCII. Slashes in reverse-DNS names ("/")
/// must be encoded; spaces too. Good enough for our query params.
mod urlencoding {
    pub fn encode_lite(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for b in input.bytes() {
            let safe = b.is_ascii_alphanumeric()
                || b == b'-'
                || b == b'_'
                || b == b'.'
                || b == b'~';
            if safe {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_handles_slashes_and_spaces() {
        assert_eq!(urlencoding::encode_lite("io.github.foo/bar"), "io.github.foo%2Fbar");
        assert_eq!(urlencoding::encode_lite("hello world"), "hello%20world");
        assert_eq!(urlencoding::encode_lite("plain-name_v1.0"), "plain-name_v1.0");
    }

    #[test]
    fn deserialises_real_registry_entry_shape() {
        // Trimmed snapshot of the actual /v0.1/servers response for the
        // com.pulsemcp/slack entry — the test catches regressions if a
        // field rename slips through schema versioning.
        let raw = r#"{
            "servers": [{
                "server": {
                    "name": "com.pulsemcp/slack",
                    "title": "Slack",
                    "description": "Slack workspace MCP",
                    "version": "0.0.6",
                    "repository": {"url": "https://github.com/pulsemcp/mcp-servers", "source": "github"},
                    "packages": [{
                        "registryType": "npm",
                        "identifier": "slack-workspace-mcp-server",
                        "version": "0.0.6",
                        "runtimeHint": "npx",
                        "transport": {"type": "stdio"},
                        "runtimeArguments": [{"value": "-y", "type": "positional"}],
                        "environmentVariables": [
                            {"name": "SLACK_BOT_TOKEN", "description": "Bot token", "isRequired": true, "isSecret": true},
                            {"name": "ENABLED_TOOLGROUPS", "description": "comma list"}
                        ]
                    }]
                },
                "_meta": {
                    "io.modelcontextprotocol.registry/official": {
                        "status": "active",
                        "isLatest": true,
                        "publishedAt": "2026-05-15T18:18:20Z"
                    }
                }
            }],
            "metadata": {"nextCursor": "next:cursor", "count": 1}
        }"#;
        let parsed: RegistryListResponse =
            serde_json::from_str(raw).expect("parse registry shape");
        assert_eq!(parsed.servers.len(), 1);
        let s = &parsed.servers[0].server;
        assert_eq!(s.name, "com.pulsemcp/slack");
        assert_eq!(s.packages.len(), 1);
        let pkg = &s.packages[0];
        assert_eq!(pkg.registry_type, "npm");
        assert_eq!(pkg.runtime_hint.as_deref(), Some("npx"));
        assert_eq!(pkg.environment_variables.len(), 2);
        assert_eq!(pkg.environment_variables[0].is_secret, Some(true));
        assert_eq!(parsed.metadata.next_cursor.as_deref(), Some("next:cursor"));
    }

    #[test]
    fn ignores_extra_fields_for_forward_compat() {
        // Older entries have $schema, icons[], publisher _meta blobs. We
        // ignore them silently so registry schema changes don't break us
        // until something we actually consume changes.
        let raw = r#"{
            "servers": [{
                "server": {
                    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
                    "name": "io.example/foo",
                    "icons": [{"src": "https://example.com/i.png"}],
                    "packages": []
                },
                "_meta": {}
            }]
        }"#;
        let parsed: RegistryListResponse =
            serde_json::from_str(raw).expect("forward-compat parse");
        assert_eq!(parsed.servers[0].server.name, "io.example/foo");
    }
}
