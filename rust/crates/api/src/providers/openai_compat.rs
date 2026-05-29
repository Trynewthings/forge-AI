use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};

use super::{Provider, ProviderFuture};

pub const DEFAULT_XAI_BASE_URL: &str = "https://api.x.ai/v1";
pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
pub const DEFAULT_OPENAI_COMPAT_BASE_URL: &str = "http://127.0.0.1:11434/v1";
const REQUEST_ID_HEADER: &str = "request-id";
const ALT_REQUEST_ID_HEADER: &str = "x-request-id";
const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_millis(200);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(2);
const DEFAULT_MAX_RETRIES: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenAiCompatConfig {
    pub provider_name: &'static str,
    pub api_key_env: &'static str,
    pub base_url_env: &'static str,
    pub default_base_url: &'static str,
}

const XAI_ENV_VARS: &[&str] = &["XAI_API_KEY"];
const OPENAI_ENV_VARS: &[&str] = &["OPENAI_API_KEY"];
const DEEPSEEK_ENV_VARS: &[&str] = &["DEEPSEEK_API_KEY"];
const OPENAI_COMPAT_ENV_VARS: &[&str] = &["OPENAI_COMPAT_API_KEY"];

impl OpenAiCompatConfig {
    #[must_use]
    pub const fn xai() -> Self {
        Self {
            provider_name: "xAI",
            api_key_env: "XAI_API_KEY",
            base_url_env: "XAI_BASE_URL",
            default_base_url: DEFAULT_XAI_BASE_URL,
        }
    }

    #[must_use]
    pub const fn openai() -> Self {
        Self {
            provider_name: "OpenAI",
            api_key_env: "OPENAI_API_KEY",
            base_url_env: "OPENAI_BASE_URL",
            default_base_url: DEFAULT_OPENAI_BASE_URL,
        }
    }

    #[must_use]
    pub const fn deepseek() -> Self {
        Self {
            provider_name: "DeepSeek",
            api_key_env: "DEEPSEEK_API_KEY",
            base_url_env: "DEEPSEEK_BASE_URL",
            default_base_url: DEFAULT_DEEPSEEK_BASE_URL,
        }
    }

    #[must_use]
    pub const fn generic() -> Self {
        Self {
            provider_name: "OpenAI-compatible",
            api_key_env: "OPENAI_COMPAT_API_KEY",
            base_url_env: "OPENAI_COMPAT_BASE_URL",
            default_base_url: DEFAULT_OPENAI_COMPAT_BASE_URL,
        }
    }

    #[must_use]
    pub fn credential_env_vars(self) -> &'static [&'static str] {
        match self.provider_name {
            "xAI" => XAI_ENV_VARS,
            "OpenAI" => OPENAI_ENV_VARS,
            "DeepSeek" => DEEPSEEK_ENV_VARS,
            "OpenAI-compatible" => OPENAI_COMPAT_ENV_VARS,
            _ => &[],
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpenAiCompatClient {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    max_retries: u32,
    initial_backoff: Duration,
    max_backoff: Duration,
}

impl OpenAiCompatClient {
    #[must_use]
    pub fn new(api_key: impl Into<String>, config: OpenAiCompatConfig) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key: api_key.into(),
            base_url: read_base_url(config),
            max_retries: DEFAULT_MAX_RETRIES,
            initial_backoff: DEFAULT_INITIAL_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
        }
    }

    pub fn from_env(config: OpenAiCompatConfig) -> Result<Self, ApiError> {
        let Some(api_key) = read_env_non_empty(config.api_key_env)? else {
            return Err(ApiError::missing_credentials(
                config.provider_name,
                config.credential_env_vars(),
            ));
        };
        Ok(Self::new(api_key, config))
    }

    #[must_use]
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    #[must_use]
    pub fn with_retry_policy(
        mut self,
        max_retries: u32,
        initial_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        self.max_retries = max_retries;
        self.initial_backoff = initial_backoff;
        self.max_backoff = max_backoff;
        self
    }

    pub async fn send_message(
        &self,
        request: &MessageRequest,
    ) -> Result<MessageResponse, ApiError> {
        let request = MessageRequest {
            stream: false,
            ..request.clone()
        };
        let response = self.send_with_retry(&request).await?;
        let request_id = request_id_from_headers(response.headers());
        let payload = response.json::<ChatCompletionResponse>().await?;
        let mut normalized = normalize_response(&request.model, payload)?;
        if normalized.request_id.is_none() {
            normalized.request_id = request_id;
        }
        Ok(normalized)
    }

    pub async fn stream_message(
        &self,
        request: &MessageRequest,
    ) -> Result<MessageStream, ApiError> {
        let response = self
            .send_with_retry(&request.clone().with_streaming())
            .await?;
        Ok(MessageStream {
            request_id: request_id_from_headers(response.headers()),
            response,
            parser: OpenAiSseParser::new(),
            pending: VecDeque::new(),
            done: false,
            state: StreamState::new(request.model.clone()),
        })
    }

    async fn send_with_retry(
        &self,
        request: &MessageRequest,
    ) -> Result<reqwest::Response, ApiError> {
        let mut attempts = 0;

        let last_error = loop {
            attempts += 1;
            let retryable_error = match self.send_raw_request(request).await {
                Ok(response) => match expect_success(response).await {
                    Ok(response) => return Ok(response),
                    Err(error) if error.is_retryable() && attempts <= self.max_retries + 1 => error,
                    Err(error) => return Err(error),
                },
                Err(error) if error.is_retryable() && attempts <= self.max_retries + 1 => error,
                Err(error) => return Err(error),
            };

            if attempts > self.max_retries {
                break retryable_error;
            }

            tokio::time::sleep(self.backoff_for_attempt(attempts)?).await;
        };

        Err(ApiError::RetriesExhausted {
            attempts,
            last_error: Box::new(last_error),
        })
    }

    async fn send_raw_request(
        &self,
        request: &MessageRequest,
    ) -> Result<reqwest::Response, ApiError> {
        let request_url = chat_completions_endpoint(&self.base_url);
        let is_deepseek = self.base_url.contains("deepseek");
        self.http
            .post(&request_url)
            .header("content-type", "application/json")
            .bearer_auth(&self.api_key)
            .json(&build_chat_completion_request(request, is_deepseek))
            .send()
            .await
            .map_err(ApiError::from)
    }

    fn backoff_for_attempt(&self, attempt: u32) -> Result<Duration, ApiError> {
        let Some(multiplier) = 1_u32.checked_shl(attempt.saturating_sub(1)) else {
            return Err(ApiError::BackoffOverflow {
                attempt,
                base_delay: self.initial_backoff,
            });
        };
        Ok(self
            .initial_backoff
            .checked_mul(multiplier)
            .map_or(self.max_backoff, |delay| delay.min(self.max_backoff)))
    }
}

