import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachSessionLibrary,
  cancelTurn,
  createSession,
  answerQuestion,
  decidePermission,
  deleteSession,
  fetchConfig,
  fetchLibraries,
  fetchMcpServers,
  fetchProviders,
  fetchSkills,
  fetchTools,
  getSession,
  installMcpPreset,
  listSessions,
  patchConfig,
  pickAttachmentFile,
  pickWorkspace,
  sendMessage,
  setSessionMcpAttached,
  statAttachment,
  uploadFile,
} from "../api";
import { useSessionEvents } from "../useSessionEvents";
import type {
  AttachmentRef,
  AttachmentStat,
  CommandSummary,
  ConversationMessage,
  LibrarySummary,
  McpServerSummary,
  ProviderSummary,
  ServerConfig,
  SessionId,
  SessionSummary,
  SkillSummary,
  TokenUsage,
  ToolSummary,
} from "../types";
import {
  fetchCommands,
  isAsyncLocalCommand,
  parseSlash,
  renderLocalCommand,
  runAsyncLocalCommand,
} from "../slashCommands";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { ChatInput } from "./ChatInput";
import { EmptyHero } from "./EmptyHero";
import { RightPanel } from "./RightPanel";
import { SettingsModal } from "./SettingsModal";
import { PermissionTray } from "./PermissionTray";
import type { PendingPermission } from "./PermissionTray";
import { QuestionTray } from "./QuestionTray";
import type { PendingQuestion, QuestionAnswerPayload } from "./QuestionTray";
import { AbsorbModal } from "./AbsorbModal";
import { BranchIcon, SparkleIcon } from "./Icons";

type TurnState = "idle" | "running" | "error";

interface LocalEntry {
  anchor: number;
  msg: ConversationMessage;
  optimistic?: boolean;
}

