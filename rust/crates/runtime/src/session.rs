use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::json::{JsonError, JsonValue};
use crate::usage::TokenUsage;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: String,
    },
    ToolResult {
        tool_use_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    },
    /// Model's chain-of-thought. Set on DeepSeek `reasoning_content`
    /// chunks (also covers Anthropic native `thinking` blocks when we
    /// wire those up). Re-serialised back to the provider on
    /// subsequent turns so multi-turn tool use stays consistent —
    /// DeepSeek rejects tool-use histories that drop the reasoning
    /// trail it expects.
    ///
    /// `signature` is Anthropic-specific; DeepSeek has nothing here.
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
    /// User-provided attachments associated with this turn. Storage is kept
    /// separate from `blocks` so the UI can render the typed prompt as a
    /// clean bubble and the attachments as collapsible chips. The provider
    /// path (`convert_messages` in the `api` crate) merges them back into
    /// the outgoing text payload so the LLM still sees one coherent
    /// message. Empty for assistant/tool messages and any user message
    /// without attachments — `#[serde(default)]` keeps old persisted
    /// sessions readable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachment>,
    /// Model that produced this message — set on assistant messages with
    /// usage, used by the per-model usage aggregation. `None` for
    /// user/tool messages, for assistant messages from before this field
    /// was added (serde default), and for synthetic stop notices.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Chunks retrieved by RAG when the session has an attached library.
    /// Stored alongside the user message (separate from `blocks` so the
    /// UI can render it as a collapsible chip rather than as inline
    /// prompt content) and spliced into the LLM-facing payload at
    /// `convert_messages` time. `None` when no library is attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retrieved_context: Option<RetrievedContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RetrievedContext {
    pub library: String,
    pub chunks: Vec<RetrievedChunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetrievedChunk {
    pub source: String,
    pub content: String,
    pub distance: f32,
}

// `f32` is not `Eq` (NaN); use a manual impl that treats bitwise-equal
// chunks as equal so the parent type's derived `Eq` stays valid.
impl Eq for RetrievedChunk {}

/// A file the user attached to a user turn. The content is held verbatim
/// so the UI can re-render it on demand and the API serializer can splice
/// it into the outgoing message at request time. `kind` discriminates how
/// `content` should be interpreted — plain UTF-8 text, an inline image
/// (base64), or extracted-text from a binary source like a PDF.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageAttachment {
    pub path: String,
    pub content: String,
    /// Optional language hint (e.g. `python`, `rust`) used to label the
    /// fenced code block when assembling the LLM-facing message. Skipped
    /// from output when empty so older sessions deserialize cleanly.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub language: String,
    /// Discriminates how `content` is interpreted. Defaults to Text so
    /// older persisted sessions (which had no `kind` field) keep parsing.
    #[serde(default)]
    pub kind: AttachmentKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AttachmentKind {
    /// UTF-8 text — `content` is the verbatim file body. Rendered to the
    /// LLM as a fenced code block.
    #[default]
    Text,
    /// Inline image — `content` is the base64-encoded image bytes,
    /// `media_type` is the IANA mime (e.g. `image/png`). Rendered to the
    /// LLM as a provider-native image content block.
    Image { media_type: String },
    /// Text extracted from a binary document like a PDF — `content` is the
    /// extracted plain text. Rendered the same way as `Text` but UI can
    /// label it differently.
    ExtractedText { source_format: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    pub version: u32,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug)]
pub enum SessionError {
    Io(std::io::Error),
    Json(JsonError),
    Format(String),
}