impl Provider for OpenAiCompatClient {
    type Stream = MessageStream;

    fn send_message<'a>(
        &'a self,
        request: &'a MessageRequest,
    ) -> ProviderFuture<'a, MessageResponse> {
        Box::pin(async move { self.send_message(request).await })
    }

    fn stream_message<'a>(
        &'a self,
        request: &'a MessageRequest,
    ) -> ProviderFuture<'a, Self::Stream> {
        Box::pin(async move { self.stream_message(request).await })
    }
}

#[derive(Debug)]
pub struct MessageStream {
    request_id: Option<String>,
    response: reqwest::Response,
    parser: OpenAiSseParser,
    pending: VecDeque<StreamEvent>,
    done: bool,
    state: StreamState,
}

impl MessageStream {
    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    pub async fn next_event(&mut self) -> Result<Option<StreamEvent>, ApiError> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }

            if self.done {
                self.pending.extend(self.state.finish()?);
                if let Some(event) = self.pending.pop_front() {
                    return Ok(Some(event));
                }
                return Ok(None);
            }

            match self.response.chunk().await? {
                Some(chunk) => {
                    for parsed in self.parser.push(&chunk)? {
                        self.pending.extend(self.state.ingest_chunk(parsed)?);
                    }
                }
                None => {
                    self.done = true;
                }
            }
        }
    }
}

#[derive(Debug, Default)]
struct OpenAiSseParser {
    buffer: Vec<u8>,
}

impl OpenAiSseParser {
    fn new() -> Self {
        Self::default()
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<ChatCompletionChunk>, ApiError> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();

        while let Some(frame) = next_sse_frame(&mut self.buffer) {
            if let Some(event) = parse_sse_frame(&frame)? {
                events.push(event);
            }
        }

        Ok(events)
    }
}

#[derive(Debug)]
struct StreamState {
    model: String,
    message_started: bool,
    /// DeepSeek emits reasoning_content BEFORE content, so the reasoning
    /// block always lands at index 0 when present. `text_index` shifts
    /// to 1 in that case so the two blocks don't collide.
    reasoning_started: bool,
    reasoning_finished: bool,
    text_started: bool,
    text_finished: bool,
    finished: bool,
    stop_reason: Option<String>,
    usage: Option<Usage>,
    tool_calls: BTreeMap<u32, ToolCallState>,
}

impl StreamState {
    fn new(model: String) -> Self {
        Self {
            model,
            message_started: false,
            reasoning_started: false,
            reasoning_finished: false,
            text_started: false,
            text_finished: false,
            finished: false,
            stop_reason: None,
            usage: None,
            tool_calls: BTreeMap::new(),
        }
    }

