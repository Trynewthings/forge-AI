use std::future::Future;
use std::pin::Pin;

use crate::error::ApiError;
use crate::types::{MessageRequest, MessageResponse};

pub mod claw_provider;
pub mod openai_compat;

pub type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ApiError>> + Send + 'a>>;

pub trait Provider {
    type Stream;

    fn send_message<'a>(
        &'a self,
        request: &'a MessageRequest,
    ) -> ProviderFuture<'a, MessageResponse>;

    fn stream_message<'a>(
        &'a self,
        request: &'a MessageRequest,
    ) -> ProviderFuture<'a, Self::Stream>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    ClawApi,
    Xai,
    OpenAi,
    DeepSeek,
    OpenAiCompat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderMetadata {
    pub provider: ProviderKind,
    pub auth_env: &'static str,
    pub base_url_env: &'static str,
    pub default_base_url: &'static str,
}

const MODEL_REGISTRY: &[(&str, ProviderMetadata)] = &[
    (
        "opus",
        ProviderMetadata {
            provider: ProviderKind::ClawApi,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: claw_provider::DEFAULT_BASE_URL,
        },
    ),
    (
        "sonnet",
        ProviderMetadata {
            provider: ProviderKind::ClawApi,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: claw_provider::DEFAULT_BASE_URL,
        },
    ),
    (
        "haiku",
        ProviderMetadata {
            provider: ProviderKind::ClawApi,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: claw_provider::DEFAULT_BASE_URL,
        },
    ),
    (
        "claude-opus-4-6",
        ProviderMetadata {
            provider: ProviderKind::ClawApi,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: claw_provider::DEFAULT_BASE_URL,
        },
    ),
    (
        "claude-sonnet-4-6",
        ProviderMetadata {
            provider: ProviderKind::ClawApi,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: claw_provider::DEFAULT_BASE_URL,
        },
    ),
    (
        "claude-haiku-4-5-20251213",
        ProviderMetadata {
            provider: ProviderKind::ClawApi,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: claw_provider::DEFAULT_BASE_URL,
        },
    ),
    (
        "deepseek",
        ProviderMetadata {
            provider: ProviderKind::DeepSeek,
            auth_env: "DEEPSEEK_API_KEY",
            base_url_env: "DEEPSEEK_BASE_URL",
            default_base_url: openai_compat::DEFAULT_DEEPSEEK_BASE_URL,
        },
    ),
    (
        "deepseek-chat",
        ProviderMetadata {
            provider: ProviderKind::DeepSeek,
            auth_env: "DEEPSEEK_API_KEY",
            base_url_env: "DEEPSEEK_BASE_URL",
            default_base_url: openai_compat::DEFAULT_DEEPSEEK_BASE_URL,
        },
    ),
    (
        "deepseek-reasoner",
        ProviderMetadata {
            provider: ProviderKind::DeepSeek,
            auth_env: "DEEPSEEK_API_KEY",
            base_url_env: "DEEPSEEK_BASE_URL",
            default_base_url: openai_compat::DEFAULT_DEEPSEEK_BASE_URL,
        },
    ),
    (
        "openai-compatible",
        ProviderMetadata {
            provider: ProviderKind::OpenAiCompat,
            auth_env: "OPENAI_COMPAT_API_KEY",
            base_url_env: "OPENAI_COMPAT_BASE_URL",
            default_base_url: openai_compat::DEFAULT_OPENAI_COMPAT_BASE_URL,
        },
    ),
    (
        "grok",
        ProviderMetadata {
            provider: ProviderKind::Xai,
            auth_env: "XAI_API_KEY",
            base_url_env: "XAI_BASE_URL",
            default_base_url: openai_compat::DEFAULT_XAI_BASE_URL,
        },
    ),
    (
        "grok-3",
        ProviderMetadata {
            provider: ProviderKind::Xai,
            auth_env: "XAI_API_KEY",
            base_url_env: "XAI_BASE_URL",
            default_base_url: openai_compat::DEFAULT_XAI_BASE_URL,
        },
    ),
    (
        "grok-mini",
        ProviderMetadata {
            provider: ProviderKind::Xai,
            auth_env: "XAI_API_KEY",
            base_url_env: "XAI_BASE_URL",
            default_base_url: openai_compat::DEFAULT_XAI_BASE_URL,
        },
    ),
    (
        "grok-3-mini",
        ProviderMetadata {
            provider: ProviderKind::Xai,
            auth_env: "XAI_API_KEY",
            base_url_env: "XAI_BASE_URL",
            default_base_url: openai_compat::DEFAULT_XAI_BASE_URL,
        },
    ),
    (
        "grok-2",
        ProviderMetadata {
            provider: ProviderKind::Xai,
            auth_env: "XAI_API_KEY",
            base_url_env: "XAI_BASE_URL",
            default_base_url: openai_compat::DEFAULT_XAI_BASE_URL,
        },
    ),
];