impl Display for SessionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::Format(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<std::io::Error> for SessionError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<JsonError> for SessionError {
    fn from(value: JsonError) -> Self {
        Self::Json(value)
    }
}

impl Session {
    #[must_use]
    pub fn new() -> Self {
        Self {
            version: 1,
            messages: Vec::new(),
        }
    }

    pub fn save_to_path(&self, path: impl AsRef<Path>) -> Result<(), SessionError> {
        fs::write(path, self.to_json().render())?;
        Ok(())
    }

    pub fn load_from_path(path: impl AsRef<Path>) -> Result<Self, SessionError> {
        let contents = fs::read_to_string(path)?;
        Self::from_json(&JsonValue::parse(&contents)?)
    }

    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        object.insert(
            "version".to_string(),
            JsonValue::Number(i64::from(self.version)),
        );
        object.insert(
            "messages".to_string(),
            JsonValue::Array(
                self.messages
                    .iter()
                    .map(ConversationMessage::to_json)
                    .collect(),
            ),
        );
        JsonValue::Object(object)
    }

    pub fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("session must be an object".to_string()))?;
        let version = object
            .get("version")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| SessionError::Format("missing version".to_string()))?;
        let version = u32::try_from(version)
            .map_err(|_| SessionError::Format("version out of range".to_string()))?;
        let messages = object
            .get("messages")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| SessionError::Format("missing messages".to_string()))?
            .iter()
            .map(ConversationMessage::from_json)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { version, messages })
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationMessage {
    #[must_use]
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
            attachments: Vec::new(),
            model: None,
            retrieved_context: None,
        }
    }

    #[must_use]
    pub fn user_with_attachments(
        text: impl Into<String>,
        attachments: Vec<MessageAttachment>,
    ) -> Self {
        Self {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
            attachments,
            model: None,
            retrieved_context: None,
        }
    }

    #[must_use]
    pub fn assistant(blocks: Vec<ContentBlock>) -> Self {
        Self {
            role: MessageRole::Assistant,
            blocks,
            usage: None,
            attachments: Vec::new(),
            model: None,
            retrieved_context: None,
        }
    }

    #[must_use]
    pub fn assistant_with_usage(blocks: Vec<ContentBlock>, usage: Option<TokenUsage>) -> Self {
        Self {
            role: MessageRole::Assistant,
            blocks,
            usage,
            attachments: Vec::new(),
            model: None,
            retrieved_context: None,
        }
    }

    #[must_use]
    pub fn tool_result(
        tool_use_id: impl Into<String>,
        tool_name: impl Into<String>,
        output: impl Into<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: tool_use_id.into(),
                tool_name: tool_name.into(),
                output: output.into(),
                is_error,
            }],
            usage: None,
            attachments: Vec::new(),
            model: None,
            retrieved_context: None,
        }
    }

    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        object.insert(
            "role".to_string(),
            JsonValue::String(
                match self.role {
                    MessageRole::System => "system",
                    MessageRole::User => "user",
                    MessageRole::Assistant => "assistant",
                    MessageRole::Tool => "tool",
                }
                .to_string(),
            ),
        );
        object.insert(
            "blocks".to_string(),
            JsonValue::Array(self.blocks.iter().map(ContentBlock::to_json).collect()),
        );
        if let Some(usage) = self.usage {
            object.insert("usage".to_string(), usage_to_json(usage));
        }
        if !self.attachments.is_empty() {
            object.insert(
                "attachments".to_string(),
                JsonValue::Array(
                    self.attachments
                        .iter()
                        .map(MessageAttachment::to_json)
                        .collect(),
                ),
            );
        }
        JsonValue::Object(object)
    }

    fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("message must be an object".to_string()))?;
        let role = match object
            .get("role")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| SessionError::Format("missing role".to_string()))?
        {
            "system" => MessageRole::System,
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            "tool" => MessageRole::Tool,
            other => {
                return Err(SessionError::Format(format!(
                    "unsupported message role: {other}"
                )))
            }
        };
        let blocks = object
            .get("blocks")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| SessionError::Format("missing blocks".to_string()))?
            .iter()
            .map(ContentBlock::from_json)
            .collect::<Result<Vec<_>, _>>()?;
        let usage = object.get("usage").map(usage_from_json).transpose()?;
        let attachments = object
            .get("attachments")
            .and_then(JsonValue::as_array)
            .map(|arr| {
                arr.iter()
                    .map(MessageAttachment::from_json)
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            role,
            blocks,
            usage,
            attachments,
            model: None,
            retrieved_context: None,
        })
    }
}

