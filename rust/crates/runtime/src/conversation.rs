use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};

use crate::compact::{
    compact_session, estimate_session_tokens, CompactionConfig, CompactionResult,
};
use crate::config::RuntimeFeatureConfig;
use crate::hooks::{HookRunResult, HookRunner};
use crate::permissions::{PermissionOutcome, PermissionPolicy, PermissionPrompter};
use crate::questions::{UserQuestionAnswer, UserQuestionOption, UserQuestionRequest, UserQuestioner};
use crate::session::{ContentBlock, ConversationMessage, Session};
use crate::usage::{TokenUsage, UsageTracker};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiRequest {
    pub system_prompt: Vec<String>,
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssistantEvent {
    TextDelta(String),
    /// Chunk of model reasoning (DeepSeek `reasoning_content`,
    /// Anthropic native `thinking`). Streamed before TextDelta when the
    /// provider supports it. Accumulated into a single Reasoning
    /// ContentBlock at message-build time.
    ReasoningDelta(String),
    ToolUse {
        id: String,
        name: String,
        input: String,
    },
    Usage(TokenUsage),
    MessageStop,
}

pub trait ApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError>;
}

pub trait ToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    message: String,
}

impl ToolError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for ToolError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ToolError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeError {
    message: String,
}

impl RuntimeError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for RuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RuntimeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSummary {
    pub assistant_messages: Vec<ConversationMessage>,
    pub tool_results: Vec<ConversationMessage>,
    pub iterations: usize,
    pub usage: TokenUsage,
}

/// Observes the conversation as it progresses inside `run_turn`. The runtime calls
/// `on_message` immediately after appending an assistant or tool-result message to the
/// session, so an observer can stream incremental state (e.g. write back to a server
/// session store, broadcast SSE events) without waiting for the whole turn to finish.
pub trait TurnObserver: Send {
    fn on_message(&mut self, _message: &ConversationMessage) {}

    /// Optional hook to expose a per-delta observer the provider client
    /// can call as TextDelta / ReasoningDelta events arrive — before the
    /// turn loop finishes consuming the full stream. Used by the server
    /// to broadcast `assistant_delta` / `reasoning_delta` SSE in real
    /// time. Implementations that don't need streaming return `None`.
    fn delta_observer(&self) -> Option<std::sync::Arc<dyn Fn(&AssistantEvent) + Send + Sync>> {
        None
    }

    /// Optional shared cancel flag the runtime polls at iter boundaries.
    /// External callers (e.g. server's `/cancel` HTTP handler) flip this
    /// to `true`; the loop sees it on its next iteration check and
    /// closes the turn with a synthetic "cancelled" stop message. This
    /// is the only reliable way to stop a `spawn_blocking` turn since
    /// tokio's `.abort()` can't pre-empt OS threads.
    fn cancel_signal(&self) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        None
    }
}

pub struct ConversationRuntime<C, T> {
    session: Session,
    api_client: C,
    tool_executor: T,
    permission_policy: PermissionPolicy,
    system_prompt: Vec<String>,
    max_iterations: usize,
    usage_tracker: UsageTracker,
    hook_runner: HookRunner,
    observer: Option<Box<dyn TurnObserver>>,
    /// Model name to tag onto each assistant message that carries usage.
    /// `None` for fallback/echo configurations where there's no meaningful
    /// model identifier; the resulting usage rows show up under "unknown"
    /// in the aggregated view.
    model: Option<String>,
    /// Cooperative cancellation flag checked at each iteration boundary.
    /// `tokio::spawn_blocking` can't be aborted from outside, so the
    /// only way to stop a runaway turn in finite time is to have the
    /// loop itself check this signal and bail. The server flips this
    /// when the user hits cancel; the loop closes with a synthetic
    /// "cancelled" stop notice on the next iter check.
    cancel_signal: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// Pluggable handler for the `AskUser` tool. When set, AskUser calls
    /// are intercepted in the tool dispatch loop and routed here instead
    /// of the regular tool_executor; the answer is fed back as a normal
    /// `tool_result`. When `None` (e.g. headless CLI), AskUser calls
    /// surface a clean error and the model gets to recover.
    questioner: Option<Box<dyn UserQuestioner>>,
}

