//! Generic OpenAI-compatible embedding client.
//!
//! Originally tied to OpenAI directly; now driven by an explicit
//! `EmbeddingProvider` config so we can swap in DashScope's
//! `text-embedding-v4`, Voyage, Cohere's compat shim, or any other
//! provider exposing the OpenAI `/v1/embeddings` shape.
//!
//! The client is deliberately tiny — embeddings are a much simpler
//! endpoint than chat (no streaming, no tools, no images), so the chat
//! provider client in `api::providers::openai_compat` is the wrong tool
//! to reuse.

use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum EmbeddingError {
    NotConfigured,
    Http(reqwest::Error),
    Status { status: u16, body: String },
    Empty,
    DimensionMismatch { got: usize, expected: usize },
}

impl std::fmt::Display for EmbeddingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(
                f,
                "embedding provider isn't configured — set one in Settings (Embedding section) before ingesting. OpenAI, DashScope, and any OpenAI-compatible endpoint are supported."
            ),
            Self::Http(e) => write!(f, "embedding request failed: {e}"),
            Self::Status { status, body } => {
                write!(f, "embedding API returned HTTP {status}: {body}")
            }
            Self::Empty => write!(f, "embedding API returned no vectors"),
            Self::DimensionMismatch { got, expected } => write!(
                f,
                "unexpected embedding dimension: got {got}, expected {expected}"
            ),
        }
    }
}

impl std::error::Error for EmbeddingError {}

/// Pluggable embedding-provider config. Persisted on `ServerConfig`. The
/// frontend's Settings panel writes this; ingest/retrieve handlers
/// build an `EmbeddingClient` from it on every call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddingProvider {
    /// `https://api.openai.com/v1` for OpenAI,
    /// `https://dashscope.aliyuncs.com/compatible-mode/v1` for DashScope,
    /// etc. No trailing slash required — we trim before suffixing.
    pub base_url: String,
    pub api_key: String,
    /// `text-embedding-3-small`, `text-embedding-v4`, …
    pub model: String,
    /// Vector dim the provider should return. Must match the library
    /// store's dim — mismatches surface as `DimensionMismatch` rather
    /// than silently corrupting the index.
    pub dimensions: u32,
}

impl EmbeddingProvider {
    /// Convenience: a baseline OpenAI default for the case where the user
    /// has only set their OpenAI chat creds and hasn't picked an
    /// embedding provider yet. `api_key` is plumbed in by the caller.
    #[must_use]
    pub fn openai_default(api_key: String) -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key,
            model: "text-embedding-3-small".to_string(),
            dimensions: 1536,
        }
    }
}

/// Resolved client for a single provider config.
#[derive(Debug, Clone)]
pub struct EmbeddingClient {
    http: reqwest::Client,
    config: EmbeddingProvider,
}

impl EmbeddingClient {
    pub fn new(config: EmbeddingProvider) -> Result<Self, EmbeddingError> {
        if config.api_key.trim().is_empty() {
            return Err(EmbeddingError::NotConfigured);
        }
        Ok(Self {
            http: reqwest::Client::new(),
            config,
        })
    }

    #[must_use]
    pub fn dimensions(&self) -> usize {
        self.config.dimensions as usize
    }

    /// Embed up to MAX_BATCH strings in one call. Returns vectors in the
    /// same order as inputs. Splits across multiple requests for larger
    /// input lists.
    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        const MAX_BATCH: usize = 96;

        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let expected_dim = self.dimensions();
        let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        for batch in texts.chunks(MAX_BATCH) {
            let payload = EmbedRequest {
                model: &self.config.model,
                input: batch,
                // `text-embedding-3-*` and DashScope `text-embedding-v3/v4`
                // both accept this. Older OpenAI models silently ignore
                // unknown params, so this is safe to always send.
                dimensions: self.config.dimensions,
                encoding_format: "float",
            };
            let url = format!(
                "{}/embeddings",
                self.config.base_url.trim_end_matches('/'),
            );
            let response = self
                .http
                .post(&url)
                .header("authorization", format!("Bearer {}", self.config.api_key))
                .header("content-type", "application/json")
                .json(&payload)
                .timeout(Duration::from_secs(60))
                .send()
                .await
                .map_err(EmbeddingError::Http)?;
            if !response.status().is_success() {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                return Err(EmbeddingError::Status { status, body });
            }
            let parsed: EmbedResponse =
                response.json().await.map_err(EmbeddingError::Http)?;
            if parsed.data.is_empty() {
                return Err(EmbeddingError::Empty);
            }
            let mut items = parsed.data;
            items.sort_by_key(|item| item.index);
            for item in items {
                if item.embedding.len() != expected_dim {
                    return Err(EmbeddingError::DimensionMismatch {
                        got: item.embedding.len(),
                        expected: expected_dim,
                    });
                }
                out.push(item.embedding);
            }
        }
        Ok(out)
    }
}

#[derive(Debug, Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
    dimensions: u32,
    encoding_format: &'a str,
}

#[derive(Debug, Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedItem>,
}

#[derive(Debug, Deserialize)]
struct EmbedItem {
    index: usize,
    embedding: Vec<f32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_rejects_blank_api_key() {
        let err = EmbeddingClient::new(EmbeddingProvider {
            base_url: "https://example.com/v1".to_string(),
            api_key: "   ".to_string(),
            model: "x".to_string(),
            dimensions: 1024,
        })
        .expect_err("blank key");
        assert!(matches!(err, EmbeddingError::NotConfigured));
    }

    #[test]
    fn openai_default_is_1536_dim_text_embedding_3_small() {
        let p = EmbeddingProvider::openai_default("sk-fake".to_string());
        assert_eq!(p.model, "text-embedding-3-small");
        assert_eq!(p.dimensions, 1536);
        assert!(p.base_url.contains("api.openai.com"));
    }

    #[test]
    fn empty_input_returns_empty_without_network() {
        let client = EmbeddingClient::new(EmbeddingProvider {
            base_url: "http://127.0.0.1:1".to_string(), // would fail if called
            api_key: "sk-fake".to_string(),
            model: "x".to_string(),
            dimensions: 1024,
        })
        .expect("client");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(client.embed(&[])).expect("ok");
        assert!(result.is_empty());
    }
}