#[must_use]
pub fn resolve_model_alias(model: &str) -> String {
    let trimmed = model.trim();
    let lower = trimmed.to_ascii_lowercase();
    MODEL_REGISTRY
        .iter()
        .find_map(|(alias, metadata)| {
            (*alias == lower).then_some(match metadata.provider {
                ProviderKind::ClawApi => match *alias {
                    "opus" => "claude-opus-4-6",
                    "sonnet" => "claude-sonnet-4-6",
                    "haiku" => "claude-haiku-4-5-20251213",
                    _ => trimmed,
                },
                ProviderKind::Xai => match *alias {
                    "grok" | "grok-3" => "grok-3",
                    "grok-mini" | "grok-3-mini" => "grok-3-mini",
                    "grok-2" => "grok-2",
                    _ => trimmed,
                },
                ProviderKind::OpenAi => trimmed,
                ProviderKind::DeepSeek => match *alias {
                    "deepseek" => "deepseek-chat",
                    _ => trimmed,
                },
                ProviderKind::OpenAiCompat => trimmed,
            })
        })
        .map_or_else(|| trimmed.to_string(), ToOwned::to_owned)
}

#[must_use]
pub fn metadata_for_model(model: &str) -> Option<ProviderMetadata> {
    let canonical = resolve_model_alias(model);
    let lower = canonical.to_ascii_lowercase();
    if let Some((_, metadata)) = MODEL_REGISTRY.iter().find(|(alias, _)| *alias == lower) {
        return Some(*metadata);
    }
    if lower.starts_with("grok") {
        return Some(ProviderMetadata {
            provider: ProviderKind::Xai,
            auth_env: "XAI_API_KEY",
            base_url_env: "XAI_BASE_URL",
            default_base_url: openai_compat::DEFAULT_XAI_BASE_URL,
        });
    }
    if lower.starts_with("deepseek") {
        return Some(ProviderMetadata {
            provider: ProviderKind::DeepSeek,
            auth_env: "DEEPSEEK_API_KEY",
            base_url_env: "DEEPSEEK_BASE_URL",
            default_base_url: openai_compat::DEFAULT_DEEPSEEK_BASE_URL,
        });
    }
    // `openai-compat/<real-model-id>` (or legacy `openai-compatible/<id>`)
    // dispatches to the generic OpenAI-compatible client. The real upstream
    // model id is everything after the slash; the strip happens at the
    // wire-format stage (`build_chat_completion_request`).
    if lower.starts_with("openai-compat/") || lower.starts_with("openai-compatible/") {
        return Some(ProviderMetadata {
            provider: ProviderKind::OpenAiCompat,
            auth_env: "OPENAI_COMPAT_API_KEY",
            base_url_env: "OPENAI_COMPAT_BASE_URL",
            default_base_url: openai_compat::DEFAULT_OPENAI_COMPAT_BASE_URL,
        });
    }
    None
}

/// Strip the `openai-compat/` (or `openai-compatible/`) prefix from a
/// dispatched model id so we send only the real upstream model name on
/// the wire. Idempotent — returns the input unchanged if no prefix.
#[must_use]
pub fn strip_openai_compat_prefix(model: &str) -> &str {
    let trimmed = model.trim_start();
    if let Some(rest) = trimmed.strip_prefix("openai-compat/") {
        return rest;
    }
    if let Some(rest) = trimmed.strip_prefix("openai-compatible/") {
        return rest;
    }
    model
}

