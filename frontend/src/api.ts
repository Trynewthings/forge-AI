import type {
  AttachmentRef,
  BrowserState,
  CancelTurnResponse,
  CommandsResponse,
  CompactSessionResponse,
  CreateSessionResponse,
  IngestResponse,
  InstallFromRegistryPayload,
  InstallPresetPayload,
  LibrariesResponse,
  LibrarySummary,
  ListSessionsResponse,
  LiveModelsResponse,
  McpPresetsResponse,
  McpServerPayload,
  McpServersResponse,
  PrereqCheckResponse,
  RegistryListingResponse,
  ProviderCredsPayload,
  ProvidersResponse,
  ServerConfig,
  SessionDetailsResponse,
  SessionId,
  SkillsResponse,
  SkillSummary,
  CreateSkillPayload,
  SkillRegistryResponse,
  InstallSkillFromRegistryPayload,
  ToolsResponse,
  UsageResponse,
  WorkspaceFileResponse,
  WorkspacePickerResponse,
  WorkspaceTreeResponse,
} from "./types";

// Dev: Vite proxies `/api/*` → `http://127.0.0.1:8787/*` (strips `/api`).
// Prod (single binary): the same Rust server hosts the SPA so all fetches
// are same-origin and we hit routes at root directly. `import.meta.env.DEV`
// is a Vite-injected boolean that's true under `vite dev` and false in
// any `vite build` output.
const BASE = import.meta.env.DEV ? "/api" : "";

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function createSession(): Promise<CreateSessionResponse> {
  return jsonOrThrow(await fetch(`${BASE}/sessions`, { method: "POST" }));
}

export async function listSessions(): Promise<ListSessionsResponse> {
  return jsonOrThrow(await fetch(`${BASE}/sessions`));
}

export async function getSession(id: SessionId): Promise<SessionDetailsResponse> {
  return jsonOrThrow(await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`));
}

/** Drops the session from the server's in-memory store. If a turn is
 *  in flight the backend cancels it before removing. 204 on success. */
export async function deleteSession(id: SessionId): Promise<void> {
  const response = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
}

export async function sendMessage(
  id: SessionId,
  message: string,
  attachments: AttachmentRef[] = [],
): Promise<void> {
  const response = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, attachments }),
  });
  if (response.status === 409) {
    throw new Error("a turn is already running on this session");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

export async function pickAttachmentFile(): Promise<WorkspacePickerResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/workspace/pick-file`, { method: "POST" }),
  );
}

