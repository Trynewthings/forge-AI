//! Curated MCP server presets — the "install from preset" catalog.
//!
//! Each preset is a typed schema that the frontend renders into a form: the
//! user fills in a small number of fields (PAT, path, DSN…) and the install
//! flow templates them into the final `{command, args, env}` payload that the
//! existing `PUT /mcp/servers/{name}` endpoint already understands. The same
//! schema also declares `prerequisites` (which binaries must be present and
//! at what minimum version) so the UI can fail fast with a useful hint
//! instead of saving a broken config.
//!
//! Long term we may pull from the upstream MCP registry, but for now
//! hand-curated yields a smaller, higher-quality catalog of servers we have
//! actually verified end-to-end against this client.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One catalog entry. `id` is the stable identifier the install endpoint
/// references; `display_name` is the human label.
#[derive(Debug, Clone, Serialize)]
pub struct McpPreset {
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub homepage: Option<&'static str>,
    pub command: &'static str,
    pub args_template: Vec<&'static str>,
    /// Env keys that the preset hardcodes regardless of user input. Values
    /// in this map can contain `{{placeholder}}` tokens that get substituted
    /// from `user_inputs` whose `target == Env`. Used sparingly — most env
    /// vars come from user inputs directly.
    pub env_template: BTreeMap<&'static str, &'static str>,
    pub user_inputs: Vec<UserInput>,
    pub prerequisites: Vec<Prerequisite>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserInput {
    /// Placeholder key — `{{name}}` in args/env templates gets replaced with
    /// the user's value.
    pub name: &'static str,
    pub label: &'static str,
    pub help: Option<&'static str>,
    pub required: bool,
    pub input_type: UserInputType,
    pub target: InputTarget,
    /// For `target == Env`, the env-var name to write into. Ignored for
    /// `target == Args` (the placeholder substitution carries the value).
    pub env_key: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UserInputType {
    Text { placeholder: Option<&'static str> },
    Secret,
    Path { must_be_dir: bool, must_exist: bool },
    Url,
    Choice { options: Vec<&'static str> },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InputTarget {
    Env,
    Args,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prerequisite {
    /// Binary name to look up via `which`. Resolved against `$PATH`.
    pub binary: String,
    /// Optional minimum semver. None = just check the binary exists.
    #[serde(default)]
    pub min_version: Option<String>,
    /// CLI args that print a version string we can parse (e.g. `["--version"]`).
    /// We grep the first SemVer-shaped match out of the combined stdout+stderr.
    #[serde(default)]
    pub version_args: Vec<String>,
    pub install_hint: String,
}

/// The full hand-curated catalog. Order here is the order the UI displays
/// before user-side filtering — put the "boring stable" ones first so first
/// impressions of the catalog are not "Postgres DSN required".
pub fn catalog() -> Vec<McpPreset> {
    vec![
        // ---- no-config quick wins ----
        McpPreset {
            id: "memory",
            display_name: "Memory",
            description: "In-process knowledge graph the agent can read and write across turns.",
            category: "agent",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/memory"),
            command: "npx",
            args_template: vec!["-y", "@modelcontextprotocol/server-memory"],
            env_template: BTreeMap::new(),
            user_inputs: vec![],
            prerequisites: vec![npx_prereq()],
        },
        McpPreset {
            id: "sequentialthinking",
            display_name: "Sequential Thinking",
            description: "Structured chain-of-thought scratchpad with rewindable steps.",
            category: "agent",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking"),
            command: "npx",
            args_template: vec!["-y", "@modelcontextprotocol/server-sequentialthinking"],
            env_template: BTreeMap::new(),
            user_inputs: vec![],
            prerequisites: vec![npx_prereq()],
        },
        McpPreset {
            id: "time",
            display_name: "Time",
            description: "Current time, timezone conversion, scheduling math.",
            category: "utility",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/time"),
            command: "uvx",
            args_template: vec!["mcp-server-time"],
            env_template: BTreeMap::new(),
            user_inputs: vec![],
            prerequisites: vec![uvx_prereq()],
        },
        McpPreset {
            id: "everything",
            display_name: "Everything (test server)",
            description: "Reference server exercising every MCP feature. Useful for sanity testing.",
            category: "testing",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/everything"),
            command: "npx",
            args_template: vec!["-y", "@modelcontextprotocol/server-everything"],
            env_template: BTreeMap::new(),
            user_inputs: vec![],
            prerequisites: vec![npx_prereq()],
        },
        // ---- path / DSN configuration ----
        McpPreset {
            id: "filesystem",
            display_name: "Filesystem",
            description: "Sandboxed read/write access to a single directory tree.",
            category: "code",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem"),
            command: "npx",
            args_template: vec!["-y", "@modelcontextprotocol/server-filesystem", "{{root}}"],
            env_template: BTreeMap::new(),
            user_inputs: vec![UserInput {
                name: "root",
                label: "Root directory",
                help: Some("Absolute path. The server can only see files under this directory."),
                required: true,
                input_type: UserInputType::Path {
                    must_be_dir: true,
                    must_exist: true,
                },
                target: InputTarget::Args,
                env_key: None,
            }],
            prerequisites: vec![npx_prereq()],
        },
        McpPreset {
            id: "sqlite",
            display_name: "SQLite",
            description: "Query a local .sqlite database file.",
            category: "data",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite"),
            command: "uvx",
            args_template: vec!["mcp-server-sqlite", "--db-path", "{{db_path}}"],
            env_template: BTreeMap::new(),
            user_inputs: vec![UserInput {
                name: "db_path",
                label: "Database file path",
                help: Some("Absolute path to the .sqlite or .db file."),
                required: true,
                input_type: UserInputType::Path {
                    must_be_dir: false,
                    must_exist: true,
                },
                target: InputTarget::Args,
                env_key: None,
            }],
            prerequisites: vec![uvx_prereq()],
        },
        McpPreset {
            id: "postgres",
            display_name: "Postgres",
            description: "Read-only Postgres query tool. The connection string never leaves your machine.",
            category: "data",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/postgres"),
            command: "npx",
            args_template: vec!["-y", "@modelcontextprotocol/server-postgres", "{{dsn}}"],
            env_template: BTreeMap::new(),
            user_inputs: vec![UserInput {
                name: "dsn",
                label: "Connection string",
                help: Some("postgresql://user:pass@host:5432/dbname"),
                required: true,
                input_type: UserInputType::Url,
                target: InputTarget::Args,
                env_key: None,
            }],
            prerequisites: vec![npx_prereq()],
        },
        // ---- secret / API key ----
        McpPreset {
            id: "brave-search",
            display_name: "Brave Search",
            description: "Web search via Brave's API. Requires a free API key.",
            category: "search",
            homepage: Some("https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search"),
            command: "npx",
            args_template: vec!["-y", "@modelcontextprotocol/server-brave-search"],
            env_template: BTreeMap::new(),
            user_inputs: vec![UserInput {
                name: "api_key",
                label: "Brave API key",
                help: Some("Get a free key at brave.com/search/api/"),
                required: true,
                input_type: UserInputType::Secret,
                target: InputTarget::Env,
                env_key: Some("BRAVE_API_KEY"),
            }],
            prerequisites: vec![npx_prereq()],
        },
        McpPreset {
            id: "github-local",
            display_name: "GitHub (official, local)",
            description: "GitHub's official Go MCP server, running locally in Docker. Supersedes the deprecated Node version.",
            category: "code",
            homepage: Some("https://github.com/github/github-mcp-server"),
            command: "docker",
            args_template: vec![
                "run",
                "-i",
                "--rm",
                "-e",
                "GITHUB_PERSONAL_ACCESS_TOKEN",
                "ghcr.io/github/github-mcp-server",
            ],
            env_template: BTreeMap::new(),
            user_inputs: vec![UserInput {
                name: "token",
                label: "Personal Access Token",
                help: Some("github.com/settings/tokens — classic PAT with `repo` and `read:org` for typical use."),
                required: true,
                input_type: UserInputType::Secret,
                target: InputTarget::Env,
                env_key: Some("GITHUB_PERSONAL_ACCESS_TOKEN"),
            }],
            prerequisites: vec![docker_prereq()],
        },
        // ---- pip-installed; assumes user pre-installed the package ----
        McpPreset {
            id: "powerpoint",
            display_name: "PowerPoint (Office)",
            description: "Create and edit .pptx presentations. Install with `pip3 install office-powerpoint-mcp-server` first.",
            category: "docs",
            homepage: Some("https://github.com/GongRzhe/Office-PowerPoint-MCP-Server"),
            command: "ppt_mcp_server",
            args_template: vec![],
            env_template: BTreeMap::new(),
            user_inputs: vec![],
            prerequisites: vec![Prerequisite {
                binary: "ppt_mcp_server".to_string(),
                min_version: None,
                version_args: vec![],
                install_hint: "Run `pip3 install office-powerpoint-mcp-server`, then make sure the binary is on your PATH.".to_string(),
            }],
        },
    ]
}

fn npx_prereq() -> Prerequisite {
    // We need npx on PATH at runtime, but `npx --version` actually prints
    // npm's version. Check `node` instead — npx ships with node, and
    // version policy is keyed off node anyway (MCP needs Node >= 18).
    Prerequisite {
        binary: "node".to_string(),
        min_version: Some("18.0.0".to_string()),
        version_args: vec!["--version".to_string()],
        install_hint: "Install Node.js 18+ from nodejs.org (ships with npx).".to_string(),
    }
}

fn uvx_prereq() -> Prerequisite {
    Prerequisite {
        binary: "uvx".to_string(),
        min_version: None,
        version_args: vec!["--version".to_string()],
        install_hint: "Install uv from astral.sh/uv — it ships uvx.".to_string(),
    }
}

fn docker_prereq() -> Prerequisite {
    Prerequisite {
        binary: "docker".to_string(),
        min_version: None,
        version_args: vec!["--version".to_string()],
        install_hint: "Install Docker Desktop or `colima` and start the daemon.".to_string(),
    }
}

/// Map a launcher command (npx / uvx / docker / pip-binary) to the
/// prerequisite check we'd run for it. Used by the registry translator —
/// registry entries don't ship prereqs, but every entry has a derived
/// runtime, and we already know what to check for the common ones.
pub fn prereq_for_command(command: &str) -> Vec<Prerequisite> {
    match command {
        "npx" => vec![npx_prereq()],
        "uvx" => vec![uvx_prereq()],
        "docker" => vec![docker_prereq()],
        _ => Vec::new(),
    }
}

/// Substitute `{{name}}` placeholders in the args / env templates of a
/// preset, given a map of user-supplied values keyed by `UserInput.name`.
/// Returns the final `{command, args, env}` triple ready to hand to the
/// existing `/mcp/servers/{name}` endpoint.
///
/// Returns an error string if a required input is missing — callers should
/// have already validated, but we double-check defensively.
pub fn instantiate(
    preset: &McpPreset,
    inputs: &BTreeMap<String, String>,
) -> Result<InstantiatedPreset, String> {
    // Validate all required inputs are present.
    for input in &preset.user_inputs {
        if input.required && !inputs.contains_key(input.name) {
            return Err(format!("missing required input `{}`", input.name));
        }
    }

    // Substitute placeholders in args.
    let args: Vec<String> = preset
        .args_template
        .iter()
        .map(|tpl| substitute(tpl, inputs))
        .collect();

    // Build env: hardcoded template entries first, then user inputs whose
    // target == Env.
    let mut env: BTreeMap<String, String> = preset
        .env_template
        .iter()
        .map(|(k, v)| ((*k).to_string(), substitute(v, inputs)))
        .collect();
    for input in &preset.user_inputs {
        if !matches!(input.target, InputTarget::Env) {
            continue;
        }
        let Some(env_key) = input.env_key else {
            return Err(format!(
                "preset bug: input `{}` targets Env but has no env_key",
                input.name
            ));
        };
        if let Some(value) = inputs.get(input.name) {
            env.insert(env_key.to_string(), value.clone());
        }
    }

    Ok(InstantiatedPreset {
        command: preset.command.to_string(),
        args,
        env,
    })
}

/// Result of templating a preset against user inputs — exactly the shape
/// `PUT /mcp/servers/{name}` accepts.
#[derive(Debug, Clone, Serialize)]
pub struct InstantiatedPreset {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

pub(crate) fn substitute(template: &str, inputs: &BTreeMap<String, String>) -> String {
    // Cheap, no-regex single-pass scan for `{{key}}` tokens. Avoids pulling
    // a templating crate for ~5 substitutions per install.
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(end) = template[i + 2..].find("}}") {
                let key = &template[i + 2..i + 2 + end];
                if let Some(value) = inputs.get(key) {
                    out.push_str(value);
                } else {
                    // Leave the placeholder verbatim — surfaces the typo to
                    // the user instead of silently dropping it.
                    out.push_str(&template[i..i + 2 + end + 2]);
                }
                i += 2 + end + 2;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_non_empty_and_ids_are_unique() {
        let presets = catalog();
        assert!(presets.len() >= 8, "expected at least 8 presets");
        let mut seen = std::collections::HashSet::new();
        for preset in &presets {
            assert!(seen.insert(preset.id), "duplicate preset id `{}`", preset.id);
        }
    }

    #[test]
    fn instantiate_filesystem_substitutes_root_path() {
        let preset = catalog()
            .into_iter()
            .find(|p| p.id == "filesystem")
            .expect("filesystem preset");
        let mut inputs = BTreeMap::new();
        inputs.insert("root".to_string(), "/tmp/sandbox".to_string());

        let out = instantiate(&preset, &inputs).expect("instantiate");
        assert_eq!(out.command, "npx");
        assert_eq!(
            out.args,
            vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
                "/tmp/sandbox".to_string()
            ]
        );
        assert!(out.env.is_empty());
    }

    #[test]
    fn instantiate_github_writes_token_into_env_under_canonical_key() {
        // The user input is named `token` but it must land in the env as
        // `GITHUB_PERSONAL_ACCESS_TOKEN` — that's what the server reads.
        let preset = catalog()
            .into_iter()
            .find(|p| p.id == "github-local")
            .expect("github preset");
        let mut inputs = BTreeMap::new();
        inputs.insert("token".to_string(), "ghp_fake".to_string());

        let out = instantiate(&preset, &inputs).expect("instantiate");
        assert_eq!(
            out.env.get("GITHUB_PERSONAL_ACCESS_TOKEN").map(String::as_str),
            Some("ghp_fake")
        );
        // Token must NOT be substituted into args either — only env.
        assert!(
            !out.args.iter().any(|a| a.contains("ghp_fake")),
            "token leaked into args: {:?}",
            out.args
        );
    }

    #[test]
    fn instantiate_rejects_missing_required_input() {
        let preset = catalog()
            .into_iter()
            .find(|p| p.id == "filesystem")
            .expect("filesystem preset");
        let inputs = BTreeMap::new();
        let err = instantiate(&preset, &inputs).expect_err("must error");
        assert!(err.contains("root"), "error should name the field: {err}");
    }

    #[test]
    fn substitute_leaves_unknown_placeholders_verbatim() {
        // So typos in preset definitions are surfaced loudly, not silently
        // turned into empty strings.
        let inputs = BTreeMap::new();
        assert_eq!(substitute("hello {{missing}} world", &inputs), "hello {{missing}} world");
    }

    #[test]
    fn substitute_handles_multiple_placeholders() {
        let mut inputs = BTreeMap::new();
        inputs.insert("a".to_string(), "1".to_string());
        inputs.insert("b".to_string(), "2".to_string());
        assert_eq!(substitute("{{a}}-{{b}}-{{a}}", &inputs), "1-2-1");
    }
}