impl<C, T> ConversationRuntime<C, T>
where
    C: ApiClient,
    T: ToolExecutor,
{
    #[must_use]
    pub fn new(
        session: Session,
        api_client: C,
        tool_executor: T,
        permission_policy: PermissionPolicy,
        system_prompt: Vec<String>,
    ) -> Self {
        Self::new_with_features(
            session,
            api_client,
            tool_executor,
            permission_policy,
            system_prompt,
            RuntimeFeatureConfig::default(),
        )
    }

    #[must_use]
    pub fn new_with_features(
        session: Session,
        api_client: C,
        tool_executor: T,
        permission_policy: PermissionPolicy,
        system_prompt: Vec<String>,
        feature_config: RuntimeFeatureConfig,
    ) -> Self {
        let usage_tracker = UsageTracker::from_session(&session);
        Self {
            session,
            api_client,
            tool_executor,
            permission_policy,
            system_prompt,
            max_iterations: usize::MAX,
            usage_tracker,
            hook_runner: HookRunner::from_feature_config(&feature_config),
            observer: None,
            model: None,
            cancel_signal: None,
            questioner: None,
        }
    }

    #[must_use]
    pub fn with_model(mut self, model: Option<String>) -> Self {
        self.model = model;
        self
    }

    #[must_use]
    pub fn with_cancel_signal(
        mut self,
        signal: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        self.cancel_signal = Some(signal);
        self
    }

    #[must_use]
    pub fn with_observer(mut self, observer: Box<dyn TurnObserver>) -> Self {
        // Auto-promote the observer's cancel_signal onto the runtime so
        // callers don't have to wire it twice. Keeps the existing
        // single-`with_observer()` ergonomic.
        if self.cancel_signal.is_none() {
            self.cancel_signal = observer.cancel_signal();
        }
        self.observer = Some(observer);
        self
    }

    #[must_use]
    pub fn with_max_iterations(mut self, max_iterations: usize) -> Self {
        self.max_iterations = max_iterations;
        self
    }

    /// Attach a `UserQuestioner` so the `AskUser` tool can route through
    /// it. Without one, AskUser calls degrade to an error tool_result —
    /// fine for CLI / batch scenarios where there's no human in the
    /// loop, but the model has to recover on its own.
    #[must_use]
    pub fn with_questioner(mut self, questioner: Box<dyn UserQuestioner>) -> Self {
        self.questioner = Some(questioner);
        self
    }

    pub fn run_turn(
        &mut self,
        user_input: impl Into<String>,
        prompter: Option<&mut dyn PermissionPrompter>,
    ) -> Result<TurnSummary, RuntimeError> {
        self.run_turn_with_message(
            ConversationMessage::user_text(user_input.into()),
            prompter,
        )
    }

    /// Same as [`run_turn`] but accepts a pre-built `ConversationMessage`
    /// so callers can attach files (`attachments`) or other metadata that
    /// the simple text constructor doesn't carry.
    pub fn run_turn_with_message(
        &mut self,
        user_message: ConversationMessage,
        mut prompter: Option<&mut dyn PermissionPrompter>,
    ) -> Result<TurnSummary, RuntimeError> {
        self.session.messages.push(user_message);

        let mut assistant_messages = Vec::new();
        let mut tool_results = Vec::new();
        let mut iterations = 0;

        // No-progress detection: if the agent makes the same set of tool
        // calls in NO_PROGRESS_WINDOW consecutive iterations, abort. This
        // catches the common "LLM stuck retrying the same broken call"
        // failure long before the iteration cap (which is set
        // generously) would. We compare a stable signature of the
        // (name, input) pairs in each iteration — iteration-order is
        // preserved because the LLM's own ordering is meaningful.
        const NO_PROGRESS_WINDOW: usize = 3;
        let mut recent_signatures: std::collections::VecDeque<String> =
            std::collections::VecDeque::with_capacity(NO_PROGRESS_WINDOW);

        loop {
            iterations += 1;
            // Cooperative cancel — checked first so a user click during
            // iteration N takes effect at the iter-N+1 boundary instead
            // of running through the whole remaining loop.
            if let Some(signal) = self.cancel_signal.as_ref() {
                if signal.load(std::sync::atomic::Ordering::Relaxed) {
                    let stop_msg = ConversationMessage::assistant(vec![ContentBlock::Text {
                        text: "[stopped] Cancelled by user.".to_string(),
                    }]);
                    self.session.messages.push(stop_msg.clone());
                    if let Some(observer) = self.observer.as_mut() {
                        observer.on_message(&stop_msg);
                    }
                    assistant_messages.push(stop_msg);
                    break;
                }
            }
            if iterations > self.max_iterations {
                // Iter cap is a deliberate safety stop, not an internal
                // error — synthesize an assistant message explaining it
                // and break normally. Lets the SSE pipeline emit a clean
                // turn_finished without an error event, and the user
                // sees the stop in-conversation where they can just reply
                // "continue" to keep going.
                let stop_text = format!(
                    "[stopped] Reached the per-turn iteration cap ({}). The agent did real work but ran longer than this turn's budget allows. Reply if you want me to continue, or raise `max_tool_iterations_per_turn` in settings.",
                    self.max_iterations,
                );
                let stop_msg = ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: stop_text,
                }]);
                self.session.messages.push(stop_msg.clone());
                if let Some(observer) = self.observer.as_mut() {
                    observer.on_message(&stop_msg);
                }
                assistant_messages.push(stop_msg);
                break;
            }

            let request = ApiRequest {
                system_prompt: self.system_prompt.clone(),
                messages: self.session.messages.clone(),
            };
            let events = self.api_client.stream(request)?;
            let (mut assistant_message, usage) = build_assistant_message(events)?;
            if let Some(usage) = usage {
                self.usage_tracker.record(usage);
                // Stamp the model name onto messages that actually got
                // billed; the per-model usage aggregator keys off this.
                // Skipped when no model is configured (echo client / test
                // doubles) — those rows roll up under "unknown".
                if assistant_message.model.is_none() {
                    assistant_message.model = self.model.clone();
                }
            }
            let pending_tool_uses = assistant_message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse { id, name, input } => {
                        Some((id.clone(), name.clone(), input.clone()))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();

            self.session.messages.push(assistant_message.clone());
            if let Some(observer) = self.observer.as_mut() {
                observer.on_message(&assistant_message);
            }
            assistant_messages.push(assistant_message);

            if pending_tool_uses.is_empty() {
                break;
            }

            // Record a signature for this iteration and check whether the
            // last NO_PROGRESS_WINDOW iterations are all identical. We use
            // `name + input` so different argument values count as
            // progress (e.g. polling status with a changing cursor is OK).
            let signature: String = pending_tool_uses
                .iter()
                .map(|(_id, name, input)| format!("{name}\u{1f}{input}"))
                .collect::<Vec<_>>()
                .join("\u{1e}");
            recent_signatures.push_back(signature);
            if recent_signatures.len() > NO_PROGRESS_WINDOW {
                recent_signatures.pop_front();
            }
            if recent_signatures.len() == NO_PROGRESS_WINDOW
                && recent_signatures.iter().all(|s| s == &recent_signatures[0])
            {
                // Treat as a friendly stop rather than an error — same
                // reasoning as the iter cap above. The conversation
                // surface shows what tool kept repeating so the user can
                // decide whether to retry with different framing.
                let stuck_tool = pending_tool_uses
                    .first()
                    .map(|(_, n, _)| n.as_str())
                    .unwrap_or("(unknown)");
                let stop_text = format!(
                    "[stopped] Detected no progress: I called `{stuck_tool}` with the same arguments {NO_PROGRESS_WINDOW} times in a row. Try rephrasing the task or giving me more context.",
                );
                let stop_msg = ConversationMessage::assistant(vec![ContentBlock::Text {
                    text: stop_text,
                }]);
                self.session.messages.push(stop_msg.clone());
                if let Some(observer) = self.observer.as_mut() {
                    observer.on_message(&stop_msg);
                }
                assistant_messages.push(stop_msg);
                break;
            }

            for (tool_use_id, tool_name, input) in pending_tool_uses {
                // AskUser bypasses the regular permission/executor path. It has
                // zero blast radius (it just shows a UI prompt), and routing
                // it through tool_executor would require threading the
                // questioner into every executor — we keep that decoupled.
                if tool_name == "AskUser" {
                    let result_message = handle_ask_user(
                        &tool_use_id,
                        &tool_name,
                        &input,
                        self.questioner.as_mut(),
                    );
                    self.session.messages.push(result_message.clone());
                    if let Some(observer) = self.observer.as_mut() {
                        observer.on_message(&result_message);
                    }
                    tool_results.push(result_message);
                    continue;
                }

                let permission_outcome = if let Some(prompt) = prompter.as_mut() {
                    self.permission_policy
                        .authorize(&tool_name, &input, Some(*prompt))
                } else {
                    self.permission_policy.authorize(&tool_name, &input, None)
                };

                let result_message = match permission_outcome {
                    PermissionOutcome::Allow => {
                        let pre_hook_result = self.hook_runner.run_pre_tool_use(&tool_name, &input);
                        if pre_hook_result.is_denied() {
                            let deny_message = format!("PreToolUse hook denied tool `{tool_name}`");
                            ConversationMessage::tool_result(
                                tool_use_id,
                                tool_name,
                                format_hook_message(&pre_hook_result, &deny_message),
                                true,
                            )
                        } else {
                            let (mut output, mut is_error) =
                                match self.tool_executor.execute(&tool_name, &input) {
                                    Ok(output) => (output, false),
                                    Err(error) => (error.to_string(), true),
                                };
                            output = merge_hook_feedback(pre_hook_result.messages(), output, false);

                            let post_hook_result = self
                                .hook_runner
                                .run_post_tool_use(&tool_name, &input, &output, is_error);
                            if post_hook_result.is_denied() {
                                is_error = true;
                            }
                            output = merge_hook_feedback(
                                post_hook_result.messages(),
                                output,
                                post_hook_result.is_denied(),
                            );

                            ConversationMessage::tool_result(
                                tool_use_id,
                                tool_name,
                                output,
                                is_error,
                            )
                        }
                    }
                    PermissionOutcome::Deny { reason } => {
                        ConversationMessage::tool_result(tool_use_id, tool_name, reason, true)
                    }
                };
                self.session.messages.push(result_message.clone());
                if let Some(observer) = self.observer.as_mut() {
                    observer.on_message(&result_message);
                }
                tool_results.push(result_message);
            }
        }

        Ok(TurnSummary {
            assistant_messages,
            tool_results,
            iterations,
            usage: self.usage_tracker.cumulative_usage(),
        })
    }

    #[must_use]
    pub fn compact(&self, config: CompactionConfig) -> CompactionResult {
        compact_session(&self.session, config)
    }

    #[must_use]
    pub fn estimated_tokens(&self) -> usize {
        estimate_session_tokens(&self.session)
    }

    #[must_use]
    pub fn usage(&self) -> &UsageTracker {
        &self.usage_tracker
    }

    #[must_use]
    pub fn session(&self) -> &Session {
        &self.session
    }

    #[must_use]
    pub fn into_session(self) -> Session {
        self.session
    }
}

