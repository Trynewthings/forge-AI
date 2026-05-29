import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelTurn,
  checkPrereqs,
  compactSession,
  createSession,
  decidePermission,
  deleteMcpServer,
  deleteProvider,
  createSkill,
  deleteSkill,
  fetchCommands,
  fetchConfig,
  fetchLiveModels,
  fetchMcpPresets,
  fetchMcpServers,
  fetchSkillRegistry,
  fetchSkills,
  installSkillFromRegistry,
  attachSessionLibrary,
  createLibrary,
  deleteLibrary,
  fetchLibraries,
  fetchProviders,
  fetchRegistry,
  fetchTools,
  fetchUsage,
  ingestLibrary,
  fetchWorkspaceFile,
  fetchWorkspaceTree,
  getSession,
  installFromRegistry,
  installMcpPreset,
  listSessions,
  patchConfig,
  pickWorkspace,
  pickAttachmentFile,
  putMcpServer,
  putProvider,
  sendMessage,
  setMcpServerEnabled,
  setSessionMcpAttached,
  statAttachment,
  uploadFile,
} from "./api";
import { Markdown } from "./Markdown";
import { useSessionEvents } from "./useSessionEvents";
import type {
  AttachmentRef,
  AttachmentStat,
  CommandSummary,
  ContentBlock,
  ConversationMessage,
  EmbeddingProviderView,
  LibrarySummary,
  MessageAttachment,
  LiveModel,
  McpPreset,
  McpServerPayload,
  McpServerSummary,
  PrereqCheckResult,
  RegistryListingEntry,
  UsageResponse,
  ProviderSummary,
  ServerConfig,
  SessionEvent,
  SessionId,
  SessionSummary,
  SkillRegistryEntry,
  SkillRegistryResponse,
  SkillSummary,
  TokenUsage,
  ToolSummary,
  WorkspaceFileResponse,
  WorkspaceTreeResponse,
} from "./types";

type Drawer =
  | null
  | "sessions"
  | "events"
  | "tools"
  | "commands"
  | "config"
  | "files"
  | "mcp"
  | "rag";
type TurnState = "idle" | "running" | "error";

interface LocalEntry {
  /** Position in the merged render where this local entry should live.
   * Captured at insertion time so later real messages stack after it. */
  anchor: number;
  msg: ConversationMessage;
  /** `true` for optimistic-UI user bubbles pushed at click-send time so
   * the message renders BEFORE the server's `user_message` SSE comes
   * back (RAG embed + roundtrip can take 300-500ms). Cleared once the
   * refreshed session contains the server-side copy, so we never
   * double-render the bubble. */
  optimistic?: boolean;
}

interface PendingPermission {
  requestId: string;
  toolName: string;
  input: string;
  currentMode: string;
  requiredMode: string;
}