impl MessageAttachment {
    #[must_use]
    fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        object.insert("path".to_string(), JsonValue::String(self.path.clone()));
        object.insert("content".to_string(), JsonValue::String(self.content.clone()));
        if !self.language.is_empty() {
            object.insert("language".to_string(), JsonValue::String(self.language.clone()));
        }
        match &self.kind {
            AttachmentKind::Text => {}
            AttachmentKind::Image { media_type } => {
                let mut k = BTreeMap::new();
                k.insert("type".to_string(), JsonValue::String("image".to_string()));
                k.insert(
                    "media_type".to_string(),
                    JsonValue::String(media_type.clone()),
                );
                object.insert("kind".to_string(), JsonValue::Object(k));
            }
            AttachmentKind::ExtractedText { source_format } => {
                let mut k = BTreeMap::new();
                k.insert(
                    "type".to_string(),
                    JsonValue::String("extracted_text".to_string()),
                );
                k.insert(
                    "source_format".to_string(),
                    JsonValue::String(source_format.clone()),
                );
                object.insert("kind".to_string(), JsonValue::Object(k));
            }
        }
        JsonValue::Object(object)
    }

    fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("attachment must be an object".to_string()))?;
        let path = object
            .get("path")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| SessionError::Format("attachment missing path".to_string()))?
            .to_string();
        let content = object
            .get("content")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| SessionError::Format("attachment missing content".to_string()))?
            .to_string();
        let language = object
            .get("language")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string();
        let kind = match object.get("kind").and_then(JsonValue::as_object) {
            None => AttachmentKind::Text,
            Some(k) => match k.get("type").and_then(JsonValue::as_str) {
                None | Some("text") => AttachmentKind::Text,
                Some("image") => AttachmentKind::Image {
                    media_type: k
                        .get("media_type")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("application/octet-stream")
                        .to_string(),
                },
                Some("extracted_text") => AttachmentKind::ExtractedText {
                    source_format: k
                        .get("source_format")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string(),
                },
                Some(other) => {
                    return Err(SessionError::Format(format!(
                        "unknown attachment kind `{other}`"
                    )))
                }
            },
        };
        Ok(Self {
            path,
            content,
            language,
            kind,
        })
    }
}

impl ContentBlock {
    #[must_use]
    pub fn to_json(&self) -> JsonValue {
        let mut object = BTreeMap::new();
        match self {
            Self::Text { text } => {
                object.insert("type".to_string(), JsonValue::String("text".to_string()));
                object.insert("text".to_string(), JsonValue::String(text.clone()));
            }
            Self::ToolUse { id, name, input } => {
                object.insert(
                    "type".to_string(),
                    JsonValue::String("tool_use".to_string()),
                );
                object.insert("id".to_string(), JsonValue::String(id.clone()));
                object.insert("name".to_string(), JsonValue::String(name.clone()));
                object.insert("input".to_string(), JsonValue::String(input.clone()));
            }
            Self::ToolResult {
                tool_use_id,
                tool_name,
                output,
                is_error,
            } => {
                object.insert(
                    "type".to_string(),
                    JsonValue::String("tool_result".to_string()),
                );
                object.insert(
                    "tool_use_id".to_string(),
                    JsonValue::String(tool_use_id.clone()),
                );
                object.insert(
                    "tool_name".to_string(),
                    JsonValue::String(tool_name.clone()),
                );
                object.insert("output".to_string(), JsonValue::String(output.clone()));
                object.insert("is_error".to_string(), JsonValue::Bool(*is_error));
            }
            Self::Reasoning { text, signature } => {
                object.insert(
                    "type".to_string(),
                    JsonValue::String("reasoning".to_string()),
                );
                object.insert("text".to_string(), JsonValue::String(text.clone()));
                if let Some(sig) = signature {
                    object.insert("signature".to_string(), JsonValue::String(sig.clone()));
                }
            }
        }
        JsonValue::Object(object)
    }

