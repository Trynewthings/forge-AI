export type SessionId = string;

export interface SessionSummary {
  id: SessionId;
  created_at: number;
  message_count: number;
  turn_in_flight: boolean;
  title?: string | null;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export interface CreateSessionResponse {
  session_id: SessionId;
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | {
      type: "tool_result";
      tool_use_id: string;
      tool_name: string;
      output: string;
      is_error: boolean;
    }
  /** Model's chain-of-thought (DeepSeek `reasoning_content`, Anthropic
   *  native `thinking`). Rendered collapsibly — visible by default
   *  collapsed so it doesn't dominate the conversation, expandable when
   *  the user wants to see what the model was thinking. */
  | { type: "reasoning"; text: string; signature?: string | null };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ConversationMessage {
  role: MessageRole;
  blocks: ContentBlock[];
  usage: TokenUsage | null;
  /** User-only sidecar: files the user attached when sending this turn.
   * Stored separately from blocks so the UI can show the typed prompt
   * cleanly and offer expandable chips for the file contents. */
  attachments?: MessageAttachment[];
  /** Model that produced this message — set on assistant messages with
   * usage. Undefined on legacy persisted data and user/tool messages. */
  model?: string | null;
  /** RAG chunks retrieved at turn time when a library was attached.
   * UI renders this as a collapsible chip on the user bubble. */
  retrieved_context?: RetrievedContext | null;
}

export interface MessageAttachment {
  path: string;
  content: string;
  language?: string;
  kind?: AttachmentSubKind;
}

export type AttachmentSubKind =
  | { type: "text" }
  | { type: "image"; media_type: string }
  | { type: "extracted_text"; source_format: string };

export interface RuntimeSession {
  messages: ConversationMessage[];
}

export interface SessionDetailsResponse {
  id: SessionId;
  created_at: number;
  session: RuntimeSession;
  /** MCP servers the model has attached for this session. Empty by default. */
  attached_mcps: string[];
  /** Cumulative tokens spent on this session — drives the budget badge. */
  cumulative_tokens: number;
  /** RAG library currently attached to this session (null = none). */
  attached_library: string | null;
}

/** Wire shape for a single AskUser option, mirrors backend
 *  SessionQuestionOption. Sticky labels — UI uses them as button text
 *  AND as the answer payload identifier. */
export interface QuestionOption {
  label: string;
  description?: string | null;
}

/** Discriminated union for the AskUser answer broadcast. Matches the
 *  backend UserAnswerKind serde tag layout. */
export type UserAnswerKind =
  | { type: "selected"; index: number; label: string }
  | { type: "other_text"; text: string }
  | { type: "dismissed" };

/** POST body for `/sessions/{id}/questions/{qid}/answer`. Use the
 *  helper in api.ts; this type is exported for callers that want to
 *  build payloads inline. */
export type QuestionAnswerRequest =
  | { type: "selected"; index: number; label: string }
  | { type: "other_text"; text: string }
  | { type: "dismissed" };

export type SessionEvent =
  | { type: "session_snapshot"; session_id: SessionId; session: RuntimeSession }
  | { type: "turn_started"; session_id: SessionId }
  | { type: "user_message"; session_id: SessionId; message: ConversationMessage }
  | { type: "assistant_delta"; session_id: SessionId; text: string }
  | { type: "reasoning_delta"; session_id: SessionId; text: string }
  | { type: "assistant_message"; session_id: SessionId; message: ConversationMessage }
  | { type: "tool_use"; session_id: SessionId; id: string; name: string; input: string }
  | {
      type: "tool_result";
      session_id: SessionId;
      tool_use_id: string;
      tool_name: string;
      output: string;
      is_error: boolean;
    }
  | {
      type: "permission_request";
      session_id: SessionId;
      request_id: string;
      tool_name: string;
      input: string;
      current_mode: string;
      required_mode: string;
    }
  | {
      type: "permission_decision";
      session_id: SessionId;
      request_id: string;
      allowed: boolean;
      reason: string | null;
    }
  | {
      /** Model fired AskUser — pause and show the prompt UI. The runtime
       *  is blocked until POST /sessions/{id}/questions/{qid}/answer lands. */
      type: "user_question";
      session_id: SessionId;
      question_id: string;
      question: string;
      header: string | null;
      options: QuestionOption[];
      allow_other: boolean;
    }
  | {
      /** Decision was delivered (by this tab or another). Broadcast so
       *  every connected tab dismisses its copy of the prompt. Mirrors
       *  the permission_decision pattern. */
      type: "user_answer";
      session_id: SessionId;
      question_id: string;
      kind: UserAnswerKind;
    }
  | { type: "usage"; session_id: SessionId; usage: TokenUsage }
  | { type: "error"; session_id: SessionId; message: string }
  | { type: "turn_finished"; session_id: SessionId }
  | { type: "turn_cancelled"; session_id: SessionId };

export interface ToolSummary {
  name: string;
  description: string;
  required_permission: string;
  input_schema: unknown;
}

export interface ToolsResponse {
  tools: ToolSummary[];
}

export interface CommandSummary {
  name: string;
  aliases: string[];
  summary: string;
  argument_hint: string | null;
  resume_supported: boolean;
  category: string;
}

export interface CommandsResponse {
  commands: CommandSummary[];
}

export interface ServerConfig {
  permission_mode: string;
  model: string | null;
  workspace_root: string | null;
  context_window: number;
  /** Hard cap on tool_use iterations per turn. 0 means "use server default". */
  max_tool_iterations_per_turn: number;
  /** Optional cumulative-token ceiling for a session. null = unlimited. */
  max_session_tokens: number | null;
  /** Sanitised view of the configured embedding provider — `api_key` is
   * NOT included; presence is shown via `configured`. `null` when no
   * embedding provider is set (RAG ingestion will refuse with a clear
   * error). */
  embedding_provider: EmbeddingProviderView | null;
  /** Sub-LLM that summarizes WebFetch results to save main-session
   * context. Sanitised view — `api_key` is stripped server-side; check
   * `configured` to see whether a per-summarizer key is set. `null`
   * disables the feature (raw clean_text returned). */
  web_fetch_summarizer: WebFetchSummarizerView | null;
  /** Sub-LLM that condenses prior sessions into a structured handoff
   * for the cross-session "absorb" feature. Same shape + secret handling
   * as `web_fetch_summarizer`. `null` ⇒ absorb falls back to the main
   * `model` (UI surfaces that as a warning). */
  session_summarizer: SessionSummarizerView | null;
}

/** Read-side view for the session summarizer config — no api_key. */
export interface SessionSummarizerView {
  model: string;
  configured: boolean;
  base_url?: string | null;
  max_tokens?: number | null;
  system_prompt?: string | null;
}

/** Write-side patch for the session summarizer. Same secret rules as
 *  WebFetchSummarizerPatch. */
export interface SessionSummarizerPatch {
  model: string;
  api_key?: string;
  base_url?: string | null;
  max_tokens?: number | null;
  system_prompt?: string | null;
}

/** Backend payload for POST /sessions/{target}/absorb. Two usage modes:
 *  generate-only (`inject: false`, no `override_summary`), or inject
 *  user-edited text (`inject: true, override_summary: "<...>"`). */
export interface AbsorbRequest {
  source_session_ids: SessionId[];
  inject?: boolean;
  override_summary?: string | null;
}

export interface AbsorbResponse {
  summary: string;
  summarizer_model: string;
  /** `true` when no dedicated `session_summarizer` was configured and
   *  the absorb fell back to the main `config.model`. UI shows a warning. */
  fallback_to_main_model: boolean;
  injected: boolean;
  /** Rough per-source character counts (cheap token-cost proxy). */
  source_char_counts: Record<SessionId, number>;
}

/** Read-side shape returned by GET /config — no secrets. */
export interface WebFetchSummarizerView {
  /** Model id, e.g. `"deepseek-chat"` or `"deepseek-v4-flash"`. Provider
   * is detected by prefix. */
  model: string;
  /** `true` iff a dedicated api_key is set server-side. `false` means
   * the summarizer falls back to the provider's standard env var
   * (`DEEPSEEK_API_KEY` etc.). */
  configured: boolean;
  /** Optional base-URL override for OpenAI-compatible proxies. */
  base_url?: string | null;
  /** Optional ceiling on summary length. Backend default if omitted. */
  max_tokens?: number | null;
  /** Optional system prompt override. Backend default if omitted. */
  system_prompt?: string | null;
}

/** Write-side shape for PATCH /config. `api_key` is `undefined` to leave
 * the existing key alone, `""` to clear back to env-fallback, or a real
 * string to update. Mirrors EmbeddingProviderPatch's secret handling. */
export interface WebFetchSummarizerPatch {
  model: string;
  api_key?: string;
  base_url?: string | null;
  max_tokens?: number | null;
  system_prompt?: string | null;
}

export interface EmbeddingProviderView {
  base_url: string;
  model: string;
  dimensions: number;
  /** `true` iff an api_key is set server-side. */
  configured: boolean;
}

/** Full payload shape for PATCH /config. The api_key field is only
 * present when the user is providing one — we don't echo the key back
 * from the server. */
export interface EmbeddingProviderPatch {
  base_url: string;
  api_key: string;
  model: string;
  dimensions: number;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
}

export interface WorkspaceTreeResponse {
  root: string;
  relative: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFileResponse {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface WorkspacePickerResponse {
  path: string | null;
  supported: boolean;
}

export interface AttachmentRef {
  type: "file";
  path: string;
}

export interface AttachmentStat {
  kind: "text" | "image" | "extracted_text";
  size_bytes: number;
  estimated_tokens: number;
  media_type?: string;
}

export interface McpToolSummary {
  name: string;
  raw_name: string;
  description?: string | null;
  input_schema: unknown;
}

export interface McpServerSummary {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Defaults to true on older state files that pre-date the field. */
  enabled: boolean;
  tools: McpToolSummary[];
  /** "ready" | "discovering" | "failed" | "disabled". Disambiguates the
   * "0 tools" UI state between "still starting" and "broken config". */
  discovery_status: "ready" | "discovering" | "failed" | "disabled";
}

export interface McpServersResponse {
  servers: McpServerSummary[];
}

export interface McpServerPayload {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpPresetUserInputType =
  | { kind: "text"; placeholder?: string | null }
  | { kind: "secret" }
  | { kind: "path"; must_be_dir: boolean; must_exist: boolean }
  | { kind: "url" }
  | { kind: "choice"; options: string[] };

export interface McpPresetUserInput {
  name: string;
  label: string;
  help: string | null;
  required: boolean;
  input_type: McpPresetUserInputType;
  target: "env" | "args";
  env_key: string | null;
}

export interface McpPresetPrerequisite {
  binary: string;
  min_version: string | null;
  version_args: string[];
  install_hint: string;
}

export interface McpPreset {
  id: string;
  display_name: string;
  description: string;
  category: string;
  homepage: string | null;
  command: string;
  args_template: string[];
  env_template: Record<string, string>;
  user_inputs: McpPresetUserInput[];
  prerequisites: McpPresetPrerequisite[];
}

export interface McpPresetsResponse {
  presets: McpPreset[];
}

export interface PrereqCheckResult {
  binary: string;
  /** "ok" | "missing" | "version_low" | "unknown_version" */
  status: "ok" | "missing" | "version_low" | "unknown_version";
  current_version: string | null;
  min_version: string | null;
  install_hint: string;
}

export interface PrereqCheckResponse {
  results: PrereqCheckResult[];
}

export interface InstallPresetPayload {
  name: string;
  inputs: Record<string, string>;
}

/** Listing entry from /mcp/registry. JSON shape is intentionally compatible
 * with the subset of `McpPreset` consumed by the install form, so the form
 * component renders identically for hardcoded and registry-sourced
 * entries. The runtime hint (`command_hint`) is informational — registry
 * entries derive the actual command at install time on the backend. */
export interface RegistryListingEntry {
  registry_name: string;
  version: string;
  display_name: string;
  description: string;
  category: string;
  homepage: string | null;
  command_hint: string;
  user_inputs: McpPresetUserInput[];
  status: string | null;
  prerequisites: McpPresetPrerequisite[];
}

export interface RegistryListingResponse {
  entries: RegistryListingEntry[];
  next_cursor: string | null;
  raw_count: number;
  installable_count: number;
}

export interface InstallFromRegistryPayload {
  registry_name: string;
  server_name: string;
  inputs: Record<string, string>;
}

export interface UsageRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  turns: number;
  estimated_cost_usd: number | null;
}

export interface UsageResponse {
  rows: UsageRow[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number | null;
  total_turns: number;
}

export interface LibrarySummary {
  name: string;
  chunk_count: number;
  size_bytes: number;
  last_updated_ms: number | null;
  sources: string[];
}

export interface LibrariesResponse {
  libraries: LibrarySummary[];
}

export interface IngestResponse {
  chunks_written: number;
  source: string;
}

export interface RetrievedChunkView {
  source: string;
  content: string;
  distance: number;
}

export interface RetrievedContext {
  library: string;
  chunks: RetrievedChunkView[];
}

export interface CancelTurnResponse {
  cancelled: boolean;
}

export interface CompactSessionResponse {
  removed_message_count: number;
  before_tokens: number;
  after_tokens: number;
  kept_message_count: number;
}

export interface ProviderSummary {
  name: string;
  label: string;
  configured: boolean;
  base_url: string | null;
  default_base_url: string;
  env_keys: string[];
  models: string[];
}

export interface ProvidersResponse {
  providers: ProviderSummary[];
}

export interface LiveModel {
  id: string;
  context_window: number | null;
  /** USD per 1M input/output tokens from the server's static price table.
   *  Absent when the model id matches no known pricing tier. */
  input_per_million?: number | null;
  output_per_million?: number | null;
}

/** Live observation snapshot for the Browser pane (GET /browser/state).
 *  `available` is false when no browser MCP server has discovered tools yet. */
export interface BrowserState {
  available: boolean;
  url?: string | null;
  snapshot?: string | null;
  /** `data:` URL of the latest screenshot, or absent if no page is open. */
  screenshot?: string | null;
  error?: string | null;
}

export interface LiveModelsResponse {
  provider: string;
  fetched_from: string;
  models: LiveModel[];
}

export interface ProviderCredsPayload {
  api_key: string;
  base_url?: string | null;
}

/** Skill metadata as exposed by GET /skills. Mirrors backend `SkillInfo`. */
export interface SkillSummary {
  name: string;
  description: string | null;
  /** Where the skill came from — "project" / "user" / "codex-home" /
   * "~/.codex/skills" etc. Display-only. */
  origin: string;
  /** Display path of the SKILL.md file. */
  path: string;
  /** Higher-priority root shadows this one — the Skill tool resolves to
   * the shadowing entry; this one is essentially dead. */
  shadowed: boolean;
  /** Only `~/.claw/skills/` entries are editable via the UI. Used to
   * disable the delete button for project / codex skills. */
  editable: boolean;
}

export interface SkillsResponse {
  skills: SkillSummary[];
}

/** Payload for POST /skills. Backend writes to `~/.claw/skills/<name>/SKILL.md`. */
export interface CreateSkillPayload {
  name: string;
  description?: string | null;
  prompt: string;
}

/** A single entry surfaced by GET /skills/registry — the "Skill store"
 * shows one card per entry. `files` map is hidden server-side; the
 * frontend only needs the metadata it renders. */
export interface SkillRegistryEntry {
  name: string;
  description: string;
  category: string | null;
  version: string | null;
  tags: string[];
  homepage: string | null;
}

export interface SkillRegistryResponse {
  registry_url: string;
  entries: SkillRegistryEntry[];
  fetched_at_ms: number;
}

export interface InstallSkillFromRegistryPayload {
  name: string;
}