/// Translate an AskUser tool_use into a tool_result by routing through
/// the optional UserQuestioner. Stays self-contained (no `&mut self`)
/// because the only state it needs is the questioner reference passed
/// in by the caller — keeping the dispatch loop readable.
fn handle_ask_user(
    tool_use_id: &str,
    tool_name: &str,
    input: &str,
    questioner: Option<&mut Box<dyn UserQuestioner>>,
) -> ConversationMessage {
    let request = match parse_ask_user_input(input) {
        Ok(req) => req,
        Err(err) => {
            return ConversationMessage::tool_result(
                tool_use_id.to_string(),
                tool_name.to_string(),
                format!("AskUser input invalid: {err}"),
                true,
            );
        }
    };

    let Some(q) = questioner else {
        // No human in the loop (CLI / batch). Surface a clean error
        // tool_result so the model can recover by making the decision
        // itself rather than retrying AskUser.
        return ConversationMessage::tool_result(
            tool_use_id.to_string(),
            tool_name.to_string(),
            "AskUser is not available in this client (no interactive prompter wired). \
             Make the decision yourself based on context and proceed."
                .to_string(),
            true,
        );
    };

    let answer = q.as_mut().ask(&request);
    let body = serialize_ask_user_answer(&answer);
    let is_error = matches!(answer, UserQuestionAnswer::Dismissed);
    ConversationMessage::tool_result(
        tool_use_id.to_string(),
        tool_name.to_string(),
        body,
        is_error,
    )
}