    /// Block index for the text content block — shifted to 1 when a
    /// reasoning block precedes it, 0 otherwise.
    fn text_block_index(&self) -> u32 {
        if self.reasoning_started { 1 } else { 0 }
    }

    /// Block index for tool-call N — depends on whether reasoning and/or
    /// text occupied earlier slots. Provider emits tool calls last
    /// (after both reasoning and content), so `tool_offset_base` lets
    /// us slot them in cleanly.
    fn tool_block_offset(&self) -> u32 {
        let mut offset = 0;
        if self.reasoning_started {
            offset += 1;
        }
        if self.text_started {
            offset += 1;
        }
        offset
    }

    fn ingest_chunk(&mut self, chunk: ChatCompletionChunk) -> Result<Vec<StreamEvent>, ApiError> {
        let mut events = Vec::new();
        if !self.message_started {
            self.message_started = true;
            events.push(StreamEvent::MessageStart(MessageStartEvent {
                message: MessageResponse {
                    id: chunk.id.clone(),
                    kind: "message".to_string(),
                    role: "assistant".to_string(),
                    content: Vec::new(),
                    model: chunk.model.clone().unwrap_or_else(|| self.model.clone()),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: Usage {
                        input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        output_tokens: 0,
                    },
                    request_id: None,
                },
            }));
        }

        if let Some(usage) = chunk.usage {
            self.usage = Some(Usage {
                input_tokens: usage.prompt_tokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: usage.completion_tokens,
            });
        }

        for choice in chunk.choices {
            // DeepSeek streams reasoning_content BEFORE content. Open a
            // Thinking block at index 0 the moment we see it, then
            // close it when text begins (or when the stream ends with
            // no text at all, which can happen on tool-only turns).
            if let Some(reasoning) = choice
                .delta
                .reasoning_content
                .filter(|value| !value.is_empty())
            {
                if !self.reasoning_started {
                    self.reasoning_started = true;
                    events.push(StreamEvent::ContentBlockStart(ContentBlockStartEvent {
                        index: 0,
                        content_block: OutputContentBlock::Thinking {
                            thinking: String::new(),
                            signature: None,
                        },
                    }));
                }
                events.push(StreamEvent::ContentBlockDelta(ContentBlockDeltaEvent {
                    index: 0,
                    delta: ContentBlockDelta::ThinkingDelta { thinking: reasoning },
                }));
            }

            if let Some(content) = choice.delta.content.filter(|value| !value.is_empty()) {
                // First content delta closes the reasoning block (if
                // any) and opens the text block.
                if self.reasoning_started && !self.reasoning_finished {
                    self.reasoning_finished = true;
                    events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                        index: 0,
                    }));
                }
                let text_idx = self.text_block_index();
                if !self.text_started {
                    self.text_started = true;
                    events.push(StreamEvent::ContentBlockStart(ContentBlockStartEvent {
                        index: text_idx,
                        content_block: OutputContentBlock::Text {
                            text: String::new(),
                        },
                    }));
                }
                events.push(StreamEvent::ContentBlockDelta(ContentBlockDeltaEvent {
                    index: text_idx,
                    delta: ContentBlockDelta::TextDelta { text: content },
                }));
            }

            for tool_call in choice.delta.tool_calls {
                // Capture the current offset BEFORE entering the map so
                // first-time tool entries get a stable block index even
                // if reasoning happened to start in the same chunk.
                let offset_now = self.tool_block_offset();
                let state = self.tool_calls.entry(tool_call.index).or_default();
                if !state.started && state.block_offset == 0 {
                    // First sighting — bake in the current offset. Tool
                    // calls that arrive AFTER reasoning + text get
                    // shifted accordingly; without this they'd collide
                    // with the text block at index 1.
                    state.block_offset = offset_now;
                }
                state.apply(tool_call);
                let block_index = state.block_index();
                if !state.started {
                    if let Some(start_event) = state.start_event()? {
                        state.started = true;
                        events.push(StreamEvent::ContentBlockStart(start_event));
                    } else {
                        continue;
                    }
                }
                if let Some(delta_event) = state.delta_event() {
                    events.push(StreamEvent::ContentBlockDelta(delta_event));
                }
                if choice.finish_reason.as_deref() == Some("tool_calls") && !state.stopped {
                    state.stopped = true;
                    events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                        index: block_index,
                    }));
                }
            }

            if let Some(finish_reason) = choice.finish_reason {
                self.stop_reason = Some(normalize_finish_reason(&finish_reason));
                if finish_reason == "tool_calls" {
                    for state in self.tool_calls.values_mut() {
                        if state.started && !state.stopped {
                            state.stopped = true;
                            events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                                index: state.block_index(),
                            }));
                        }
                    }
                }
            }
        }

        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ApiError> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.finished = true;

        let mut events = Vec::new();
        // Close the reasoning block if it ran to end-of-stream without
        // any text following (e.g. a tool-only turn where DeepSeek
        // thought then directly called a tool — reasoning_finished
        // would still be false because no `content` delta arrived to
        // trigger the close).
        if self.reasoning_started && !self.reasoning_finished {
            self.reasoning_finished = true;
            events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                index: 0,
            }));
        }
        if self.text_started && !self.text_finished {
            self.text_finished = true;
            events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                index: self.text_block_index(),
            }));
        }

        for state in self.tool_calls.values_mut() {
            if !state.started {
                if let Some(start_event) = state.start_event()? {
                    state.started = true;
                    events.push(StreamEvent::ContentBlockStart(start_event));
                    if let Some(delta_event) = state.delta_event() {
                        events.push(StreamEvent::ContentBlockDelta(delta_event));
                    }
                }
            }
            if state.started && !state.stopped {
                state.stopped = true;
                events.push(StreamEvent::ContentBlockStop(ContentBlockStopEvent {
                    index: state.block_index(),
                }));
            }
        }

        if self.message_started {
            events.push(StreamEvent::MessageDelta(MessageDeltaEvent {
                delta: MessageDelta {
                    stop_reason: Some(
                        self.stop_reason
                            .clone()
                            .unwrap_or_else(|| "end_turn".to_string()),
                    ),
                    stop_sequence: None,
                },
                usage: self.usage.clone().unwrap_or(Usage {
                    input_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    output_tokens: 0,
                }),
            }));
            events.push(StreamEvent::MessageStop(MessageStopEvent {}));
        }
        Ok(events)
    }
}

