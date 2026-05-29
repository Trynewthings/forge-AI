//! Translate a registry server entry into shapes our existing UI consumes.
//!
//! Two outputs per entry:
//!
//! 1. **Listing entry** — what the catalog UI renders. Display info plus a
//!    typed `user_inputs` schema so the existing install-form component
//!    renders identically for hardcoded presets and registry entries.
//!
//! 2. **Instantiable triple** — the `{command, args, env}` we hand to
//!    `put_mcp_server`. Built at install time from the user's filled-in
//!    inputs, with `{{name}}` substitution shared with the static preset
//!    instantiator.
//!
//! Entries without a stdio package (remote-only) are filtered out here —
//! we keep them in `RegistryServer.remotes` for future Phase-3 OAuth
//! support but they're invisible to the current catalog.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::presets::{self, Prerequisite};
use crate::registry::{RegistryArgument, RegistryEnvVar, RegistryPackage, RegistryServer};

/// What the `/mcp/registry` endpoint returns per entry. JSON shape is kept
/// compatible with the frontend's `McpPreset` interface so the install
/// form component renders both sources identically.
#[derive(Debug, Clone, Serialize)]
pub struct RegistryListingEntry {
    /// Stable identifier — reverse-DNS name like `com.pulsemcp/slack`. The
    /// frontend echoes this back on install to identify which entry to
    /// re-fetch (we never trust client-side schema).
    pub registry_name: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub homepage: Option<String>,
    /// The launcher binary the frontend's prereq UI shows ("npx" / "uvx" /
    /// "docker"). Distinct from `command` because for registry entries we
    /// derive command at install time, not list time — but we want the
    /// chip in the catalog to say which runtime you'll need.
    pub command_hint: String,
    /// User-fillable fields, same shape as `presets::UserInput`.
    pub user_inputs: Vec<OwnedUserInput>,
    /// Whether the entry's flagged active / deprecated by the registry.
    pub status: Option<String>,
    /// Derived from `command_hint` — npx → node, uvx → uvx, docker →
    /// docker. The frontend reuses the same prereq-check UI as for static
    /// presets.
    pub prerequisites: Vec<Prerequisite>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OwnedUserInput {
    pub name: String,
    pub label: String,
    pub help: Option<String>,
    pub required: bool,
    pub input_type: OwnedUserInputType,
    pub target: OwnedInputTarget,
    pub env_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwnedUserInputType {
    Text { placeholder: Option<String> },
    Secret,
    Path { must_be_dir: bool, must_exist: bool },
    Url,
    Choice { options: Vec<String> },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnedInputTarget {
    Env,
    Args,
}

/// Translate a registry server into a listing entry. Returns `None` for
/// remote-only entries — those need OAuth (Phase 3) we don't implement.
pub fn to_listing(server: &RegistryServer) -> Option<RegistryListingEntry> {
    let pkg = first_stdio_package(server)?;
    let command_hint = derive_command(pkg);
    let user_inputs = collect_user_inputs(pkg);

    let display_name = server
        .title
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(server.name.as_str())
        .to_string();
    let description = server
        .description
        .as_deref()
        .unwrap_or("(no description)")
        .to_string();
    let homepage = server
        .repository
        .as_ref()
        .and_then(|r| r.url.clone())
        .or_else(|| server.website_url.clone());

    let prerequisites = presets::prereq_for_command(&command_hint);
    Some(RegistryListingEntry {
        registry_name: server.name.clone(),
        version: server.version.clone().unwrap_or_default(),
        display_name,
        description,
        category: namespace_category(&server.name),
        homepage,
        command_hint,
        user_inputs,
        status: None,
        prerequisites,
    })
}

/// Build a `(command, args_template, env_template, user_inputs)` quadruple
/// suitable for substitution. Args templates contain `{{name}}` tokens
/// referencing items in `user_inputs`.
pub fn to_instantiable(server: &RegistryServer) -> Option<InstantiableEntry> {
    let pkg = first_stdio_package(server)?;
    let command = derive_command(pkg).to_string();
    let identifier_args = identifier_args_for(pkg);

    let mut args_template: Vec<String> = Vec::new();
    args_template.extend(args_from_registry(&pkg.runtime_arguments));
    args_template.extend(identifier_args);
    args_template.extend(args_from_registry(&pkg.package_arguments));

    let env_template = env_from_registry(&pkg.environment_variables);

    let user_inputs = collect_user_inputs(pkg);

    Some(InstantiableEntry {
        command,
        args_template,
        env_template,
        user_inputs,
    })
}

/// Owned mirror of `presets::InstantiatedPreset` use-case — what install
/// produces after substitution.
pub struct InstantiableEntry {
    pub command: String,
    pub args_template: Vec<String>,
    pub env_template: BTreeMap<String, String>,
    pub user_inputs: Vec<OwnedUserInput>,
}

impl InstantiableEntry {
    /// Validate and substitute `{{name}}` placeholders. Mirror of
    /// `presets::instantiate` for owned-string data.
    pub fn instantiate(
        &self,
        inputs: &BTreeMap<String, String>,
    ) -> Result<presets::InstantiatedPreset, String> {
        for input in &self.user_inputs {
            if input.required && !inputs.contains_key(&input.name) {
                return Err(format!("missing required input `{}`", input.name));
            }
        }
        let args: Vec<String> = self
            .args_template
            .iter()
            .map(|tpl| presets::substitute(tpl, inputs))
            .collect();
        let mut env: BTreeMap<String, String> = self
            .env_template
            .iter()
            .map(|(k, v)| (k.clone(), presets::substitute(v, inputs)))
            .collect();
        for input in &self.user_inputs {
            if !matches!(input.target, OwnedInputTarget::Env) {
                continue;
            }
            let Some(env_key) = input.env_key.as_ref() else {
                return Err(format!(
                    "registry input `{}` targets env without a key",
                    input.name
                ));
            };
            if let Some(value) = inputs.get(&input.name) {
                env.insert(env_key.clone(), value.clone());
            }
        }
        Ok(presets::InstantiatedPreset {
            command: self.command.clone(),
            args,
            env,
        })
    }
}

// ---- helpers ---------------------------------------------------------------

fn first_stdio_package(server: &RegistryServer) -> Option<&RegistryPackage> {
    server.packages.iter().find(|p| {
        // No transport field is fine — older entries omit it and we treat
        // them as stdio (the registry's default for `packages[]`).
        match p.transport.as_ref() {
            None => true,
            Some(t) => t.kind.is_empty() || t.kind == "stdio",
        }
    })
}

fn derive_command(pkg: &RegistryPackage) -> String {
    // Explicit runtimeHint wins. Otherwise fall back to a sensible default
    // per package registry — npm and pypi packages run via npx/uvx in the
    // overwhelming majority of cases; oci is docker; mcpb is treated as
    // an opaque local binary path (rare; caller must override).
    if let Some(hint) = pkg.runtime_hint.as_deref() {
        if !hint.is_empty() {
            return hint.to_string();
        }
    }
    match pkg.registry_type.as_str() {
        "npm" => "npx".to_string(),
        "pypi" => "uvx".to_string(),
        "oci" => "docker".to_string(),
        other => other.to_string(),
    }
}

/// What goes between `runtimeArguments` and `packageArguments`. For npm we
/// want `-y` (already in runtimeArguments by convention) and then the
/// identifier; for docker we want the image name; for uvx we want
/// `--from <pkg>` then the entrypoint (handled by user_inputs if needed).
fn identifier_args_for(pkg: &RegistryPackage) -> Vec<String> {
    match pkg.registry_type.as_str() {
        "npm" => vec![pkg.identifier.clone()],
        "pypi" => vec![pkg.identifier.clone()],
        "oci" => {
            // Default docker invocation: run -i --rm <image>. If the
            // registry entry already supplies runtimeArguments overriding
            // this, that'll appear before our default — and `docker run`
            // accepts repeated/overriding flags fine.
            vec!["run".into(), "-i".into(), "--rm".into(), pkg.identifier.clone()]
        }
        _ => vec![pkg.identifier.clone()],
    }
}

/// Walk registry args and produce template strings with `{{name}}`
/// placeholders for inputs the user must fill, or the literal `value` for
/// fixed args. Named args produce `--name {{value}}` pairs.
fn args_from_registry(args: &[RegistryArgument]) -> Vec<String> {
    let mut out = Vec::new();
    for arg in args {
        match arg.kind.as_str() {
            "named" => {
                let Some(flag_name) = arg.name.as_deref() else {
                    continue;
                };
                out.push(format!("--{flag_name}"));
                out.push(value_or_placeholder(arg));
            }
            _ => {
                // positional or unspecified
                out.push(value_or_placeholder(arg));
            }
        }
    }
    out
}

fn value_or_placeholder(arg: &RegistryArgument) -> String {
    // Fixed value beats anything else — registry uses this for flags like
    // `-y` where there's nothing for the user to fill.
    if let Some(v) = arg.value.as_deref().filter(|s| !s.is_empty()) {
        return v.to_string();
    }
    // Default-with-no-user-input is also fixed.
    if arg.is_required.unwrap_or(false) {
        // User must fill — emit a placeholder keyed by the arg name (or
        // a synthetic name based on the description if the arg lacks one).
        let key = arg
            .name
            .clone()
            .or_else(|| arg.description.clone())
            .unwrap_or_else(|| "arg".to_string());
        return format!("{{{{{}}}}}", sanitize_input_key(&key));
    }
    arg.default.clone().unwrap_or_default()
}

/// Env values are fixed only when registered with a non-templated default;
/// user-required ones use the substitution path so `{{key}}` resolves at
/// install time.
fn env_from_registry(vars: &[RegistryEnvVar]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for v in vars {
        if !v.is_required.unwrap_or(false) {
            if let Some(default) = v.default.as_deref().filter(|s| !s.is_empty()) {
                out.insert(v.name.clone(), default.to_string());
            }
        }
        // Required vars are written into env by `InstantiableEntry::instantiate`
        // via the env_key on the matching user_input — not via env_template.
    }
    out
}

/// Build the user_inputs list from both env vars and typed args. Env vars
/// target Env (with the registry's name as env_key); args target Args with
/// a placeholder that matches what `args_from_registry` emitted.
fn collect_user_inputs(pkg: &RegistryPackage) -> Vec<OwnedUserInput> {
    let mut out = Vec::new();
    for v in &pkg.environment_variables {
        if !v.is_required.unwrap_or(false) {
            continue;
        }
        out.push(OwnedUserInput {
            name: sanitize_input_key(&v.name),
            label: v.name.clone(),
            help: v.description.clone(),
            required: true,
            input_type: if v.is_secret.unwrap_or(false) {
                OwnedUserInputType::Secret
            } else if !v.choices.is_empty() {
                OwnedUserInputType::Choice {
                    options: v.choices.clone(),
                }
            } else {
                OwnedUserInputType::Text { placeholder: None }
            },
            target: OwnedInputTarget::Env,
            env_key: Some(v.name.clone()),
        });
    }
    // Same for typed args — only emit if isRequired and no fixed value.
    for arg in pkg.runtime_arguments.iter().chain(pkg.package_arguments.iter()) {
        if !arg.is_required.unwrap_or(false) {
            continue;
        }
        if arg.value.is_some() {
            // Fixed value — nothing for user to fill.
            continue;
        }
        let raw_key = arg
            .name
            .clone()
            .or_else(|| arg.description.clone())
            .unwrap_or_else(|| "arg".to_string());
        let key = sanitize_input_key(&raw_key);
        let label = arg.description.clone().unwrap_or_else(|| raw_key.clone());
        let input_type = match arg.format.as_deref() {
            Some("filepath") => OwnedUserInputType::Path {
                must_be_dir: false,
                must_exist: false,
            },
            _ if !arg.choices.is_empty() => OwnedUserInputType::Choice {
                options: arg.choices.clone(),
            },
            _ if arg.is_secret.unwrap_or(false) => OwnedUserInputType::Secret,
            _ => OwnedUserInputType::Text {
                placeholder: arg.placeholder.clone(),
            },
        };
        out.push(OwnedUserInput {
            name: key,
            label,
            help: arg.description.clone(),
            required: true,
            input_type,
            target: OwnedInputTarget::Args,
            env_key: None,
        });
    }
    out
}

/// Reverse-DNS-style names look like `io.github.foo/bar`. We use the
/// top-level slug ("io.github" / "com.pulsemcp" / etc.) as a rough
/// category badge so the catalog isn't a sea of identical-looking entries.
fn namespace_category(name: &str) -> String {
    name.split('.')
        .next()
        .map(|s| s.split('/').next().unwrap_or(s).to_string())
        .unwrap_or_else(|| "registry".to_string())
}

/// Placeholder keys (the `{{name}}` in templates) must be valid identifiers
/// for substitution. Env var names use SCREAMING_SNAKE which works fine;
/// descriptions might contain spaces or symbols — flatten to snake_case.
fn sanitize_input_key(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_underscore = true;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        "input".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{Repository, TransportSpec};

    fn make_pkg_npm_slack() -> RegistryPackage {
        RegistryPackage {
            registry_type: "npm".into(),
            identifier: "slack-workspace-mcp-server".into(),
            version: Some("0.0.6".into()),
            runtime_hint: Some("npx".into()),
            transport: Some(TransportSpec { kind: "stdio".into() }),
            runtime_arguments: vec![RegistryArgument {
                kind: "positional".into(),
                value: Some("-y".into()),
                name: None,
                default: None,
                is_required: None,
                is_secret: None,
                description: None,
                placeholder: None,
                format: None,
                choices: vec![],
            }],
            package_arguments: vec![],
            environment_variables: vec![
                RegistryEnvVar {
                    name: "SLACK_BOT_TOKEN".into(),
                    description: Some("Slack OAuth token".into()),
                    is_required: Some(true),
                    is_secret: Some(true),
                    default: None,
                    choices: vec![],
                },
                RegistryEnvVar {
                    name: "ENABLED_TOOLGROUPS".into(),
                    description: Some("comma list".into()),
                    is_required: None,
                    is_secret: None,
                    default: None,
                    choices: vec![],
                },
            ],
        }
    }

    fn server_with_packages(name: &str, packages: Vec<RegistryPackage>) -> RegistryServer {
        RegistryServer {
            name: name.into(),
            title: Some("Title".into()),
            description: Some("Description".into()),
            version: Some("1.2.3".into()),
            repository: Some(Repository {
                url: Some("https://example.com".into()),
            }),
            packages,
            remotes: vec![],
            website_url: None,
        }
    }

    #[test]
    fn npm_with_secret_env_translates_for_listing() {
        let server = server_with_packages("com.pulsemcp/slack", vec![make_pkg_npm_slack()]);
        let entry = to_listing(&server).expect("listing");
        assert_eq!(entry.registry_name, "com.pulsemcp/slack");
        assert_eq!(entry.command_hint, "npx");
        // Only the *required* env var should surface as an input.
        assert_eq!(entry.user_inputs.len(), 1);
        let inp = &entry.user_inputs[0];
        assert_eq!(inp.env_key.as_deref(), Some("SLACK_BOT_TOKEN"));
        assert!(matches!(inp.input_type, OwnedUserInputType::Secret));
        assert!(matches!(inp.target, OwnedInputTarget::Env));
    }

    #[test]
    fn npm_instantiable_writes_token_to_env_under_canonical_name() {
        let server = server_with_packages("com.pulsemcp/slack", vec![make_pkg_npm_slack()]);
        let inst = to_instantiable(&server).expect("instantiable");
        let mut inputs = BTreeMap::new();
        inputs.insert("slack_bot_token".to_string(), "xoxb-fake".to_string());
        let result = inst.instantiate(&inputs).expect("instantiate");
        assert_eq!(result.command, "npx");
        // Args: -y then identifier (no packageArguments)
        assert_eq!(
            result.args,
            vec![
                "-y".to_string(),
                "slack-workspace-mcp-server".to_string(),
            ]
        );
        // Token went into env with the registry's canonical name.
        assert_eq!(
            result.env.get("SLACK_BOT_TOKEN").map(String::as_str),
            Some("xoxb-fake")
        );
        // Token must NOT have leaked into args.
        assert!(!result.args.iter().any(|a| a.contains("xoxb-fake")));
    }

    #[test]
    fn pypi_default_runtime_is_uvx() {
        let pkg = RegistryPackage {
            registry_type: "pypi".into(),
            identifier: "some-pypi-mcp".into(),
            version: Some("1.0".into()),
            runtime_hint: None, // no hint — must default to uvx for pypi
            transport: None,
            runtime_arguments: vec![],
            package_arguments: vec![],
            environment_variables: vec![],
        };
        let server = server_with_packages("io.example/foo", vec![pkg]);
        let inst = to_instantiable(&server).expect("instantiable");
        assert_eq!(inst.command, "uvx");
        assert_eq!(inst.args_template, vec!["some-pypi-mcp".to_string()]);
    }

    #[test]
    fn oci_uses_docker_run() {
        let pkg = RegistryPackage {
            registry_type: "oci".into(),
            identifier: "ghcr.io/example/server:latest".into(),
            version: Some("1.0".into()),
            runtime_hint: None,
            transport: None,
            runtime_arguments: vec![],
            package_arguments: vec![],
            environment_variables: vec![],
        };
        let server = server_with_packages("io.example/docker", vec![pkg]);
        let inst = to_instantiable(&server).expect("instantiable");
        assert_eq!(inst.command, "docker");
        assert_eq!(
            inst.args_template,
            vec![
                "run".to_string(),
                "-i".to_string(),
                "--rm".to_string(),
                "ghcr.io/example/server:latest".to_string(),
            ]
        );
    }

    #[test]
    fn remote_only_entry_translates_to_none() {
        let server = server_with_packages("io.remote/only", vec![]);
        assert!(to_listing(&server).is_none());
        assert!(to_instantiable(&server).is_none());
    }

    #[test]
    fn typed_package_argument_becomes_args_user_input() {
        let pkg = RegistryPackage {
            registry_type: "uvx".into(),
            identifier: "mcp-server-sqlite".into(),
            version: Some("0.1".into()),
            runtime_hint: Some("uvx".into()),
            transport: None,
            runtime_arguments: vec![],
            package_arguments: vec![RegistryArgument {
                kind: "named".into(),
                name: Some("db-path".into()),
                value: None,
                default: None,
                is_required: Some(true),
                is_secret: None,
                description: Some("Path to SQLite database".into()),
                placeholder: None,
                format: Some("filepath".into()),
                choices: vec![],
            }],
            environment_variables: vec![],
        };
        let server = server_with_packages("io.example/sqlite", vec![pkg]);
        let listing = to_listing(&server).expect("listing");
        assert_eq!(listing.user_inputs.len(), 1);
        assert!(matches!(
            listing.user_inputs[0].input_type,
            OwnedUserInputType::Path { .. }
        ));
        assert!(matches!(listing.user_inputs[0].target, OwnedInputTarget::Args));

        let inst = to_instantiable(&server).expect("instantiable");
        // Args should be: --db-path {{db_path}}, with the identifier in
        // front for pypi-like uvx invocation.
        assert!(inst.args_template.contains(&"--db-path".to_string()));
        assert!(inst
            .args_template
            .iter()
            .any(|a| a.contains("{{db_path}}")));

        let mut inputs = BTreeMap::new();
        inputs.insert("db_path".to_string(), "/tmp/foo.db".to_string());
        let result = inst.instantiate(&inputs).expect("instantiate");
        assert!(result.args.contains(&"/tmp/foo.db".to_string()));
    }

    #[test]
    fn sanitize_input_key_collapses_punctuation() {
        assert_eq!(sanitize_input_key("SLACK_BOT_TOKEN"), "slack_bot_token");
        assert_eq!(sanitize_input_key("Path to file"), "path_to_file");
        assert_eq!(sanitize_input_key("foo--bar...baz"), "foo_bar_baz");
        assert_eq!(sanitize_input_key("___"), "input");
    }
}