fn parse_ask_user_input(raw: &str) -> Result<UserQuestionRequest, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid JSON: {e}"))?;
    let question = value
        .get("question")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "missing required string `question`".to_string())?;
    if question.trim().is_empty() {
        return Err("`question` must not be empty".to_string());
    }
    let header = value
        .get("header")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let allow_other = value
        .get("allow_other")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let mut options = Vec::new();
    if let Some(arr) = value.get("options").and_then(|v| v.as_array()) {
        if arr.len() > 4 {
            return Err("`options` may contain at most 4 entries".to_string());
        }
        for (i, opt) in arr.iter().enumerate() {
            let label = opt
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .ok_or_else(|| format!("options[{i}].label must be a string"))?;
            if label.trim().is_empty() {
                return Err(format!("options[{i}].label must not be empty"));
            }
            let description = opt
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            options.push(UserQuestionOption { label, description });
        }
    }
    // If the model gave neither options nor an "Other" affordance the
    // user has no way to answer — force allow_other on so the UI can
    // at least render a free-text input rather than an unanswerable
    // prompt that only Skip can resolve.
    let allow_other = if options.is_empty() { true } else { allow_other };
    // Header sanity — 12 char cap matches the tool schema. Anything longer
    // gets truncated rather than rejected so a well-meaning model with a
    // slightly-too-long label still gets through.
    let header = header.map(|h| {
        if h.chars().count() > 12 {
            h.chars().take(12).collect()
        } else {
            h
        }
    });
    // Question hard ceiling to match the schema. Truncate rather than
    // reject for the same reason; the model gets a usable prompt instead
    // of an error tool_result for an off-by-one issue.
    const QUESTION_MAX: usize = 300;
    let question = if question.chars().count() > QUESTION_MAX {
        let mut t: String = question.chars().take(QUESTION_MAX - 1).collect();
        t.push('…');
        t
    } else {
        question
    };
    Ok(UserQuestionRequest {
        question,
        header,
        options,
        allow_other,
    })
}