#[derive(Debug, Default)]
struct ToolCallState {
    openai_index: u32,
    /// Captured at creation time from `StreamState::tool_block_offset()`
    /// so the absolute block index stays stable across deltas even if
    /// the stream-level offset would change later.
    block_offset: u32,
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    emitted_len: usize,
    started: bool,
    stopped: bool,
}

impl ToolCallState {
    fn apply(&mut self, tool_call: DeltaToolCall) {
        self.openai_index = tool_call.index;
        if let Some(id) = tool_call.id {
            self.id = Some(id);
        }
        if let Some(name) = tool_call.function.name {
            self.name = Some(name);
        }
        if let Some(arguments) = tool_call.function.arguments {
            self.arguments.push_str(&arguments);
        }
    }

    const fn block_index(&self) -> u32 {
        self.openai_index + self.block_offset
    }

    fn start_event(&self) -> Result<Option<ContentBlockStartEvent>, ApiError> {
        let Some(name) = self.name.clone() else {
            return Ok(None);
        };
        let id = self
            .id
            .clone()
            .unwrap_or_else(|| format!("tool_call_{}", self.openai_index));
        Ok(Some(ContentBlockStartEvent {
            index: self.block_index(),
            content_block: OutputContentBlock::ToolUse {
                id,
                name,
                input: json!({}),
            },
        }))
    }

    fn delta_event(&mut self) -> Option<ContentBlockDeltaEvent> {
        if self.emitted_len >= self.arguments.len() {
            return None;
        }
        let delta = self.arguments[self.emitted_len..].to_string();
        self.emitted_len = self.arguments.len();
        Some(ContentBlockDeltaEvent {
            index: self.block_index(),
            delta: ContentBlockDelta::InputJsonDelta {
                partial_json: delta,
            },
        })
    }
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    id: String,
    model: String,
    choices: Vec<ChatChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    role: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ResponseToolCall>,
}

#[derive(Debug, Deserialize)]
struct ResponseToolCall {
    id: String,
    function: ResponseToolFunction,
}

#[derive(Debug, Deserialize)]
struct ResponseToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChunk {
    id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    delta: ChunkDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    /// DeepSeek streams its chain-of-thought here in chunks, separate
    /// from the user-visible `content`. The field is absent in non-
    /// thinking responses and on providers that don't support it; the
    /// default keeps deserialisation tolerant.
    #[serde(default, rename = "reasoning_content")]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<DeltaToolCall>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCall {
    #[serde(default)]
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: DeltaFunction,
}

#[derive(Debug, Default, Deserialize)]
struct DeltaFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    #[serde(rename = "type")]
    error_type: Option<String>,
    message: Option<String>,
}