export async function statAttachment(
  path: string,
): Promise<import("./types").AttachmentStat> {
  return jsonOrThrow(
    await fetch(`${BASE}/workspace/attachment-stat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  );
}

/// Upload a browser-side `File` (drag-drop or clipboard) and get back the
/// server-side absolute path the standard attachment flow expects. Server
/// writes to a per-process temp dir.
export async function uploadFile(
  file: File,
): Promise<WorkspacePickerResponse> {
  const form = new FormData();
  form.append("file", file, file.name || "upload");
  const response = await fetch(`${BASE}/workspace/upload`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as WorkspacePickerResponse;
}

export async function cancelTurn(id: SessionId): Promise<CancelTurnResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  );
}

export async function compactSession(id: SessionId): Promise<CompactSessionResponse> {
  const response = await fetch(
    `${BASE}/sessions/${encodeURIComponent(id)}/compact`,
    { method: "POST" },
  );
  if (response.status === 409) {
    throw new Error("a turn is in progress — cancel it before compacting");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as CompactSessionResponse;
}

export async function fetchTools(): Promise<ToolsResponse> {
  return jsonOrThrow(await fetch(`${BASE}/tools`));
}

export async function fetchCommands(): Promise<CommandsResponse> {
  return jsonOrThrow(await fetch(`${BASE}/commands`));
}

export async function fetchConfig(): Promise<ServerConfig> {
  return jsonOrThrow(await fetch(`${BASE}/config`));
}

/** PATCH /config payload — supersets `Partial<ServerConfig>` so that
 *  `embedding_provider` can be sent with the api_key field that the
 *  GET response strips out. The `web_fetch_summarizer` field round-trips
 *  with the same shape since it carries no secrets (auth via env). */
export type ServerConfigPatch = Partial<
  Omit<
    ServerConfig,
    "embedding_provider" | "web_fetch_summarizer" | "session_summarizer"
  >
> & {
  /** `undefined` = leave alone, `null` = clear, object = set/replace. */
  embedding_provider?: import("./types").EmbeddingProviderPatch | null;
  /** `undefined` = leave alone, `null` = clear, object = set/replace. */
  web_fetch_summarizer?: import("./types").WebFetchSummarizerPatch | null;
  /** `undefined` = leave alone, `null` = clear, object = set/replace. */
  session_summarizer?: import("./types").SessionSummarizerPatch | null;
};

export async function patchConfig(patch: ServerConfigPatch): Promise<ServerConfig> {
  return jsonOrThrow(
    await fetch(`${BASE}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export function sessionEventsUrl(id: SessionId): string {
  return `${BASE}/sessions/${encodeURIComponent(id)}/events`;
}

/** POST /sessions/{target}/absorb — cross-session summary + injection.
 *  Pass `inject: false` to preview without touching the target, then call
 *  again with `override_summary` (the user-edited text) + `inject: true`
 *  to commit. Or `inject: true` without override_summary to do it in one
 *  shot. */
export async function absorbSessions(
  targetId: import("./types").SessionId,
  payload: import("./types").AbsorbRequest,
): Promise<import("./types").AbsorbResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/sessions/${encodeURIComponent(targetId)}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  return jsonOrThrow(await fetch(`${BASE}/providers`));
}

export async function fetchUsage(): Promise<UsageResponse> {
  return jsonOrThrow(await fetch(`${BASE}/usage`));
}

// ---- RAG libraries -------------------------------------------------------

export async function fetchLibraries(): Promise<LibrariesResponse> {
  return jsonOrThrow(await fetch(`${BASE}/rag/libraries`));
}

export async function createLibrary(name: string): Promise<LibrarySummary> {
  return jsonOrThrow(
    await fetch(`${BASE}/rag/libraries/${encodeURIComponent(name)}`, {
      method: "POST",
    }),
  );
}

export async function deleteLibrary(name: string): Promise<void> {
  const response = await fetch(
    `${BASE}/rag/libraries/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

export async function ingestLibrary(
  name: string,
  file: File,
): Promise<IngestResponse> {
  const form = new FormData();
  form.append("file", file, file.name);
  return jsonOrThrow(
    await fetch(
      `${BASE}/rag/libraries/${encodeURIComponent(name)}/ingest`,
      { method: "POST", body: form },
    ),
  );
}

export async function attachSessionLibrary(
  sessionId: SessionId,
  library: string | null,
): Promise<{ library: string | null }> {
  return jsonOrThrow(
    await fetch(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/rag/attach`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ library }),
      },
    ),
  );
}

export async function fetchLiveModels(provider: string): Promise<LiveModelsResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/providers/${encodeURIComponent(provider)}/models/live`),
  );
}

export async function putProvider(
  name: string,
  payload: ProviderCredsPayload,
): Promise<void> {
  const response = await fetch(
    `${BASE}/providers/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

export async function decidePermission(
  sessionId: SessionId,
  requestId: string,
  allowed: boolean,
  reason: string | null = null,
  remember = false,
): Promise<void> {
  const response = await fetch(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(
      requestId,
    )}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed, reason, remember }),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

/** Mirrors decidePermission for the AskUser flow. Pass a discriminated
 *  payload — backend tags by `type`. */
export async function answerQuestion(
  sessionId: SessionId,
  questionId: string,
  payload: import("./types").QuestionAnswerRequest,
): Promise<void> {
  const response = await fetch(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(
      questionId,
    )}/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

export async function deleteProvider(name: string): Promise<void> {
  const response = await fetch(
    `${BASE}/providers/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

export async function fetchWorkspaceTree(path?: string): Promise<WorkspaceTreeResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return jsonOrThrow(await fetch(`${BASE}/workspace/tree${query}`));
}

export async function fetchWorkspaceFile(path: string): Promise<WorkspaceFileResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/workspace/file?path=${encodeURIComponent(path)}`),
  );
}

export async function pickWorkspace(): Promise<WorkspacePickerResponse> {
  return jsonOrThrow(await fetch(`${BASE}/workspace/picker`, { method: "POST" }));
}

export async function fetchMcpServers(): Promise<McpServersResponse> {
  return jsonOrThrow(await fetch(`${BASE}/mcp/servers`));
}

