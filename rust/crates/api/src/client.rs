use crate::error::ApiError;
use crate::providers::claw_provider::{self, AuthSource, ClawApiClient};
use crate::providers::openai_compat::{self, OpenAiCompatClient, OpenAiCompatConfig};
use crate::providers::{self, Provider, ProviderKind};
use crate::types::{MessageRequest, MessageResponse, StreamEvent};

async fn send_via_provider<P: Provider>(
    provider: &P,
    request: &MessageRequest,
) -> Result<MessageResponse, ApiError> {
    provider.send_message(request).await
}

async fn stream_via_provider<P: Provider>(
    provider: &P,
    request: &MessageRequest,
) -> Result<P::Stream, ApiError> {
    provider.stream_message(request).await
}

#[derive(Debug, Clone)]
pub enum ProviderClient {
    ClawApi(ClawApiClient),
    Xai(OpenAiCompatClient),
    OpenAi(OpenAiCompatClient),
    DeepSeek(OpenAiCompatClient),
    OpenAiCompat(OpenAiCompatClient),
}

impl ProviderClient {
    pub fn from_model(model: &str) -> Result<Self, ApiError> {
        Self::from_model_with_default_auth(model, None)
    }

    pub fn from_model_with_default_auth(
        model: &str,
        default_auth: Option<AuthSource>,
    ) -> Result<Self, ApiError> {
        let resolved_model = providers::resolve_model_alias(model);
        match providers::detect_provider_kind(&resolved_model) {
            ProviderKind::ClawApi => Ok(Self::ClawApi(match default_auth {
                Some(auth) => ClawApiClient::from_auth(auth),
                None => ClawApiClient::from_env()?,
            })),
            ProviderKind::Xai => Ok(Self::Xai(OpenAiCompatClient::from_env(
                OpenAiCompatConfig::xai(),
            )?)),
            ProviderKind::OpenAi => Ok(Self::OpenAi(OpenAiCompatClient::from_env(
                OpenAiCompatConfig::openai(),
            )?)),
            ProviderKind::DeepSeek => Ok(Self::DeepSeek(OpenAiCompatClient::from_env(
                OpenAiCompatConfig::deepseek(),
            )?)),
            ProviderKind::OpenAiCompat => Ok(Self::OpenAiCompat(OpenAiCompatClient::from_env(
                OpenAiCompatConfig::generic(),
            )?)),
        }
    }

    /// Build a provider client using explicit credentials instead of environment variables.
    /// `base_url` overrides the provider's default endpoint when supplied; the API key is
    /// required for every provider.
    pub fn from_model_with_credentials(
        model: &str,
        api_key: String,
        base_url: Option<String>,
    ) -> Result<Self, ApiError> {
        let resolved_model = providers::resolve_model_alias(model);
        Ok(match providers::detect_provider_kind(&resolved_model) {
            ProviderKind::ClawApi => {
                let mut client = ClawApiClient::new(api_key);
                if let Some(url) = base_url {
                    client = client.with_base_url(url);
                }
                Self::ClawApi(client)
            }
            ProviderKind::Xai => {
                Self::Xai(build_openai_compat(api_key, base_url, OpenAiCompatConfig::xai()))
            }
            ProviderKind::OpenAi => Self::OpenAi(build_openai_compat(
                api_key,
                base_url,
                OpenAiCompatConfig::openai(),
            )),
            ProviderKind::DeepSeek => Self::DeepSeek(build_openai_compat(
                api_key,
                base_url,
                OpenAiCompatConfig::deepseek(),
            )),
            ProviderKind::OpenAiCompat => Self::OpenAiCompat(build_openai_compat(
                api_key,
                base_url,
                OpenAiCompatConfig::generic(),
            )),
        })
    }

    #[must_use]
    pub const fn provider_kind(&self) -> ProviderKind {
        match self {
            Self::ClawApi(_) => ProviderKind::ClawApi,
            Self::Xai(_) => ProviderKind::Xai,
            Self::OpenAi(_) => ProviderKind::OpenAi,
            Self::DeepSeek(_) => ProviderKind::DeepSeek,
            Self::OpenAiCompat(_) => ProviderKind::OpenAiCompat,
        }
    }

    pub async fn send_message(
        &self,
        request: &MessageRequest,
    ) -> Result<MessageResponse, ApiError> {
        match self {
            Self::ClawApi(client) => send_via_provider(client, request).await,
            Self::Xai(client)
            | Self::OpenAi(client)
            | Self::DeepSeek(client)
            | Self::OpenAiCompat(client) => send_via_provider(client, request).await,
        }
    }

    pub async fn stream_message(
        &self,
        request: &MessageRequest,
    ) -> Result<MessageStream, ApiError> {
        match self {
            Self::ClawApi(client) => stream_via_provider(client, request)
                .await
                .map(MessageStream::ClawApi),
            Self::Xai(client)
            | Self::OpenAi(client)
            | Self::DeepSeek(client)
            | Self::OpenAiCompat(client) => stream_via_provider(client, request)
                .await
                .map(MessageStream::OpenAiCompat),
        }
    }
}

#[derive(Debug)]
pub enum MessageStream {
    ClawApi(claw_provider::MessageStream),
    OpenAiCompat(openai_compat::MessageStream),
}

impl MessageStream {
    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::ClawApi(stream) => stream.request_id(),
            Self::OpenAiCompat(stream) => stream.request_id(),
        }
    }

    pub async fn next_event(&mut self) -> Result<Option<StreamEvent>, ApiError> {
        match self {
            Self::ClawApi(stream) => stream.next_event().await,
            Self::OpenAiCompat(stream) => stream.next_event().await,
        }
    }
}

fn build_openai_compat(
    api_key: String,
    base_url: Option<String>,
    config: OpenAiCompatConfig,
) -> OpenAiCompatClient {
    let mut client = OpenAiCompatClient::new(api_key, config);
    if let Some(url) = base_url {
        client = client.with_base_url(url);
    }
    client
}

pub use claw_provider::{
    oauth_token_is_expired, resolve_saved_oauth_token, resolve_startup_auth_source, OAuthTokenSet,
};
#[must_use]
pub fn read_base_url() -> String {
    claw_provider::read_base_url()
}

#[must_use]
pub fn read_xai_base_url() -> String {
    openai_compat::read_base_url(OpenAiCompatConfig::xai())
}

#[must_use]
pub fn read_deepseek_base_url() -> String {
    openai_compat::read_base_url(OpenAiCompatConfig::deepseek())
}

#[cfg(test)]
mod tests {
    use crate::providers::{detect_provider_kind, resolve_model_alias, ProviderKind};

    #[test]
    fn resolves_existing_and_grok_aliases() {
        assert_eq!(resolve_model_alias("opus"), "claude-opus-4-6");
        assert_eq!(resolve_model_alias("grok"), "grok-3");
        assert_eq!(resolve_model_alias("grok-mini"), "grok-3-mini");
        assert_eq!(resolve_model_alias("deepseek"), "deepseek-chat");
    }

    #[test]
    fn provider_detection_prefers_model_family() {
        assert_eq!(detect_provider_kind("grok-3"), ProviderKind::Xai);
        assert_eq!(
            detect_provider_kind("deepseek-chat"),
            ProviderKind::DeepSeek
        );
        assert_eq!(
            detect_provider_kind("claude-sonnet-4-6"),
            ProviderKind::ClawApi
        );
    }
}