fn build_chat_completion_request(request: &MessageRequest, _is_deepseek: bool) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = request.system.as_ref().filter(|value| !value.is_empty()) {
        messages.push(json!({
            "role": "system",
            "content": system,
        }));
    }
    for message in &request.messages {
        messages.extend(translate_message(message));
    }

    // `openai-compat/<real-model>` is our dispatch convention — the
    // upstream LLM only wants the bare model id, so strip the prefix
    // before writing it into the wire payload.
    let upstream_model = super::strip_openai_compat_prefix(&request.model);

    let mut payload = json!({
        "model": upstream_model,
        "max_tokens": request.max_tokens,
        "messages": messages,
        "stream": request.stream,
    });

    if let Some(tools) = &request.tools {
        payload["tools"] =
            Value::Array(tools.iter().map(openai_tool_definition).collect::<Vec<_>>());
    }
    if let Some(tool_choice) = &request.tool_choice {
        payload["tool_choice"] = openai_tool_choice(tool_choice);
    }

    // DeepSeek v4 returns `reasoning_content` alongside `content` and
    // expects those blocks echoed back on subsequent assistant messages.
    // We now serialise Reasoning blocks → `reasoning_content` in
    // translate_message and parse them back on the stream side, so the
    // old `thinking:{type:disabled}` workaround is no longer needed.

    payload
}

fn translate_message(message: &InputMessage) -> Vec<Value> {
    match message.role.as_str() {
        "assistant" => {
            let mut text = String::new();
            let mut reasoning = String::new();
            let mut tool_calls = Vec::new();
            for block in &message.content {
                match block {
                    InputContentBlock::Text { text: value } => text.push_str(value),
                    InputContentBlock::Thinking { thinking, .. } => {
                        reasoning.push_str(thinking);
                    }
                    InputContentBlock::ToolUse { id, name, input } => tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": input.to_string(),
                        }
                    })),
                    InputContentBlock::ToolResult { .. } => {}
                    // Assistant role doesn't emit image attachments — skip
                    // silently if the runtime ever produces one.
                    InputContentBlock::Image { .. } => {}
                }
            }
            if text.is_empty() && tool_calls.is_empty() && reasoning.is_empty() {
                Vec::new()
            } else {
                // OpenAI spec: assistant messages need `content` OR
                // `tool_calls` (or both, when both present). An empty
                // `tool_calls: []` is invalid and DeepSeek rejects it
                // with "Invalid 'messages[N].tool_calls': empty array."
                // Same for `content: null` on some stricter providers —
                // omit fields entirely when they'd be empty/null.
                let mut obj = serde_json::Map::new();
                obj.insert("role".to_string(), Value::String("assistant".to_string()));
                if !text.is_empty() {
                    obj.insert("content".to_string(), Value::String(text));
                }
                if !tool_calls.is_empty() {
                    obj.insert("tool_calls".to_string(), Value::Array(tool_calls));
                }
                // `reasoning_content` is the DeepSeek-specific field
                // that lets multi-turn tool use stay coherent. OpenAI
                // / Anthropic-compat providers silently ignore unknown
                // fields, so emitting it unconditionally is safe; a
                // future per-provider strip can specialise if needed.
                if !reasoning.is_empty() {
                    obj.insert(
                        "reasoning_content".to_string(),
                        Value::String(reasoning),
                    );
                }
                vec![Value::Object(obj)]
            }
        }
        _ => {
            // Collect user-facing content (text + images) into a single
            // message, then emit tool_result blocks as separate `role: tool`
            // messages. OpenAI's chat-completions spec requires array-form
            // content for any image; we keep the simple string form for the
            // common text-only case to minimise churn and stay friendly to
            // providers (like deepseek) that only parse the simple shape.
            let mut user_parts: Vec<Value> = Vec::new();
            let mut tool_msgs: Vec<Value> = Vec::new();
            for block in &message.content {
                match block {
                    InputContentBlock::Text { text } => {
                        user_parts.push(json!({"type": "text", "text": text}));
                    }
                    InputContentBlock::Image { source } => {
                        user_parts.push(json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!(
                                    "data:{};base64,{}",
                                    source.media_type, source.data
                                ),
                            },
                        }));
                    }
                    InputContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => tool_msgs.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_use_id,
                        "content": flatten_tool_result_content(content),
                        "is_error": is_error,
                    })),
                    InputContentBlock::ToolUse { .. } => {}
                    // Thinking blocks are an assistant-only concept; if
                    // one ever shows up under user/tool role we drop it
                    // silently rather than fail the request.
                    InputContentBlock::Thinking { .. } => {}
                }
            }
            let mut out = Vec::new();
            if !user_parts.is_empty() {
                let only_text =
                    user_parts.iter().all(|p| p.get("type").and_then(Value::as_str) == Some("text"));
                let content_value = if only_text {
                    // Concatenate text parts back into a single string for
                    // wire-compat with the simple chat-completions schema.
                    let combined = user_parts
                        .iter()
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("");
                    Value::String(combined)
                } else {
                    Value::Array(user_parts)
                };
                out.push(json!({
                    "role": "user",
                    "content": content_value,
                }));
            }
            out.extend(tool_msgs);
            out
        }
    }
}