const PERMISSION_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
  "prompt",
  "allow",
] as const;

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<SessionId | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streamText, setStreamText] = useState("");
  // Live-accumulating chain-of-thought during a turn. Rendered as a
  // streaming Reasoning chip above the response so users can watch the
  // model think in real time; cleared when the turn closes (same
  // lifecycle as streamText).
  const [streamReasoning, setStreamReasoning] = useState("");
  const [turnState, setTurnState] = useState<TurnState>("idle");

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [drawer, setDrawer] = useState<Drawer>(null);

  const [composer, setComposer] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<AttachmentRef[]>([]);
  // Server-supplied metadata (token cost, kind) for each pending attachment.
  // Keyed by path; entries appear once the /workspace/attachment-stat call
  // resolves, so the chip can render a budget hint before the message is sent.
  // "loading" is a sentinel; "error" sentinel surfaces a red marker on the chip.
  const [attachmentStats, setAttachmentStats] = useState<
    Record<string, AttachmentStat | "loading" | { error: string }>
  >({});
  const [attachedMcps, setAttachedMcps] = useState<string[]>([]);
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  // Cumulative session tokens — refreshed from /api/sessions/{id} and
  // incremented locally as assistant_message events stream in. Same value
  // the backend uses to enforce `max_session_tokens`.
  const [cumulativeTokens, setCumulativeTokens] = useState<number>(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // RAG: catalog of libraries (refreshed on demand) and the one this
  // session is currently bound to (null = no auto-retrieval).
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [attachedLibrary, setAttachedLibrary] = useState<string | null>(null);
  // Skills surfaced in Settings (user-level + project-level + a few
  // legacy roots). Only `editable: true` entries can be deleted via UI.
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  // Open state of the standalone Create-skill modal triggered from the
  // composer's `+` menu. Decoupled from Settings so authors can spin
  // up a skill mid-chat without losing flow.
  const [skillCreateModalOpen, setSkillCreateModalOpen] = useState(false);
  // Skill store registry catalog. Loaded lazily when the user opens
  // the Skill store tab — no eager fetch at app boot so an offline /
  // unreachable registry doesn't block startup.
  const [skillRegistry, setSkillRegistry] = useState<SkillRegistryResponse | null>(null);
  const [skillRegistryLoading, setSkillRegistryLoading] = useState(false);
  const [skillRegistryError, setSkillRegistryError] = useState<string | null>(null);
  // Each local entry is anchored to the index in `messages` it was
  // produced at, so later real messages from the server stack AFTER it
  // (not before) in the merged render.
  const [localMessages, setLocalMessages] = useState<LocalEntry[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [turnCancelled, setTurnCancelled] = useState(false);
  // Mirror `turnCancelled` into a ref so the SSE event handler (whose
  // useEffect closure captures values at mount-time) can read the
  // latest value without re-subscribing on every state flip. This lets
  // us drop late assistant_delta / reasoning_delta events that arrive
  // AFTER the user cancelled — the spawn_blocking backend thread keeps
  // emitting for a beat before its iter check sees the cancel signal.
  const turnCancelledRef = useRef(false);
  useEffect(() => {
    turnCancelledRef.current = turnCancelled;
  }, [turnCancelled]);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [decidingPermissionId, setDecidingPermissionId] = useState<string | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [fileViewerNonce, setFileViewerNonce] = useState(0);

  const { events, totalCount, connection } = useSessionEvents(activeId);

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
      setAttachedMcps(data.attached_mcps ?? []);
      setCumulativeTokens(data.cumulative_tokens ?? 0);
      setAttachedLibrary(data.attached_library ?? null);
      // Seed the context-usage badge from the latest message that carries
      // a `usage` payload (assistant messages persist their TokenUsage).
      // Without this, reloading or switching to an existing session would
      // show "ctx — / Nk" until another turn ran.
      const latestUsage = [...data.session.messages]
        .reverse()
        .find((m) => m.usage)?.usage;
      if (latestUsage) setLastUsage(latestUsage);
    } catch (err) {
      console.error("getSession failed", err);
    }
  }, [activeId]);

  const refreshProviders = useCallback(async () => {
    try {
      const data = await fetchProviders();
      setProviders(data.providers);
    } catch (err) {
      console.error("fetchProviders failed", err);
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

  const refreshLibraries = useCallback(async () => {
    try {
      const data = await fetchLibraries();
      setLibraries(data.libraries);
    } catch (err) {
      console.error("fetchLibraries failed", err);
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

  const handleCreateSkill = useCallback(
    async (payload: { name: string; description: string | null; prompt: string }) => {
      await createSkill({
        name: payload.name,
        description: payload.description,
        prompt: payload.prompt,
      });
      await refreshSkills();
    },
    [refreshSkills],
  );

  const handleDeleteSkill = useCallback(
    async (name: string) => {
      await deleteSkill(name);
      await refreshSkills();
    },
    [refreshSkills],
  );

  const refreshSkillRegistry = useCallback(
    async (force = false) => {
      setSkillRegistryLoading(true);
      setSkillRegistryError(null);
      try {
        const data = await fetchSkillRegistry(force);
        setSkillRegistry(data);
      } catch (err) {
        setSkillRegistryError(err instanceof Error ? err.message : String(err));
      } finally {
        setSkillRegistryLoading(false);
      }
    },
    [],
  );

  const handleInstallSkill = useCallback(
    async (name: string) => {
      await installSkillFromRegistry({ name });
      // Refresh local skills so the Installed tab and the Skill store
      // both reflect the new entry without another user action.
      await refreshSkills();
    },
    [refreshSkills],
  );

  const handleCreateLibrary = useCallback(
    async (name: string) => {
      await createLibrary(name);
      await refreshLibraries();
    },
    [refreshLibraries],
  );

  const handleIngestLibrary = useCallback(
    async (name: string, file: File) => {
      await ingestLibrary(name, file);
      await refreshLibraries();
    },
    [refreshLibraries],
  );

  const handleDeleteLibrary = useCallback(
    async (name: string) => {
      await deleteLibrary(name);
      // If the deleted library was attached to the current session, the
      // backend's session.attached_library is now stale-pointing — but
      // retrieval will just fail and degrade gracefully. We optimistically
      // clear the local view here so the UI doesn't keep claiming the
      // library is attached.
      if (attachedLibrary === name) setAttachedLibrary(null);
      await refreshLibraries();
    },
    [attachedLibrary, refreshLibraries],
  );

  const handleAttachLibrary = useCallback(
    async (library: string | null) => {
      if (!activeId) return;
      const result = await attachSessionLibrary(activeId, library);
      setAttachedLibrary(result.library);
    },
    [activeId],
  );

  const handleSaveEmbeddingProvider = useCallback(
    async (payload: import("./types").EmbeddingProviderPatch | null) => {
      const updated = await patchConfig({ embedding_provider: payload });
      setConfig(updated);
    },
    [],
  );

  useEffect(() => {
    refreshSessions();
    fetchConfig().then(setConfig).catch((err) => console.error(err));
    fetchTools().then((r) => setTools(r.tools)).catch((err) => console.error(err));
    fetchCommands().then((r) => setCommands(r.commands)).catch((err) => console.error(err));
    refreshProviders();
    refreshMcpServers();
    refreshLibraries();
    refreshSkills();
  }, [refreshSessions, refreshProviders, refreshMcpServers, refreshLibraries, refreshSkills]);

  // Poll while any MCP server is still discovering — slow Python servers
  // (e.g. ppt) take ~8s to respond to tools/list, and without polling the
  // UI sticks on "discovering…" forever. Stops once every server has
  // settled into ready / failed / disabled.
  useEffect(() => {
    const anyDiscovering = mcpServers.some(
      (s) => s.discovery_status === "discovering",
    );
    if (!anyDiscovering) return;
    const timer = setInterval(refreshMcpServers, 1500);
    return () => clearInterval(timer);
  }, [mcpServers, refreshMcpServers]);

  useEffect(() => {
    refreshActive();
    setStreamText("");
    setStreamReasoning("");
    setTurnState("idle");
    setError(null);
    setTurnError(null);
    setTurnCancelled(false);
    setPendingPermissions([]);
    setLocalMessages([]);
    setLastUsage(null);
    setCumulativeTokens(0);
    setAttachedMcps([]);
    setAttachedLibrary(null);
  }, [activeId, refreshActive]);

  const commandsByName = useMemo(() => {
    const map = new Map<string, CommandSummary>();
    for (const c of commands) {
      map.set(c.name.toLowerCase(), c);
      for (const alias of c.aliases) {
        map.set(alias.toLowerCase(), c);
      }
    }
    return map;
  }, [commands]);

  const renderedMessages = useMemo(() => {
    const out = [...messages];
    // Splice in ascending-anchor order — each insertion shifts subsequent
    // anchors right, which is what we want because later anchors describe
    // positions in the post-splice list.
    const sorted = [...localMessages].sort((a, b) => a.anchor - b.anchor);
    for (const { anchor, msg } of sorted) {
      const idx = Math.min(Math.max(anchor, 0), out.length);
      out.splice(idx, 0, msg);
    }
    return out;
  }, [messages, localMessages]);

  // React to every newly-appended SSE event. We track total events ever received
  // (monotonic counter from useSessionEvents) so a batched render doesn't drop
  // intermediate events (e.g. an `error` sandwiched between `user_message` and
  // `turn_finished`). Tracking absolute count rather than array index is what
  // makes this survive the MAX_EVENTS sliding-window slice in useSessionEvents:
  // once the buffer starts dropping head events on long streaming turns, an
  // index-based cursor would equal `events.length` forever and silently skip
  // every new event — including the final `turn_finished`, leaving the UI
  // stuck in a "running" state.
  const processedRef = useRef(0);
  useEffect(() => {
    if (!activeId) {
      processedRef.current = 0;
      return;
    }
    if (totalCount < processedRef.current) {
      // session switch — useSessionEvents reset totalCount to 0.
      processedRef.current = 0;
    }
    let needsRefresh = false;
    let needsSessionsRefresh = false;
    // When the server confirms it has persisted the user message we
    // want to refresh AND drop the optimistic local copy once the
    // refresh resolves — see the post-loop block below. A separate
    // flag (vs. inline drop) prevents a flicker where the optimistic
    // is gone but the real one hasn't loaded yet.
    let dropOptimisticAfterRefresh = false;
    // New events live at the TAIL of `events`. Compute the slice we
    // haven't processed yet from the totalCount delta, then clamp to
    // events.length in case the sliding window dropped some (extreme
    // overflow within a single render — should not happen in practice
    // since MAX_EVENTS is 500 and React batches at most one frame's
    // worth of SSE messages at a time).
    const newCount = Math.min(totalCount - processedRef.current, events.length);
    const startIndex = events.length - newCount;
    for (let i = startIndex; i < events.length; i++) {
      const evt = events[i];
      if (evt.session_id !== activeId) continue;
      switch (evt.type) {
        case "turn_started":
          setTurnState("running");
          setStreamText("");
          setError(null);
          setTurnError(null);
          setTurnCancelled(false);
          break;
        case "user_message":
          // Server-side user message landed (post-RAG retrieval). Pull
          // the canonical copy in and queue removal of the optimistic
          // local stand-in.
          needsRefresh = true;
          dropOptimisticAfterRefresh = true;
          break;
        case "assistant_delta":
          // Drop stale deltas if the user has cancelled this turn —
          // backend can't kill the spawn_blocking thread mid-iter so
          // it'll keep streaming until it checks the cancel flag.
          if (!turnCancelledRef.current) {
            setStreamText((prev) => prev + evt.text);
          }
          break;
        case "reasoning_delta":
          if (!turnCancelledRef.current) {
            setStreamReasoning((prev) => prev + evt.text);
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
          // Fired by server-side mutations that bypass a turn (e.g. /compact
          // replacing the conversation, or attach/detach mutating the
          // attached_mcps set). The snapshot payload only carries the
          // conversation body so we route through refreshActive to also
          // re-fetch the attached_mcps list.
          needsRefresh = true;
          needsSessionsRefresh = true;
          break;
        case "turn_finished":
          setTurnState((current) => (current === "error" ? "error" : "idle"));
          setStreamText("");
          setStreamReasoning("");
          needsRefresh = true;
          needsSessionsRefresh = true;
          // Backstop: if `user_message` SSE was missed (rare connection
          // glitch), turn_finished still guarantees the server persisted
          // it. Drop the optimistic after this refresh too.
          dropOptimisticAfterRefresh = true;
          // Anything still pending at turn_finished is stale — the runtime is gone.
          setPendingPermissions([]);
          break;
        case "turn_cancelled":
          setTurnState("idle");
          setStreamText("");
          setStreamReasoning("");
          setTurnCancelled(true);
          needsRefresh = true;
          // Same backstop reasoning — cancellation still means the user
          // message landed before the turn was killed.
          dropOptimisticAfterRefresh = true;
          setPendingPermissions([]);
          break;
        case "error":
          setTurnState("error");
          setTurnError(evt.message);
          setError(evt.message);
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
        case "usage":
          // Each turn closes with a `usage` event. input_tokens reflects the
          // full context the runtime just sent to the LLM — including any
          // cached prefix — so it's the most accurate measure of how full
          // the conversation buffer currently is.
          setLastUsage(evt.usage);
          break;
        case "permission_decision":
          setPendingPermissions((prev) =>
            prev.filter((p) => p.requestId !== evt.request_id),
          );
          break;
        default:
          break;
      }
    }
    processedRef.current = totalCount;
    if (needsRefresh) {
      // Chain the optimistic-cleanup onto refresh completion so the
      // bubble never disappears between "drop optimistic" and "real
      // message arrives in messages[]" — the swap is atomic from the
      // viewer's perspective.
      const refreshed = refreshActive();
      if (dropOptimisticAfterRefresh) {
        refreshed
          .then(() => {
            setLocalMessages((prev) => prev.filter((e) => !e.optimistic));
          })
          .catch(() => {
            // refresh failed → keep the optimistic so the user still
            // sees their input. They'll notice via the error banner.
          });
      }
    }
    if (needsSessionsRefresh) refreshSessions();
  }, [events, totalCount, activeId, refreshActive, refreshSessions]);

  const handleCreateSession = useCallback(async () => {
    const created = await createSession();
    await refreshSessions();
    setActiveId(created.session_id);
  }, [refreshSessions]);

  const handleSend = useCallback(async () => {
    if (!activeId || sending) return;
    // The user must either type something or attach at least one file —
    // an empty prompt with attachments would still be a valid query
    // ("look at these files"), so we only block when both are empty.
    if (!composer.trim() && composerAttachments.length === 0) return;

    const parsed = parseSlash(composer);
    if (parsed) {
      const match = commandsByName.get(parsed.name.toLowerCase());
      if (match) {
        // /model with no arg opens the picker modal instead of writing a
        // message into the log. /model <name> still flows through the async
        // local-command path below so the switch shows up in chat.
        if (match.name === "model" && !parsed.args.trim()) {
          setModelPickerOpen(true);
          setComposer("");
          setError(null);
          return;
        }
        const userMsg: ConversationMessage = {
          role: "user",
          blocks: [{ type: "text", text: composer.trim() }],
          usage: null,
        };
        const placeholderText = isAsyncLocalCommand(match.name)
          ? `Running /${match.name}…`
          : renderLocalCommand(match, parsed.args, commands);
        const placeholder: ConversationMessage = {
          role: "system",
          blocks: [{ type: "text", text: placeholderText }],
          usage: null,
        };
        // Anchor against the current merged render so subsequent real
        // messages don't jump ahead of this command's bubbles.
        const anchor = messages.length + localMessages.length;
        setLocalMessages((prev) => [
          ...prev,
          { anchor, msg: userMsg },
          { anchor: anchor + 1, msg: placeholder },
        ]);
        setComposer("");
        setError(null);

        if (isAsyncLocalCommand(match.name)) {
          const resolved = await runAsyncLocalCommand(match, parsed.args, {
            sessionId: activeId,
            patchConfig: async (p) => {
              const updated = await patchConfig(p);
              setConfig(updated);
              return updated;
            },
          });
          setLocalMessages((prev) => {
            const copy = [...prev];
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
      // unknown slash command — fall through and treat as a regular message
    }

    setSending(true);
    setError(null);

    // Optimistic echo — render the user bubble instantly so the UI
    // doesn't sit on "thinking" with no user input visible while the
    // server runs RAG embed + LLM first-token-latency. We capture the
    // composer state at this point and clear the input immediately so
    // the typing field feels responsive. The optimistic entry is
    // dropped once `refreshActive` picks up the server-side copy
    // (which arrives via the `user_message` SSE event below).
    const optimisticText = composer;
    const optimisticAttachments: MessageAttachment[] = composerAttachments.map((ref) => ({
      path: ref.path,
      content: "",
    }));
    const optimisticUserMsg: ConversationMessage = {
      role: "user",
      blocks: [{ type: "text", text: optimisticText }],
      usage: null,
      attachments: optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
    };
    const anchor = messages.length + localMessages.length;
    setLocalMessages((prev) => [
      ...prev,
      { anchor, msg: optimisticUserMsg, optimistic: true },
    ]);
    setComposer("");
    setComposerAttachments([]);
    setAttachmentStats({});

    try {
      await sendMessage(activeId, optimisticText, composerAttachments);
    } catch (err) {
      setError((err as Error).message);
      // Server rejected the message — the optimistic bubble would
      // mislead the user into thinking it landed. Drop it.
      setLocalMessages((prev) => prev.filter((e) => !e.optimistic));
    } finally {
      setSending(false);
    }
  }, [
    activeId,
    composer,
    composerAttachments,
    sending,
    commandsByName,
    commands,
    messages.length,
    localMessages.length,
  ]);

  const handleCancel = useCallback(async () => {
    if (!activeId) return;
    // Flip the cancel state IMMEDIATELY (don't wait for the SSE
    // `turn_cancelled` round-trip) so any late assistant/reasoning
    // deltas in-flight from the still-running backend thread get
    // dropped on arrival. The backend's spawn_blocking work can't be
    // interrupted mid-iteration, so this is the only way to make the
    // UI feel responsive even while the server continues for a few
    // hundred ms.
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

  const handleModeChange = useCallback(async (mode: string) => {
    try {
      const updated = await patchConfig({ permission_mode: mode });
      setConfig(updated);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleModelChange = useCallback(async (model: string | null) => {
    try {
      const updated = await patchConfig({ model });
      setConfig(updated);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleDecidePermission = useCallback(
    async (requestId: string, allowed: boolean) => {
      if (!activeId) return;
      setDecidingPermissionId(requestId);
      try {
        await decidePermission(activeId, requestId, allowed);
        // Backend will broadcast permission_decision; the reducer above drops it.
        // We still optimistically remove so the modal closes immediately even if SSE lags.
        setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setDecidingPermissionId(null);
      }
    },
    [activeId],
  );

  const handleSaveProvider = useCallback(
    async (name: string, apiKey: string, baseUrl: string | null) => {
      await putProvider(name, { api_key: apiKey, base_url: baseUrl });
      await refreshProviders();
    },
    [refreshProviders],
  );

  const handleForgetProvider = useCallback(
    async (name: string) => {
      await deleteProvider(name);
      await refreshProviders();
    },
    [refreshProviders],
  );

  const handleSaveMcpServer = useCallback(
    async (name: string, payload: McpServerPayload) => {
      const response = await putMcpServer(name, payload);
      setMcpServers(response.servers);
    },
    [],
  );

  const handleDeleteMcpServer = useCallback(
    async (name: string) => {
      await deleteMcpServer(name);
      await refreshMcpServers();
    },
    [refreshMcpServers],
  );

  const handleInstallPreset = useCallback(
    async (presetId: string, name: string, inputs: Record<string, string>) => {
      const response = await installMcpPreset(presetId, { name, inputs });
      setMcpServers(response.servers);
    },
    [],
  );

  const handleInstallFromRegistry = useCallback(
    async (
      registryName: string,
      serverName: string,
      inputs: Record<string, string>,
    ) => {
      const response = await installFromRegistry({
        registry_name: registryName,
        server_name: serverName,
        inputs,
      });
      setMcpServers(response.servers);
    },
    [],
  );

  const handleToggleMcpServer = useCallback(
    async (name: string, enabled: boolean) => {
      const response = await setMcpServerEnabled(name, enabled);
      setMcpServers(response.servers);
    },
    [],
  );

  const handleAddAttachment = useCallback(
    (att: AttachmentRef) => {
      // Dedupe by path so accidentally picking the same file twice doesn't
      // double the token cost or duplicate chips.
      let added = false;
      setComposerAttachments((prev) => {
        if (prev.some((a) => a.path === att.path)) return prev;
        added = true;
        return [...prev, att];
      });
      if (!added) return;
      setAttachmentStats((prev) => ({ ...prev, [att.path]: "loading" }));
      statAttachment(att.path)
        .then((stat) => {
          setAttachmentStats((prev) => ({ ...prev, [att.path]: stat }));
        })
        .catch((err) => {
          setAttachmentStats((prev) => ({
            ...prev,
            [att.path]: { error: (err as Error).message },
          }));
        });
    },
    [],
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      try {
        const r = await uploadFile(file);
        if (r.path) {
          handleAddAttachment({ type: "file", path: r.path });
        }
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [handleAddAttachment],
  );

  const handleRemoveAttachment = useCallback((index: number) => {
    setComposerAttachments((prev) => {
      const removed = prev[index];
      if (removed) {
        setAttachmentStats((s) => {
          const { [removed.path]: _, ...rest } = s;
          return rest;
        });
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);


  const handleDetachMcp = useCallback(
    async (name: string) => {
      if (!activeId) return;
      try {
        const updated = await setSessionMcpAttached(activeId, name, false);
        setAttachedMcps(updated.attached_mcps);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeId],
  );

  const handleSetWorkspace = useCallback(
    async (value: string | null) => {
      try {
        const updated = await patchConfig({ workspace_root: value });
        setConfig(updated);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

  const handlePickWorkspace = useCallback(async () => {
    try {
      const picker = await pickWorkspace();
      if (!picker.supported) {
        setError("native folder picker not available on this server; type the path manually");
        return;
      }
      if (picker.path) {
        await handleSetWorkspace(picker.path);
      }
      // null path = user cancelled, leave config alone
    } catch (err) {
      setError((err as Error).message);
    }
  }, [handleSetWorkspace]);

  const handlePickModel = useCallback(async (model: string) => {
    try {
      const updated = await patchConfig({ model });
      setConfig(updated);
      setModelPickerOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleOpenFile = useCallback(
    (rawPath: string) => {
      const root = config?.workspace_root ?? null;
      let path = rawPath;
      // Strip workspace root prefix if the tool used an absolute path inside it,
      // because /workspace/file only accepts paths relative to the root.
      if (root && path.startsWith(root)) {
        path = path.slice(root.length).replace(/^\/+/, "");
      }
      setOpenFilePath(path);
      setFileViewerNonce((nonce) => nonce + 1); // force re-fetch even if path unchanged
      setDrawer("files");
    },
    [config?.workspace_root],
  );

  return (
    <div className="flex h-full bg-zinc-950 font-mono text-[13px] text-zinc-100 leading-relaxed">
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreateSession}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && (
        <SettingsModal
          currentBudget={config?.max_session_tokens ?? null}
          onClose={() => setSettingsOpen(false)}
          onSaveBudget={async (value) => {
            await patchConfig({ max_session_tokens: value });
            const fresh = await fetchConfig();
            setConfig(fresh);
          }}
          providers={providers}
          onSaveProvider={handleSaveProvider}
          onForgetProvider={handleForgetProvider}
          activeModel={config?.model ?? null}
          onActivateModel={handleModelChange}
          embeddingProvider={config?.embedding_provider ?? null}
          onSaveEmbeddingProvider={handleSaveEmbeddingProvider}
          summarizer={config?.web_fetch_summarizer ?? null}
          onSaveSummarizer={async (payload) => {
            await patchConfig({ web_fetch_summarizer: payload });
            const fresh = await fetchConfig();
            setConfig(fresh);
          }}
          librariesExist={libraries.length > 0}
          skills={skills}
          onCreateSkill={handleCreateSkill}
          onDeleteSkill={handleDeleteSkill}
          onRefreshSkills={refreshSkills}
          skillRegistry={skillRegistry}
          skillRegistryLoading={skillRegistryLoading}
          skillRegistryError={skillRegistryError}
          onRefreshSkillRegistry={refreshSkillRegistry}
          onInstallSkill={handleInstallSkill}
        />
      )}
      {skillCreateModalOpen && (
        <SkillCreateModal
          onSubmit={handleCreateSkill}
          onClose={() => setSkillCreateModalOpen(false)}
        />
      )}
      <div className="flex flex-1 min-w-0 flex-col border-l border-zinc-800">
        <TopBar
          config={config}
          connection={connection}
          turnState={turnState}
          drawer={drawer}
          onDrawer={setDrawer}
        />
        <div className="flex flex-1 min-h-0">
          <main className="relative flex flex-1 min-w-0 flex-col">
            <Conversation
              messages={renderedMessages}
              streamText={streamText}
              streamReasoning={streamReasoning}
              turnState={turnState}
              turnError={turnError}
              turnCancelled={turnCancelled}
              hasSession={!!activeId}
              onOpenFile={handleOpenFile}
            />
            {pendingPermissions.length > 0 && (
              <PermissionPanel
                pending={pendingPermissions}
                decidingId={decidingPermissionId}
                onDecide={handleDecidePermission}
              />
            )}
            <WorkspaceBar
              workspaceRoot={config?.workspace_root ?? null}
              attachedMcps={attachedMcps}
              onDetachMcp={handleDetachMcp}
              onPick={handlePickWorkspace}
              onClear={() => handleSetWorkspace(null)}
            />
            {modelPickerOpen && (
              <ModelPicker
                providers={providers}
                currentModel={config?.model ?? null}
                onClose={() => setModelPickerOpen(false)}
                onPick={handlePickModel}
              />
            )}
            <Composer
              value={composer}
              onChange={setComposer}
              onSend={handleSend}
              onCancel={handleCancel}
              sending={sending}
              disabled={!activeId}
              turnState={turnState}
              error={error}
              commands={commands}
              contextWindow={config?.context_window ?? 0}
              lastUsage={lastUsage}
              model={config?.model ?? null}
              attachments={composerAttachments}
              attachmentStats={attachmentStats}
              onAddAttachment={handleAddAttachment}
              onRemoveAttachment={handleRemoveAttachment}
              onUploadFile={handleUploadFile}
              cumulativeTokens={cumulativeTokens}
              budget={config?.max_session_tokens ?? null}
              libraries={libraries}
              attachedLibrary={attachedLibrary}
              onAttachLibrary={handleAttachLibrary}
              onOpenSkillCreate={() => setSkillCreateModalOpen(true)}
            />
          </main>
          <DrawerPanel
            drawer={drawer}
            onClose={() => setDrawer(null)}
            events={events}
            sessionId={activeId}
            tools={tools}
            commands={commands}
            config={config}
            mcpServers={mcpServers}
            onModeChange={handleModeChange}
            onModelChange={handleModelChange}
            onSaveMcpServer={handleSaveMcpServer}
            onDeleteMcpServer={handleDeleteMcpServer}
            onToggleMcpServer={handleToggleMcpServer}
            onInstallPreset={handleInstallPreset}
            onInstallFromRegistry={handleInstallFromRegistry}
            libraries={libraries}
            embeddingProvider={config?.embedding_provider ?? null}
            onRefreshLibraries={refreshLibraries}
            onCreateLibrary={handleCreateLibrary}
            onIngestLibrary={handleIngestLibrary}
            onDeleteLibrary={handleDeleteLibrary}
            onSaveEmbeddingProvider={handleSaveEmbeddingProvider}
            onWorkspaceChange={handleSetWorkspace}
            openFilePath={openFilePath}
            onOpenFile={setOpenFilePath}
            fileViewerNonce={fileViewerNonce}
          />
        </div>
      </div>
    </div>
  );
}

interface SessionListProps {
  sessions: SessionSummary[];
  activeId: SessionId | null;
  onSelect: (id: SessionId) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
}

function SessionList({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onOpenSettings,
}: SessionListProps) {
  return (
    <aside className="flex h-full w-60 flex-col bg-zinc-950">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="font-semibold text-orange-400">claw</span>
        <button
          onClick={onCreate}
          title="new session"
          className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-orange-400 hover:text-orange-400"
        >
          + new
        </button>
      </div>
      <div className="border-t border-zinc-800 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
        sessions
      </div>
      <ul className="claw-scroll flex-1 overflow-y-auto">
        {sessions.length === 0 && (
          <li className="px-4 py-3 text-xs text-zinc-600">no sessions yet</li>
        )}
        {sessions.map((session) => {
          const active = session.id === activeId;
          const label =
            (session.title && session.title.length > 0) ? session.title : session.id;
          return (
            <li key={session.id}>
              <button
                onClick={() => onSelect(session.id)}
                className={`group flex w-full flex-col gap-0.5 border-l-2 px-4 py-2 text-left ${
                  active
                    ? "border-orange-400 bg-zinc-900/60"
                    : "border-transparent hover:border-zinc-700 hover:bg-zinc-900/40"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`flex-1 truncate text-[12px] ${
                      active ? "text-zinc-100" : "text-zinc-300"
                    }`}
                    title={label}
                  >
                    {label}
                  </span>
                  {session.turn_in_flight && (
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400" />
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                  <span>{session.message_count} msg</span>
                  <span>·</span>
                  <span className="font-mono">{session.id}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        onClick={onOpenSettings}
        className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2.5 text-left text-[12px] text-zinc-400 hover:bg-zinc-900/60 hover:text-orange-400"
      >
        <span>⚙</span>
        <span>Settings</span>
        <span className="ml-auto text-[10px] text-zinc-600">usage · budget</span>
      </button>
    </aside>
  );
}

interface SettingsModalProps {
  currentBudget: number | null;
  onClose: () => void;
  onSaveBudget: (value: number | null) => Promise<void>;
  // Provider credentials (moved out of the old `providers` nav drawer).
  providers: ProviderSummary[];
  onSaveProvider: (name: string, apiKey: string, baseUrl: string | null) => Promise<void>;
  onForgetProvider: (name: string) => Promise<void>;
  // Chat model selector — wires to PATCH /config { model }.
  activeModel: string | null;
  onActivateModel: (model: string | null) => void;
  // Embedding (RAG) model — was inside RAG drawer; surfaces here too so
  // the Models hub is the one stop for "which model does what".
  embeddingProvider: EmbeddingProviderView | null;
  onSaveEmbeddingProvider: (
    payload: import("./types").EmbeddingProviderPatch | null,
  ) => Promise<void>;
  // WebFetch sub-LLM summarizer (Tier 3). View has api_key stripped;
  // save handler accepts the Patch shape (api_key optional).
  summarizer: import("./types").WebFetchSummarizerView | null;
  onSaveSummarizer: (
    payload: import("./types").WebFetchSummarizerPatch | null,
  ) => Promise<void>;
  // True iff any RAG libraries exist — gates the "changing embedding
  // dim requires server restart" warning inside EmbeddingProviderSection.
  librariesExist: boolean;
  // Skills (installed) tab data + handlers.
  skills: SkillSummary[];
  onCreateSkill: (payload: {
    name: string;
    description: string | null;
    prompt: string;
  }) => Promise<void>;
  onDeleteSkill: (name: string) => Promise<void>;
  onRefreshSkills: () => Promise<void>;
  // Skill store tab — fetched lazily; can be null until first open.
  skillRegistry: SkillRegistryResponse | null;
  skillRegistryLoading: boolean;
  skillRegistryError: string | null;
  onRefreshSkillRegistry: (force?: boolean) => Promise<void>;
  onInstallSkill: (name: string) => Promise<void>;
}

function SettingsModal({
  currentBudget,
  onClose,
  onSaveBudget,
  providers,
  onSaveProvider,
  onForgetProvider,
  activeModel,
  onActivateModel,
  embeddingProvider,
  onSaveEmbeddingProvider,
  summarizer,
  onSaveSummarizer,
  librariesExist,
  skills,
  onCreateSkill,
  onDeleteSkill,
  onRefreshSkills,
  skillRegistry,
  skillRegistryLoading,
  skillRegistryError,
  onRefreshSkillRegistry,
  onInstallSkill,
}: SettingsModalProps) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  // Empty string in the input maps to "unlimited" (null) on save.
  const [budgetInput, setBudgetInput] = useState<string>(
    currentBudget == null ? "" : String(currentBudget),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    setUsageLoading(true);
    fetchUsage()
      .then((r) => {
        setUsage(r);
        setUsageError(null);
      })
      .catch((err) => setUsageError(err instanceof Error ? err.message : String(err)))
      .finally(() => setUsageLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const trimmedInput = budgetInput.trim();
  const parsedBudget =
    trimmedInput === "" ? null : Number.parseInt(trimmedInput, 10);
  const budgetInvalid =
    trimmedInput !== "" &&
    (Number.isNaN(parsedBudget) || (parsedBudget != null && parsedBudget <= 0));
  const budgetDirty = (currentBudget ?? null) !== parsedBudget;

  // Active sidebar tab. Keep flat names (no nested routes) — the modal
  // is a focused popover, not an app-within-an-app.
  type SettingsTab = "usage" | "models" | "skills" | "skillStore";
  const [tab, setTab] = useState<SettingsTab>("usage");

  // Lazy-load the registry the first time the user lands on Skill
  // store. Avoids a network call at app boot when the registry might
  // be unreachable (offline, private network without VPN, etc.).
  useEffect(() => {
    if (tab === "skillStore" && skillRegistry === null && !skillRegistryLoading) {
      void onRefreshSkillRegistry(false);
    }
  }, [tab, skillRegistry, skillRegistryLoading, onRefreshSkillRegistry]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[840px] max-w-full flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-medium text-zinc-100">Settings</div>
          <button
            onClick={onClose}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-orange-400 hover:text-orange-400"
          >
            ✕ close
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <nav className="w-44 shrink-0 border-r border-zinc-800 bg-zinc-950/50 py-3">
            <ul className="space-y-0.5 px-2">
              {(
                [
                  ["usage", "Usage"],
                  ["models", "Models"],
                  ["skills", "Skills"],
                  ["skillStore", "Skill store"],
                ] as const
              ).map(([id, label]) => (
                <li key={id}>
                  <button
                    onClick={() => setTab(id)}
                    className={`w-full rounded px-2 py-1.5 text-left text-[12px] ${
                      tab === id
                        ? "bg-orange-400/10 text-orange-300"
                        : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content pane — exactly one tab's content visible at a time */}
          <div className="flex-1 overflow-y-auto">
          {/* Usage section */}
          {tab === "usage" && (
          <>
          <section className="border-b border-zinc-800 px-4 py-3">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-[11px] uppercase tracking-wider text-zinc-400">
                Usage
              </h3>
              {usage && (
                <span className="text-[10px] text-zinc-500">
                  {usage.total_turns} turns ·{" "}
                  {formatTokenCount(
                    usage.total_input_tokens + usage.total_output_tokens,
                  )}{" "}
                  tokens
                  {usage.total_cost_usd != null
                    ? ` · ~$${usage.total_cost_usd.toFixed(4)}`
                    : ""}
                </span>
              )}
            </div>
            {usageLoading && (
              <div className="text-xs text-zinc-600">loading…</div>
            )}
            {usageError && (
              <div className="text-xs text-red-400">{usageError}</div>
            )}
            {usage && usage.rows.length === 0 && !usageLoading && (
              <div className="text-xs text-zinc-600">
                no usage yet — send a message to a real model first
              </div>
            )}
            {usage && usage.rows.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="py-1.5 pr-2 font-normal">Model</th>
                    <th className="px-2 py-1.5 text-right font-normal">Input</th>
                    <th className="px-2 py-1.5 text-right font-normal">Output</th>
                    <th className="px-2 py-1.5 text-right font-normal">Turns</th>
                    <th className="pl-2 py-1.5 text-right font-normal">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.rows.map((row) => (
                    <tr
                      key={row.model}
                      className="border-b border-zinc-800/40 last:border-0"
                    >
                      <td className="py-1.5 pr-2 font-mono text-zinc-200">
                        {row.model}
                      </td>
                      <td className="px-2 py-1.5 text-right text-zinc-300">
                        {formatTokenCount(row.input_tokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-zinc-300">
                        {formatTokenCount(row.output_tokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-zinc-500">
                        {row.turns}
                      </td>
                      <td className="pl-2 py-1.5 text-right text-zinc-300">
                        {row.estimated_cost_usd != null
                          ? `$${row.estimated_cost_usd.toFixed(4)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-2 text-[10px] text-zinc-600">
              Prices are rough server-side estimates. Cost is shown as `—` when
              the model isn't in the table.
            </div>
          </section>

          {/* Session limits section */}
          <section className="border-b border-zinc-800 px-4 py-3">
            <h3 className="mb-2 text-[11px] uppercase tracking-wider text-zinc-400">
              Session limits
            </h3>
            <label className="mb-1 block text-[11px] text-zinc-500">
              Max tokens per session
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={budgetInput}
                onChange={(e) => {
                  setBudgetInput(e.target.value);
                  setSaveOk(false);
                  setSaveError(null);
                }}
                placeholder="(empty = unlimited)"
                className={`flex-1 rounded border bg-zinc-950 px-2 py-1 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
                  budgetInvalid
                    ? "border-red-500/60 focus:border-red-500"
                    : "border-zinc-800 focus:border-orange-400"
                }`}
              />
              <button
                onClick={async () => {
                  if (budgetInvalid) return;
                  setSaving(true);
                  setSaveError(null);
                  setSaveOk(false);
                  try {
                    await onSaveBudget(parsedBudget);
                    setSaveOk(true);
                  } catch (err) {
                    setSaveError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving || budgetInvalid || !budgetDirty}
                className="rounded border border-orange-400 bg-orange-400/10 px-3 py-1 text-xs text-orange-300 hover:bg-orange-400/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? "saving…" : "save"}
              </button>
            </div>
            {budgetInvalid && (
              <div className="mt-1 text-[11px] text-red-400">
                must be a positive integer
              </div>
            )}
            {saveError && (
              <div className="mt-1 text-[11px] text-red-400">{saveError}</div>
            )}
            {saveOk && (
              <div className="mt-1 text-[11px] text-emerald-400">saved ✓</div>
            )}
            <div className="mt-2 text-[10px] text-zinc-600">
              Once a session's cumulative tokens reach this number, new turns
              are refused with a clear error. Empty = unlimited.
            </div>
          </section>
          </>
          )}

          {/* Models tab — Credentials (provider keys) up top, then
              per-use-case model assignment blocks below. */}
          {tab === "models" && (
          <>
          {/* Credentials sub-section — manages api_key + base_url per
              known provider; the model dropdowns below assume the
              relevant provider has been configured here. */}
          <section className="border-b border-zinc-800 px-4 py-3">
            <h3 className="mb-2 text-[11px] uppercase tracking-wider text-zinc-400">
              Credentials
            </h3>
            <div className="-mx-4">
              <ProvidersEditor
                providers={providers}
                onSave={onSaveProvider}
                onForget={onForgetProvider}
                activeModel={activeModel}
                onActivateModel={onActivateModel}
              />
            </div>
          </section>

          {/* Models section — per-use-case model assignment. Each block
              owns its model id; provider auth comes from Credentials
              above. Vision is a coming-soon stub (no backend support
              yet). */}
          <section className="px-4 py-3">
            <h3 className="mb-3 text-[11px] uppercase tracking-wider text-zinc-400">
              Models
            </h3>
            <div className="space-y-4">
              <ChatModelBlock
                activeModel={activeModel}
                providers={providers}
                onActivateModel={onActivateModel}
              />
              <EmbeddingProviderSection
                current={embeddingProvider}
                librariesExist={librariesExist}
                onSave={onSaveEmbeddingProvider}
              />
              <SummarizerSection
                current={summarizer}
                onSave={onSaveSummarizer}
              />
              <VisionModelStub />
            </div>
          </section>
          </>
          )}

          {/* Skills tab — locally installed skills. Mirrors the same
              roots the Skill tool actually resolves at chat time, so
              what shows here is what the agent can invoke. */}
          {tab === "skills" && (
            <section className="px-4 py-3">
              <SkillsSection
                skills={skills}
                onCreate={onCreateSkill}
                onDelete={onDeleteSkill}
                onRefresh={onRefreshSkills}
              />
            </section>
          )}

          {/* Skill store tab — browse and install from the registry. */}
          {tab === "skillStore" && (
            <section className="px-4 py-3">
              <SkillStoreSection
                registry={skillRegistry}
                loading={skillRegistryLoading}
                error={skillRegistryError}
                installedSkillNames={skills.map((s) => s.name.toLowerCase())}
                onRefresh={onRefreshSkillRegistry}
                onInstall={onInstallSkill}
                onUninstall={onDeleteSkill}
              />
            </section>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Read-only chat-model display + a quick switch to the first model
 *  offered by any configured provider. Full picker is still available
 *  via the top-bar `model` button → ModelPicker modal. */
function ChatModelBlock({
  activeModel,
  providers,
  onActivateModel,
}: {
  activeModel: string | null;
  providers: ProviderSummary[];
  onActivateModel: (model: string | null) => void;
}) {
  const configured = providers.filter((p) => p.configured);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h4 className="text-[11px] font-medium text-zinc-200">Chat</h4>
        <span className="text-[10px] text-zinc-600">
          drives every assistant turn
        </span>
      </div>
      <div className="mb-2 font-mono text-[12px] text-zinc-100">
        {activeModel ?? <span className="text-zinc-500">(echo — no model)</span>}
      </div>
      {configured.length === 0 ? (
        <div className="text-[11px] text-zinc-600">
          Configure a provider above to enable model selection.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {configured.flatMap((p) =>
            p.models.map((m) => (
              <button
                key={`${p.name}:${m}`}
                onClick={() => onActivateModel(m)}
                className={`rounded border px-2 py-0.5 text-[11px] ${
                  activeModel === m
                    ? "border-orange-400 bg-orange-400/10 text-orange-300"
                    : "border-zinc-800 text-zinc-400 hover:border-orange-400/60 hover:text-zinc-100"
                }`}
              >
                {m}
              </button>
            )),
          )}
        </div>
      )}
    </div>
  );
}

/** Vision model placeholder. Backend has no `vision_model` field yet;
 *  this UI exists so users see the shape of the Models hub without
 *  being able to misconfigure something that won't take effect. Wire
 *  this up when the vision feature lands. */
function VisionModelStub() {
  return (
    <div className="rounded border border-dashed border-zinc-800 bg-zinc-950/20 p-3 opacity-70">
      <div className="mb-1 flex items-baseline justify-between">
        <h4 className="text-[11px] font-medium text-zinc-400">Vision</h4>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-zinc-400">
          coming soon
        </span>
      </div>
      <div className="text-[11px] text-zinc-600">
        Dedicated model for image inputs. Backend support not yet wired —
        images currently flow through the main chat model.
      </div>
    </div>
  );
}

interface TopBarProps {
  config: ServerConfig | null;
  connection: string;
  turnState: TurnState;
  drawer: Drawer;
  onDrawer: (drawer: Drawer) => void;
}

function TopBar({ config, connection, turnState, drawer, onDrawer }: TopBarProps) {
  const modelLabel = config?.model ?? "echo";
  const modeLabel = config?.permission_mode ?? "—";
  return (
    <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
      <div className="flex items-center gap-3 text-xs">
        <ConnectionDot state={connection} />
        {turnState === "running" && (
          <span className="text-orange-400">● running</span>
        )}
      </div>
      <div className="flex items-center gap-4 text-xs">
        <button
          onClick={() => onDrawer(drawer === "config" ? null : "config")}
          className="text-zinc-400 hover:text-zinc-100"
          title="server config"
        >
          <span className="text-zinc-600">model</span>{" "}
          <span className="text-zinc-100">{modelLabel}</span>
          <span className="mx-2 text-zinc-700">·</span>
          <span className="text-zinc-600">mode</span>{" "}
          <span className="text-zinc-100">{modeLabel}</span>
        </button>
        <DrawerTab label="files" current={drawer} value="files" onClick={onDrawer} />
        <DrawerTab label="mcp" current={drawer} value="mcp" onClick={onDrawer} />
        <DrawerTab label="rag" current={drawer} value="rag" onClick={onDrawer} />
        <DrawerTab label="events" current={drawer} value="events" onClick={onDrawer} />
        <DrawerTab label="tools" current={drawer} value="tools" onClick={onDrawer} />
        <DrawerTab label="commands" current={drawer} value="commands" onClick={onDrawer} />
      </div>
    </header>
  );
}

interface WorkspaceBarProps {
  workspaceRoot: string | null;
  attachedMcps: string[];
  onDetachMcp: (name: string) => Promise<void> | void;
  onPick: () => Promise<void> | void;
  onClear: () => Promise<void> | void;
}

function WorkspaceBar({
  workspaceRoot,
  attachedMcps,
  onDetachMcp,
  onPick,
  onClear,
}: WorkspaceBarProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = workspaceRoot
    ? workspaceRoot.split("/").slice(-2).join("/") || workspaceRoot
    : "no workspace";

  const handlePick = async () => {
    setBusy(true);
    try {
      await onPick();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative border-t border-zinc-800 px-6 py-2" ref={ref}>
      <div className="mx-auto flex max-w-3xl items-center gap-2 text-[11px] text-zinc-400">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded border border-zinc-800 px-2 py-1 hover:border-orange-400/60 hover:text-zinc-100"
          title="attach / switch workspace"
        >
          <span className="text-zinc-500">+</span>
          <span className="text-zinc-300">workspace</span>
        </button>
        <span className="truncate font-mono text-zinc-500" title={workspaceRoot ?? "no workspace"}>
          {label}
        </span>
        {attachedMcps.length > 0 && (
          <div className="flex items-center gap-1" title="MCP servers attached to this session">
            <span className="text-zinc-600">·</span>
            {attachedMcps.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-300"
              >
                mcp:{name}
                <button
                  type="button"
                  onClick={() => onDetachMcp(name)}
                  title={`Detach ${name} from this session`}
                  className="text-emerald-400/70 hover:text-red-300"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {workspaceRoot && (
          <button
            onClick={() => onClear()}
            className="ml-auto text-zinc-600 hover:text-zinc-200"
            title="clear workspace"
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <div className="absolute bottom-full left-6 z-10 mb-1 w-72 rounded border border-zinc-800 bg-zinc-950 p-2 text-xs shadow-lg">
          <button
            onClick={handlePick}
            disabled={busy}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
          >
            <span>📁 Select workspace…</span>
            <span className="text-[10px] text-zinc-600">native</span>
          </button>
          <button
            disabled
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-zinc-500"
            title="not yet implemented"
          >
            <span>📎 Attach file…</span>
            <span className="text-[10px] text-zinc-600">soon</span>
          </button>
        </div>
      )}
    </div>
  );
}

function DrawerTab({
  label,
  value,
  current,
  onClick,
}: {
  label: string;
  value: Exclude<Drawer, null>;
  current: Drawer;
  onClick: (drawer: Drawer) => void;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(active ? null : value)}
      className={
        active
          ? "text-orange-400"
          : "text-zinc-400 hover:text-zinc-100"
      }
    >
      {label}
    </button>
  );
}

function ConnectionDot({ state }: { state: string }) {
  const palette: Record<string, { color: string; label: string }> = {
    idle: { color: "bg-zinc-600", label: "no stream" },
    connecting: { color: "bg-sky-400 animate-pulse", label: "connecting" },
    open: { color: "bg-emerald-400", label: "live" },
    error: { color: "bg-red-500", label: "stream error" },
    closed: { color: "bg-zinc-600", label: "closed" },
  };
  const entry = palette[state] ?? palette.idle;
  return (
    <span title={`sse ${state}`} className="flex items-center gap-1.5 text-[10px] text-zinc-500">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${entry.color}`} />
      <span className="uppercase tracking-wider">{entry.label}</span>
    </span>
  );
}

interface ConversationProps {
  messages: ConversationMessage[];
  streamText: string;
  streamReasoning: string;
  turnState: TurnState;
  turnError: string | null;
  turnCancelled: boolean;
  hasSession: boolean;
  onOpenFile: (path: string) => void;
}

function Conversation({
  messages,
  streamText,
  streamReasoning,
  turnState,
  turnError,
  turnCancelled,
  hasSession,
  onOpenFile,
}: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => flatten(messages), [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Reasoning length included so streaming thinking also keeps the
    // view scrolled to the bottom — same UX guarantee as text streaming.
  }, [entries.length, streamText.length, streamReasoning.length]);

  if (!hasSession) {
    return (
      <div className="flex flex-1 items-center justify-center text-zinc-600">
        no session — pick one or create a new one
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="claw-scroll flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl space-y-5">
        {entries.length === 0 &&
          streamText.length === 0 &&
          streamReasoning.length === 0 &&
          turnState !== "running" && (
            <div className="text-zinc-600">empty session — type below to start</div>
          )}
        {entries.map((entry, i) => (
          <Entry key={i} entry={entry} onOpenFile={onOpenFile} />
        ))}
        {streamReasoning.length > 0 && (
          <Entry
            entry={{ kind: "reasoning", body: streamReasoning }}
            onOpenFile={onOpenFile}
          />
        )}
        {streamText.length > 0 && (
          <Entry
            entry={{ kind: "assistant", body: streamText, streaming: true }}
            onOpenFile={onOpenFile}
          />
        )}
        {turnState === "running" &&
          streamText.length === 0 &&
          streamReasoning.length === 0 && (
            <div className="text-zinc-500">
              <span className="mr-2 text-orange-400">●</span>thinking…
            </div>
          )}
        {turnError && (
          <div className="rounded border border-red-500/40 bg-red-500/5 px-3 py-2">
            <div className="text-xs text-red-400">turn error</div>
            <div className="mt-1 whitespace-pre-wrap font-sans text-[13px] text-red-200">
              {turnError}
            </div>
          </div>
        )}
        {turnCancelled && !turnError && (
          <div className="text-xs text-zinc-500">turn cancelled</div>
        )}
      </div>
    </div>
  );
}

interface FlatEntry {
  kind: "user" | "assistant" | "tool_call" | "system" | "reasoning";
  // For tool_call: serialized JSON of the tool input.
  body: string;
  meta?: string;
  toolName?: string;
  isError?: boolean;
  streaming?: boolean;
  running?: boolean;
  // tool_call-only: the result text (raw), once it's been paired up.
  output?: string;
  outputIsError?: boolean;
  toolUseId?: string;
  // user-only: files attached when this turn was sent.
  attachments?: MessageAttachment[];
}

function flatten(messages: ConversationMessage[]): FlatEntry[] {
  // First pass: index every tool_result by its tool_use_id so we can merge it onto
  // the matching tool_use call later. This gives the UI a single bubble per tool
  // invocation instead of two separate rows.
  const resultsById = new Map<
    string,
    { output: string; isError: boolean }
  >();
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    for (const block of message.blocks) {
      if (block.type === "tool_result") {
        resultsById.set(block.tool_use_id, {
          output: block.output,
          isError: block.is_error,
        });
      }
    }
  }

  const entries: FlatEntry[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message.blocks);
      if (text) entries.push({ kind: "system", body: text });
      continue;
    }
    if (message.role === "user") {
      entries.push({
        kind: "user",
        body: textOf(message.blocks),
        attachments: message.attachments,
      });
    } else if (message.role === "assistant") {
      // Reasoning goes FIRST in render order — it's emitted before text
      // in DeepSeek's stream, and putting it above the final answer
      // mirrors the natural "think then speak" flow.
      for (const block of message.blocks) {
        if (block.type === "reasoning" && block.text.trim().length > 0) {
          entries.push({ kind: "reasoning", body: block.text });
        }
      }
      const text = textOf(message.blocks);
      if (text) entries.push({ kind: "assistant", body: text });
      for (const block of message.blocks) {
        if (block.type === "tool_use") {
          const result = resultsById.get(block.id);
          entries.push({
            kind: "tool_call",
            toolName: block.name,
            body: prettyJson(block.input),
            meta: block.id,
            toolUseId: block.id,
            running: !result,
            output: result?.output,
            outputIsError: result?.isError,
          });
        }
        // tool_result blocks are intentionally not emitted — they're folded into
        // the matching tool_call above.
      }
    }
  }
  return entries;
}

function textOf(blocks: ContentBlock[]): string {
  let out = "";
  for (const block of blocks) {
    if (block.type === "text") {
      if (out.length > 0) out += "\n";
      out += block.text;
    }
  }
  return out;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Entry({
  entry,
  onOpenFile,
}: {
  entry: FlatEntry;
  onOpenFile: (path: string) => void;
}) {
  if (entry.kind === "user") {
    return <UserBubble body={entry.body} attachments={entry.attachments ?? []} />;
  }
  if (entry.kind === "assistant") {
    return (
      <div>
        <Markdown text={entry.body} />
        {entry.streaming && <span className="claw-caret text-orange-400" />}
      </div>
    );
  }
  if (entry.kind === "tool_call") {
    return <ToolCallBlock entry={entry} onOpenFile={onOpenFile} />;
  }
  if (entry.kind === "reasoning") {
    return <ReasoningBlock body={entry.body} />;
  }
  return (
    <div className="text-xs text-zinc-500">
      <span className="text-zinc-600">·</span> {entry.body}
    </div>
  );
}

/// Model's chain-of-thought. Collapsed by default so it doesn't dominate
/// the visible conversation — the user reads the final answer first and
/// can drill in if they want to see how the model got there. The label
/// shows a short preview so you don't need to expand to know what's
/// inside.
function ReasoningBlock({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  // Strip whitespace + grab first ~80 chars as a teaser. Helps you scan
  // a turn's reasoning at a glance without expanding every block.
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 80);
  const truncated = body.length > 80;
  return (
    <div className="border-l-2 border-zinc-700 pl-3 text-xs text-zinc-500">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left hover:text-zinc-300"
        title="model chain-of-thought"
      >
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
        <span className="text-[10px] uppercase tracking-wider text-zinc-600">
          thinking
        </span>
        {!open && (
          <span className="truncate font-mono text-zinc-500">
            {preview}
            {truncated ? "…" : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 whitespace-pre-wrap rounded bg-zinc-900/40 p-2 font-mono text-[11px] text-zinc-400">
          {body}
        </div>
      )}
    </div>
  );
}

const INLINE_RESULT_LINE_LIMIT = 40;

function UserBubble({
  body,
  attachments,
}: {
  body: string;
  attachments: MessageAttachment[];
}) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[80%] flex-col items-end gap-1.5">
        {body.trim().length > 0 && (
          <div className="whitespace-pre-wrap rounded-2xl border border-zinc-700/50 bg-zinc-800/70 px-4 py-2 font-sans text-[14px] text-zinc-100">
            {body}
          </div>
        )}
        {attachments.length > 0 && (
          <UserAttachmentGroup attachments={attachments} />
        )}
      </div>
    </div>
  );
}

function UserAttachmentGroup({ attachments }: { attachments: MessageAttachment[] }) {
  // Split images out of the rest — two or more images render as a thumbnail
  // grid (Cursor / ChatGPT style); anything else stays in the wrap-flow
  // chip strip. Single image stays in the strip too so it doesn't sit
  // awkwardly alone in a grid.
  const images = attachments.filter((a) => a.kind?.type === "image");
  const others = attachments.filter((a) => a.kind?.type !== "image");
  const useGrid = images.length >= 2;
  return (
    <div className="flex w-full flex-col items-end gap-1.5">
      {useGrid && <ImageGrid attachments={images} />}
      {(others.length > 0 || (!useGrid && images.length > 0)) && (
        <div className="flex flex-wrap justify-end gap-1">
          {(!useGrid ? attachments : others).map((att, i) => (
            <UserAttachmentChip key={`${att.path}-${i}`} attachment={att} />
          ))}
        </div>
      )}
    </div>
  );
}

function ImageGrid({ attachments }: { attachments: MessageAttachment[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // 2 → 2 cols, 3-4 → 2 cols, 5+ → 3 cols. Mirrors typical chat-app grids.
  const cols = attachments.length >= 5 ? 3 : 2;
  return (
    <div className="w-full">
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {attachments.map((att, i) => {
          if (att.kind?.type !== "image") return null;
          const url = `data:${att.kind.media_type};base64,${att.content}`;
          return (
            <button
              key={`${att.path}-${i}`}
              type="button"
              onClick={() => setOpenIndex(i)}
              title={att.path}
              className="overflow-hidden rounded border border-zinc-700/60 bg-zinc-900/40 transition hover:border-orange-400/60"
            >
              <img
                src={url}
                alt={att.path.split("/").pop() || att.path}
                className="block aspect-square h-full w-full object-cover"
              />
            </button>
          );
        })}
      </div>
      {openIndex !== null && attachments[openIndex]?.kind?.type === "image" && (
        <ImageLightbox
          attachment={attachments[openIndex]}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </div>
  );
}

function ImageLightbox({
  attachment,
  onClose,
}: {
  attachment: MessageAttachment;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (attachment.kind?.type !== "image") return null;
  const url = `data:${attachment.kind.media_type};base64,${attachment.content}`;
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
    >
      <img
        src={url}
        alt={attachment.path}
        className="max-h-full max-w-full rounded border border-zinc-700 object-contain"
      />
    </div>
  );
}

function UserAttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const [open, setOpen] = useState(false);
  const name = attachment.path.split("/").pop() || attachment.path;
  const kind = attachment.kind?.type ?? "text";

  if (kind === "image" && attachment.kind?.type === "image") {
    const dataUrl = `data:${attachment.kind.media_type};base64,${attachment.content}`;
    return (
      <div className="flex max-w-full flex-col items-end">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={attachment.path}
          className="inline-flex items-center gap-1.5 rounded border border-zinc-700/60 bg-zinc-900/60 p-1 hover:border-orange-400/60"
        >
          <img
            src={dataUrl}
            alt={name}
            className="block max-h-16 max-w-[160px] rounded object-cover"
          />
          <span className="max-w-[180px] truncate px-1 text-[11px] text-zinc-300">
            {name}
          </span>
        </button>
        {open && (
          <img
            src={dataUrl}
            alt={name}
            className="mt-1 max-h-[480px] max-w-full rounded border border-zinc-800/60 object-contain"
          />
        )}
      </div>
    );
  }

  // Text + extracted_text both render as expandable code chips. PDF
  // extracts get a tag so the user knows it's not the raw binary.
  const lineCount = attachment.content.split("\n").length;
  const tag =
    attachment.kind?.type === "extracted_text"
      ? `${attachment.kind.source_format} text`
      : null;
  return (
    <div className="flex max-w-full flex-col items-end">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={attachment.path}
        className="inline-flex items-center gap-1.5 rounded border border-zinc-700/60 bg-zinc-900/60 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-orange-400/60 hover:text-zinc-100"
      >
        <span className="text-zinc-500">{open ? "▾" : "▸"}</span>
        <span className="text-zinc-500">📄</span>
        <span className="max-w-[260px] truncate">{name}</span>
        {tag && (
          <span className="rounded bg-zinc-800 px-1 text-[9px] uppercase tracking-wider text-zinc-400">
            {tag}
          </span>
        )}
        <span className="text-[10px] text-zinc-600">
          {lineCount} line{lineCount === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <pre className="claw-scroll mt-1 max-h-72 max-w-full overflow-auto rounded border border-zinc-800/60 bg-zinc-950/60 px-3 py-2 text-left text-[12px] leading-snug text-zinc-200">
          {attachment.content}
        </pre>
      )}
    </div>
  );
}

function ToolCallBlock({
  entry,
  onOpenFile,
}: {
  entry: FlatEntry;
  onOpenFile: (path: string) => void;
}) {
  const running = !!entry.running;
  const output = entry.output ?? "";
  const outputIsError = !!entry.outputIsError;
  const diff = output ? tryParseDiff(output) : null;
  const filePath = extractFilePathForOpen(entry, diff);
  // Default closed — user clicks to peek. Errors auto-expand so failures are loud.
  const [open, setOpen] = useState(outputIsError);

  const summary = summarizeToolInput(entry.toolName ?? "", entry.body);
  const cleaned = output ? cleanedOutputForTool(entry.toolName, output) : null;
  // For read_file/write_file/edit_file with long content, the right panel is a
  // better viewer than inline. Clicking expand on those routes to the panel.
  const isFileTool = !!(entry.toolName && FILE_TOOLS.has(entry.toolName));
  const renderedLineCount = cleaned
    ? cleaned.text.split("\n").length
    : output
    ? output.split("\n").length
    : 0;
  const shouldDeferToSidePanel =
    isFileTool && !diff && !!filePath && renderedLineCount > INLINE_RESULT_LINE_LIMIT;

  const handleToggle = () => {
    if (running) return;
    if (!open && shouldDeferToSidePanel && filePath) {
      onOpenFile(filePath);
      return;
    }
    setOpen((current) => !current);
  };

  // Right-hand status badge in the collapsed header
  let statusBadge: React.ReactNode = null;
  if (running) {
    statusBadge = <span className="text-[10px] text-orange-400">running…</span>;
  } else if (outputIsError) {
    statusBadge = <span className="text-[10px] text-red-400">error</span>;
  } else if (diff) {
    statusBadge = (
      <span className="text-[10px] text-zinc-500">
        <span className="text-emerald-400">+{diff.totalAdditions}</span>{" "}
        <span className="text-red-400">-{diff.totalDeletions}</span>
      </span>
    );
  } else if (output) {
    statusBadge = (
      <span className="text-[10px] text-zinc-600">
        {renderedLineCount} line{renderedLineCount === 1 ? "" : "s"}
        {shouldDeferToSidePanel && (
          <span className="ml-1 text-orange-400">→ panel</span>
        )}
      </span>
    );
  }

  return (
    <div className="border-l-2 border-zinc-800 pl-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleToggle}
          disabled={running}
          className="flex flex-1 items-center gap-2 text-left text-xs hover:text-zinc-100 disabled:cursor-default disabled:hover:text-inherit"
        >
          <span className="text-zinc-600">
            {running ? " " : open ? "▾" : "▸"}
          </span>
          <span
            className={outputIsError ? "text-red-300" : "text-zinc-300"}
          >
            {entry.toolName}
          </span>
          {running && <Spinner />}
          <span
            className={`truncate font-mono text-[12px] ${
              outputIsError ? "text-red-300" : "text-zinc-100"
            }`}
            title={summary}
          >
            {summary}
          </span>
          <span className="ml-auto">{statusBadge}</span>
        </button>
        {filePath && !running && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onOpenFile(filePath);
            }}
            className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500 hover:border-orange-400/60 hover:text-orange-400"
            title={`open ${filePath} in the files viewer`}
          >
            open →
          </button>
        )}
      </div>
      {open && !shouldDeferToSidePanel && output && (
        <ToolCallBody
          toolName={entry.toolName ?? ""}
          output={output}
          isError={outputIsError}
          diff={diff}
          cleaned={cleaned}
        />
      )}
    </div>
  );
}

interface CleanedOutput {
  text: string;
  // Optional extra labels rendered above the content (file path, line counts).
  meta?: string;
}

/// For tools that wrap their payload in JSON (notably read_file), pull the actual
/// content out so the inline view doesn't dump raw JSON in the user's face.
function cleanedOutputForTool(
  toolName: string | undefined,
  raw: string,
): CleanedOutput | null {
  if (!toolName) return null;
  if (toolName === "read_file") {
    try {
      const parsed = JSON.parse(raw);
      const file = (parsed as { file?: Record<string, unknown> })?.file;
      const content = file?.content;
      const filePath = file?.filePath;
      if (typeof content === "string") {
        const meta = typeof filePath === "string" ? filePath : undefined;
        return { text: content, meta };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

// TodoWrite returns `{oldTodos, newTodos, verificationNudgeNeeded}` from the
// runtime. We only render the current state — the diff against oldTodos isn't
// useful to the human reading the conversation.
function tryParseTodos(raw: string): TodoItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const list = (parsed as { newTodos?: unknown }).newTodos;
  if (!Array.isArray(list)) return null;
  const todos: TodoItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const content = typeof row.content === "string" ? row.content : null;
    const status = row.status;
    if (
      !content ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      return null; // Strict shape — bail on first malformed row.
    }
    todos.push({
      content,
      status,
      activeForm: typeof row.activeForm === "string" ? row.activeForm : undefined,
    });
  }
  return todos.length > 0 ? todos : null;
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="mt-1 space-y-1 rounded border border-zinc-800/60 bg-zinc-900/40 px-3 py-2 text-[13px]">
      {todos.map((todo, i) => {
        const { icon, iconClass, textClass } = todoStyle(todo.status);
        return (
          <li key={i} className="flex items-baseline gap-2">
            <span className={`select-none ${iconClass}`}>{icon}</span>
            <span className={textClass}>{todo.content}</span>
          </li>
        );
      })}
    </ul>
  );
}

function todoStyle(status: TodoItem["status"]): {
  icon: string;
  iconClass: string;
  textClass: string;
} {
  switch (status) {
    case "completed":
      return {
        icon: "☑",
        iconClass: "text-emerald-500",
        textClass: "text-zinc-500 line-through",
      };
    case "in_progress":
      return {
        icon: "◐",
        iconClass: "text-orange-400",
        textClass: "font-medium text-zinc-100",
      };
    default:
      return {
        icon: "☐",
        iconClass: "text-zinc-500",
        textClass: "text-zinc-300",
      };
  }
}

function ToolCallBody({
  toolName,
  output,
  isError,
  diff,
  cleaned,
}: {
  toolName: string;
  output: string;
  isError: boolean;
  diff: ParsedDiff | null;
  cleaned: CleanedOutput | null;
}) {
  if (diff) {
    return <DiffViewer diff={diff} />;
  }
  if (toolName === "TodoWrite") {
    const todos = tryParseTodos(output);
    if (todos) return <TodoList todos={todos} />;
  }
  if (cleaned) {
    return (
      <div className="mt-1 overflow-hidden rounded border border-zinc-800/60 bg-zinc-900/40">
        {cleaned.meta && (
          <div className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-1 font-mono text-[11px] text-zinc-500">
            {cleaned.meta}
          </div>
        )}
        <pre className="claw-scroll max-h-72 overflow-auto whitespace-pre px-3 py-2 text-[12px] leading-snug text-zinc-200">
          {cleaned.text}
        </pre>
      </div>
    );
  }
  const palette =
    isError ? "text-red-300" : toolName === "bash" ? "text-zinc-200" : "text-zinc-300";
  return (
    <pre
      className={`mt-1 max-h-72 overflow-auto whitespace-pre-wrap text-[12px] leading-snug claw-scroll ${palette}`}
    >
      {output}
    </pre>
  );
}

function Spinner() {
  return (
    <span
      aria-label="running"
      className="inline-block h-2 w-2 animate-pulse rounded-full bg-orange-400"
    />
  );
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface ParsedDiff {
  filePath?: string;
  hunks: DiffHunk[];
  totalAdditions: number;
  totalDeletions: number;
}

// edit_file / write_file return a JSON payload that includes a `structuredPatch` array of
// hunks with unified-diff-style lines (prefixed `+` / `-` / ` `). When we detect that
// shape, render a colored diff in place of the raw JSON dump.
function tryParseDiff(raw: string): ParsedDiff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const patchValue = obj.structuredPatch;
  if (!Array.isArray(patchValue) || patchValue.length === 0) return null;

  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const hunkRaw of patchValue) {
    if (!hunkRaw || typeof hunkRaw !== "object") continue;
    const h = hunkRaw as Record<string, unknown>;
    const lines = Array.isArray(h.lines) ? (h.lines.filter((l) => typeof l === "string") as string[]) : [];
    for (const line of lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    hunks.push({
      oldStart: Number(h.oldStart ?? 0),
      oldLines: Number(h.oldLines ?? 0),
      newStart: Number(h.newStart ?? 0),
      newLines: Number(h.newLines ?? 0),
      lines,
    });
  }
  if (hunks.length === 0) return null;

  const filePath = typeof obj.filePath === "string" ? obj.filePath : undefined;
  return { filePath, hunks, totalAdditions: additions, totalDeletions: deletions };
}

/// File ops we know how to open in the right-side viewer. For results we use the
/// diff's `filePath`; for tool_use calls we parse the JSON input for `path`.
const FILE_TOOLS = new Set(["edit_file", "write_file", "read_file", "NotebookEdit"]);

function extractFilePathForOpen(entry: FlatEntry, diff: ParsedDiff | null): string | null {
  if (!entry.toolName || !FILE_TOOLS.has(entry.toolName)) return null;
  if (diff?.filePath) return diff.filePath;
  try {
    const parsed = JSON.parse(entry.body);
    if (parsed && typeof parsed === "object") {
      const candidate =
        (parsed as Record<string, unknown>).path ??
        (parsed as Record<string, unknown>).notebook_path ??
        (parsed as Record<string, unknown>).file_path ??
        (parsed as Record<string, unknown>).filePath;
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function DiffViewer({ diff }: { diff: ParsedDiff }) {
  return (
    <div className="mt-1 overflow-hidden rounded border border-zinc-800 bg-zinc-900/40">
      {diff.filePath && (
        <div className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-1 font-mono text-[11px] text-zinc-400">
          {diff.filePath}
          <span className="ml-2 text-emerald-400">+{diff.totalAdditions}</span>
          <span className="ml-1 text-red-400">-{diff.totalDeletions}</span>
        </div>
      )}
      <div className="max-h-72 overflow-auto claw-scroll">
        {diff.hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx} className="font-mono text-[12px] leading-tight">
            <div className="bg-sky-500/10 px-3 py-0.5 text-[10px] text-sky-300">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, idx) => {
              const first = line.charAt(0);
              const tone =
                first === "+"
                  ? "bg-emerald-500/10 text-emerald-300"
                  : first === "-"
                  ? "bg-red-500/10 text-red-300"
                  : "text-zinc-400";
              return (
                <div key={idx} className={`whitespace-pre px-3 py-[1px] ${tone}`}>
                  {line || " "}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`;
  return `${(n / (1024 * 1024)).toFixed(1)}mb`;
}

// Produce a short, glanceable summary of a tool_use input for the collapsed header.
function summarizeToolInput(toolName: string, rawJson: string): string {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
  } catch {
    return rawJson.slice(0, 120);
  }
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const num = (key: string) => (typeof input[key] === "number" ? (input[key] as number) : null);

  switch (toolName) {
    case "bash":
    case "REPL":
    case "PowerShell":
      return `$ ${truncate(str("command"), 140)}`;
    case "read_file": {
      const limit = num("limit");
      const offset = num("offset");
      const range = offset || limit
        ? ` [${offset ?? 0}${limit ? ":+" + limit : ""}]`
        : "";
      return `${truncate(str("path"), 120)}${range}`;
    }
    case "write_file": {
      const content = str("content");
      return `${truncate(str("path"), 80)} (${humanBytes(content.length)})`;
    }
    case "edit_file":
      return `${truncate(str("path"), 100)}`;
    case "glob_search":
      return `${truncate(str("pattern"), 100)}`;
    case "grep_search": {
      const pat = truncate(str("pattern"), 80);
      const path = str("path") || str("file");
      return path ? `${pat} in ${truncate(path, 60)}` : pat;
    }
    case "WebFetch":
    case "WebSearch":
      return truncate(str("url") || str("query"), 120);
    case "Agent":
      return truncate(str("prompt") || str("description") || str("description"), 120);
    case "TodoWrite": {
      const todos = (input.todos as unknown[]) ?? [];
      let done = 0;
      let active = 0;
      for (const item of todos) {
        if (item && typeof item === "object") {
          const s = (item as Record<string, unknown>).status;
          if (s === "completed") done += 1;
          else if (s === "in_progress") active += 1;
        }
      }
      const parts = [`${todos.length} todo${todos.length === 1 ? "" : "s"}`];
      if (done > 0) parts.push(`${done} done`);
      if (active > 0) parts.push(`${active} active`);
      return parts.join(" · ");
    }
    case "Skill":
      return `${truncate(str("skill") || str("name"), 80)}`;
    case "NotebookEdit":
      return `${truncate(str("notebook_path") || str("path"), 100)}`;
    case "Sleep":
      return `${num("seconds") ?? "?"}s`;
    default: {
      const first = Object.entries(input)[0];
      if (!first) return "";
      const [k, v] = first;
      return `${k}: ${truncate(typeof v === "string" ? v : JSON.stringify(v), 100)}`;
    }
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function parseSlash(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const match = rest.match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  return { name: match[1], args: match[2] };
}

function isAsyncLocalCommand(name: string): boolean {
  return name === "compact" || name === "model";
}

async function runAsyncLocalCommand(
  match: CommandSummary,
  args: string,
  ctx: {
    sessionId: SessionId;
    patchConfig: (patch: import("./api").ServerConfigPatch) => Promise<ServerConfig>;
  },
): Promise<string> {
  if (match.name === "compact") {
    try {
      const r = await compactSession(ctx.sessionId);
      const before = formatTokenCount(r.before_tokens);
      const after = formatTokenCount(r.after_tokens);
      if (r.removed_message_count === 0) {
        return `/compact: nothing to compact (kept ${r.kept_message_count} messages, est. ${before} tokens).`;
      }
      return `/compact: compacted ${r.removed_message_count} messages → kept ${r.kept_message_count}. Est. tokens ${before} → ${after}.`;
    } catch (err) {
      return `/compact failed: ${(err as Error).message}`;
    }
  }
  if (match.name === "model") {
    const target = args.trim();
    if (!target) return "/model: type `/model <name>` to switch, or `/model` (no args) opens the picker.";
    try {
      const updated = await ctx.patchConfig({ model: target });
      return `/model: switched to \`${updated.model}\` (ctx ${formatTokenCount(updated.context_window)}).`;
    } catch (err) {
      return `/model failed: ${(err as Error).message}`;
    }
  }
  return `/${match.name}: not yet implemented`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value}`;
}

function renderLocalCommand(
  match: CommandSummary,
  args: string,
  all: CommandSummary[],
): string {
  if (match.name === "help") {
    const byCategory = new Map<string, CommandSummary[]>();
    for (const c of all) {
      const list = byCategory.get(c.category) ?? [];
      list.push(c);
      byCategory.set(c.category, list);
    }
    const sections: string[] = ["Available slash commands:"];
    for (const [cat, list] of byCategory) {
      sections.push("");
      sections.push(`${cat}:`);
      for (const c of list) {
        const hint = c.argument_hint ? ` ${c.argument_hint}` : "";
        sections.push(`  /${c.name}${hint}  —  ${c.summary}`);
      }
    }
    return sections.join("\n");
  }
  const argSuffix = args ? ` (args: ${args})` : "";
  return `/${match.name}${argSuffix}: not yet implemented locally`;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  sending: boolean;
  disabled: boolean;
  turnState: TurnState;
  error: string | null;
  commands: CommandSummary[];
  contextWindow: number;
  lastUsage: TokenUsage | null;
  model: string | null;
  attachments: AttachmentRef[];
  attachmentStats: Record<string, AttachmentStat | "loading" | { error: string }>;
  onAddAttachment: (att: AttachmentRef) => void;
  onRemoveAttachment: (index: number) => void;
  onUploadFile: (file: File) => void | Promise<void>;
  /** Cumulative tokens spent on this session. Used by BudgetBadge to
   * render the running cost vs. the configured ceiling. */
  cumulativeTokens: number;
  /** Per-session token budget — `null` means unlimited; the budget badge
   * is hidden in that case. */
  budget: number | null;
  /** Catalog of RAG libraries surfaced in the 📚 popover. */
  libraries: LibrarySummary[];
  /** Currently attached library for this session (null = no auto-RAG). */
  attachedLibrary: string | null;
  /** Bind / unbind a library to the active session. */
  onAttachLibrary: (library: string | null) => Promise<void>;
  /** Open the standalone "Create skill" modal. Triggered from the `+`
   *  menu so the user can author a skill mid-chat — same affordance
   *  as attaching a file, just for tool capabilities instead. */
  onOpenSkillCreate: () => void;
}

function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  sending,
  disabled,
  turnState,
  error,
  commands,
  contextWindow,
  lastUsage,
  model,
  attachments,
  attachmentStats,
  onAddAttachment,
  onRemoveAttachment,
  onUploadFile,
  cumulativeTokens,
  budget,
  libraries,
  attachedLibrary,
  onAttachLibrary,
  onOpenSkillCreate,
}: ComposerProps) {
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const running = turnState === "running";
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Popover shows only while the user is still typing the command name —
  // i.e. value starts with `/` and there's no whitespace yet.
  const slashQuery = useMemo(() => {
    const match = value.match(/^\s*\/(\S*)$/);
    return match ? match[1].toLowerCase() : null;
  }, [value]);

  const suggestions = useMemo(() => {
    if (slashQuery === null) return [];
    return commands
      .filter(
        (c) =>
          c.name.toLowerCase().startsWith(slashQuery) ||
          c.aliases.some((a) => a.toLowerCase().startsWith(slashQuery)),
      )
      .slice(0, 8);
  }, [commands, slashQuery]);

  // Reset selection whenever the candidate list changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  // Reopen popover when the user resumes typing a slash query after dismissing.
  useEffect(() => {
    setDismissed(false);
  }, [slashQuery]);

  const popoverOpen = suggestions.length > 0 && !dismissed;

  const applySuggestion = (idx: number) => {
    const c = suggestions[idx];
    if (!c) return;
    const suffix = c.argument_hint ? " " : "";
    onChange(`/${c.name}${suffix}`);
    setDismissed(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  return (
    <div className="border-t border-zinc-800 px-6 py-3">
      <div className="relative mx-auto max-w-3xl">
        {error && (
          <div className="mb-2 text-xs text-red-400">{error}</div>
        )}
        {popoverOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-2 rounded border border-zinc-800 bg-zinc-950/95 shadow-lg backdrop-blur">
            <ul className="claw-scroll max-h-60 overflow-y-auto py-1">
              {suggestions.map((c, i) => {
                const active = i === selectedIndex;
                return (
                  <li key={c.name}>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applySuggestion(i);
                      }}
                      onMouseEnter={() => setSelectedIndex(i)}
                      className={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-[12px] ${
                        active
                          ? "bg-zinc-900 text-zinc-100"
                          : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-100"
                      }`}
                    >
                      <span className="font-mono text-zinc-200">/{c.name}</span>
                      {c.argument_hint && (
                        <span className="text-zinc-600">{c.argument_hint}</span>
                      )}
                      <span className="ml-auto truncate text-[11px] text-zinc-500">
                        {c.summary}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-zinc-800 px-3 py-1 text-[10px] text-zinc-600">
              ↑↓ navigate · tab/enter to insert · esc to dismiss
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <AttachmentChips
            attachments={attachments}
            stats={attachmentStats}
            onRemove={onRemoveAttachment}
          />
        )}
        <div
          className={`flex items-center gap-2 rounded border bg-zinc-900/60 px-3 py-2 transition-colors ${
            dragOver
              ? "border-orange-400/80 bg-orange-500/5"
              : "border-zinc-800 focus-within:border-orange-400/60"
          }`}
          onDragOver={(e) => {
            // Anything being dragged over the composer is potentially a
            // file — accept it. preventDefault is what tells the browser
            // we're a valid drop target.
            if (disabled || sending) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (disabled || sending) return;
            e.preventDefault();
            setDragOver(false);
            for (const file of Array.from(e.dataTransfer.files)) {
              void onUploadFile(file);
            }
          }}
        >
          <AttachButton
            disabled={disabled || sending}
            onAdd={onAddAttachment}
            onOpenSkillCreate={onOpenSkillCreate}
          />
          <LibraryAttachButton
            disabled={disabled || sending}
            libraries={libraries}
            attached={attachedLibrary}
            onAttach={onAttachLibrary}
          />
          <textarea
            ref={taRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onPaste={(event) => {
              // Grab any files from the clipboard (Ctrl+V on a copied
              // screenshot or a file from the OS clipboard). Default
              // paste continues for normal text.
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              for (const file of files) {
                void onUploadFile(file);
              }
            }}
            onKeyDown={(event) => {
              if (popoverOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  const exact = suggestions.find(
                    (s) => s.name.toLowerCase() === slashQuery,
                  );
                  if (event.key === "Enter" && exact) {
                    // Command name is already fully typed — send instead of completing.
                    onSend();
                  } else {
                    applySuggestion(selectedIndex);
                  }
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissed(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder={
              disabled
                ? "create or pick a session first"
                : running
                ? "running — press cancel to abort"
                : attachments.length > 0
                ? "message (or send attachments only)…"
                : "message claw…"
            }
            disabled={disabled || sending}
            className="flex-1 resize-none bg-transparent text-zinc-100 placeholder-zinc-600 focus:outline-none disabled:opacity-50"
            style={{ maxHeight: "180px" }}
          />
          {running ? (
            <button
              onClick={onCancel}
              className="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/10"
            >
              cancel
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={
                disabled || sending || (!value.trim() && attachments.length === 0)
              }
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:border-orange-400 hover:text-orange-400 disabled:opacity-30"
            >
              {sending ? "…" : "send"}
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-end text-[11px] text-zinc-600">
          <span className="flex items-center gap-2">
            {model && (
              <span className="text-zinc-500" title={`Active model: ${model}`}>
                {model}
              </span>
            )}
            {model && contextWindow > 0 && <span className="text-zinc-700">·</span>}
            <ContextBadge contextWindow={contextWindow} lastUsage={lastUsage} />
            {budget != null && budget > 0 && (
              <>
                <span className="text-zinc-700">·</span>
                <BudgetBadge used={cumulativeTokens} budget={budget} />
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function AttachmentChips({
  attachments,
  stats,
  onRemove,
}: {
  attachments: AttachmentRef[];
  stats: Record<string, AttachmentStat | "loading" | { error: string }>;
  onRemove: (idx: number) => void;
}) {
  const totalKnown = attachments.reduce((acc, a) => {
    const s = stats[a.path];
    if (s && s !== "loading" && !("error" in s)) {
      return acc + s.estimated_tokens;
    }
    return acc;
  }, 0);
  const pending = attachments.some(
    (a) => stats[a.path] === "loading" || stats[a.path] === undefined,
  );
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1">
      {attachments.map((att, i) => {
        const name = att.path.split("/").pop() || att.path;
        const stat = stats[att.path];
        const isImage = stat && stat !== "loading" && !("error" in stat) && stat.kind === "image";
        const tokens =
          stat && stat !== "loading" && !("error" in stat)
            ? formatTokenCount(stat.estimated_tokens)
            : stat === "loading"
            ? "…"
            : null;
        const errorMessage =
          stat && typeof stat === "object" && "error" in stat ? stat.error : null;
        return (
          <span
            key={`${att.path}-${i}`}
            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${
              errorMessage
                ? "border-red-500/50 bg-red-500/10 text-red-200"
                : "border-zinc-700 bg-zinc-900/80 text-zinc-200"
            }`}
            title={errorMessage ? `${att.path}\n${errorMessage}` : att.path}
          >
            <span className="text-zinc-500">{isImage ? "🖼" : "📄"}</span>
            <span className="max-w-[200px] truncate">{name}</span>
            {tokens && (
              <span className="text-[10px] text-zinc-500">~{tokens}</span>
            )}
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="text-zinc-500 hover:text-red-300"
              title="Remove attachment"
            >
              ×
            </button>
          </span>
        );
      })}
      {(totalKnown > 0 || pending) && (
        <span className="ml-auto text-[10px] text-zinc-500" title="Sum of attachment token estimates (rough)">
          total ~{formatTokenCount(totalKnown)}{pending ? " …" : ""}
        </span>
      )}
    </div>
  );
}

function LibraryAttachButton({
  disabled,
  libraries,
  attached,
  onAttach,
}: {
  disabled: boolean;
  libraries: LibrarySummary[];
  attached: string | null;
  onAttach: (library: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Close the popover when the user clicks outside; clicking the
  // button itself toggles via `setOpen((v) => !v)`.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const choose = async (library: string | null) => {
    setBusy(true);
    try {
      await onAttach(library);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => setOpen((v) => !v)}
        title={
          attached
            ? `RAG library attached: ${attached}`
            : "attach a RAG library — every turn auto-retrieves top-5 chunks"
        }
        className={`flex items-center gap-1 self-end rounded border px-2 py-1 text-[12px] ${
          attached
            ? "border-orange-400 bg-orange-400/10 text-orange-300"
            : "border-zinc-700 text-zinc-400 hover:border-orange-400 hover:text-orange-400"
        } disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <span>📚</span>
        {attached && (
          <span className="max-w-[120px] truncate font-mono text-[11px]">
            {attached}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-2 w-64 rounded border border-zinc-800 bg-zinc-950 p-1 text-xs shadow-lg">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            knowledge libraries
          </div>
          <button
            type="button"
            onClick={() => void choose(null)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
              attached == null
                ? "bg-zinc-800/60 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/40"
            }`}
          >
            <span>—</span>
            <span>(none)</span>
            {attached == null && <span className="ml-auto text-orange-400">✓</span>}
          </button>
          {libraries.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-zinc-600">
              no libraries — create one in the rag drawer
            </div>
          ) : (
            libraries.map((lib) => (
              <button
                key={lib.name}
                type="button"
                onClick={() => void choose(lib.name)}
                className={`flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left ${
                  attached === lib.name
                    ? "bg-zinc-800/60 text-zinc-100"
                    : "text-zinc-300 hover:bg-zinc-800/40"
                }`}
              >
                <span className="font-mono">{lib.name}</span>
                <span className="ml-auto text-[10px] text-zinc-600">
                  {lib.chunk_count}c
                </span>
                {attached === lib.name && (
                  <span className="text-orange-400">✓</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AttachButton({
  disabled,
  onAdd,
  onOpenSkillCreate,
}: {
  disabled: boolean;
  onAdd: (att: AttachmentRef) => void;
  /** Opens the standalone Create-skill modal. Lives in the same menu as
   *  file attach because it's the same "augment this conversation"
   *  mental model — files for inputs, skills for tool capabilities. */
  onOpenSkillCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [pickError, setPickError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open && !manualOpen) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
        setManualOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, manualOpen]);

  const handlePickNative = async () => {
    setBusy(true);
    setPickError(null);
    try {
      const r = await pickAttachmentFile();
      if (!r.supported) {
        setPickError("Native file picker is not supported on this OS — paste a path instead.");
        return;
      }
      if (r.path) {
        onAdd({ type: "file", path: r.path });
        setOpen(false);
      }
    } catch (err) {
      setPickError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleManualSubmit = () => {
    const trimmed = manualPath.trim();
    if (!trimmed) return;
    onAdd({ type: "file", path: trimmed });
    setManualPath("");
    setManualOpen(false);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="Attach file"
        className="flex h-7 w-7 select-none items-center justify-center rounded-full border border-zinc-700 text-[14px] leading-none text-zinc-400 hover:border-orange-400/60 hover:text-orange-300 disabled:opacity-30"
      >
        +
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-2 w-64 rounded border border-zinc-800 bg-zinc-950 p-1 text-xs shadow-lg">
          <button
            type="button"
            onClick={handlePickNative}
            disabled={busy}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
          >
            <span>📁 Pick file…</span>
            <span className="text-[10px] text-zinc-600">native</span>
          </button>
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-900"
          >
            <span>📋 Paste path…</span>
            <span className="text-[10px] text-zinc-600">absolute</span>
          </button>
          <div className="my-1 border-t border-zinc-800" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSkillCreate();
            }}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-900"
          >
            <span>🧠 Create skill…</span>
            <span className="text-[10px] text-zinc-600">~/.claw/skills</span>
          </button>
          {manualOpen && (
            <div className="mt-1 border-t border-zinc-800 px-2 pt-2">
              <input
                type="text"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleManualSubmit();
                  }
                  if (e.key === "Escape") setManualOpen(false);
                }}
                autoFocus
                placeholder="/abs/path/to/file"
                className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
              />
              <div className="mt-1 flex justify-end">
                <button
                  type="button"
                  onClick={handleManualSubmit}
                  disabled={!manualPath.trim()}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-200 hover:border-orange-400 disabled:opacity-30"
                >
                  add
                </button>
              </div>
            </div>
          )}
          {pickError && (
            <div className="mt-1 border-t border-zinc-800 px-2 py-1 text-[10px] text-red-300">
              {pickError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MergedModel {
  id: string;
  contextWindow: number | null;
  fromLive: boolean;
}

function ModelPicker({
  providers,
  currentModel,
  onClose,
  onPick,
}: {
  providers: ProviderSummary[];
  currentModel: string | null;
  onClose: () => void;
  onPick: (model: string) => Promise<void> | void;
}) {
  const [liveByProvider, setLiveByProvider] = useState<Record<string, LiveModel[]>>({});
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = useCallback(async (name: string) => {
    setLoadingProvider(name);
    setError(null);
    try {
      const r = await fetchLiveModels(name);
      setLiveByProvider((prev) => ({ ...prev, [name]: r.models }));
    } catch (err) {
      setError(`${name}: ${(err as Error).message}`);
    } finally {
      setLoadingProvider(null);
    }
  }, []);

  // Auto-fetch live models for every configured provider as soon as the
  // picker opens. Live is authoritative — deprecated models that the
  // provider has dropped (e.g. `deepseek-chat` once it rotates out) should
  // not appear, and we don't want the user to have to click "refresh" on
  // each provider before they see the real list.
  useEffect(() => {
    for (const p of providers) {
      if (p.configured) {
        refresh(p.name);
      }
    }
    // refresh is stable (useCallback []), providers list rarely changes mid-modal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/95 px-6 py-3 backdrop-blur">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            switch model
          </span>
          <button
            onClick={onClose}
            className="text-[11px] text-zinc-500 hover:text-zinc-100"
          >
            esc · close
          </button>
        </div>
        <ul className="claw-scroll mt-2 max-h-72 space-y-3 overflow-y-auto pr-1">
          {providers.map((p) => {
            const isLoading = loadingProvider === p.name;
            const merged = mergeModels(p.models, liveByProvider[p.name]);
            return (
              <li key={p.name}>
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>
                    {p.label}
                    {!p.configured && (
                      <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                        no key
                      </span>
                    )}
                  </span>
                  <button
                    disabled={!p.configured || isLoading}
                    onClick={() => refresh(p.name)}
                    className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-orange-400/60 hover:text-orange-400 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {isLoading ? "fetching…" : "refresh live"}
                  </button>
                </div>
                <ul className="mt-1 rounded border border-zinc-800/60">
                  {merged.length === 0 && (
                    <li className="px-3 py-2 text-[11px] text-zinc-600">
                      no models listed
                    </li>
                  )}
                  {merged.map((m) => {
                    const active = m.id === currentModel;
                    return (
                      <li key={m.id}>
                        <button
                          onMouseDown={(event) => {
                            event.preventDefault();
                            if (!active) onPick(m.id);
                          }}
                          disabled={active}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                            active
                              ? "bg-zinc-900/50 text-zinc-400"
                              : "text-zinc-200 hover:bg-zinc-900/70"
                          }`}
                        >
                          <span className="font-mono">{m.id}</span>
                          {m.fromLive && (
                            <span className="rounded bg-emerald-500/10 px-1 py-px text-[10px] text-emerald-400">
                              live
                            </span>
                          )}
                          {active && (
                            <span className="text-[10px] text-orange-400">
                              current
                            </span>
                          )}
                          {m.contextWindow !== null && (
                            <span className="ml-auto text-[10px] text-zinc-500">
                              {formatTokenCount(m.contextWindow)} ctx
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
        {error && (
          <div className="mt-2 rounded border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-[11px] text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function mergeModels(staticIds: string[], live: LiveModel[] | undefined): MergedModel[] {
  // Live is authoritative: once we have a fresh response from the provider
  // we surface exactly that list. Anything the provider drops (e.g. a
  // deprecated alias) is gone from the picker. The static catalog is only
  // a placeholder shown while the live fetch is still in flight.
  if (live) {
    return live.map((m) => ({
      id: m.id,
      contextWindow: m.context_window,
      fromLive: true,
    }));
  }
  return staticIds.map((id) => ({ id, contextWindow: null, fromLive: false }));
}

function BudgetBadge({
  used,
  budget,
}: {
  used: number;
  budget: number | null;
}) {
  // Hidden when no budget configured — keeps the ctx area uncluttered for
  // users who don't care about cost gating.
  if (budget == null || budget <= 0) return null;
  const pct = Math.min(100, (used / budget) * 100);
  const color =
    pct >= 100
      ? "text-red-400"
      : pct >= 90
        ? "text-amber-400"
        : pct >= 70
          ? "text-amber-500/80"
          : "text-zinc-500";
  return (
    <span
      className={color}
      title={`Session: ${used.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct.toFixed(
        1,
      )}%). New turns are blocked once usage reaches the budget.`}
    >
      budget {formatTokenCount(used)} / {formatTokenCount(budget)} ({pct.toFixed(0)}%)
    </span>
  );
}

function ContextBadge({
  contextWindow,
  lastUsage,
}: {
  contextWindow: number;
  lastUsage: TokenUsage | null;
}) {
  if (contextWindow <= 0) return null;
  const limitLabel = formatTokenCount(contextWindow);
  if (!lastUsage) {
    return (
      <span
        title={`Context window: ${contextWindow.toLocaleString()} tokens. Usage shows after the next turn.`}
      >
        ctx — / {limitLabel}
      </span>
    );
  }
  const used =
    lastUsage.input_tokens +
    lastUsage.cache_creation_input_tokens +
    lastUsage.cache_read_input_tokens;
  const pct = Math.min(100, (used / contextWindow) * 100);
  const color =
    pct >= 95 ? "text-red-400" : pct >= 80 ? "text-amber-400" : "text-zinc-500";
  return (
    <span
      className={color}
      title={`${used.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
    >
      ctx {formatTokenCount(used)} / {limitLabel} ({pct.toFixed(0)}%)
    </span>
  );
}

interface DrawerPanelProps {
  drawer: Drawer;
  onClose: () => void;
  events: SessionEvent[];
  sessionId: SessionId | null;
  tools: ToolSummary[];
  commands: CommandSummary[];
  config: ServerConfig | null;
  mcpServers: McpServerSummary[];
  onModeChange: (mode: string) => void;
  onModelChange: (model: string | null) => void;
  onSaveMcpServer: (name: string, payload: McpServerPayload) => Promise<void>;
  onDeleteMcpServer: (name: string) => Promise<void>;
  onToggleMcpServer: (name: string, enabled: boolean) => Promise<void>;
  onInstallPreset: (
    presetId: string,
    name: string,
    inputs: Record<string, string>,
  ) => Promise<void>;
  onInstallFromRegistry: (
    registryName: string,
    serverName: string,
    inputs: Record<string, string>,
  ) => Promise<void>;
  libraries: LibrarySummary[];
  embeddingProvider: EmbeddingProviderView | null;
  onRefreshLibraries: () => Promise<void>;
  onCreateLibrary: (name: string) => Promise<void>;
  onIngestLibrary: (name: string, file: File) => Promise<void>;
  onDeleteLibrary: (name: string) => Promise<void>;
  onSaveEmbeddingProvider: (
    payload: import("./types").EmbeddingProviderPatch | null,
  ) => Promise<void>;
  onWorkspaceChange: (value: string | null) => Promise<void>;
  openFilePath: string | null;
  onOpenFile: (path: string | null) => void;
  fileViewerNonce: number;
}

function DrawerPanel(props: DrawerPanelProps) {
  if (props.drawer === null) return null;
  const titles: Record<Exclude<Drawer, null>, string> = {
    sessions: "sessions",
    events: "events",
    tools: "tools",
    commands: "commands",
    config: "config",
    files: "files",
    mcp: "mcp servers",
    rag: "rag libraries",
  };
  return (
    <aside className="flex w-96 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-xs uppercase tracking-wider text-zinc-500">
        <span>{titles[props.drawer]}</span>
        <button onClick={props.onClose} className="text-zinc-500 hover:text-zinc-100">
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {props.drawer === "events" && (
          <EventsList events={props.events} sessionId={props.sessionId} />
        )}
        {props.drawer === "tools" && <ToolsList tools={props.tools} />}
        {props.drawer === "commands" && <CommandsList commands={props.commands} />}
        {props.drawer === "config" && (
          <ConfigEditor
            config={props.config}
            onModeChange={props.onModeChange}
            onModelChange={props.onModelChange}
            onWorkspaceChange={props.onWorkspaceChange}
          />
        )}
        {props.drawer === "files" && (
          <FilesPanel
            workspaceRoot={props.config?.workspace_root ?? null}
            openPath={props.openFilePath}
            onOpenPath={props.onOpenFile}
            nonce={props.fileViewerNonce}
          />
        )}
        {props.drawer === "mcp" && (
          <McpEditor
            servers={props.mcpServers}
            onSave={props.onSaveMcpServer}
            onDelete={props.onDeleteMcpServer}
            onToggleEnabled={props.onToggleMcpServer}
            onInstallPreset={props.onInstallPreset}
            onInstallFromRegistry={props.onInstallFromRegistry}
          />
        )}
        {props.drawer === "rag" && (
          <RagLibraryEditor
            libraries={props.libraries}
            embeddingProvider={props.embeddingProvider}
            onRefresh={props.onRefreshLibraries}
            onCreate={props.onCreateLibrary}
            onIngest={props.onIngestLibrary}
            onDelete={props.onDeleteLibrary}
            onSaveEmbeddingProvider={props.onSaveEmbeddingProvider}
          />
        )}
      </div>
    </aside>
  );
}

function EventsList({
  events,
  sessionId,
}: {
  events: SessionEvent[];
  sessionId: SessionId | null;
}) {
  const filtered = sessionId
    ? events.filter((event) => event.session_id === sessionId)
    : events;
  if (filtered.length === 0) {
    return <div className="px-4 py-6 text-xs text-zinc-600">no events yet</div>;
  }
  return (
    <ul className="space-y-1 px-3 py-3 text-[11px]">
      {filtered.map((event, i) => (
        <li key={i}>
          <details className="rounded border border-zinc-800/60 bg-zinc-900/30 open:bg-zinc-900/60">
            <summary className="cursor-pointer px-2 py-1 text-zinc-300">
              <span className="text-orange-400">{event.type}</span>
            </summary>
            <pre className="overflow-x-auto px-2 pb-2 pt-1 text-zinc-400">
              {JSON.stringify(event, null, 2)}
            </pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function ToolsList({ tools }: { tools: ToolSummary[] }) {
  if (tools.length === 0) {
    return <div className="px-4 py-6 text-xs text-zinc-600">loading tools…</div>;
  }
  return (
    <ul className="divide-y divide-zinc-800/60">
      {tools.map((tool) => (
        <li key={tool.name} className="px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-zinc-100">{tool.name}</span>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              {tool.required_permission}
            </span>
          </div>
          <p className="mt-1 font-sans text-[12px] text-zinc-400">{tool.description}</p>
        </li>
      ))}
    </ul>
  );
}

function CommandsList({ commands }: { commands: CommandSummary[] }) {
  if (commands.length === 0) {
    return <div className="px-4 py-6 text-xs text-zinc-600">loading commands…</div>;
  }
  return (
    <ul className="divide-y divide-zinc-800/60">
      {commands.map((command) => (
        <li key={command.name} className="px-4 py-2">
          <div className="flex items-baseline gap-2">
            <span className="text-zinc-100">/{command.name}</span>
            {command.argument_hint && (
              <span className="text-zinc-500">{command.argument_hint}</span>
            )}
            <span className="ml-auto text-[10px] uppercase tracking-wider text-zinc-600">
              {command.category}
            </span>
          </div>
          <p className="mt-0.5 font-sans text-[12px] text-zinc-400">{command.summary}</p>
        </li>
      ))}
    </ul>
  );
}

interface McpEditorProps {
  servers: McpServerSummary[];
  onSave: (name: string, payload: McpServerPayload) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onToggleEnabled: (name: string, enabled: boolean) => Promise<void>;
  onInstallPreset: (
    presetId: string,
    name: string,
    inputs: Record<string, string>,
  ) => Promise<void>;
  onInstallFromRegistry: (
    registryName: string,
    serverName: string,
    inputs: Record<string, string>,
  ) => Promise<void>;
}

function McpEditor({
  servers,
  onSave,
  onDelete,
  onToggleEnabled,
  onInstallPreset,
  onInstallFromRegistry,
}: McpEditorProps) {
  const [adding, setAdding] = useState(false);
  const [presetModal, setPresetModal] = useState(false);
  return (
    <div>
      <div className="border-b border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
        Stdio MCP servers spawned by claw. Tools become available as{" "}
        <span className="font-mono text-zinc-300">mcp__&lt;name&gt;__&lt;tool&gt;</span>.
      </div>
      <ul className="divide-y divide-zinc-800/60">
        {servers.length === 0 && !adding && (
          <li className="px-4 py-4 text-xs text-zinc-600">
            no MCP servers configured. Add one below.
          </li>
        )}
        {servers.map((server) => (
          <li key={server.name}>
            <McpServerRow
              server={server}
              onSave={onSave}
              onDelete={onDelete}
              onToggleEnabled={onToggleEnabled}
            />
          </li>
        ))}
        {adding && (
          <li>
            <McpServerForm
              initial={null}
              onSubmit={async (name, payload) => {
                await onSave(name, payload);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          </li>
        )}
      </ul>
      {!adding && (
        <div className="space-y-2 px-4 py-3">
          <button
            onClick={() => setPresetModal(true)}
            className="w-full rounded border border-orange-400/40 bg-orange-400/5 px-2 py-2 text-xs text-orange-300 hover:border-orange-400 hover:bg-orange-400/10"
          >
            ⚡ install from preset
          </button>
          <button
            onClick={() => setAdding(true)}
            className="w-full rounded border border-zinc-800 px-2 py-2 text-xs text-zinc-300 hover:border-orange-400 hover:text-orange-400"
          >
            + add MCP server (manual)
          </button>
        </div>
      )}
      {presetModal && (
        <PresetCatalogModal
          existingNames={servers.map((s) => s.name)}
          onClose={() => setPresetModal(false)}
          onInstall={async (presetId, name, inputs) => {
            await onInstallPreset(presetId, name, inputs);
            setPresetModal(false);
          }}
          onInstallFromRegistry={async (registryName, name, inputs) => {
            await onInstallFromRegistry(registryName, name, inputs);
            setPresetModal(false);
          }}
        />
      )}
    </div>
  );
}

interface PresetCatalogModalProps {
  existingNames: string[];
  onClose: () => void;
  onInstall: (
    presetId: string,
    name: string,
    inputs: Record<string, string>,
  ) => Promise<void>;
  onInstallFromRegistry: (
    registryName: string,
    name: string,
    inputs: Record<string, string>,
  ) => Promise<void>;
}

interface RagLibraryEditorProps {
  libraries: LibrarySummary[];
  embeddingProvider: EmbeddingProviderView | null;
  onRefresh: () => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onIngest: (name: string, file: File) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onSaveEmbeddingProvider: (
    payload: import("./types").EmbeddingProviderPatch | null,
  ) => Promise<void>;
}

function RagLibraryEditor({
  libraries,
  embeddingProvider,
  onRefresh,
  onCreate,
  onIngest,
  onDelete,
  onSaveEmbeddingProvider,
}: RagLibraryEditorProps) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Strict name validation mirrors backend rules so the UX fails fast
  // instead of round-tripping through a 400.
  const nameValid =
    newName.length > 0 &&
    newName.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(newName);

  const handleCreate = async () => {
    if (!nameValid) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(newName);
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div className="border-b border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
        RAG libraries are sqlite-vec stores at{" "}
        <span className="font-mono text-zinc-300">~/.claw/rag/&lt;name&gt;.db</span>.
        Attach a library to a session via the 📚 button in the composer.
      </div>

      <EmbeddingProviderSection
        current={embeddingProvider}
        librariesExist={libraries.length > 0}
        onSave={onSaveEmbeddingProvider}
      />

      <div className="border-b border-zinc-800 px-4 py-3">
        <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
          create new library
        </label>
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameValid) {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="name (alphanumeric, _, -)"
            className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
          />
          <button
            disabled={!nameValid || creating}
            onClick={handleCreate}
            className="rounded border border-orange-400 bg-orange-400/10 px-3 py-1 text-xs text-orange-300 hover:bg-orange-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? "creating…" : "create"}
          </button>
        </div>
        {error && (
          <div className="mt-1 text-[11px] text-red-400">{error}</div>
        )}
      </div>

      <ul className="divide-y divide-zinc-800/60">
        {libraries.length === 0 && (
          <li className="px-4 py-4 text-xs text-zinc-600">
            no libraries yet — create one above, then upload files into it.
          </li>
        )}
        {libraries.map((lib) => (
          <li key={lib.name}>
            <LibraryRow
              library={lib}
              onIngest={(file) => onIngest(lib.name, file)}
              onDelete={async () => {
                if (
                  !window.confirm(
                    `Delete library "${lib.name}"? Its ${lib.chunk_count} chunks (~${formatBytes(lib.size_bytes)}) will be lost.`,
                  )
                ) {
                  return;
                }
                await onDelete(lib.name);
              }}
              onRefresh={onRefresh}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/// Hand-curated list of OpenAI-compatible embedding endpoints we know
/// work today. Selecting a preset pre-fills base_url / model /
/// dimensions; the user only has to paste their API key. "Custom" leaves
/// all fields empty so users can wire anything that speaks the
/// OpenAI `/v1/embeddings` shape (Voyage, Cohere compat, LiteLLM, ...).
const EMBEDDING_PRESETS: {
  id: string;
  label: string;
  base_url: string;
  model: string;
  dimensions: number;
  note?: string;
}[] = [
  {
    id: "openai-3-small",
    label: "OpenAI text-embedding-3-small",
    base_url: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimensions: 1536,
    note: "default · 1536-d · multilingual decent",
  },
  {
    id: "openai-3-large",
    label: "OpenAI text-embedding-3-large",
    base_url: "https://api.openai.com/v1",
    model: "text-embedding-3-large",
    dimensions: 3072,
    note: "higher quality · 3072-d · more expensive",
  },
  {
    id: "dashscope-v4-1024",
    label: "DashScope text-embedding-v4 (1024-d)",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v4",
    dimensions: 1024,
    note: "best Chinese quality · 1024-d",
  },
  {
    id: "dashscope-v3-1024",
    label: "DashScope text-embedding-v3 (1024-d)",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v3",
    dimensions: 1024,
    note: "previous gen · 1024-d",
  },
];

interface EmbeddingProviderSectionProps {
  current: EmbeddingProviderView | null;
  librariesExist: boolean;
  onSave: (
    payload: import("./types").EmbeddingProviderPatch | null,
  ) => Promise<void>;
}

function EmbeddingProviderSection({
  current,
  librariesExist,
  onSave,
}: EmbeddingProviderSectionProps) {
  const [editing, setEditing] = useState(false);
  const [presetId, setPresetId] = useState<string>("openai-3-small");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form to either the currently saved provider's URL / model /
  // dim (so editing feels like "change one field") or to the first
  // preset's defaults if nothing's configured yet.
  const resetForm = useCallback(() => {
    setApiKey("");
    setError(null);
    if (current) {
      setBaseUrl(current.base_url);
      setModel(current.model);
      setDimensions(String(current.dimensions));
      // Pick the preset that matches, else "custom".
      const match = EMBEDDING_PRESETS.find(
        (p) =>
          p.base_url === current.base_url &&
          p.model === current.model &&
          p.dimensions === current.dimensions,
      );
      setPresetId(match?.id ?? "custom");
    } else {
      const p = EMBEDDING_PRESETS[0];
      setPresetId(p.id);
      setBaseUrl(p.base_url);
      setModel(p.model);
      setDimensions(String(p.dimensions));
    }
  }, [current]);

  useEffect(() => {
    if (editing) resetForm();
  }, [editing, resetForm]);

  // Preset selection pre-fills the form fields; "custom" leaves them
  // alone so the user can paste arbitrary values.
  const applyPreset = (id: string) => {
    setPresetId(id);
    if (id === "custom") return;
    const p = EMBEDDING_PRESETS.find((x) => x.id === id);
    if (p) {
      setBaseUrl(p.base_url);
      setModel(p.model);
      setDimensions(String(p.dimensions));
    }
  };

  const parsedDim = Number.parseInt(dimensions, 10);
  const dimInvalid =
    !dimensions.trim() || Number.isNaN(parsedDim) || parsedDim <= 0;
  const newDimDiffersFromCurrent =
    current != null && parsedDim !== current.dimensions;
  const canSave =
    baseUrl.trim().length > 0 &&
    model.trim().length > 0 &&
    apiKey.trim().length > 0 &&
    !dimInvalid &&
    !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        base_url: baseUrl.trim(),
        api_key: apiKey,
        model: model.trim(),
        dimensions: parsedDim,
      });
      setEditing(false);
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (
      !window.confirm(
        "Clear the embedding provider? RAG ingestion and retrieval will fail until you set one again.",
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(null);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border-b border-zinc-800 px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] uppercase tracking-wider text-zinc-400">
          Embedding provider
        </h3>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-orange-400 hover:text-orange-400"
          >
            {current ? "edit" : "configure"}
          </button>
        )}
      </div>

      {/* Read-only summary */}
      {!editing && (
        <div className="text-xs">
          {current ? (
            <div className="space-y-0.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-zinc-200">{current.model}</span>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                  {current.dimensions}-d
                </span>
                {current.configured ? (
                  <span className="text-[10px] text-emerald-400">✓ key set</span>
                ) : (
                  <span className="text-[10px] text-red-400">⚠ no key</span>
                )}
              </div>
              <div className="font-mono text-[10px] text-zinc-500">
                {current.base_url}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-zinc-600">
              not configured — RAG ingestion will fail until you set one.
              OpenAI, DashScope, or any OpenAI-compatible endpoint works.
            </div>
          )}
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="space-y-2 text-xs">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
              Preset
            </label>
            <select
              value={presetId}
              onChange={(e) => applyPreset(e.target.value)}
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-zinc-200 focus:border-orange-400 focus:outline-none"
            >
              {EMBEDDING_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom (manual entry)</option>
            </select>
            {presetId !== "custom" && (
              <div className="mt-1 text-[10px] text-zinc-600">
                {EMBEDDING_PRESETS.find((p) => p.id === presetId)?.note}
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
              Base URL
            </label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                Model
              </label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="text-embedding-3-small"
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
              />
            </div>
            <div className="w-28">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                Dimensions
              </label>
              <input
                value={dimensions}
                onChange={(e) => setDimensions(e.target.value)}
                placeholder="1536"
                className={`w-full rounded border bg-zinc-950 px-2 py-1 font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
                  dimInvalid
                    ? "border-red-500/60 focus:border-red-500"
                    : "border-zinc-800 focus:border-orange-400"
                }`}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
              API key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                current?.configured
                  ? "(re-enter to change · stored server-side)"
                  : "sk-..."
              }
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
              autoComplete="off"
            />
          </div>

          {librariesExist && newDimDiffersFromCurrent && (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-300">
              ⚠ Changing dimensions ({current?.dimensions} → {parsedDim})
              requires restarting the server and deleting existing libraries —
              their vec0 tables are locked to the old dimension.
            </div>
          )}

          {error && (
            <div className="text-[11px] text-red-400">{error}</div>
          )}

          <div className="flex items-center gap-2">
            <button
              disabled={!canSave}
              onClick={handleSave}
              className="rounded border border-orange-400 bg-orange-400/10 px-3 py-1 text-orange-300 hover:bg-orange-400/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "saving…" : "save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              className="rounded border border-zinc-700 px-3 py-1 text-zinc-400 hover:border-orange-400 hover:text-orange-400"
            >
              cancel
            </button>
            {current && (
              <button
                onClick={handleClear}
                className="ml-auto rounded border border-zinc-800 px-2 py-1 text-[10px] text-zinc-500 hover:border-red-400 hover:text-red-400"
              >
                clear
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** WebFetch sub-LLM summarizer editor. The backend accepts any model id
 *  and routes by prefix (`deepseek*` → DeepSeek, etc.). API key has
 *  three semantics here:
 *   - leave blank when a key is already configured → key stays put,
 *     other fields update (we omit `api_key` in the patch entirely)
 *   - clear an existing key → use the "clear key" button (sends `""`)
 *   - paste a new key when none configured → sends the literal string
 *  Same secret-handling pattern as the embedding provider section. */
interface SummarizerSectionProps {
  current: import("./types").WebFetchSummarizerView | null;
  onSave: (
    payload: import("./types").WebFetchSummarizerPatch | null,
  ) => Promise<void>;
}

function SummarizerSection({ current, onSave }: SummarizerSectionProps) {
  const [model, setModel] = useState<string>(current?.model ?? "");
  const [apiKey, setApiKey] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>(current?.base_url ?? "");
  const [maxTokens, setMaxTokens] = useState<string>(
    current?.max_tokens != null ? String(current.max_tokens) : "",
  );
  const [systemPrompt, setSystemPrompt] = useState<string>(
    current?.system_prompt ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Resync from props when the upstream config changes (another tab
  // patched it, or initial fetch finished after first render). api_key
  // is intentionally NOT seeded — server never echoes secrets, so the
  // input stays empty and means "leave alone" on save.
  useEffect(() => {
    setModel(current?.model ?? "");
    setBaseUrl(current?.base_url ?? "");
    setMaxTokens(current?.max_tokens != null ? String(current.max_tokens) : "");
    setSystemPrompt(current?.system_prompt ?? "");
    setApiKey("");
  }, [current]);

  const trimmedModel = model.trim();
  const trimmedTokens = maxTokens.trim();
  const parsedTokens = trimmedTokens === "" ? null : Number.parseInt(trimmedTokens, 10);
  const tokensInvalid =
    trimmedTokens !== "" &&
    (Number.isNaN(parsedTokens) || (parsedTokens != null && parsedTokens <= 0));

  const isEnabled = current != null;
  const keyConfigured = current?.configured ?? false;

  const handleSave = async () => {
    if (!trimmedModel) {
      setError("model id is required");
      return;
    }
    if (tokensInvalid) {
      setError("max tokens must be a positive integer");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const trimmedKey = apiKey.trim();
      const trimmedBase = baseUrl.trim();
      await onSave({
        model: trimmedModel,
        // Omit api_key entirely when the input is blank → backend
        // preserves the existing key. Send the value when present.
        ...(trimmedKey !== "" ? { api_key: trimmedKey } : {}),
        base_url: trimmedBase === "" ? null : trimmedBase,
        max_tokens: parsedTokens,
        system_prompt: systemPrompt.trim() === "" ? null : systemPrompt,
      });
      // Wipe the api_key input post-save — the value is now persisted
      // and the empty state correctly means "key in server, hidden".
      setApiKey("");
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (!trimmedModel) {
      setError("model id is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Explicit empty string tells the backend "clear the stored key
      // back to env-fallback".
      await onSave({
        model: trimmedModel,
        api_key: "",
        base_url: baseUrl.trim() === "" ? null : baseUrl.trim(),
        max_tokens: parsedTokens,
        system_prompt: systemPrompt.trim() === "" ? null : systemPrompt,
      });
      setApiKey("");
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(null);
      setModel("");
      setApiKey("");
      setBaseUrl("");
      setMaxTokens("");
      setSystemPrompt("");
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h4 className="text-[11px] font-medium text-zinc-200">Summarizer</h4>
        <span className="text-[10px] text-zinc-600">
          WebFetch results → compact summary, saves session context
        </span>
      </div>
      <div className="mb-2 text-[11px] text-zinc-500">
        {isEnabled
          ? `enabled · ${current!.model}${keyConfigured ? " · key set" : " · env auth"}`
          : "disabled — WebFetch returns raw extracted text (up to 120 KB)"}
      </div>
      <div className="space-y-2">
        <div>
          <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">
            Model id
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setSavedAt(null);
              setError(null);
            }}
            placeholder="e.g. deepseek-chat"
            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="mb-0.5 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-zinc-500">
            <span>API key</span>
            <span className="text-[9px] normal-case text-zinc-600">
              {keyConfigured
                ? "configured ✓ — leave blank to keep, paste to replace"
                : "blank → falls back to provider env var"}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setSavedAt(null);
                setError(null);
              }}
              placeholder={keyConfigured ? "•••••••• (hidden)" : "sk-…"}
              className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            {keyConfigured && (
              <button
                type="button"
                onClick={handleClearKey}
                disabled={saving}
                title="Clear stored key, fall back to env var"
                className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:border-red-400/60 hover:text-red-300 disabled:opacity-40"
              >
                clear key
              </button>
            )}
          </div>
          <div className="mt-1 text-[10px] text-zinc-600">
            If blank and no env var is set, the LLM call will fail and
            WebFetch will fall back to returning truncated raw text.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">
              Base URL (optional)
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setSavedAt(null);
                setError(null);
              }}
              placeholder="provider default"
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">
              Max tokens
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={maxTokens}
              onChange={(e) => {
                setMaxTokens(e.target.value);
                setSavedAt(null);
                setError(null);
              }}
              placeholder="default 1024"
              className={`w-full rounded border bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
                tokensInvalid
                  ? "border-red-500/60 focus:border-red-500"
                  : "border-zinc-800 focus:border-orange-400"
              }`}
            />
          </div>
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">
            System prompt override (optional)
          </label>
          <textarea
            value={systemPrompt}
            onChange={(e) => {
              setSystemPrompt(e.target.value);
              setSavedAt(null);
              setError(null);
            }}
            placeholder="leave empty to use backend default"
            rows={2}
            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
            spellCheck={false}
          />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !trimmedModel || tokensInvalid}
          className="rounded border border-orange-400 bg-orange-400/10 px-3 py-1 text-[11px] text-orange-300 hover:bg-orange-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "saving…" : isEnabled ? "update" : "enable"}
        </button>
        {isEnabled && (
          <button
            onClick={handleDisable}
            disabled={saving}
            className="rounded border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 hover:border-red-400/60 hover:text-red-300 disabled:opacity-40"
          >
            disable
          </button>
        )}
        {savedAt && !error && (
          <span className="text-[10px] text-emerald-400">saved ✓</span>
        )}
        {error && <span className="text-[10px] text-red-400">{error}</span>}
      </div>
    </div>
  );
}

/** Skills directory browser + author UI. v1 scope: list the agent's
 *  visible skills (across project / user / codex roots), let the user
 *  add new skills to `~/.claw/skills/`, and delete user-level entries.
 *
 *  Multi-file skills, allowed-tools frontmatter, enable/disable, and
 *  `.skill` package import are deferred — see [phase B in chat]. */
interface SkillsSectionProps {
  skills: SkillSummary[];
  onCreate: (payload: {
    name: string;
    description: string | null;
    prompt: string;
  }) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

/** Stateful, self-contained create form. Reused from two callers:
 *   - Inline expand in SkillsSection (Settings → Skills store tab)
 *   - SkillCreateModal triggered from the composer + menu
 *  Lives outside SkillsSection so we don't carry the list state when
 *  the form is shown standalone. */
interface SkillCreateFormProps {
  onSubmit: (payload: {
    name: string;
    description: string | null;
    prompt: string;
  }) => Promise<void>;
  onCancel: () => void;
  /** Caller-controlled affordance for differentiating "first submit" UX —
   *  inline form uses "create", modal uses the same. Default "create". */
  submitLabel?: string;
  /** Optional autofocus on mount for modal usage. */
  autofocus?: boolean;
}

function SkillCreateForm({
  onSubmit,
  onCancel,
  submitLabel = "create",
  autofocus = false,
}: SkillCreateFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autofocus) nameRef.current?.focus();
  }, [autofocus]);

  // Skill name validation mirrors backend: alnum + dashes + underscores,
  // 1–64 chars, not starting with `-` or `.`. Catching this client-side
  // gives instant feedback; backend still re-validates as the source of truth.
  const trimmedName = name.trim();
  const nameInvalid =
    trimmedName !== "" &&
    (trimmedName.length > 64 ||
      trimmedName.startsWith("-") ||
      trimmedName.startsWith(".") ||
      !/^[A-Za-z0-9_-]+$/.test(trimmedName));

  const submit = async () => {
    if (!trimmedName || nameInvalid) {
      setError("invalid name — use letters, digits, dashes, underscores (1–64 chars)");
      return;
    }
    if (!prompt.trim()) {
      setError("prompt body must not be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: trimmedName,
        description: description.trim() === "" ? null : description.trim(),
        prompt,
      });
      // Caller is responsible for unmounting / hiding us on success.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">
          Name
        </label>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="e.g. summarize-pdf"
          className={`w-full rounded border bg-zinc-950 px-2 py-1 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
            nameInvalid
              ? "border-red-500/60 focus:border-red-500"
              : "border-zinc-800 focus:border-orange-400"
          }`}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div>
        <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">
          Description (optional, shown to the agent)
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setError(null);
          }}
          placeholder="one-line summary the agent uses to decide when to call this"
          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
        />
      </div>
      <div>
        <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-zinc-500">
          Prompt body (markdown)
        </label>
        <textarea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setError(null);
          }}
          placeholder="# How to do X&#10;&#10;Step 1: ..."
          rows={10}
          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
          spellCheck={false}
        />
      </div>
      {error && <div className="text-[11px] text-red-400">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={saving || !trimmedName || nameInvalid || prompt.trim() === ""}
          className="rounded border border-orange-400 bg-orange-400/10 px-3 py-1 text-[11px] text-orange-300 hover:bg-orange-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "creating…" : submitLabel}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-40"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

/** Standalone modal wrapping SkillCreateForm. Triggered from the
 *  composer's `+` menu so users can author a skill mid-chat without
 *  trekking into Settings. ESC and backdrop click both dismiss. */
interface SkillCreateModalProps {
  onSubmit: (payload: {
    name: string;
    description: string | null;
    prompt: string;
  }) => Promise<void>;
  onClose: () => void;
}

function SkillCreateModal({ onSubmit, onClose }: SkillCreateModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[560px] max-w-full flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-zinc-100">Create skill</div>
            <div className="text-[11px] text-zinc-500">
              writes to <code className="text-zinc-400">~/.claw/skills/&lt;name&gt;/SKILL.md</code>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-orange-400 hover:text-orange-400"
          >
            ✕ close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <SkillCreateForm
            onSubmit={async (payload) => {
              await onSubmit(payload);
              onClose();
            }}
            onCancel={onClose}
            autofocus
          />
        </div>
      </div>
    </div>
  );
}

function SkillsSection({ skills, onCreate, onDelete, onRefresh }: SkillsSectionProps) {
  const [creating, setCreating] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete skill "${name}"? This removes ~/.claw/skills/${name}/ entirely.`)) {
      return;
    }
    setDeletingName(name);
    setListError(null);
    try {
      await onDelete(name);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingName(null);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] uppercase tracking-wider text-zinc-400">Skills store</h3>
        <div className="flex items-center gap-2 text-[10px] text-zinc-500">
          <span>{skills.length} found</span>
          <button
            onClick={onRefresh}
            className="text-zinc-500 hover:text-zinc-200"
            title="rescan disk"
          >
            ⟳
          </button>
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="rounded border border-orange-400/60 px-2 py-0.5 text-[10px] text-orange-300 hover:bg-orange-400/10"
            >
              + add skill
            </button>
          )}
        </div>
      </div>
      <div className="mb-2 text-[10px] text-zinc-600">
        Skills the Skill tool can load. New skills land in
        <code className="mx-1 text-zinc-500">~/.claw/skills/</code>; only those
        can be deleted from here.
      </div>

      {creating && (
        <div className="mb-3 rounded border border-orange-400/40 bg-zinc-950/40 p-3">
          <SkillCreateForm
            onSubmit={async (payload) => {
              await onCreate(payload);
              setCreating(false);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      {listError && (
        <div className="mb-2 text-[11px] text-red-400">{listError}</div>
      )}

      {skills.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-800 px-3 py-4 text-center text-[11px] text-zinc-600">
          no skills found — add one above or drop a directory in ~/.claw/skills/
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/60">
          {skills.map((skill) => (
            <li
              key={`${skill.origin}:${skill.name}`}
              className={`flex items-baseline justify-between gap-2 py-2 ${
                skill.shadowed ? "opacity-50" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[12px] text-zinc-100">
                    {skill.name}
                  </span>
                  <span
                    className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-zinc-400"
                    title={skill.path}
                  >
                    {skill.origin}
                  </span>
                  {skill.shadowed && (
                    <span
                      className="rounded border border-amber-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-400"
                      title="A higher-priority root has a skill with this same name; the Skill tool resolves to that one."
                    >
                      shadowed
                    </span>
                  )}
                </div>
                {skill.description && (
                  <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                    {skill.description}
                  </div>
                )}
                <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-700">
                  {skill.path}
                </div>
              </div>
              <button
                onClick={() => handleDelete(skill.name)}
                disabled={!skill.editable || deletingName === skill.name}
                title={
                  skill.editable
                    ? "Delete this skill (removes its directory)"
                    : "Read-only — only skills in ~/.claw/skills/ can be deleted from the UI"
                }
                className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-red-400/60 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-zinc-700 disabled:hover:text-zinc-400"
              >
                {deletingName === skill.name ? "…" : "delete"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Browse + install UI for the configured registry (default
 *  `instructkr/claw-skills` on GitHub). Client-side filters the
 *  pre-fetched catalog — search is just a name+description substring
 *  check, no server query. Install state is computed against the
 *  parent's installed-skills list so install ↔ uninstall buttons
 *  swap correctly without a separate is-installed call. */
interface SkillStoreSectionProps {
  registry: SkillRegistryResponse | null;
  loading: boolean;
  error: string | null;
  /** Lowercased names of currently-installed skills. */
  installedSkillNames: string[];
  onRefresh: (force?: boolean) => Promise<void>;
  onInstall: (name: string) => Promise<void>;
  onUninstall: (name: string) => Promise<void>;
}

function SkillStoreSection({
  registry,
  loading,
  error,
  installedSkillNames,
  onRefresh,
  onInstall,
  onUninstall,
}: SkillStoreSectionProps) {
  const [search, setSearch] = useState("");
  const [busyName, setBusyName] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ name: string; msg: string } | null>(null);

  const installedSet = useMemo(
    () => new Set(installedSkillNames),
    [installedSkillNames],
  );

  const filtered = useMemo<SkillRegistryEntry[]>(() => {
    if (!registry) return [];
    const q = search.trim().toLowerCase();
    if (q === "") return registry.entries;
    return registry.entries.filter((e) => {
      const haystack = `${e.name} ${e.description} ${e.tags.join(" ")} ${e.category ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [registry, search]);

  const handleInstall = async (name: string) => {
    setBusyName(name);
    setRowError(null);
    try {
      await onInstall(name);
    } catch (err) {
      setRowError({ name, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyName(null);
    }
  };

  const handleUninstall = async (name: string) => {
    if (!confirm(`Uninstall skill "${name}"? Removes ~/.claw/skills/${name}/.`)) {
      return;
    }
    setBusyName(name);
    setRowError(null);
    try {
      await onUninstall(name);
    } catch (err) {
      setRowError({ name, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] uppercase tracking-wider text-zinc-400">
          Skill store
        </h3>
        <button
          onClick={() => void onRefresh(true)}
          disabled={loading}
          className="text-[10px] text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
          title="force refresh from registry"
        >
          ⟳ refresh
        </button>
      </div>
      {registry && (
        <div className="mb-2 truncate font-mono text-[10px] text-zinc-600" title={registry.registry_url}>
          {registry.registry_url}
        </div>
      )}

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search by name, description, tag, category…"
          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
        />
      </div>

      {loading && !registry && (
        <div className="rounded border border-dashed border-zinc-800 px-3 py-4 text-center text-[11px] text-zinc-600">
          loading registry…
        </div>
      )}

      {error && !loading && (
        <div className="rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          registry fetch failed: {error}
          <div className="mt-1 text-[10px] text-red-400/70">
            Set <code>CLAW_SKILL_REGISTRY_URL</code> to point at a private
            mirror if the default GitHub repo isn't reachable.
          </div>
        </div>
      )}

      {registry && filtered.length === 0 && !loading && (
        <div className="rounded border border-dashed border-zinc-800 px-3 py-4 text-center text-[11px] text-zinc-600">
          {registry.entries.length === 0
            ? "registry is empty"
            : `no skills match "${search}"`}
        </div>
      )}

      {registry && filtered.length > 0 && (
        <ul className="divide-y divide-zinc-800/60">
          {filtered.map((entry) => {
            const installed = installedSet.has(entry.name.toLowerCase());
            const busy = busyName === entry.name;
            return (
              <li
                key={entry.name}
                className="flex items-baseline justify-between gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[12px] text-zinc-100">
                      {entry.name}
                    </span>
                    {entry.category && (
                      <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-zinc-400">
                        {entry.category}
                      </span>
                    )}
                    {entry.version && (
                      <span className="font-mono text-[10px] text-zinc-600">
                        v{entry.version}
                      </span>
                    )}
                    {installed && (
                      <span className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400">
                        installed
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    {entry.description}
                  </div>
                  {entry.tags.length > 0 && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {entry.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded bg-zinc-900 px-1.5 py-0.5 text-[9px] text-zinc-500"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {entry.homepage && (
                    <a
                      href={entry.homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 inline-block truncate text-[10px] text-zinc-600 hover:text-orange-400"
                    >
                      {entry.homepage}
                    </a>
                  )}
                  {rowError && rowError.name === entry.name && (
                    <div className="mt-1 text-[10px] text-red-400">
                      {rowError.msg}
                    </div>
                  )}
                </div>
                {installed ? (
                  <button
                    onClick={() => handleUninstall(entry.name)}
                    disabled={busy}
                    className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-red-400/60 hover:text-red-300 disabled:opacity-40"
                  >
                    {busy ? "…" : "uninstall"}
                  </button>
                ) : (
                  <button
                    onClick={() => handleInstall(entry.name)}
                    disabled={busy}
                    className="shrink-0 rounded border border-orange-400/60 px-2 py-0.5 text-[10px] text-orange-300 hover:bg-orange-400/10 disabled:opacity-40"
                  >
                    {busy ? "installing…" : "install"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LibraryRow({
  library,
  onIngest,
  onDelete,
  onRefresh,
}: {
  library: LibrarySummary;
  onIngest: (file: File) => Promise<void>;
  onDelete: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        await onIngest(file);
        await onRefresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [onIngest, onRefresh],
  );

  return (
    <div className="px-4 py-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
          <span className="text-zinc-100">{library.name}</span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-zinc-500">
            {library.chunk_count} chunks · {formatBytes(library.size_bytes)}
          </span>
        </button>
        <button
          onClick={onDelete}
          title="delete library"
          className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500 hover:border-red-400 hover:text-red-400"
        >
          delete
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-4 text-xs">
          {library.sources.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                sources
              </div>
              <ul className="space-y-0.5">
                {library.sources.map((s) => (
                  <li key={s} className="font-mono text-zinc-400">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            className={`block cursor-pointer rounded border border-dashed px-3 py-3 text-center text-[11px] ${
              dragOver
                ? "border-orange-400 bg-orange-400/5 text-orange-300"
                : "border-zinc-700 text-zinc-500 hover:border-orange-400/60 hover:text-orange-400"
            }`}
          >
            {uploading
              ? "uploading + embedding…"
              : "drag a text/markdown/PDF file here, or click to pick one"}
            <input
              type="file"
              accept=".md,.markdown,.txt,.pdf,text/markdown,text/plain,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </label>
          {uploadError && (
            <div className="text-[11px] text-red-400">{uploadError}</div>
          )}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type CatalogTab = "featured" | "registry";

type SelectedItem =
  | { source: "featured"; preset: McpPreset }
  | { source: "registry"; entry: RegistryListingEntry };

function PresetCatalogModal({
  existingNames,
  onClose,
  onInstall,
  onInstallFromRegistry,
}: PresetCatalogModalProps) {
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<CatalogTab>("featured");
  const [selected, setSelected] = useState<SelectedItem | null>(null);

  useEffect(() => {
    fetchMcpPresets()
      .then((r) => setPresets(r.presets))
      .catch((err) => console.error("fetchMcpPresets failed", err))
      .finally(() => setLoadingPresets(false));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selected) setSelected(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, selected]);

  const filteredPresets = useMemo(() => {
    if (!query.trim()) return presets;
    const q = query.toLowerCase();
    return presets.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        p.display_name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }, [presets, query]);

  // Convert selected registry entry into a McpPreset-shaped object so the
  // existing install form renders unchanged. Fields the form doesn't read
  // (id, command, args_template, env_template) get safe defaults — the
  // form only needs display info, user_inputs, and prerequisites.
  const presetForForm: McpPreset | null = useMemo(() => {
    if (!selected) return null;
    if (selected.source === "featured") return selected.preset;
    const e = selected.entry;
    return {
      id: e.registry_name,
      display_name: e.display_name,
      description: e.description,
      category: e.category,
      homepage: e.homepage,
      command: e.command_hint,
      args_template: [],
      env_template: {},
      user_inputs: e.user_inputs,
      prerequisites: e.prerequisites,
    };
  }, [selected]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-[720px] max-w-full flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-zinc-100">
              {selected
                ? `Install ${
                    selected.source === "featured"
                      ? selected.preset.display_name
                      : selected.entry.display_name
                  }`
                : "MCP catalog"}
            </div>
            <div className="text-[11px] text-zinc-500">
              {selected
                ? "fill in required fields, then install"
                : "curated picks (Featured) or 28k entries from the official registry"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-orange-400 hover:text-orange-400"
          >
            ✕ close
          </button>
        </div>

        {selected && presetForForm ? (
          <PresetInstallForm
            preset={presetForForm}
            existingNames={existingNames}
            onBack={() => setSelected(null)}
            onInstall={async (name, inputs) => {
              if (selected.source === "featured") {
                await onInstall(selected.preset.id, name, inputs);
              } else {
                await onInstallFromRegistry(
                  selected.entry.registry_name,
                  name,
                  inputs,
                );
              }
            }}
          />
        ) : (
          <>
            {/* Tab switcher */}
            <div className="flex border-b border-zinc-800">
              <button
                onClick={() => setActiveTab("featured")}
                className={`flex-1 px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
                  activeTab === "featured"
                    ? "border-b-2 border-orange-400 text-orange-300"
                    : "border-b-2 border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Featured · {presets.length}
              </button>
              <button
                onClick={() => setActiveTab("registry")}
                className={`flex-1 px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
                  activeTab === "registry"
                    ? "border-b-2 border-orange-400 text-orange-300"
                    : "border-b-2 border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Registry · 28k+
              </button>
            </div>

            <div className="border-b border-zinc-800 px-4 py-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  activeTab === "featured"
                    ? "search Featured (name, description, category)…"
                    : "search the registry (name substring)…"
                }
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none"
                autoFocus
              />
            </div>

            {activeTab === "featured" ? (
              <FeaturedList
                loading={loadingPresets}
                entries={filteredPresets}
                query={query}
                onSelect={(p) => setSelected({ source: "featured", preset: p })}
              />
            ) : (
              <RegistryList
                query={query}
                onSelect={(e) => setSelected({ source: "registry", entry: e })}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FeaturedList({
  loading,
  entries,
  query,
  onSelect,
}: {
  loading: boolean;
  entries: McpPreset[];
  query: string;
  onSelect: (p: McpPreset) => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
        loading catalog…
      </div>
    );
  }
  return (
    <ul className="flex-1 divide-y divide-zinc-800/60 overflow-y-auto">
      {entries.length === 0 && (
        <li className="px-4 py-6 text-center text-xs text-zinc-600">
          no Featured presets match "{query}"
        </li>
      )}
      {entries.map((preset) => (
        <li key={preset.id}>
          <button
            onClick={() => onSelect(preset)}
            className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-zinc-800/40"
          >
            <div className="flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-zinc-100">{preset.display_name}</span>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                  {preset.category}
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">{preset.description}</div>
            </div>
            <span className="text-zinc-600">›</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RegistryList({
  query,
  onSelect,
}: {
  query: string;
  onSelect: (entry: RegistryListingEntry) => void;
}) {
  const [entries, setEntries] = useState<RegistryListingEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [rawCount, setRawCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The search input is debounced so each keystroke doesn't slam the
  // registry. 300 ms feels responsive enough without being chatty.
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Re-fetch from page 1 whenever the debounced search changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRegistry(debouncedQuery || undefined)
      .then((r) => {
        if (cancelled) return;
        setEntries(r.entries);
        setNextCursor(r.next_cursor);
        setRawCount(r.raw_count);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const r = await fetchRegistry(debouncedQuery || undefined, nextCursor);
      setEntries((prev) => [...prev, ...r.entries]);
      setNextCursor(r.next_cursor);
      setRawCount((prev) => prev + r.raw_count);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, nextCursor]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-zinc-800 bg-zinc-950/50 px-4 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        {loading && entries.length === 0
          ? "loading…"
          : `${entries.length} installable · ${rawCount} scanned${
              nextCursor ? " · more available" : ""
            }`}
      </div>
      <ul className="flex-1 divide-y divide-zinc-800/60 overflow-y-auto">
        {error && (
          <li className="px-4 py-4 text-xs text-red-400">{error}</li>
        )}
        {entries.length === 0 && !loading && !error && (
          <li className="px-4 py-6 text-center text-xs text-zinc-600">
            no installable (stdio) entries match "{query}"
            <div className="mt-1 text-[11px] text-zinc-700">
              try a more specific term — remote-only entries are filtered out
            </div>
          </li>
        )}
        {entries.map((entry) => (
          <li key={`${entry.registry_name}@${entry.version}`}>
            <button
              onClick={() => onSelect(entry)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-zinc-800/40"
            >
              <div className="flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm text-zinc-100">
                    {entry.display_name}
                  </span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                    {entry.command_hint}
                  </span>
                  {entry.user_inputs.length > 0 && (
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-400">
                      needs {entry.user_inputs.length} input
                      {entry.user_inputs.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {entry.status === "deprecated" && (
                    <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-red-400">
                      deprecated
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-zinc-600">
                  {entry.registry_name}
                </div>
                <div className="mt-1 text-xs text-zinc-500 line-clamp-2">
                  {entry.description}
                </div>
              </div>
              <span className="text-zinc-600">›</span>
            </button>
          </li>
        ))}
        {nextCursor && entries.length > 0 && (
          <li className="px-4 py-3">
            <button
              onClick={loadMore}
              disabled={loading}
              className="w-full rounded border border-zinc-800 px-2 py-1.5 text-[11px] text-zinc-400 hover:border-orange-400 hover:text-orange-400 disabled:opacity-40"
            >
              {loading ? "loading…" : "load more"}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

interface PresetInstallFormProps {
  preset: McpPreset;
  existingNames: string[];
  onBack: () => void;
  onInstall: (name: string, inputs: Record<string, string>) => Promise<void>;
}

function PresetInstallForm({
  preset,
  existingNames,
  onBack,
  onInstall,
}: PresetInstallFormProps) {
  const [name, setName] = useState(preset.id);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [prereqs, setPrereqs] = useState<PrereqCheckResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preset.prerequisites.length === 0) {
      setPrereqs([]);
      return;
    }
    checkPrereqs(preset.prerequisites)
      .then((r) => setPrereqs(r.results))
      .catch((err) => {
        console.error("checkPrereqs failed", err);
        setPrereqs([]);
      });
  }, [preset.prerequisites]);

  const prereqsOk = prereqs?.every((r) => r.status === "ok") ?? false;
  const requiredMissing = preset.user_inputs
    .filter((i) => i.required)
    .some((i) => !(inputs[i.name] || "").trim());
  const nameInvalid =
    !name.trim() || existingNames.includes(name.trim());
  const canSubmit = prereqsOk && !requiredMissing && !nameInvalid && !submitting;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="text-xs text-zinc-400">{preset.description}</div>
        {preset.homepage && (
          <a
            href={preset.homepage}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-[11px] text-orange-400/80 hover:text-orange-400 hover:underline"
          >
            ↗ {preset.homepage}
          </a>
        )}
      </div>

      {/* Prereqs */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">
          prerequisites
        </div>
        {prereqs === null ? (
          <div className="text-xs text-zinc-600">checking…</div>
        ) : prereqs.length === 0 ? (
          <div className="text-xs text-zinc-600">none</div>
        ) : (
          <ul className="space-y-1.5">
            {prereqs.map((r) => (
              <li key={r.binary} className="flex items-start gap-2 text-xs">
                <span
                  className={
                    r.status === "ok"
                      ? "text-emerald-400"
                      : r.status === "missing"
                        ? "text-red-400"
                        : "text-amber-400"
                  }
                >
                  {r.status === "ok"
                    ? "✓"
                    : r.status === "missing"
                      ? "✗"
                      : "⚠"}
                </span>
                <div className="flex-1">
                  <span className="font-mono text-zinc-200">{r.binary}</span>
                  {r.current_version && (
                    <span className="ml-2 text-zinc-500">
                      v{r.current_version}
                      {r.min_version && ` (need ≥ ${r.min_version})`}
                    </span>
                  )}
                  {r.status === "missing" && (
                    <div className="mt-0.5 text-zinc-500">{r.install_hint}</div>
                  )}
                  {r.status === "version_low" && (
                    <div className="mt-0.5 text-zinc-500">
                      version too old. {r.install_hint}
                    </div>
                  )}
                  {r.status === "unknown_version" && (
                    <div className="mt-0.5 text-zinc-500">
                      could not detect version — proceeding may still work
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Server name */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
          server name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`w-full rounded border bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:outline-none ${
            nameInvalid
              ? "border-red-500/60 focus:border-red-500"
              : "border-zinc-800 focus:border-orange-400"
          }`}
        />
        {existingNames.includes(name.trim()) && (
          <div className="mt-1 text-[11px] text-red-400">
            name `{name.trim()}` is already in use
          </div>
        )}
      </div>

      {/* Per-input fields */}
      {preset.user_inputs.length > 0 && (
        <div className="space-y-3 border-b border-zinc-800 px-4 py-3">
          {preset.user_inputs.map((input) => (
            <PresetInputField
              key={input.name}
              input={input}
              value={inputs[input.name] || ""}
              onChange={(v) => setInputs((prev) => ({ ...prev, [input.name]: v }))}
            />
          ))}
        </div>
      )}

      {/* Footer actions */}
      <div className="mt-auto flex items-center justify-between border-t border-zinc-800 px-4 py-3">
        <button
          onClick={onBack}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-orange-400 hover:text-orange-400"
        >
          ‹ back
        </button>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-[11px] text-red-400">{error}</span>
          )}
          <button
            disabled={!canSubmit}
            onClick={async () => {
              setSubmitting(true);
              setError(null);
              try {
                await onInstall(name.trim(), inputs);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setSubmitting(false);
              }
            }}
            className="rounded border border-orange-400 bg-orange-400/10 px-3 py-1 text-xs text-orange-300 hover:bg-orange-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "installing…" : "install"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PresetInputField({
  input,
  value,
  onChange,
}: {
  input: McpPreset["user_inputs"][number];
  value: string;
  onChange: (v: string) => void;
}) {
  const ty = input.input_type;
  const inputClass =
    "w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-orange-400 focus:outline-none font-mono";
  return (
    <div>
      <label className="mb-1 flex items-baseline gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>{input.label}</span>
        {input.required && <span className="text-red-400">*</span>}
      </label>
      {ty.kind === "secret" ? (
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          autoComplete="off"
        />
      ) : ty.kind === "choice" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          <option value="">— choose —</option>
          {ty.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            ty.kind === "text" ? ty.placeholder ?? undefined : undefined
          }
          className={inputClass}
        />
      )}
      {input.help && (
        <div className="mt-1 text-[11px] text-zinc-500">{input.help}</div>
      )}
    </div>
  );
}

function McpServerRow({
  server,
  onSave,
  onDelete,
  onToggleEnabled,
}: {
  server: McpServerSummary;
  onSave: (name: string, payload: McpServerPayload) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onToggleEnabled: (name: string, enabled: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
          <span className={server.enabled ? "text-zinc-100" : "text-zinc-500 line-through"}>
            {server.name}
          </span>
          <span
            className={`ml-auto text-[10px] uppercase tracking-wider ${
              server.discovery_status === "discovering"
                ? "text-amber-400"
                : server.discovery_status === "failed"
                  ? "text-red-400"
                  : "text-zinc-500"
            }`}
          >
            {!server.enabled
              ? "disabled"
              : server.discovery_status === "discovering"
                ? "discovering…"
                : server.discovery_status === "failed"
                  ? "failed"
                  : `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`}
          </span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled(server.name, !server.enabled);
          }}
          title={server.enabled ? "Disable this server" : "Enable this server"}
          className={`rounded border px-2 py-0.5 text-[10px] ${
            server.enabled
              ? "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
              : "border-zinc-700 text-zinc-500 hover:border-orange-400/60 hover:text-orange-400"
          }`}
        >
          {server.enabled ? "on" : "off"}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-3 pl-4 text-xs">
          <div className="text-zinc-500">
            <span className="font-mono text-zinc-300">{server.command}</span>{" "}
            {server.args.map((arg) => (
              <span key={arg} className="font-mono text-zinc-400">
                {arg}{" "}
              </span>
            ))}
          </div>
          {Object.keys(server.env).length > 0 && (
            <div className="text-zinc-500">
              env:{" "}
              {Object.entries(server.env).map(([k]) => (
                <span key={k} className="mr-1 font-mono text-zinc-400">
                  {k}=•••
                </span>
              ))}
            </div>
          )}
          {server.tools.length === 0 ? (
            <div className="text-zinc-600">
              {server.discovery_status === "discovering"
                ? "starting up — slow MCP servers can take 5-10 seconds for tools/list to return"
                : server.discovery_status === "failed"
                  ? "no tools discovered — the server started but produced no tools; check command/args and env"
                  : "no tools available"}
            </div>
          ) : (
            <ul className="space-y-1">
              {server.tools.map((tool) => (
                <li key={tool.name} className="rounded border border-zinc-800/60 px-2 py-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-zinc-200">{tool.raw_name}</span>
                    <span className="font-mono text-[10px] text-zinc-600">{tool.name}</span>
                  </div>
                  {tool.description && (
                    <p className="mt-0.5 font-sans text-[12px] text-zinc-400">
                      {tool.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editing ? (
            <McpServerForm
              initial={server}
              onSubmit={async (name, payload) => {
                await onSave(name, payload);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setEditing(true)}
                className="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:border-orange-400 hover:text-orange-400"
              >
                edit
              </button>
              <button
                onClick={() => onDelete(server.name)}
                className="rounded border border-zinc-800 px-2 py-1 text-zinc-400 hover:border-red-500/50 hover:text-red-300"
              >
                remove
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function McpServerForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: McpServerSummary | null;
  onSubmit: (name: string, payload: McpServerPayload) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join(" "));
  const [envText, setEnvText] = useState(
    Object.entries(initial?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim() || !command.trim()) {
      setError("name and command are required");
      return;
    }
    const args = argsText
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const env: Record<string, string> = {};
    for (const line of envText.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), { command: command.trim(), args, env });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded border border-zinc-800/60 bg-zinc-900/30 p-3 text-xs">
      <div>
        <div className="mb-1 uppercase tracking-wider text-zinc-500">name</div>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={!!initial}
          placeholder="filesystem"
          className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none disabled:opacity-60"
        />
      </div>
      <div>
        <div className="mb-1 uppercase tracking-wider text-zinc-500">command</div>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="npx"
          className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
        />
      </div>
      <div>
        <div className="mb-1 uppercase tracking-wider text-zinc-500">args (space separated)</div>
        <input
          value={argsText}
          onChange={(event) => setArgsText(event.target.value)}
          placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
          className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
        />
      </div>
      <div>
        <div className="mb-1 uppercase tracking-wider text-zinc-500">env (KEY=value per line)</div>
        <textarea
          value={envText}
          onChange={(event) => setEnvText(event.target.value)}
          rows={2}
          className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
        />
      </div>
      {error && <div className="text-red-400">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={busy}
          className="rounded border border-emerald-500/50 px-2 py-1 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {busy ? "saving…" : "save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded border border-zinc-800 px-2 py-1 text-zinc-400 hover:text-zinc-200"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

interface FilesPanelProps {
  workspaceRoot: string | null;
  openPath: string | null;
  onOpenPath: (path: string | null) => void;
  nonce: number;
}

function FilesPanel({ workspaceRoot, openPath, onOpenPath, nonce }: FilesPanelProps) {
  const [browseDir, setBrowseDir] = useState<string>("");
  const [tree, setTree] = useState<WorkspaceTreeResponse | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceFileResponse | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  // Whenever the open file changes, navigate the tree to its parent directory so the
  // user has context for what they're looking at.
  useEffect(() => {
    if (openPath && openPath.includes("/")) {
      setBrowseDir(openPath.slice(0, openPath.lastIndexOf("/")));
    }
  }, [openPath]);

  const loadTree = useCallback(async () => {
    if (!workspaceRoot) {
      setTree(null);
      setTreeError("workspace_root not set — open the config tab");
      return;
    }
    setTreeError(null);
    try {
      const data = await fetchWorkspaceTree(browseDir || undefined);
      setTree(data);
    } catch (err) {
      setTree(null);
      setTreeError((err as Error).message);
    }
  }, [workspaceRoot, browseDir]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (!openPath) {
      setFile(null);
      setFileError(null);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    setFileError(null);
    fetchWorkspaceFile(openPath)
      .then((data) => {
        if (!cancelled) setFile(data);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setFile(null);
          setFileError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openPath, nonce]);

  const breadcrumbs = useMemo(() => buildBreadcrumbs(browseDir), [browseDir]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-400">
        <div className="flex items-center gap-1 font-mono">
          {workspaceRoot ? (
            <span className="truncate text-zinc-500" title={workspaceRoot}>
              {workspaceRoot.split("/").slice(-2).join("/") || workspaceRoot}
            </span>
          ) : (
            <span className="text-zinc-600">no workspace</span>
          )}
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <span className="text-zinc-700">/</span>
              <button
                onClick={() => setBrowseDir(crumb.path)}
                className="text-zinc-300 hover:text-orange-400"
              >
                {crumb.label}
              </button>
            </span>
          ))}
          <button
            onClick={loadTree}
            className="ml-auto text-zinc-500 hover:text-zinc-100"
            title="refresh"
          >
            ↻
          </button>
        </div>
      </div>
      <div className="max-h-1/2 min-h-[120px] flex-shrink-0 overflow-y-auto border-b border-zinc-800 claw-scroll">
        {treeError && (
          <div className="px-3 py-2 text-xs text-red-400">{treeError}</div>
        )}
        {!treeError && !tree && (
          <div className="px-3 py-2 text-xs text-zinc-600">loading…</div>
        )}
        {tree && (
          <ul className="text-[12px]">
            {browseDir && (
              <li>
                <button
                  onClick={() => {
                    const idx = browseDir.lastIndexOf("/");
                    setBrowseDir(idx >= 0 ? browseDir.slice(0, idx) : "");
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
                >
                  <span className="text-zinc-600">↑</span>
                  <span>..</span>
                </button>
              </li>
            )}
            {tree.entries.length === 0 && (
              <li className="px-3 py-2 text-zinc-600">(empty)</li>
            )}
            {tree.entries.map((entry) => {
              const active = openPath === entry.path;
              return (
                <li key={entry.path}>
                  <button
                    onClick={() => {
                      if (entry.kind === "dir") {
                        setBrowseDir(entry.path);
                      } else {
                        onOpenPath(entry.path);
                      }
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left font-mono ${
                      active
                        ? "bg-orange-500/10 text-orange-300"
                        : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                    }`}
                  >
                    <span className="text-zinc-600">
                      {entry.kind === "dir" ? "▸" : "·"}
                    </span>
                    <span className="truncate">{entry.name}</span>
                    {entry.kind === "file" && typeof entry.size === "number" && (
                      <span className="ml-auto text-[10px] text-zinc-600">
                        {humanBytes(entry.size)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        {!openPath && (
          <div className="px-3 py-4 text-xs text-zinc-600">
            Click a file in the tree, or use the "open →" button on a tool block.
          </div>
        )}
        {openPath && fileLoading && (
          <div className="px-3 py-4 text-xs text-zinc-500">loading {openPath}…</div>
        )}
        {fileError && (
          <div className="px-3 py-4 text-xs text-red-400">{fileError}</div>
        )}
        {file && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/40 px-3 py-1 text-[11px] font-mono text-zinc-300">
              <span className="truncate">{file.path}</span>
              <span className="text-zinc-500">
                {humanBytes(file.size)}
                {file.truncated && <span className="ml-2 text-amber-400">truncated</span>}
                {file.binary && <span className="ml-2 text-zinc-600">binary</span>}
              </span>
            </div>
            <pre className="claw-scroll flex-1 overflow-auto whitespace-pre px-3 py-2 text-[12px] leading-snug text-zinc-200">
              {file.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function buildBreadcrumbs(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const segments = path.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];
  let accum = "";
  for (const seg of segments) {
    accum = accum ? `${accum}/${seg}` : seg;
    crumbs.push({ label: seg, path: accum });
  }
  return crumbs;
}

function ConfigEditor({
  config,
  onModeChange,
  onModelChange,
  onWorkspaceChange,
}: {
  config: ServerConfig | null;
  onModeChange: (mode: string) => void;
  onModelChange: (model: string | null) => void;
  onWorkspaceChange: (value: string | null) => Promise<void>;
}) {
  const [modelDraft, setModelDraft] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  useEffect(() => {
    setModelDraft(config?.model ?? "");
  }, [config?.model]);
  useEffect(() => {
    setWorkspaceDraft(config?.workspace_root ?? "");
    setWorkspaceError(null);
  }, [config?.workspace_root]);

  const saveWorkspace = async () => {
    setWorkspaceSaving(true);
    setWorkspaceError(null);
    try {
      await onWorkspaceChange(workspaceDraft.trim().length === 0 ? null : workspaceDraft.trim());
    } catch (err) {
      setWorkspaceError((err as Error).message);
    } finally {
      setWorkspaceSaving(false);
    }
  };

  if (!config) {
    return <div className="px-4 py-6 text-xs text-zinc-600">loading…</div>;
  }
  return (
    <div className="space-y-6 px-4 py-4 text-xs">
      <div>
        <div className="mb-2 uppercase tracking-wider text-zinc-500">permission mode</div>
        <div className="flex flex-col gap-1">
          {PERMISSION_MODES.map((mode) => (
            <label key={mode} className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="mode"
                checked={config.permission_mode === mode}
                onChange={() => onModeChange(mode)}
                className="accent-orange-400"
              />
              <span className={config.permission_mode === mode ? "text-orange-400" : "text-zinc-300"}>
                {mode}
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 font-sans text-zinc-500">
          applied to the next turn via PermissionPolicy
        </p>
      </div>
      <div>
        <div className="mb-2 uppercase tracking-wider text-zinc-500">model</div>
        <div className="flex items-center gap-2">
          <input
            value={modelDraft}
            onChange={(event) => setModelDraft(event.target.value)}
            placeholder="(empty → echo driver)"
            className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
          />
          <button
            onClick={() => onModelChange(modelDraft.trim() || null)}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:border-orange-400 hover:text-orange-400"
          >
            save
          </button>
        </div>
        <p className="mt-2 font-sans text-zinc-500">
          empty = built-in echo · a model name (e.g. "deepseek") routes through ProviderClient.
          Configure keys under the providers tab; without runtime keys we fall back to the
          provider's env vars.
        </p>
      </div>
      <div>
        <div className="mb-2 uppercase tracking-wider text-zinc-500">workspace</div>
        <p className="font-sans text-zinc-500">
          Current:{" "}
          <span className="font-mono text-zinc-300">
            {config.workspace_root ?? "(unset — server CWD)"}
          </span>
        </p>
        <p className="mt-2 font-sans text-zinc-600">
          Pick or change the workspace with the <span className="text-zinc-300">+ workspace</span>{" "}
          button above the composer (uses your OS folder picker).
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            value={workspaceDraft}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
            placeholder="/absolute/path (advanced)"
            className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
          />
          <button
            onClick={saveWorkspace}
            disabled={workspaceSaving}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:border-orange-400 hover:text-orange-400 disabled:opacity-50"
          >
            {workspaceSaving ? "…" : "save"}
          </button>
        </div>
        {workspaceError && (
          <div className="mt-2 text-red-400">{workspaceError}</div>
        )}
      </div>
    </div>
  );
}

interface ProvidersEditorProps {
  providers: ProviderSummary[];
  onSave: (name: string, apiKey: string, baseUrl: string | null) => Promise<void>;
  onForget: (name: string) => Promise<void>;
  activeModel: string | null;
  onActivateModel: (model: string | null) => void;
}

interface PermissionPanelProps {
  pending: PendingPermission[];
  decidingId: string | null;
  onDecide: (requestId: string, allowed: boolean) => Promise<void>;
}

function PermissionPanel({ pending, decidingId, onDecide }: PermissionPanelProps) {
  // Stick to the bottom of the conversation, above the composer.
  return (
    <div className="border-t border-orange-500/30 bg-zinc-950">
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-3">
        {pending.map((entry) => (
          <PermissionRow
            key={entry.requestId}
            entry={entry}
            busy={decidingId === entry.requestId}
            onDecide={onDecide}
          />
        ))}
      </div>
    </div>
  );
}

function PermissionRow({
  entry,
  busy,
  onDecide,
}: {
  entry: PendingPermission;
  busy: boolean;
  onDecide: (requestId: string, allowed: boolean) => Promise<void>;
}) {
  const formattedInput = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(entry.input), null, 2);
    } catch {
      return entry.input;
    }
  }, [entry.input]);
  return (
    <div className="rounded-md border border-orange-500/40 bg-orange-500/5 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-orange-400">
            permission request
          </span>
          <span className="font-mono text-sm text-zinc-100">{entry.toolName}</span>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">
          {entry.currentMode} → needs {entry.requiredMode}
        </span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-200">
          show input
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 claw-scroll">
          {formattedInput}
        </pre>
      </details>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <button
          onClick={() => onDecide(entry.requestId, true)}
          disabled={busy}
          className="rounded border border-emerald-500/60 px-3 py-1 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {busy ? "…" : "allow"}
        </button>
        <button
          onClick={() => onDecide(entry.requestId, false)}
          disabled={busy}
          className="rounded border border-red-500/50 px-3 py-1 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
        >
          deny
        </button>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">{entry.requestId}</span>
      </div>
    </div>
  );
}

function ProvidersEditor({
  providers,
  onSave,
  onForget,
  activeModel,
  onActivateModel,
}: ProvidersEditorProps) {
  if (providers.length === 0) {
    return <div className="px-4 py-6 text-xs text-zinc-600">loading providers…</div>;
  }
  return (
    <ul className="divide-y divide-zinc-800/60">
      {providers.map((provider) => (
        <li key={provider.name}>
          <ProviderRow
            provider={provider}
            onSave={onSave}
            onForget={onForget}
            activeModel={activeModel}
            onActivateModel={onActivateModel}
          />
        </li>
      ))}
    </ul>
  );
}

interface ProviderRowProps {
  provider: ProviderSummary;
  onSave: (name: string, apiKey: string, baseUrl: string | null) => Promise<void>;
  onForget: (name: string) => Promise<void>;
  activeModel: string | null;
  onActivateModel: (model: string | null) => void;
}

function ProviderRow({
  provider,
  onSave,
  onForget,
  activeModel,
  onActivateModel,
}: ProviderRowProps) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(provider.base_url ?? "");
  }, [provider.base_url]);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError("api key required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(provider.name, apiKey.trim(), baseUrl.trim() || null);
      setApiKey("");
      // Auto-activate this provider's default model if the current model isn't already one
      // of theirs. Avoids the silent "saved but echo driver still runs" footgun.
      const ownsActive =
        activeModel !== null && provider.models.some((m) => m === activeModel);
      if (!ownsActive && provider.models.length > 0) {
        onActivateModel(provider.models[0]);
      }
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleForget = async () => {
    setError(null);
    try {
      await onForget(provider.name);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const status = provider.configured ? (
    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-emerald-400">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
      configured
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-600">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-700" />
      empty
    </span>
  );

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
        <span className="text-zinc-100">{provider.label}</span>
        <span className="text-[10px] text-zinc-600">{provider.name}</span>
        <span className="ml-auto">{status}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 pl-4 text-xs">
          <div>
            <div className="mb-1 uppercase tracking-wider text-zinc-500">api key</div>
            <div className="flex items-center gap-2">
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                type={showKey ? "text" : "password"}
                placeholder={provider.configured ? "•••• (already set — replace)" : "paste key here"}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                className="rounded border border-zinc-800 px-2 py-1 text-zinc-400 hover:text-zinc-100"
                type="button"
              >
                {showKey ? "hide" : "show"}
              </button>
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              env fallback: {provider.env_keys.join(", ")}
            </p>
          </div>
          <div>
            <div className="mb-1 uppercase tracking-wider text-zinc-500">base url</div>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={provider.default_base_url}
              className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-zinc-100 placeholder-zinc-600 focus:border-orange-400/60 focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-zinc-600">
              default: {provider.default_base_url}
            </p>
          </div>
          <div>
            <div className="mb-1 uppercase tracking-wider text-zinc-500">models</div>
            <div className="flex flex-wrap gap-1">
              {provider.models.map((model) => (
                <button
                  key={model}
                  onClick={() => onActivateModel(model)}
                  className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                    activeModel === model
                      ? "border-orange-400 text-orange-400"
                      : "border-zinc-800 text-zinc-300 hover:border-zinc-600"
                  }`}
                >
                  {model}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">click to use this model</p>
          </div>
          {error && <div className="text-red-400">{error}</div>}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded border border-emerald-500/50 px-2 py-1 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
            >
              {saving ? "saving…" : provider.configured ? "replace" : "save"}
            </button>
            {provider.configured && (
              <button
                onClick={handleForget}
                className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:border-red-500/50 hover:text-red-300"
              >
                forget
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