#[must_use]
pub fn detect_provider_kind(model: &str) -> ProviderKind {
    if let Some(metadata) = metadata_for_model(model) {
        return metadata.provider;
    }
    if claw_provider::has_auth_from_env_or_saved().unwrap_or(false) {
        return ProviderKind::ClawApi;
    }
    if openai_compat::has_api_key("OPENAI_API_KEY") {
        return ProviderKind::OpenAi;
    }
    if openai_compat::has_api_key("DEEPSEEK_API_KEY") {
        return ProviderKind::DeepSeek;
    }
    if openai_compat::has_api_key("XAI_API_KEY") {
        return ProviderKind::Xai;
    }
    if openai_compat::has_api_key("OPENAI_COMPAT_API_KEY") {
        return ProviderKind::OpenAiCompat;
    }
    ProviderKind::ClawApi
}

#[must_use]
pub fn max_tokens_for_model(model: &str) -> u32 {
    let canonical = resolve_model_alias(model);
    if canonical.contains("opus") {
        32_000
    } else {
        64_000
    }
}

/// Total input-context window (in tokens) for a given model. Used by the UI
/// to show how full the conversation buffer is.
///
/// Static lookup — for models we haven't enumerated we fall back to 200k.
/// Verified against upstream docs in 2026-05; when this table drifts, the
/// `/model` picker (Phase 3) is expected to override these with values
/// fetched live from each provider's `/v1/models` (or equivalent) endpoint.
#[must_use]
pub fn context_window_for_model(model: &str) -> u32 {
    let canonical = resolve_model_alias(model).to_ascii_lowercase();

    // Claude — see docs.claude.com/en/about-claude/models/overview.
    if canonical.starts_with("claude-opus-4-7")
        || canonical.starts_with("claude-opus-4-6")
        || canonical.starts_with("claude-sonnet-4-6")
    {
        return 1_000_000;
    }
    if canonical.starts_with("claude-") {
        // Haiku 4.5, Sonnet 4.5, Opus 4.5/4.1, older Sonnet/Opus 4.
        return 200_000;
    }

    // DeepSeek — `deepseek-chat` and `deepseek-reasoner` both point at
    // `deepseek-v4-flash`, 1M context (api-docs.deepseek.com/quick_start/pricing).
    if canonical.starts_with("deepseek") {
        return 1_000_000;
    }

    // xAI Grok — grok-4.* series ship 1M, grok-3 family is 131k.
    if canonical.starts_with("grok-4") {
        return 1_000_000;
    }
    if canonical.starts_with("grok-3") || canonical.starts_with("grok-2") {
        return 131_072;
    }
    if canonical.starts_with("grok") {
        return 131_072;
    }

    // OpenAI — gpt-4o/4-turbo are 128k; o3/o4 reasoning models 200k. No
    // confirmed 2026 data for gpt-5; defer to the conservative bucket below.
    if canonical.starts_with("o3") || canonical.starts_with("o4") {
        return 200_000;
    }
    if canonical.starts_with("gpt-4o") || canonical.starts_with("gpt-4-turbo") {
        return 128_000;
    }

    // Unknown model — pick a safe middle ground large enough to avoid false
    // "context full" warnings on modern models.
    200_000
}

#[cfg(test)]
mod tests {
    use super::{detect_provider_kind, max_tokens_for_model, resolve_model_alias, ProviderKind};

    #[test]
    fn resolves_grok_aliases() {
        assert_eq!(resolve_model_alias("grok"), "grok-3");
        assert_eq!(resolve_model_alias("grok-mini"), "grok-3-mini");
        assert_eq!(resolve_model_alias("grok-2"), "grok-2");
    }

    #[test]
    fn resolves_deepseek_aliases() {
        assert_eq!(resolve_model_alias("deepseek"), "deepseek-chat");
        assert_eq!(resolve_model_alias("deepseek-chat"), "deepseek-chat");
        assert_eq!(
            resolve_model_alias("deepseek-reasoner"),
            "deepseek-reasoner"
        );
    }

    #[test]
    fn detects_provider_from_model_name_first() {
        assert_eq!(detect_provider_kind("grok"), ProviderKind::Xai);
        assert_eq!(detect_provider_kind("deepseek"), ProviderKind::DeepSeek);
        assert_eq!(
            detect_provider_kind("claude-sonnet-4-6"),
            ProviderKind::ClawApi
        );
    }

    #[test]
    fn keeps_existing_max_token_heuristic() {
        assert_eq!(max_tokens_for_model("opus"), 32_000);
        assert_eq!(max_tokens_for_model("grok-3"), 64_000);
    }
}