fn flatten_tool_result_content(content: &[ToolResultContentBlock]) -> String {
    content
        .iter()
        .map(|block| match block {
            ToolResultContentBlock::Text { text } => text.clone(),
            ToolResultContentBlock::Json { value } => value.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn openai_tool_definition(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema,
        }
    })
}

fn openai_tool_choice(tool_choice: &ToolChoice) -> Value {
    match tool_choice {
        ToolChoice::Auto => Value::String("auto".to_string()),
        ToolChoice::Any => Value::String("required".to_string()),
        ToolChoice::Tool { name } => json!({
            "type": "function",
            "function": { "name": name },
        }),
    }
}

fn normalize_response(
    model: &str,
    response: ChatCompletionResponse,
) -> Result<MessageResponse, ApiError> {
    let choice = response
        .choices
        .into_iter()
        .next()
        .ok_or(ApiError::InvalidSseFrame(
            "chat completion response missing choices",
        ))?;
    let mut content = Vec::new();
    if let Some(text) = choice.message.content.filter(|value| !value.is_empty()) {
        content.push(OutputContentBlock::Text { text });
    }
    for tool_call in choice.message.tool_calls {
        content.push(OutputContentBlock::ToolUse {
            id: tool_call.id,
            name: tool_call.function.name,
            input: parse_tool_arguments(&tool_call.function.arguments),
        });
    }

    Ok(MessageResponse {
        id: response.id,
        kind: "message".to_string(),
        role: choice.message.role,
        content,
        model: response.model.if_empty_then(model.to_string()),
        stop_reason: choice
            .finish_reason
            .map(|value| normalize_finish_reason(&value)),
        stop_sequence: None,
        usage: Usage {
            input_tokens: response
                .usage
                .as_ref()
                .map_or(0, |usage| usage.prompt_tokens),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: response
                .usage
                .as_ref()
                .map_or(0, |usage| usage.completion_tokens),
        },
        request_id: None,
    })
}

fn parse_tool_arguments(arguments: &str) -> Value {
    serde_json::from_str(arguments).unwrap_or_else(|_| json!({ "raw": arguments }))
}

fn next_sse_frame(buffer: &mut Vec<u8>) -> Option<String> {
    let separator = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| (position, 2))
        .or_else(|| {
            buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| (position, 4))
        })?;

    let (position, separator_len) = separator;
    let frame = buffer.drain(..position + separator_len).collect::<Vec<_>>();
    let frame_len = frame.len().saturating_sub(separator_len);
    Some(String::from_utf8_lossy(&frame[..frame_len]).into_owned())
}

fn parse_sse_frame(frame: &str) -> Result<Option<ChatCompletionChunk>, ApiError> {
    let trimmed = frame.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut data_lines = Vec::new();
    for line in trimmed.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }
    if data_lines.is_empty() {
        return Ok(None);
    }
    let payload = data_lines.join("\n");
    if payload == "[DONE]" {
        return Ok(None);
    }
    serde_json::from_str(&payload)
        .map(Some)
        .map_err(ApiError::from)
}

fn read_env_non_empty(key: &str) -> Result<Option<String>, ApiError> {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(ApiError::from(error)),
    }
}

#[must_use]
pub fn has_api_key(key: &str) -> bool {
    read_env_non_empty(key)
        .ok()
        .and_then(std::convert::identity)
        .is_some()
}

#[must_use]
pub fn read_base_url(config: OpenAiCompatConfig) -> String {
    std::env::var(config.base_url_env).unwrap_or_else(|_| config.default_base_url.to_string())
}

fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn request_id_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(REQUEST_ID_HEADER)
        .or_else(|| headers.get(ALT_REQUEST_ID_HEADER))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

async fn expect_success(response: reqwest::Response) -> Result<reqwest::Response, ApiError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let body = response.text().await.unwrap_or_default();
    let parsed_error = serde_json::from_str::<ErrorEnvelope>(&body).ok();
    let retryable = is_retryable_status(status);

    Err(ApiError::Api {
        status,
        error_type: parsed_error
            .as_ref()
            .and_then(|error| error.error.error_type.clone()),
        message: parsed_error
            .as_ref()
            .and_then(|error| error.error.message.clone()),
        body,
        retryable,
    })
}

const fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 409 | 429 | 500 | 502 | 503 | 504)
}

fn normalize_finish_reason(value: &str) -> String {
    match value {
        "stop" => "end_turn",
        "tool_calls" => "tool_use",
        other => other,
    }
    .to_string()
}