    fn from_json(value: &JsonValue) -> Result<Self, SessionError> {
        let object = value
            .as_object()
            .ok_or_else(|| SessionError::Format("block must be an object".to_string()))?;
        match object
            .get("type")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| SessionError::Format("missing block type".to_string()))?
        {
            "text" => Ok(Self::Text {
                text: required_string(object, "text")?,
            }),
            "tool_use" => Ok(Self::ToolUse {
                id: required_string(object, "id")?,
                name: required_string(object, "name")?,
                input: required_string(object, "input")?,
            }),
            "tool_result" => Ok(Self::ToolResult {
                tool_use_id: required_string(object, "tool_use_id")?,
                tool_name: required_string(object, "tool_name")?,
                output: required_string(object, "output")?,
                is_error: object
                    .get("is_error")
                    .and_then(JsonValue::as_bool)
                    .ok_or_else(|| SessionError::Format("missing is_error".to_string()))?,
            }),
            other => Err(SessionError::Format(format!(
                "unsupported block type: {other}"
            ))),
        }
    }
}

fn usage_to_json(usage: TokenUsage) -> JsonValue {
    let mut object = BTreeMap::new();
    object.insert(
        "input_tokens".to_string(),
        JsonValue::Number(i64::from(usage.input_tokens)),
    );
    object.insert(
        "output_tokens".to_string(),
        JsonValue::Number(i64::from(usage.output_tokens)),
    );
    object.insert(
        "cache_creation_input_tokens".to_string(),
        JsonValue::Number(i64::from(usage.cache_creation_input_tokens)),
    );
    object.insert(
        "cache_read_input_tokens".to_string(),
        JsonValue::Number(i64::from(usage.cache_read_input_tokens)),
    );
    JsonValue::Object(object)
}

fn usage_from_json(value: &JsonValue) -> Result<TokenUsage, SessionError> {
    let object = value
        .as_object()
        .ok_or_else(|| SessionError::Format("usage must be an object".to_string()))?;
    Ok(TokenUsage {
        input_tokens: required_u32(object, "input_tokens")?,
        output_tokens: required_u32(object, "output_tokens")?,
        cache_creation_input_tokens: required_u32(object, "cache_creation_input_tokens")?,
        cache_read_input_tokens: required_u32(object, "cache_read_input_tokens")?,
    })
}

fn required_string(
    object: &BTreeMap<String, JsonValue>,
    key: &str,
) -> Result<String, SessionError> {
    object
        .get(key)
        .and_then(JsonValue::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| SessionError::Format(format!("missing {key}")))
}

fn required_u32(object: &BTreeMap<String, JsonValue>, key: &str) -> Result<u32, SessionError> {
    let value = object
        .get(key)
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| SessionError::Format(format!("missing {key}")))?;
    u32::try_from(value).map_err(|_| SessionError::Format(format!("{key} out of range")))
}

#[cfg(test)]
mod tests {
    use super::{ContentBlock, ConversationMessage, MessageRole, Session};
    use crate::usage::TokenUsage;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn persists_and_restores_session_json() {
        let mut session = Session::new();
        session
            .messages
            .push(ConversationMessage::user_text("hello"));
        session
            .messages
            .push(ConversationMessage::assistant_with_usage(
                vec![
                    ContentBlock::Text {
                        text: "thinking".to_string(),
                    },
                    ContentBlock::ToolUse {
                        id: "tool-1".to_string(),
                        name: "bash".to_string(),
                        input: "echo hi".to_string(),
                    },
                ],
                Some(TokenUsage {
                    input_tokens: 10,
                    output_tokens: 4,
                    cache_creation_input_tokens: 1,
                    cache_read_input_tokens: 2,
                }),
            ));
        session.messages.push(ConversationMessage::tool_result(
            "tool-1", "bash", "hi", false,
        ));

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("runtime-session-{nanos}.json"));
        session.save_to_path(&path).expect("session should save");
        let restored = Session::load_from_path(&path).expect("session should load");
        fs::remove_file(&path).expect("temp file should be removable");

        assert_eq!(restored, session);
        assert_eq!(restored.messages[2].role, MessageRole::Tool);
        assert_eq!(
            restored.messages[1].usage.expect("usage").total_tokens(),
            17
        );
    }
}