export async function putMcpServer(
  name: string,
  payload: McpServerPayload,
): Promise<McpServersResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/mcp/servers/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function deleteMcpServer(name: string): Promise<void> {
  const response = await fetch(
    `${BASE}/mcp/servers/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
): Promise<McpServersResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/mcp/servers/${encodeURIComponent(name)}/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  );
}

export async function fetchMcpPresets(): Promise<McpPresetsResponse> {
  return jsonOrThrow(await fetch(`${BASE}/mcp/presets`));
}

/** Live Browser-pane observation snapshot (screenshot + URL + DOM snapshot). */
export async function fetchBrowserState(): Promise<BrowserState> {
  return jsonOrThrow(await fetch(`${BASE}/browser/state`));
}

/** Token + cost usage summary for one session (Settings → Usage). */
export async function fetchSessionUsage(
  sessionId: SessionId,
): Promise<import("./types").SessionUsage> {
  return jsonOrThrow(
    await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/usage`),
  );
}

export async function checkPresetPrereqs(
  id: string,
): Promise<PrereqCheckResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/mcp/presets/${encodeURIComponent(id)}/check-prereqs`, {
      method: "POST",
    }),
  );
}

/** Body-form prereq check — used by the registry install flow where there
 * is no preset id to look up. The backend runs the same per-binary
 * inspection. */
export async function checkPrereqs(
  prerequisites: import("./types").McpPresetPrerequisite[],
): Promise<PrereqCheckResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/mcp/check-prereqs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prerequisites }),
    }),
  );
}

export async function installMcpPreset(
  id: string,
  payload: InstallPresetPayload,
): Promise<McpServersResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/mcp/presets/${encodeURIComponent(id)}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function fetchRegistry(
  search?: string,
  cursor?: string,
): Promise<RegistryListingResponse> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return jsonOrThrow(
    await fetch(`${BASE}/mcp/registry${qs ? `?${qs}` : ""}`),
  );
}

export async function installFromRegistry(
  payload: InstallFromRegistryPayload,
): Promise<McpServersResponse> {
  return jsonOrThrow(
    await fetch(`${BASE}/mcp/registry/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function setSessionMcpAttached(
  sessionId: SessionId,
  name: string,
  attached: boolean,
): Promise<SessionDetailsResponse> {
  const response = await fetch(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(
      name,
    )}/attached`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attached }),
    },
  );
  if (response.status === 409) {
    throw new Error("a turn is in progress — wait or cancel before detaching");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as SessionDetailsResponse;
}

// ───────────── Skills (v1 — list / create / delete) ─────────────

export async function fetchSkills(): Promise<SkillsResponse> {
  return jsonOrThrow(await fetch(`${BASE}/skills`));
}

export async function createSkill(
  payload: CreateSkillPayload,
): Promise<SkillSummary> {
  return jsonOrThrow(
    await fetch(`${BASE}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function deleteSkill(name: string): Promise<void> {
  const response = await fetch(`${BASE}/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

/** Fetch the registry catalog. `force` skips the server's 10-min cache. */
export async function fetchSkillRegistry(
  force = false,
): Promise<SkillRegistryResponse> {
  const url = force
    ? `${BASE}/skills/registry?refresh=1`
    : `${BASE}/skills/registry`;
  return jsonOrThrow(await fetch(url));
}

export async function installSkillFromRegistry(
  payload: InstallSkillFromRegistryPayload,
): Promise<SkillSummary> {
  return jsonOrThrow(
    await fetch(`${BASE}/skills/registry/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

/** Server-side proxy to skills.sh/api/search — bypasses browser CORS.
 *  Backend pass-through; shape depends on skills.sh upstream. */
export async function searchSkillsSh(
  query: string,
  limit = 50,
): Promise<unknown> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return jsonOrThrow(await fetch(`${BASE}/skills/search?${params.toString()}`));
}

/** Install a skill by full skills.sh id via the backend's `npx skills add`
 *  wrapper. `scope` chooses between `~/.claude/skills/` (global, default)
 *  and `<workspace_root>/.claude/skills/` (project). Throws on non-2xx. */
export async function installFromSkillsSh(
  id: string,
  scope: "global" | "project" = "global",
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
}> {
  return jsonOrThrow(
    await fetch(`${BASE}/skills/install/skills-sh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, scope }),
    }),
  );
}