fn serialize_ask_user_answer(answer: &UserQuestionAnswer) -> String {
    let value = match answer {
        UserQuestionAnswer::Selected { index, label } => serde_json::json!({
            "answered": true,
            "selected_index": index,
            "selected_label": label,
        }),
        UserQuestionAnswer::OtherText { text } => serde_json::json!({
            "answered": true,
            "other_text": text,
        }),
        UserQuestionAnswer::Dismissed => serde_json::json!({
            "answered": false,
            "dismissed": true,
            "note": "User dismissed the question without answering. Make a reasonable default and proceed; do not call AskUser again for the same decision.",
        }),
    };
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

fn build_assistant_message(
    events: Vec<AssistantEvent>,
) -> Result<(ConversationMessage, Option<TokenUsage>), RuntimeError> {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut blocks = Vec::new();
    let mut finished = false;
    let mut usage = None;

    for event in events {
        match event {
            AssistantEvent::ReasoningDelta(delta) => reasoning.push_str(&delta),
            AssistantEvent::TextDelta(delta) => {
                // Reasoning ends as soon as user-visible content begins,
                // so flush the accumulated thinking into a block before
                // the text starts collecting. Matches the streaming
                // order DeepSeek emits (reasoning_content → content).
                flush_reasoning_block(&mut reasoning, &mut blocks);
                text.push_str(&delta);
            }
            AssistantEvent::ToolUse { id, name, input } => {
                flush_reasoning_block(&mut reasoning, &mut blocks);
                flush_text_block(&mut text, &mut blocks);
                blocks.push(ContentBlock::ToolUse { id, name, input });
            }
            AssistantEvent::Usage(value) => usage = Some(value),
            AssistantEvent::MessageStop => {
                finished = true;
            }
        }
    }

    flush_reasoning_block(&mut reasoning, &mut blocks);
    flush_text_block(&mut text, &mut blocks);

    if !finished {
        return Err(RuntimeError::new(
            "assistant stream ended without a message stop event",
        ));
    }
    if blocks.is_empty() {
        return Err(RuntimeError::new("assistant stream produced no content"));
    }

    Ok((
        ConversationMessage::assistant_with_usage(blocks, usage),
        usage,
    ))
}

fn flush_text_block(text: &mut String, blocks: &mut Vec<ContentBlock>) {
    if !text.is_empty() {
        blocks.push(ContentBlock::Text {
            text: std::mem::take(text),
        });
    }
}

fn flush_reasoning_block(reasoning: &mut String, blocks: &mut Vec<ContentBlock>) {
    if !reasoning.is_empty() {
        blocks.push(ContentBlock::Reasoning {
            text: std::mem::take(reasoning),
            signature: None,
        });
    }
}

fn format_hook_message(result: &HookRunResult, fallback: &str) -> String {
    if result.messages().is_empty() {
        fallback.to_string()
    } else {
        result.messages().join("\n")
    }
}

fn merge_hook_feedback(messages: &[String], output: String, denied: bool) -> String {
    if messages.is_empty() {
        return output;
    }

    let mut sections = Vec::new();
    if !output.trim().is_empty() {
        sections.push(output);
    }
    let label = if denied {
        "Hook feedback (denied)"
    } else {
        "Hook feedback"
    };
    sections.push(format!("{label}:\n{}", messages.join("\n")));
    sections.join("\n\n")
}

type ToolHandler = Box<dyn FnMut(&str) -> Result<String, ToolError>>;

#[derive(Default)]
pub struct StaticToolExecutor {
    handlers: BTreeMap<String, ToolHandler>,
}

impl StaticToolExecutor {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn register(
        mut self,
        tool_name: impl Into<String>,
        handler: impl FnMut(&str) -> Result<String, ToolError> + 'static,
    ) -> Self {
        self.handlers.insert(tool_name.into(), Box::new(handler));
        self
    }
}

impl ToolExecutor for StaticToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.handlers
            .get_mut(tool_name)
            .ok_or_else(|| ToolError::new(format!("unknown tool: {tool_name}")))?(input)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ApiClient, ApiRequest, AssistantEvent, ConversationRuntime, RuntimeError,
        StaticToolExecutor,
    };
    use crate::compact::CompactionConfig;
    use crate::config::{RuntimeFeatureConfig, RuntimeHookConfig};
    use crate::permissions::{
        PermissionMode, PermissionPolicy, PermissionPromptDecision, PermissionPrompter,
        PermissionRequest,
    };
    use crate::prompt::{ProjectContext, SystemPromptBuilder};
    use crate::session::{ContentBlock, MessageRole, Session};
    use crate::usage::TokenUsage;
    use std::path::PathBuf;

    struct ScriptedApiClient {
        call_count: usize,
    }

    impl ApiClient for ScriptedApiClient {
        fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
            self.call_count += 1;
            match self.call_count {
                1 => {
                    assert!(request
                        .messages
                        .iter()
                        .any(|message| message.role == MessageRole::User));
                    Ok(vec![
                        AssistantEvent::TextDelta("Let me calculate that.".to_string()),
                        AssistantEvent::ToolUse {
                            id: "tool-1".to_string(),
                            name: "add".to_string(),
                            input: "2,2".to_string(),
                        },
                        AssistantEvent::Usage(TokenUsage {
                            input_tokens: 20,
                            output_tokens: 6,
                            cache_creation_input_tokens: 1,
                            cache_read_input_tokens: 2,
                        }),
                        AssistantEvent::MessageStop,
                    ])
                }
                2 => {
                    let last_message = request
                        .messages
                        .last()
                        .expect("tool result should be present");
                    assert_eq!(last_message.role, MessageRole::Tool);
                    Ok(vec![
                        AssistantEvent::TextDelta("The answer is 4.".to_string()),
                        AssistantEvent::Usage(TokenUsage {
                            input_tokens: 24,
                            output_tokens: 4,
                            cache_creation_input_tokens: 1,
                            cache_read_input_tokens: 3,
                        }),
                        AssistantEvent::MessageStop,
                    ])
                }
                _ => Err(RuntimeError::new("unexpected extra API call")),
            }
        }
    }

    struct PromptAllowOnce;

    impl PermissionPrompter for PromptAllowOnce {
        fn decide(&mut self, request: &PermissionRequest) -> PermissionPromptDecision {
            assert_eq!(request.tool_name, "add");
            PermissionPromptDecision::Allow
        }
    }

    #[test]
    fn runs_user_to_tool_to_result_loop_end_to_end_and_tracks_usage() {
        let api_client = ScriptedApiClient { call_count: 0 };
        let tool_executor = StaticToolExecutor::new().register("add", |input| {
            let total = input
                .split(',')
                .map(|part| part.parse::<i32>().expect("input must be valid integer"))
                .sum::<i32>();
            Ok(total.to_string())
        });
        let permission_policy = PermissionPolicy::new(PermissionMode::WorkspaceWrite);
        let system_prompt = SystemPromptBuilder::new()
            .with_project_context(ProjectContext {
                cwd: PathBuf::from("/tmp/project"),
                current_date: "2026-03-31".to_string(),
                git_status: None,
                git_diff: None,
                instruction_files: Vec::new(),
            })
            .with_os("linux", "6.8")
            .build();
        let mut runtime = ConversationRuntime::new(
            Session::new(),
            api_client,
            tool_executor,
            permission_policy,
            system_prompt,
        );

        let summary = runtime
            .run_turn("what is 2 + 2?", Some(&mut PromptAllowOnce))
            .expect("conversation loop should succeed");

        assert_eq!(summary.iterations, 2);
        assert_eq!(summary.assistant_messages.len(), 2);
        assert_eq!(summary.tool_results.len(), 1);
        assert_eq!(runtime.session().messages.len(), 4);
        assert_eq!(summary.usage.output_tokens, 10);
        assert!(matches!(
            runtime.session().messages[1].blocks[1],
            ContentBlock::ToolUse { .. }
        ));
        assert!(matches!(
            runtime.session().messages[2].blocks[0],
            ContentBlock::ToolResult {
                is_error: false,
                ..
            }
        ));
    }

    #[test]
    fn records_denied_tool_results_when_prompt_rejects() {
        struct RejectPrompter;
        impl PermissionPrompter for RejectPrompter {
            fn decide(&mut self, _request: &PermissionRequest) -> PermissionPromptDecision {
                PermissionPromptDecision::Deny {
                    reason: "not now".to_string(),
                }
            }
        }

        struct SingleCallApiClient;
        impl ApiClient for SingleCallApiClient {
            fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
                if request
                    .messages
                    .iter()
                    .any(|message| message.role == MessageRole::Tool)
                {
                    return Ok(vec![
                        AssistantEvent::TextDelta("I could not use the tool.".to_string()),
                        AssistantEvent::MessageStop,
                    ]);
                }
                Ok(vec![
                    AssistantEvent::ToolUse {
                        id: "tool-1".to_string(),
                        name: "blocked".to_string(),
                        input: "secret".to_string(),
                    },
                    AssistantEvent::MessageStop,
                ])
            }
        }

        let mut runtime = ConversationRuntime::new(
            Session::new(),
            SingleCallApiClient,
            StaticToolExecutor::new(),
            PermissionPolicy::new(PermissionMode::WorkspaceWrite),
            vec!["system".to_string()],
        );

        let summary = runtime
            .run_turn("use the tool", Some(&mut RejectPrompter))
            .expect("conversation should continue after denied tool");

        assert_eq!(summary.tool_results.len(), 1);
        assert!(matches!(
            &summary.tool_results[0].blocks[0],
            ContentBlock::ToolResult { is_error: true, output, .. } if output == "not now"
        ));
    }

    #[test]
    fn denies_tool_use_when_pre_tool_hook_blocks() {
        struct SingleCallApiClient;
        impl ApiClient for SingleCallApiClient {
            fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
                if request
                    .messages
                    .iter()
                    .any(|message| message.role == MessageRole::Tool)
                {
                    return Ok(vec![
                        AssistantEvent::TextDelta("blocked".to_string()),
                        AssistantEvent::MessageStop,
                    ]);
                }
                Ok(vec![
                    AssistantEvent::ToolUse {
                        id: "tool-1".to_string(),
                        name: "blocked".to_string(),
                        input: r#"{"path":"secret.txt"}"#.to_string(),
                    },
                    AssistantEvent::MessageStop,
                ])
            }
        }

        let mut runtime = ConversationRuntime::new_with_features(
            Session::new(),
            SingleCallApiClient,
            StaticToolExecutor::new().register("blocked", |_input| {
                panic!("tool should not execute when hook denies")
            }),
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
            RuntimeFeatureConfig::default().with_hooks(RuntimeHookConfig::new(
                vec![shell_snippet("printf 'blocked by hook'; exit 2")],
                Vec::new(),
            )),
        );

        let summary = runtime
            .run_turn("use the tool", None)
            .expect("conversation should continue after hook denial");

        assert_eq!(summary.tool_results.len(), 1);
        let ContentBlock::ToolResult {
            is_error, output, ..
        } = &summary.tool_results[0].blocks[0]
        else {
            panic!("expected tool result block");
        };
        assert!(
            *is_error,
            "hook denial should produce an error result: {output}"
        );
        assert!(
            output.contains("denied tool") || output.contains("blocked by hook"),
            "unexpected hook denial output: {output:?}"
        );
    }

    #[test]
    fn appends_post_tool_hook_feedback_to_tool_result() {
        struct TwoCallApiClient {
            calls: usize,
        }

        impl ApiClient for TwoCallApiClient {
            fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
                self.calls += 1;
                match self.calls {
                    1 => Ok(vec![
                        AssistantEvent::ToolUse {
                            id: "tool-1".to_string(),
                            name: "add".to_string(),
                            input: r#"{"lhs":2,"rhs":2}"#.to_string(),
                        },
                        AssistantEvent::MessageStop,
                    ]),
                    2 => {
                        assert!(request
                            .messages
                            .iter()
                            .any(|message| message.role == MessageRole::Tool));
                        Ok(vec![
                            AssistantEvent::TextDelta("done".to_string()),
                            AssistantEvent::MessageStop,
                        ])
                    }
                    _ => Err(RuntimeError::new("unexpected extra API call")),
                }
            }
        }

        let mut runtime = ConversationRuntime::new_with_features(
            Session::new(),
            TwoCallApiClient { calls: 0 },
            StaticToolExecutor::new().register("add", |_input| Ok("4".to_string())),
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
            RuntimeFeatureConfig::default().with_hooks(RuntimeHookConfig::new(
                vec![shell_snippet("printf 'pre hook ran'")],
                vec![shell_snippet("printf 'post hook ran'")],
            )),
        );

        let summary = runtime
            .run_turn("use add", None)
            .expect("tool loop succeeds");

        assert_eq!(summary.tool_results.len(), 1);
        let ContentBlock::ToolResult {
            is_error, output, ..
        } = &summary.tool_results[0].blocks[0]
        else {
            panic!("expected tool result block");
        };
        assert!(
            !*is_error,
            "post hook should preserve non-error result: {output:?}"
        );
        assert!(
            output.contains('4'),
            "tool output missing value: {output:?}"
        );
        assert!(
            output.contains("pre hook ran"),
            "tool output missing pre hook feedback: {output:?}"
        );
        assert!(
            output.contains("post hook ran"),
            "tool output missing post hook feedback: {output:?}"
        );
    }

    #[test]
    fn reconstructs_usage_tracker_from_restored_session() {
        struct SimpleApi;
        impl ApiClient for SimpleApi {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
                Ok(vec![
                    AssistantEvent::TextDelta("done".to_string()),
                    AssistantEvent::MessageStop,
                ])
            }
        }

        let mut session = Session::new();
        session
            .messages
            .push(crate::session::ConversationMessage::assistant_with_usage(
                vec![ContentBlock::Text {
                    text: "earlier".to_string(),
                }],
                Some(TokenUsage {
                    input_tokens: 11,
                    output_tokens: 7,
                    cache_creation_input_tokens: 2,
                    cache_read_input_tokens: 1,
                }),
            ));

        let runtime = ConversationRuntime::new(
            session,
            SimpleApi,
            StaticToolExecutor::new(),
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
        );

        assert_eq!(runtime.usage().turns(), 1);
        assert_eq!(runtime.usage().cumulative_usage().total_tokens(), 21);
    }

    #[test]
    fn compacts_session_after_turns() {
        struct SimpleApi;
        impl ApiClient for SimpleApi {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
                Ok(vec![
                    AssistantEvent::TextDelta("done".to_string()),
                    AssistantEvent::MessageStop,
                ])
            }
        }

        let mut runtime = ConversationRuntime::new(
            Session::new(),
            SimpleApi,
            StaticToolExecutor::new(),
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
        );
        runtime.run_turn("a", None).expect("turn a");
        runtime.run_turn("b", None).expect("turn b");
        runtime.run_turn("c", None).expect("turn c");

        let result = runtime.compact(CompactionConfig {
            preserve_recent_messages: 2,
            max_estimated_tokens: 1,
        });
        assert!(result.summary.contains("Conversation summary"));
        assert_eq!(
            result.compacted_session.messages[0].role,
            MessageRole::System
        );
    }

    #[cfg(windows)]
    fn shell_snippet(script: &str) -> String {
        script.replace('\'', "\"")
    }

    #[cfg(not(windows))]
    fn shell_snippet(script: &str) -> String {
        script.to_string()
    }

    /// No-progress detector: if the LLM keeps emitting the same tool call
    /// every iteration, the runtime should abort after the window fills
    /// instead of letting it run all the way to `max_iterations` (which is
    /// set generously for legit complex work).
    #[test]
    fn no_progress_detector_breaks_on_repeated_same_tool_call() {
        struct StuckClient;
        impl ApiClient for StuckClient {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
                // Identical tool call every iteration — never makes
                // progress. The runtime should give up by iter 3.
                Ok(vec![
                    AssistantEvent::ToolUse {
                        id: "tool-stuck".to_string(),
                        name: "noop".to_string(),
                        input: r#"{"a":1}"#.to_string(),
                    },
                    AssistantEvent::MessageStop,
                ])
            }
        }

        let tool_executor =
            StaticToolExecutor::new().register("noop", |_input| Ok("ok".to_string()));
        let mut runtime = ConversationRuntime::new(
            Session::new(),
            StuckClient,
            tool_executor,
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
        );
        // Large iter cap so the no-progress detector — not the iter cap —
        // is the thing that aborts.
        runtime = runtime.with_max_iterations(200);

        let summary = runtime
            .run_turn("loop forever please", None)
            .expect("no-progress stops should be Ok, not Err");
        // Last assistant message should be the synthetic stop notice.
        let last = summary
            .assistant_messages
            .last()
            .expect("at least one assistant message");
        let text = match &last.blocks[0] {
            ContentBlock::Text { text } => text,
            other => panic!("expected text block, got {other:?}"),
        };
        assert!(
            text.contains("no progress"),
            "expected no-progress stop notice, got: {text}"
        );
        assert!(
            text.contains("noop"),
            "stop notice should namedrop the stuck tool: {text}"
        );
    }

    #[test]
    fn iter_cap_emits_synthetic_stop_not_error() {
        // Iter cap should produce a clean stop in-conversation, not an
        // error event that the UI surfaces as a failure.
        struct ProgressingClient {
            n: usize,
        }
        impl ApiClient for ProgressingClient {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
                self.n += 1;
                Ok(vec![
                    AssistantEvent::ToolUse {
                        id: format!("t{}", self.n),
                        name: "step".to_string(),
                        // Different input each iteration so no-progress
                        // doesn't trip — only the iter cap should fire.
                        input: format!(r#"{{"i":{}}}"#, self.n),
                    },
                    AssistantEvent::MessageStop,
                ])
            }
        }
        let tool_executor =
            StaticToolExecutor::new().register("step", |_| Ok("ok".to_string()));
        let mut runtime = ConversationRuntime::new(
            Session::new(),
            ProgressingClient { n: 0 },
            tool_executor,
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
        );
        runtime = runtime.with_max_iterations(3);

        let summary = runtime
            .run_turn("keep going", None)
            .expect("iter cap should be Ok, not Err");
        let last_text = summary
            .assistant_messages
            .last()
            .and_then(|m| m.blocks.first())
            .and_then(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .expect("must have a text block");
        assert!(
            last_text.contains("iteration cap"),
            "expected iter-cap stop notice, got: {last_text}"
        );
        assert!(
            last_text.contains('3'),
            "stop notice should mention the cap value: {last_text}"
        );
    }

    /// Legitimate progress with changing arguments must NOT trip the
    /// no-progress detector. Same tool, different inputs each iteration
    /// = progress.
    #[test]
    fn no_progress_detector_tolerates_changing_arguments() {
        struct ProgressingClient {
            n: usize,
        }
        impl ApiClient for ProgressingClient {
            fn stream(
                &mut self,
                _request: ApiRequest,
            ) -> Result<Vec<AssistantEvent>, RuntimeError> {
                self.n += 1;
                if self.n > 5 {
                    // Stop after 5 iterations — return text only.
                    Ok(vec![
                        AssistantEvent::TextDelta("done".to_string()),
                        AssistantEvent::MessageStop,
                    ])
                } else {
                    Ok(vec![
                        AssistantEvent::ToolUse {
                            id: format!("tool-{}", self.n),
                            name: "step".to_string(),
                            // Different input each iteration — this is
                            // legit progress, not a loop.
                            input: format!(r#"{{"i":{}}}"#, self.n),
                        },
                        AssistantEvent::MessageStop,
                    ])
                }
            }
        }
        let tool_executor =
            StaticToolExecutor::new().register("step", |_input| Ok("ok".to_string()));
        let mut runtime = ConversationRuntime::new(
            Session::new(),
            ProgressingClient { n: 0 },
            tool_executor,
            PermissionPolicy::new(PermissionMode::DangerFullAccess),
            vec!["system".to_string()],
        );
        runtime = runtime.with_max_iterations(50);

        let summary = runtime
            .run_turn("step through stuff", None)
            .expect("must NOT abort — each iter has a fresh input");
        assert_eq!(summary.iterations, 6); // 5 tool iters + 1 final text iter
    }
}