trait StringExt {
    fn if_empty_then(self, fallback: String) -> String;
}

impl StringExt for String {
    fn if_empty_then(self, fallback: String) -> String {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_chat_completion_request, chat_completions_endpoint, normalize_finish_reason,
        openai_tool_choice, parse_tool_arguments, OpenAiCompatClient, OpenAiCompatConfig,
    };
    use crate::error::ApiError;
    use crate::types::{
        InputContentBlock, InputMessage, MessageRequest, ToolChoice, ToolDefinition,
        ToolResultContentBlock,
    };
    use serde_json::json;
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn request_translation_uses_openai_compatible_shape() {
        let payload = build_chat_completion_request(
            &MessageRequest {
                model: "grok-3".to_string(),
                max_tokens: 64,
                messages: vec![InputMessage {
                    role: "user".to_string(),
                    content: vec![
                        InputContentBlock::Text {
                            text: "hello".to_string(),
                        },
                        InputContentBlock::ToolResult {
                            tool_use_id: "tool_1".to_string(),
                            content: vec![ToolResultContentBlock::Json {
                                value: json!({"ok": true}),
                            }],
                            is_error: false,
                        },
                    ],
                }],
                system: Some("be helpful".to_string()),
                tools: Some(vec![ToolDefinition {
                    name: "weather".to_string(),
                    description: Some("Get weather".to_string()),
                    input_schema: json!({"type": "object"}),
                }]),
                tool_choice: Some(ToolChoice::Auto),
                stream: false,
            },
            false,
        );

        assert_eq!(payload["messages"][0]["role"], json!("system"));
        assert_eq!(payload["messages"][1]["role"], json!("user"));
        assert_eq!(payload["messages"][2]["role"], json!("tool"));
        assert_eq!(payload["tools"][0]["type"], json!("function"));
        assert_eq!(payload["tool_choice"], json!("auto"));
        assert!(payload.get("thinking").is_none());
    }

    #[test]
    fn deepseek_request_no_longer_injects_thinking_disabled() {
        // Regression: we used to inject `thinking:{type:disabled}` for
        // DeepSeek as a workaround for not handling reasoning_content.
        // Now that the full roundtrip is wired, the payload must NOT
        // carry that override — reasoning is allowed to flow.
        let payload = build_chat_completion_request(
            &MessageRequest {
                model: "deepseek-v4-flash".to_string(),
                max_tokens: 64,
                messages: vec![InputMessage {
                    role: "user".to_string(),
                    content: vec![InputContentBlock::Text {
                        text: "hi".to_string(),
                    }],
                }],
                system: None,
                tools: None,
                tool_choice: None,
                stream: false,
            },
            true,
        );

        assert!(
            payload.get("thinking").is_none(),
            "thinking override must be absent so reasoning_content can flow; got: {payload}"
        );
    }

    #[test]
    fn assistant_thinking_block_round_trips_as_reasoning_content() {
        // An assistant history entry with a Thinking block should
        // serialise to a DeepSeek-compatible `reasoning_content` field
        // alongside the regular `content`. Without this, sending the
        // history back on the next turn loses the reasoning trail and
        // DeepSeek complains about inconsistent multi-turn tool use.
        let payload = build_chat_completion_request(
            &MessageRequest {
                model: "deepseek-v4-pro".to_string(),
                max_tokens: 64,
                messages: vec![InputMessage {
                    role: "assistant".to_string(),
                    content: vec![
                        InputContentBlock::Thinking {
                            thinking: "let me think about this...".to_string(),
                            signature: None,
                        },
                        InputContentBlock::Text {
                            text: "the answer is 42".to_string(),
                        },
                    ],
                }],
                system: None,
                tools: None,
                tool_choice: None,
                stream: false,
            },
            true,
        );

        let asst = &payload["messages"][0];
        assert_eq!(asst["role"], json!("assistant"));
        assert_eq!(asst["content"], json!("the answer is 42"));
        assert_eq!(
            asst["reasoning_content"],
            json!("let me think about this..."),
            "Thinking block must surface as reasoning_content; got: {asst}"
        );
    }