export default function AppShell() {
  // ----- core session state -----
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<SessionId | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [turnState, setTurnState] = useState<TurnState>("idle");
  const [turnError, setTurnError] = useState<string | null>(null);
  const [turnCancelled, setTurnCancelled] = useState(false);
  const turnCancelledRef = useRef(false);
  useEffect(() => {
    turnCancelledRef.current = turnCancelled;
  }, [turnCancelled]);

  // ----- server-supplied metadata -----
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [attachedLibrary, setAttachedLibrary] = useState<string | null>(null);
  /** MCP servers explicitly attached to the active session (per-session,
   *  separate from globally-enabled servers). Used to inherit attachments
   *  when spawning a new session via the "+ New session" button / hero /
   *  `/clear`, so users don't lose their toolchain on every fresh start. */
  const [attachedMcps, setAttachedMcps] = useState<string[]>([]);

  /** Lookup index keyed by lowercase name + every alias, for the slash
   *  parser and the autocomplete popup. Rebuilt whenever the command
   *  catalog refreshes (rare — boot-only today). */
  const commandsByName = useMemo(() => {
    const map = new Map<string, CommandSummary>();
    for (const c of commands) {
      map.set(c.name.toLowerCase(), c);
      for (const a of c.aliases) map.set(a.toLowerCase(), c);
    }
    return map;
  }, [commands]);

  const refreshLibraries = useCallback(async () => {
    try {
      const data = await fetchLibraries();
      setLibraries(data.libraries);
    } catch (err) {
      console.error("fetchLibraries failed", err);
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      const data = await fetchProviders();
      setProviders(data.providers);
    } catch (err) {
      console.error("fetchProviders failed", err);
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    try {
      const data = await fetchSkills();
      setSkills(data.skills);
    } catch (err) {
      console.error("fetchSkills failed", err);
    }
  }, []);

  const refreshMcpServers = useCallback(async () => {
    try {
      const data = await fetchMcpServers();
      setMcpServers(data.servers);
    } catch (err) {
      console.error("fetchMcpServers failed", err);
    }
  }, []);

  /** One-click install of the built-in browser (Playwright-MCP) preset, then
   *  refresh the server list so the Browser pane flips to "installed". Rejects
   *  on failure so the pane can surface the message inline. */
  const installBrowser = useCallback(async () => {
    await installMcpPreset("browser", { name: "browser", inputs: {} });
    await refreshMcpServers();
  }, [refreshMcpServers]);

  // ----- composer / UI state -----
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Local-only bubbles (optimistic user messages, slash-command system
   *  responses, pending-first-message placeholders) keyed by session id.
   *  Bucketing per session means switching away and back preserves them
   *  — single-array state would get wiped on session switch. */
  const [localMessagesBySession, setLocalMessagesBySession] = useState<
    Record<string, LocalEntry[]>
  >({});
  const activeLocalMessages = useMemo(
    () => (activeId ? localMessagesBySession[activeId] ?? [] : []),
    [localMessagesBySession, activeId],
  );

  /** Mutate the active session's bucket. No-op if there's no active session. */
  const mutateActiveLocal = useCallback(
    (updater: (prev: LocalEntry[]) => LocalEntry[]) => {
      const sid = activeId;
      if (!sid) return;
      setLocalMessagesBySession((prev) => {
        const next = updater(prev[sid] ?? []);
        return { ...prev, [sid]: next };
      });
    },
    [activeId],
  );

  /** Same but bound to a specific session id — used by the
   *  pending-first-message effect that runs the moment activeId flips
   *  to a brand-new session, where `mutateActiveLocal` would still see
   *  the previous closure value of activeId on the first call. */
  const mutateLocalFor = useCallback(
    (sid: string, updater: (prev: LocalEntry[]) => LocalEntry[]) => {
      setLocalMessagesBySession((prev) => {
        const next = updater(prev[sid] ?? []);
        return { ...prev, [sid]: next };
      });
    },
    [],
  );
  // Cumulative session token usage — refreshed from /sessions/{id} on
  // switch, then incremented locally as SSE `usage` events stream in.
  // Drives the ctx badge in the input row + budget warnings.
  const [cumulativeTokens, setCumulativeTokens] = useState(0);
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  // Pending tool-use permission requests. The runtime parks the turn until
  // each one is allow/deny'd via decidePermission(). Without rendering UI
  // for these, the turn hangs forever in `prompt` mode.
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [decidingPermissionId, setDecidingPermissionId] = useState<string | null>(null);
  // Same shape as pendingPermissions but for the AskUser tool. SSE
  // `user_question` adds; `user_answer` (broadcast after the POST lands)
  // drops. Without rendering UI for these the turn also hangs.
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null);
  // Cross-session absorb: target = session that will receive the
  // summary, sources = sessions whose transcripts feed it. Modal opens
  // once user confirms the multi-select in the sidebar.
  const [absorbTarget, setAbsorbTarget] = useState<SessionId | null>(null);
  const [absorbSources, setAbsorbSources] = useState<Set<SessionId>>(new Set());
  const [absorbModalOpen, setAbsorbModalOpen] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<AttachmentRef[]>([]);
  // attachmentStats currently unused for rendering chips but kept to make
  // future "X tokens / Y bytes" badges trivial — already fetched on add.
  const [, setAttachmentStats] = useState<Record<string, AttachmentStat | "loading" | { error: string }>>({});
  /** First message to send after auto-creating a session from the hero. */
  const [pendingFirstMessage, setPendingFirstMessage] = useState<
    | {
        sessionId: SessionId;
        text: string;
        attachments: AttachmentRef[];
      }
    | null
  >(null);
  const [creatingFromHero, setCreatingFromHero] = useState(false);
  /** RAG library picked on the EmptyHero before any session exists.
   *  Consumed by handleHeroSubmit after createInheritingSession returns:
   *  we attach this library to the new session BEFORE sending the first
   *  message so the very first turn's retrieval uses it. */
  const [heroPendingLibrary, setHeroPendingLibrary] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  // Settings popover — owns Model / Skills / MCP / RAG / Summarizer.
  // Triggered from the sidebar gear icon (and ESC closes). `initialTab`
  // lets callers (e.g. the chat input's model button) deep-link to a
  // specific section. Reset to undefined on each open since the modal
  // unmounts on close, so `useState(initialTab ?? "models")` re-honors
  // the latest value.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    import("./SettingsModal").SettingsTab | undefined
  >(undefined);

  // ----- SSE -----
  const { events, totalCount, connection } = useSessionEvents(activeId);

  // ----- refreshers -----
  const refreshSessions = useCallback(async () => {
    try {
      const data = await listSessions();
      setSessions(data.sessions);
    } catch (err) {
      console.error("listSessions failed", err);
    }
  }, []);

  const refreshActive = useCallback(async () => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    try {
      const data = await getSession(activeId);
      setMessages(data.session.messages);
      setCumulativeTokens(data.cumulative_tokens ?? 0);
      setAttachedLibrary(data.attached_library ?? null);
      setAttachedMcps(data.attached_mcps ?? []);
      // Seed lastUsage from the most-recent assistant message so the ctx
      // badge isn't blank when reopening an existing session.
      const latestUsage = [...data.session.messages].reverse().find((m) => m.usage)?.usage;
      if (latestUsage) setLastUsage(latestUsage);
    } catch (err) {
      console.error("getSession failed", err);
    }
  }, [activeId]);

  // ----- boot -----
  useEffect(() => {
    refreshSessions();
    fetchConfig().then(setConfig).catch((err) => console.error("fetchConfig", err));
    fetchTools().then((r) => setTools(r.tools)).catch((err) => console.error("fetchTools", err));
    fetchCommands().then((r) => setCommands(r.commands)).catch((err) => console.error("fetchCommands", err));
    refreshMcpServers();
    refreshProviders();
    refreshSkills();
    refreshLibraries();
  }, [refreshSessions, refreshProviders, refreshSkills, refreshMcpServers, refreshLibraries]);

  // ----- on session switch, reset ephemeral state -----
  useEffect(() => {
    refreshActive();
    setStreamText("");
    setStreamReasoning("");
    setTurnState("idle");
    setError(null);
    setTurnError(null);
    setTurnCancelled(false);
    // NOTE: don't reset localMessagesBySession here — that's the whole
    // point of bucketing by session id. The active bucket gets cleaned
    // up by SSE optimistic-drop logic; other sessions' buckets persist
    // so switching away and back doesn't wipe slash-command bubbles.
    setCumulativeTokens(0);
    setLastUsage(null);
    setAttachedLibrary(null);
    setAttachedMcps([]);
    setPendingPermissions([]);
    setDecidingPermissionId(null);
    setPendingQuestions([]);
    setAnsweringQuestionId(null);
  }, [activeId, refreshActive]);

  // ----- SSE reducer -----
  const processedRef = useRef(0);
  useEffect(() => {
    if (!activeId) {
      processedRef.current = 0;
      return;
    }
    if (totalCount < processedRef.current) processedRef.current = 0;
    let needsRefresh = false;
    let dropOptimisticAfterRefresh = false;
    // When the server replaces history (e.g. /compact shrinks the message
    // count), local bubbles anchored past the new end would otherwise clamp
    // to the bottom and re-float after every new message. Track the snapshot's
    // new length so we can drop those stale bubbles after the refresh.
    let pruneLocalBeyond: number | null = null;
    const newCount = Math.min(totalCount - processedRef.current, events.length);
    const startIndex = events.length - newCount;
    for (let i = startIndex; i < events.length; i++) {
      const evt = events[i];
      if (evt.session_id !== activeId) continue;
      switch (evt.type) {
        case "turn_started":
          setTurnState("running");
          setStreamText("");
          setStreamReasoning("");
          setError(null);
          setTurnError(null);
          setTurnCancelled(false);
          break;
        case "user_message":
          needsRefresh = true;
          dropOptimisticAfterRefresh = true;
          break;
        case "assistant_delta":
          if (!turnCancelledRef.current) {
            setStreamText((p) => p + evt.text);
          }
          break;
        case "reasoning_delta":
          if (!turnCancelledRef.current) {
            setStreamReasoning((p) => p + evt.text);
          }
          break;
        case "tool_use":
        case "tool_result":
        case "assistant_message":
          needsRefresh = true;
          setStreamText("");
          setStreamReasoning("");
          break;
        case "session_snapshot":
          needsRefresh = true;
          // The snapshot carries the authoritative post-replace history, so
          // its length is the new valid anchor ceiling. Last snapshot wins.
          pruneLocalBeyond = evt.session.messages.length;
          break;
        case "turn_finished":
          setTurnState((c) => (c === "error" ? "error" : "idle"));
          setStreamText("");
          setStreamReasoning("");
          needsRefresh = true;
          dropOptimisticAfterRefresh = true;
          // Anything still pending is stale — the runtime is gone, the
          // decide/answer endpoints would 404. Drop them so the tray clears.
          setPendingPermissions([]);
          setPendingQuestions([]);
          break;
        case "turn_cancelled":
          setTurnState("idle");
          setStreamText("");
          setStreamReasoning("");
          setTurnCancelled(true);
          needsRefresh = true;
          dropOptimisticAfterRefresh = true;
          setPendingPermissions([]);
          setPendingQuestions([]);
          break;
        case "error":
          setTurnState("error");
          setTurnError(evt.message);
          // Don't also push to banner — turn_error block in chat already
          // renders the same message and double-displaying is noisy.
          break;
        case "usage":
          // Each turn closes with a `usage` event. input_tokens reflects
          // the full context sent to the model (including cached prefix),
          // which is the most accurate "ctx fullness" signal we have.
          setLastUsage(evt.usage);
          break;
        case "permission_request":
          setPendingPermissions((prev) => {
            if (prev.some((p) => p.requestId === evt.request_id)) return prev;
            return prev.concat({
              requestId: evt.request_id,
              toolName: evt.tool_name,
              input: evt.input,
              currentMode: evt.current_mode,
              requiredMode: evt.required_mode,
            });
          });
          break;
        case "permission_decision":
          setPendingPermissions((prev) =>
            prev.filter((p) => p.requestId !== evt.request_id),
          );
          break;
        case "user_question":
          setPendingQuestions((prev) => {
            if (prev.some((q) => q.questionId === evt.question_id)) return prev;
            return prev.concat({
              questionId: evt.question_id,
              question: evt.question,
              header: evt.header,
              options: evt.options ?? [],
              allowOther: evt.allow_other,
            });
          });
          break;
        case "user_answer":
          // Drop the matching pending question — answer was delivered by
          // this tab or another. Same pattern as permission_decision.
          setPendingQuestions((prev) =>
            prev.filter((q) => q.questionId !== evt.question_id),
          );
          break;
        default:
          break;
      }
    }
    processedRef.current = totalCount;
    if (needsRefresh) {
      const refreshed = refreshActive();
      if (dropOptimisticAfterRefresh) {
        refreshed
          .then(() => mutateActiveLocal((p) => p.filter((e) => !e.optimistic)))
          .catch(() => {});
      }
      if (pruneLocalBeyond !== null) {
        const keepThrough = pruneLocalBeyond;
        refreshed
          .then(() => mutateActiveLocal((p) => p.filter((e) => e.anchor <= keepThrough)))
          .catch(() => {});
      }
      refreshSessions();
    }
  }, [events, totalCount, activeId, refreshActive, refreshSessions]);

  // ----- merged conversation (optimistic + server) -----
  const renderedMessages = useMemo(() => {
    const out = [...messages];
    const sorted = [...activeLocalMessages].sort((a, b) => a.anchor - b.anchor);
    for (const { anchor, msg } of sorted) {
      const idx = Math.min(Math.max(anchor, 0), out.length);
      out.splice(idx, 0, msg);
    }
    return out;
  }, [messages, activeLocalMessages]);

  // ----- handlers -----
  /** Create a fresh session that inherits the per-session attachments
   *  (MCP servers, RAG library) from whichever session is currently
   *  active. Workspace_root and model are global config so they're
   *  inherited automatically by virtue of being persisted server-side.
   *  Returns the new session id; throws on createSession failure.
   *  Attachment-copy failures are warned but don't abort — a missing
   *  MCP server shouldn't block the user from getting a usable session. */
  const createInheritingSession = useCallback(async (): Promise<SessionId> => {
    const inheritMcps = attachedMcps;
    const inheritLib = attachedLibrary;
    const { session_id: newId } = await createSession();
    const tasks: Promise<unknown>[] = [];
    for (const mcp of inheritMcps) {
      tasks.push(
        setSessionMcpAttached(newId, mcp, true).catch((err) =>
          console.warn(`inherit MCP "${mcp}" failed:`, err),
        ),
      );
    }
    if (inheritLib) {
      tasks.push(
        attachSessionLibrary(newId, inheritLib).catch((err) =>
          console.warn(`inherit library "${inheritLib}" failed:`, err),
        ),
      );
    }
    await Promise.all(tasks);
    return newId;
  }, [attachedMcps, attachedLibrary]);

  const handleCreate = useCallback(async () => {
    try {
      const newId = await createInheritingSession();
      await refreshSessions();
      setActiveId(newId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refreshSessions, createInheritingSession]);

  const handleDeleteSession = useCallback(
    async (id: SessionId) => {
      try {
        await deleteSession(id);
        const wasActive = activeId === id;
        // If we just nuked the active session, switch focus to the next
        // most-recent surviving one so the chat pane doesn't dump back
        // to the empty hero unless there's literally nothing left.
        const next = sessions.find((s) => s.id !== id) ?? null;
        await refreshSessions();
        if (wasActive) setActiveId(next?.id ?? null);
        // If the deleted session was a source/target in an in-flight
        // absorb selection, drop it from the staging state so the
        // confirm bar doesn't reference a gone session.
        if (absorbTarget === id) {
          setAbsorbTarget(null);
          setAbsorbSources(new Set());
        } else if (absorbSources.has(id)) {
          setAbsorbSources((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeId, sessions, refreshSessions, absorbTarget, absorbSources],
  );

  /** Pre-flight check before dispatching a real LLM turn. Returns a
   *  user-facing reason to block, or null when good to send. Catches the
   *  two common new-user dead-ends (no model picked, or the picked model's
   *  provider has no API key) up front, instead of letting the turn fail at
   *  the backend after a round-trip. Slash commands skip this — they don't
   *  hit the model. */
  const sendBlockReason = useCallback((): string | null => {
    const model = config?.model;
    if (!model) {
      return "Pick a model first — open the Models tab on the right.";
    }
    // Best-effort: find the provider(s) whose catalog lists this model. Block
    // only when the model is known AND none of its providers has a key — that
    // avoids false positives for models shared across providers. A custom/typed
    // model (in no catalog) falls through to the backend credential check.
    const owners = providers.filter((p) => p.models.includes(model));
    if (owners.length > 0 && !owners.some((p) => p.configured)) {
      return `Add an API key for ${owners[0].label} in Settings before sending.`;
    }
    return null;
  }, [config, providers]);

  const handleSend = useCallback(async () => {
    if (!activeId || sending) return;
    if (!composer.trim() && composerAttachments.length === 0) return;

    // --- Slash command interception ---
    // Try to parse `/<cmd> [args]`. If the head matches a known command
    // from /commands, run it locally and push system bubbles into
    // localMessages instead of sending to the LLM. Unknown slash text
    // falls through and is sent as a regular message.
    const parsed = parseSlash(composer);
    if (parsed) {
      const match = commandsByName.get(parsed.name.toLowerCase());
      if (match) {
        const slashCtx = {
          sessionId: activeId,
          cumulativeTokens,
          lastUsage,
          model: config?.model ?? null,
          permissionMode: config?.permission_mode ?? "—",
          workspaceRoot: config?.workspace_root ?? null,
          attachedLibrary,
          messageCount: messages.length,
          contextWindow: config?.context_window ?? 0,
          maxSessionTokens: config?.max_session_tokens ?? null,
          patchConfig: async (p: import("../api").ServerConfigPatch) => {
            const updated = await patchConfig(p);
            setConfig(updated);
            return updated;
          },
          createSession: createInheritingSession,
          switchSession: (newId: SessionId) => {
            setActiveId(newId);
            refreshSessions();
          },
        };

        const userMsg: ConversationMessage = {
          role: "user",
          blocks: [{ type: "text", text: composer.trim() }],
          usage: null,
        };
        const isAsync = isAsyncLocalCommand(match.name, parsed.args);
        const placeholderText = isAsync
          ? `Running /${match.name}…`
          : renderLocalCommand(match, parsed.args, commands, slashCtx);
        const placeholder: ConversationMessage = {
          role: "system",
          blocks: [{ type: "text", text: placeholderText }],
          usage: null,
        };
        // Capture sourceId so /clear (which switches activeId mid-flight)
        // still resolves its placeholder in the originating session, not
        // the new empty one.
        const sourceId = activeId;
        const anchor = messages.length + activeLocalMessages.length;
        mutateLocalFor(sourceId, (prev) => [
          ...prev,
          { anchor, msg: userMsg },
          { anchor: anchor + 1, msg: placeholder },
        ]);
        setComposer("");
        setError(null);

        if (isAsync) {
          const resolved = await runAsyncLocalCommand(match, parsed.args, slashCtx);
          mutateLocalFor(sourceId, (prev) => {
            const copy = [...prev];
            if (copy.length === 0) return copy;
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = {
              anchor: last.anchor,
              msg: {
                role: "system",
                blocks: [{ type: "text", text: resolved }],
                usage: null,
              },
            };
            return copy;
          });
        }
        return;
      }
      // unknown slash command — fall through, treat as a regular message
    }

    // Real turn ahead — make sure a model + provider key are in place so the
    // user gets an actionable message now rather than a backend error later.
    const blockReason = sendBlockReason();
    if (blockReason) {
      setError(blockReason);
      return;
    }

    const text = composer;
    const attachments = composerAttachments;
    const optimistic: ConversationMessage = {
      role: "user",
      blocks: [{ type: "text", text }],
      usage: null,
      attachments: attachments.length
        ? attachments.map((a) => ({ path: a.path, content: "" }))
        : undefined,
    };
    const anchor = messages.length + activeLocalMessages.length;
    mutateActiveLocal((p) => [...p, { anchor, msg: optimistic, optimistic: true }]);
    setComposer("");
    setComposerAttachments([]);
    setAttachmentStats({});
    setError(null);
    setSending(true);
    try {
      await sendMessage(activeId, text, attachments);
    } catch (err) {
      setError((err as Error).message);
      mutateActiveLocal((p) => p.filter((e) => !e.optimistic));
    } finally {
      setSending(false);
    }
  }, [
    activeId,
    composer,
    composerAttachments,
    sending,
    messages.length,
    activeLocalMessages.length,
    commands,
    commandsByName,
    config,
    cumulativeTokens,
    lastUsage,
    attachedLibrary,
    refreshSessions,
    mutateActiveLocal,
    mutateLocalFor,
    createInheritingSession,
    sendBlockReason,
  ]);

  // ----- hero submit (no active session yet) -----
  const handleHeroSubmit = useCallback(async () => {
    if (creatingFromHero) return;
    if (!composer.trim() && composerAttachments.length === 0) return;
    // Block before spinning up a session so a missing model/key doesn't
    // leave an empty orphan session behind.
    const blockReason = sendBlockReason();
    if (blockReason) {
      setError(blockReason);
      return;
    }
    const text = composer;
    const attachments = composerAttachments;
    setError(null);
    setCreatingFromHero(true);
    try {
      // Hero usually fires with activeId=null so there's nothing to
      // inherit, but going through the helper keeps a single creation
      // path and "Just Works" if a user creates a hero session while
      // some attachments are still loaded from a prior session that got
      // deleted out from under them.
      const newId = await createInheritingSession();
      // If the user picked a RAG library on the hero, attach it BEFORE
      // dispatching the first message so retrieval runs on turn 1. If
      // they didn't pick one, createInheritingSession already inherited
      // the last-active library (if any).
      if (heroPendingLibrary) {
        try {
          const r = await attachSessionLibrary(newId, heroPendingLibrary);
          setAttachedLibrary(r.library ?? null);
        } catch (err) {
          // Non-fatal — the turn proceeds without retrieval. Surface
          // the failure so the user knows their pick didn't take.
          setError(`RAG attach failed: ${(err as Error).message}`);
        }
        setHeroPendingLibrary(null);
      }
      await refreshSessions();
      // Stash the first message — the pending-first-message useEffect
      // dispatches sendMessage once activeId has propagated.
      setPendingFirstMessage({ sessionId: newId, text, attachments });
      setComposer("");
      setComposerAttachments([]);
      setAttachmentStats({});
      setActiveId(newId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingFromHero(false);
    }
  }, [composer, composerAttachments, creatingFromHero, refreshSessions, createInheritingSession, heroPendingLibrary, sendBlockReason]);

  // When the just-created session becomes active, dispatch the first
  // message and seed the optimistic bubble. Runs after the session-switch
  // reset effect, so the optimistic survives.
  useEffect(() => {
    if (!pendingFirstMessage || pendingFirstMessage.sessionId !== activeId) return;
    const { sessionId: sid, text, attachments } = pendingFirstMessage;
    setPendingFirstMessage(null);
    const optimistic: ConversationMessage = {
      role: "user",
      blocks: [{ type: "text", text }],
      usage: null,
      attachments: attachments.length
        ? attachments.map((a) => ({ path: a.path, content: "" }))
        : undefined,
    };
    mutateLocalFor(sid, () => [{ anchor: 0, msg: optimistic, optimistic: true }]);
    setSending(true);
    sendMessage(sid, text, attachments)
      .catch((err) => {
        setError((err as Error).message);
        mutateLocalFor(sid, (p) => p.filter((e) => !e.optimistic));
      })
      .finally(() => setSending(false));
  }, [pendingFirstMessage, activeId, mutateLocalFor]);

  // ----- attachment handlers -----
  const addAttachment = useCallback(async (path: string) => {
    setComposerAttachments((prev) =>
      prev.some((a) => a.path === path) ? prev : [...prev, { type: "file", path }],
    );
    setAttachmentStats((prev) => ({ ...prev, [path]: "loading" }));
    try {
      const stat = await statAttachment(path);
      setAttachmentStats((prev) => ({ ...prev, [path]: stat }));
    } catch (err) {
      setAttachmentStats((prev) => ({ ...prev, [path]: { error: (err as Error).message } }));
    }
  }, []);

  const handlePickViaOs = useCallback(async () => {
    const picked = await pickAttachmentFile();
    if (!picked.supported) {
      throw new Error("OS file picker not available — use 'Upload from device' instead.");
    }
    if (picked.path) await addAttachment(picked.path);
  }, [addAttachment]);

  const handleUploadFromBrowser = useCallback(
    async (file: File) => {
      const resp = await uploadFile(file);
      if (resp.path) await addAttachment(resp.path);
    },
    [addAttachment],
  );

  const handlePasteImage = useCallback(
    async (file: File) => {
      const resp = await uploadFile(file);
      if (resp.path) await addAttachment(resp.path);
    },
    [addAttachment],
  );

  const handleRemoveAttachment = useCallback((index: number) => {
    setComposerAttachments((prev) => {
      const next = [...prev];
      const removed = next.splice(index, 1)[0];
      if (removed) {
        setAttachmentStats((stats) => {
          const copy = { ...stats };
          delete copy[removed.path];
          return copy;
        });
      }
      return next;
    });
  }, []);

  const handleCancel = useCallback(async () => {
    if (!activeId) return;
    setTurnCancelled(true);
    setStreamText("");
    setStreamReasoning("");
    setTurnState("idle");
    try {
      await cancelTurn(activeId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeId]);

  const handlePickWorkspace = useCallback(async () => {
    try {
      const picked = await pickWorkspace();
      if (picked.path) {
        const updated = await patchConfig({ workspace_root: picked.path });
        setConfig(updated);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // ----- absorb mode handlers -----
  const startAbsorb = useCallback((target: SessionId) => {
    setAbsorbTarget(target);
    setAbsorbSources(new Set());
    setAbsorbModalOpen(false);
  }, []);

  const toggleAbsorbSource = useCallback((id: SessionId) => {
    setAbsorbSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const cancelAbsorb = useCallback(() => {
    setAbsorbTarget(null);
    setAbsorbSources(new Set());
    setAbsorbModalOpen(false);
  }, []);

  const confirmAbsorb = useCallback(() => {
    if (!absorbTarget || absorbSources.size === 0) return;
    setAbsorbModalOpen(true);
  }, [absorbTarget, absorbSources]);

  const handleAbsorbInjected = useCallback(() => {
    // If the target is the currently-active session, SSE's session_snapshot
    // event will refresh messages automatically. For non-active targets we
    // still trigger a manual refresh-by-switch so the user can verify by
    // clicking into it. Either way, exit absorb mode.
    if (absorbTarget && absorbTarget === activeId) {
      refreshActive();
    }
    setAbsorbTarget(null);
    setAbsorbSources(new Set());
    setAbsorbModalOpen(false);
  }, [absorbTarget, activeId, refreshActive]);

  const handleDecidePermission = useCallback(
    async (requestId: string, allowed: boolean, remember = false) => {
      if (!activeId) return;
      setDecidingPermissionId(requestId);
      try {
        await decidePermission(activeId, requestId, allowed, null, remember);
        // Optimistically drop from local state — the SSE
        // `permission_decision` event will arrive shortly and is a no-op
        // (already-filtered list), but waiting for it makes the buttons
        // feel laggy.
        setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setDecidingPermissionId(null);
      }
    },
    [activeId],
  );

  const handleChangePermissionMode = useCallback(
    async (mode: string) => {
      try {
        const updated = await patchConfig({ permission_mode: mode });
        setConfig(updated);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

  const handleAnswerQuestion = useCallback(
    async (questionId: string, payload: QuestionAnswerPayload) => {
      if (!activeId) return;
      setAnsweringQuestionId(questionId);
      try {
        await answerQuestion(activeId, questionId, payload);
        // Optimistic drop — SSE user_answer will also drop it (no-op
        // on already-filtered list), but waiting feels laggy.
        setPendingQuestions((prev) => prev.filter((q) => q.questionId !== questionId));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setAnsweringQuestionId(null);
      }
    },
    [activeId],
  );

  const handleOpenModelPicker = useCallback(() => {
    // Deep-link directly into the Models tab of the Settings popover —
    // saves the user a click + visual scan to find where models live.
    setSettingsInitialTab("models");
    setSettingsOpen(true);
  }, []);

  // ----- layout -----
  return (
    <div
      style={{
        display: "flex",
        height: "100dvh",
        overflow: "hidden",
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      {/* Left rail */}
      {sidebarOpen && (
        <div
          style={{
            width: "var(--shell-sidebar-width)",
            background: "var(--bg-panel)",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
          }}
        >
          <SessionSidebar
            sessions={sessions}
            activeId={activeId}
            workspace={config?.workspace_root ?? null}
            onSelect={setActiveId}
            onCreate={handleCreate}
            onRefresh={refreshSessions}
            onPickWorkspace={handlePickWorkspace}
            onStartAbsorb={startAbsorb}
            absorbTarget={absorbTarget}
            absorbSources={absorbSources}
            onToggleAbsorbSource={toggleAbsorbSource}
            onCancelAbsorb={cancelAbsorb}
            onConfirmAbsorb={confirmAbsorb}
            onDelete={handleDeleteSession}
            onOpenSettings={() => {
              setSettingsInitialTab(undefined);
              setSettingsOpen(true);
            }}
          />
        </div>
      )}

      {/* Center column */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <TopBar
          connection={connection}
          sidebarOpen={sidebarOpen}
          rightPanelOpen={rightPanelOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onToggleRightPanel={() => setRightPanelOpen((o) => !o)}
          activeId={activeId}
          turnState={turnState}
          onStartAbsorb={activeId ? () => startAbsorb(activeId) : null}
          absorbing={absorbTarget != null}
        />

        <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
          {activeId == null ? (
            <EmptyHero
              composer={composer}
              onComposerChange={setComposer}
              onSubmit={handleHeroSubmit}
              busy={creatingFromHero}
              disabled={sending}
              model={config?.model ?? null}
              permissionMode={config?.permission_mode ?? "—"}
              attachments={composerAttachments}
              onRemoveAttachment={handleRemoveAttachment}
              onPickViaOs={handlePickViaOs}
              onUploadFromBrowser={handleUploadFromBrowser}
              onPasteImage={handlePasteImage}
              onOpenModelPicker={handleOpenModelPicker}
              libraries={libraries}
              attachedLibrary={heroPendingLibrary}
              onAttachLibrary={(lib) => {
                // No session yet — just stash for handleHeroSubmit to
                // attach after createInheritingSession returns.
                setHeroPendingLibrary(lib);
              }}
              onChangePermissionMode={handleChangePermissionMode}
            />
          ) : (
            <ChatWindow
              messages={renderedMessages}
              streamText={streamText}
              streamReasoning={streamReasoning}
              turnState={turnState}
              turnError={turnError}
            />
          )}

          {error && (
            <div
              style={{
                margin: "0 16px 4px",
                padding: "6px 10px",
                background: "var(--err-soft)",
                border: "1px solid var(--err-border)",
                borderRadius: 6,
                color: "var(--err)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
              }}
            >
              <span style={{ flex: 1, whiteSpace: "pre-wrap" }}>{error}</span>
              <button
                onClick={() => setError(null)}
                title="Dismiss"
                style={{
                  flexShrink: 0,
                  width: 18,
                  height: 18,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--err)",
                  background: "transparent",
                  borderRadius: 3,
                  border: "1px solid var(--err-border)",
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          )}

          {activeId != null && (
            <PermissionTray
              pending={pendingPermissions}
              decidingId={decidingPermissionId}
              onDecide={handleDecidePermission}
            />
          )}

          {activeId != null && (
            <QuestionTray
              pending={pendingQuestions}
              answeringId={answeringQuestionId}
              onAnswer={handleAnswerQuestion}
            />
          )}

          {activeId != null && (
            <ChatInput
              value={composer}
              onChange={setComposer}
              onSend={handleSend}
              onCancel={handleCancel}
              streaming={turnState === "running"}
              disabled={sending}
              model={config?.model ?? null}
              permissionMode={config?.permission_mode ?? "—"}
              onOpenModelPicker={handleOpenModelPicker}
              attachments={composerAttachments}
              onRemoveAttachment={handleRemoveAttachment}
              onPickViaOs={handlePickViaOs}
              onUploadFromBrowser={handleUploadFromBrowser}
              onPasteImage={handlePasteImage}
              cumulativeTokens={cumulativeTokens}
              lastUsage={lastUsage}
              maxSessionTokens={config?.max_session_tokens ?? null}
              contextWindow={config?.context_window ?? null}
              commands={commands}
              libraries={libraries}
              attachedLibrary={attachedLibrary}
              onAttachLibrary={async (library) => {
                if (!activeId) return;
                try {
                  const r = await attachSessionLibrary(activeId, library);
                  setAttachedLibrary(r.library ?? null);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
              onChangePermissionMode={handleChangePermissionMode}
            />
          )}
        </div>
      </div>

      {/* Right pane */}
      {rightPanelOpen && (
        <div
          style={{
            width: "var(--shell-right-width)",
            minWidth: "var(--shell-right-min)",
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          <RightPanel
            config={config}
            tools={tools}
            mcpServers={mcpServers}
            onInstallBrowser={installBrowser}
            turnActive={turnState === "running"}
          />
        </div>
      )}

      {absorbModalOpen && absorbTarget && (
        <AbsorbModal
          targetId={absorbTarget}
          sourceIds={Array.from(absorbSources)}
          sessions={sessions}
          summarizerLabel={
            config?.session_summarizer
              ? `${config.session_summarizer.model}${
                  config.session_summarizer.configured ? "" : " (no api_key — env fallback)"
                }`
              : config?.model
                ? `${config.model} (fallback — no dedicated summarizer)`
                : null
          }
          onClose={cancelAbsorb}
          onInjected={handleAbsorbInjected}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          providers={providers}
          skills={skills}
          mcpServers={mcpServers}
          libraries={libraries}
          attachedLibrary={attachedLibrary}
          activeSessionId={activeId}
          onConfigChange={setConfig}
          onProvidersChange={refreshProviders}
          onSkillsChange={refreshSkills}
          onMcpChange={refreshMcpServers}
          onLibrariesChange={refreshLibraries}
          onAttachedLibraryChange={setAttachedLibrary}
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsInitialTab}
        />
      )}
    </div>
  );
}

function TopBar({
  connection,
  sidebarOpen,
  rightPanelOpen,
  onToggleSidebar,
  onToggleRightPanel,
  activeId,
  turnState,
  onStartAbsorb,
  absorbing,
}: {
  connection: string;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRightPanel: () => void;
  activeId: SessionId | null;
  turnState: TurnState;
  /** Non-null when a session is active and the user can start an absorb
   *  with that session as the target. */
  onStartAbsorb: (() => void) | null;
  /** Visual state — disable the button while already in absorb mode so
   *  the user has to either confirm or cancel before starting another. */
  absorbing: boolean;
}) {
  const isLive = connection === "open";
  return (
    <div
      style={{
        height: "var(--header-h)",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "stretch",
        flexShrink: 0,
      }}
    >
      <button
        onClick={onToggleSidebar}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        style={{
          width: 36,
          color: "var(--text-muted)",
          borderRight: "1px solid var(--border)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
        }}
      >
        {sidebarOpen ? "‹" : "›"}
      </button>

      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "0 14px",
          color: "var(--text-muted)",
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <BranchIcon size={11} />
        <span style={{ fontWeight: 500 }}>main</span>
      </div>

      {onStartAbsorb && (
        <button
          onClick={onStartAbsorb}
          disabled={absorbing}
          title={
            absorbing
              ? "Confirm or cancel the current absorb selection first"
              : "Absorb other sessions into this one"
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "0 14px",
            color: absorbing ? "var(--text-dim)" : "var(--text-muted)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            borderRight: "1px solid var(--border)",
            background: absorbing ? "var(--accent-soft)" : "transparent",
            cursor: absorbing ? "not-allowed" : "pointer",
            opacity: absorbing ? 0.6 : 1,
          }}
        >
          <SparkleIcon size={11} />
          <span style={{ fontWeight: 500 }}>↓ Absorb from</span>
        </button>
      )}

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "0 14px",
          color: "var(--text-muted)",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background:
              !activeId ? "var(--text-dim)"
                : turnState === "running" ? "var(--accent)"
                  : isLive ? "var(--ok)"
                    : "var(--err)",
            boxShadow: turnState === "running" ? "0 0 8px var(--accent)" : "none",
          }}
        />
        <span>
          {!activeId
            ? "no session"
            : turnState === "running"
              ? "streaming"
              : connection === "open"
                ? "live"
                : connection}
        </span>
      </div>

      <button
        onClick={onToggleRightPanel}
        title={rightPanelOpen ? "Hide right panel" : "Show right panel"}
        style={{
          width: 36,
          color: "var(--text-muted)",
          borderLeft: "1px solid var(--border)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
        }}
      >
        {rightPanelOpen ? "›" : "‹"}
      </button>
    </div>
  );
}