    #[test]
    fn image_content_is_translated_to_image_url_data_uri() {
        // claw stores images in Anthropic shape (Image { source: ... }); the
        // OpenAI-compatible path should rewrite to {type: "image_url",
        // image_url: {url: "data:..."}} with the base64 inlined.
        let payload = build_chat_completion_request(
            &MessageRequest {
                model: "deepseek-chat".to_string(),
                max_tokens: 64,
                messages: vec![InputMessage {
                    role: "user".to_string(),
                    content: vec![
                        InputContentBlock::Text {
                            text: "describe this".to_string(),
                        },
                        InputContentBlock::Image {
                            source: crate::types::ImageSource {
                                kind: "base64".to_string(),
                                media_type: "image/png".to_string(),
                                data: "AAAA".to_string(),
                            },
                        },
                    ],
                }],
                system: None,
                tools: None,
                tool_choice: None,
                stream: false,
            },
            false,
        );

        let user_msg = &payload["messages"][0];
        assert_eq!(user_msg["role"], json!("user"));
        let parts = user_msg["content"].as_array().expect("array content");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], json!("text"));
        assert_eq!(parts[0]["text"], json!("describe this"));
        assert_eq!(parts[1]["type"], json!("image_url"));
        assert_eq!(
            parts[1]["image_url"]["url"],
            json!("data:image/png;base64,AAAA")
        );
    }

    #[test]
    fn assistant_message_omits_empty_tool_calls() {
        // Regression: text-only assistant turn used to emit
        // `"tool_calls": []`, which DeepSeek (and other stricter
        // OpenAI-compat backends) reject with "Invalid messages[N].
        // tool_calls: empty array". The field must be absent.
        let payload = build_chat_completion_request(
            &MessageRequest {
                model: "deepseek-v4-flash".to_string(),
                max_tokens: 64,
                messages: vec![InputMessage {
                    role: "assistant".to_string(),
                    content: vec![InputContentBlock::Text {
                        text: "just a text reply, no tools".to_string(),
                    }],
                }],
                system: None,
                tools: None,
                tool_choice: None,
                stream: false,
            },
            true,
        );

        let asst = &payload["messages"][0];
        assert_eq!(asst["role"], json!("assistant"));
        assert_eq!(asst["content"], json!("just a text reply, no tools"));
        // The critical bit: tool_calls must NOT be present (rather than
        // present-and-empty).
        assert!(
            asst.get("tool_calls").is_none(),
            "tool_calls must be omitted on text-only assistant turns; got: {asst}"
        );
    }

    #[test]
    fn assistant_message_with_tool_calls_omits_null_content() {
        // Mirror case: a tool_use-only assistant turn (no preamble
        // text) must not emit `"content": null` either, since the same
        // strict providers reject that. Only the fields actually
        // populated should appear.
        let payload = build_chat_completion_request(
            &MessageRequest {
                model: "deepseek-v4-flash".to_string(),
                max_tokens: 64,
                messages: vec![InputMessage {
                    role: "assistant".to_string(),
                    content: vec![InputContentBlock::ToolUse {
                        id: "call_1".to_string(),
                        name: "weather".to_string(),
                        input: serde_json::json!({"city": "Paris"}),
                    }],
                }],
                system: None,
                tools: None,
                tool_choice: None,
                stream: false,
            },
            true,
        );

        let asst = &payload["messages"][0];
        assert_eq!(asst["role"], json!("assistant"));
        assert!(
            asst.get("content").is_none(),
            "content must be omitted when there's only tool_use; got: {asst}"
        );
        assert!(asst["tool_calls"].is_array());
        assert_eq!(asst["tool_calls"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn tool_choice_translation_supports_required_function() {
        assert_eq!(openai_tool_choice(&ToolChoice::Any), json!("required"));
        assert_eq!(
            openai_tool_choice(&ToolChoice::Tool {
                name: "weather".to_string(),
            }),
            json!({"type": "function", "function": {"name": "weather"}})
        );
    }

    #[test]
    fn parses_tool_arguments_fallback() {
        assert_eq!(
            parse_tool_arguments("{\"city\":\"Paris\"}"),
            json!({"city": "Paris"})
        );
        assert_eq!(parse_tool_arguments("not-json"), json!({"raw": "not-json"}));
    }

    #[test]
    fn missing_xai_api_key_is_provider_specific() {
        let _lock = env_lock();
        std::env::remove_var("XAI_API_KEY");
        let error = OpenAiCompatClient::from_env(OpenAiCompatConfig::xai())
            .expect_err("missing key should error");
        assert!(matches!(
            error,
            ApiError::MissingCredentials {
                provider: "xAI",
                ..
            }
        ));
    }

    #[test]
    fn endpoint_builder_accepts_base_urls_and_full_endpoints() {
        assert_eq!(
            chat_completions_endpoint("https://api.x.ai/v1"),
            "https://api.x.ai/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://api.x.ai/v1/"),
            "https://api.x.ai/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://api.x.ai/v1/chat/completions"),
            "https://api.x.ai/v1/chat/completions"
        );
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock")
    }

    #[test]
    fn normalizes_stop_reasons() {
        assert_eq!(normalize_finish_reason("stop"), "end_turn");
        assert_eq!(normalize_finish_reason("tool_calls"), "tool_use");
    }
}
