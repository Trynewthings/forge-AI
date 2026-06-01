import { useCallback, useEffect, useState } from "react";
import type {
  LibrarySummary,
  McpServerSummary,
  ProviderSummary,
  ServerConfig,
  SessionId,
  SkillSummary,
} from "../types";
import {
  BookIcon,
  CloseIcon,
  CubeIcon,
  FileIcon,
  PlugIcon,
  SettingsIcon,
  SparkleIcon,
} from "./Icons";
import { fetchSessionUsage } from "../api";
import type { SessionUsage } from "../types";
import { ModelsPanel } from "./panels/ModelsPanel";
import { SkillsPanel } from "./panels/SkillsPanel";
import { McpPanel } from "./panels/McpPanel";
import { RagPanel } from "./panels/RagPanel";
import { SessionSummarizerForm } from "./panels/SummarizerForm";

export type SettingsTab = "models" | "skills" | "mcp" | "rag" | "usage" | "summarizer" | "config";

interface Props {
  config: ServerConfig | null;
  providers: ProviderSummary[];
  skills: SkillSummary[];
  mcpServers: McpServerSummary[];
  libraries: LibrarySummary[];
  attachedLibrary: string | null;
  activeSessionId: SessionId | null;
  onConfigChange: (c: ServerConfig) => void;
  onProvidersChange: () => void;
  onSkillsChange: () => void;
  onMcpChange: () => void;
  onLibrariesChange: () => void;
  onAttachedLibraryChange: (lib: string | null) => void;
  onClose: () => void;
  /** Optional tab to land on when the modal first opens — defaults to "models". */
  initialTab?: SettingsTab;
}

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
  hint?: string;
}

const TABS: TabDef[] = [
  { id: "models", label: "Models", icon: <CubeIcon size={13} />, hint: "Current model + providers" },
  { id: "skills", label: "Skills", icon: <SparkleIcon size={13} />, hint: "Installed + create + store" },
  { id: "mcp", label: "MCP", icon: <PlugIcon size={13} />, hint: "Servers + registry" },
  { id: "rag", label: "RAG", icon: <FileIcon size={13} />, hint: "Libraries + embedding" },
  { id: "usage", label: "Usage", icon: <BookIcon size={13} />, hint: "Tokens + cost for this session" },
  { id: "summarizer", label: "Summarizer", icon: <SettingsIcon size={13} />, hint: "Absorb / handoff model" },
  { id: "config", label: "Config", icon: <SettingsIcon size={13} />, hint: "Read-only server state" },
];

/** Full-screen centered Settings modal. Hosts everything that used to live
 *  in the RightPanel except Files/Tools — those stay on the right where
 *  they're useful per-turn. Settings is opened from the SessionSidebar
 *  bottom (gear icon) and via Cmd+, (TODO). */
export function SettingsModal({
  config,
  providers,
  skills,
  mcpServers,
  libraries,
  attachedLibrary,
  activeSessionId,
  onConfigChange,
  onProvidersChange,
  onSkillsChange,
  onMcpChange,
  onLibrariesChange,
  onAttachedLibraryChange,
  onClose,
  initialTab,
}: Props) {
  const [active, setActive] = useState<SettingsTab>(initialTab ?? "models");

  // ESC dismisses — matches the rest of our modal UX (AbsorbModal).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(960px, 94vw)",
          height: "min(720px, 88vh)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            height: 44,
            padding: "0 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <SettingsIcon size={14} style={{ color: "var(--accent-hover)" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Settings</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              borderRadius: 6,
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              background: "var(--bg)",
              cursor: "pointer",
            }}
            className="pi-row"
          >
            <CloseIcon size={11} />
          </button>
        </div>

        {/* Body: vertical sidebar nav + content */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <nav
            style={{
              width: 180,
              flexShrink: 0,
              borderRight: "1px solid var(--border)",
              padding: "8px 6px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              overflowY: "auto",
              background: "var(--bg)",
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                title={tab.hint}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "7px 10px",
                  borderRadius: 6,
                  background:
                    active === tab.id ? "var(--accent-soft)" : "transparent",
                  border: `1px solid ${
                    active === tab.id ? "var(--accent-soft-border)" : "transparent"
                  }`,
                  color:
                    active === tab.id ? "var(--accent-hover)" : "var(--text-muted)",
                  fontSize: 12.5,
                  fontWeight: active === tab.id ? 600 : 500,
                  textAlign: "left",
                  cursor: "pointer",
                }}
                className="pi-row"
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <div
              style={{
                padding: "8px 10px",
                fontSize: 10,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                lineHeight: 1.4,
              }}
            >
              Esc to close
            </div>
          </nav>

          {/* Content pane — render the existing panels verbatim. Each
              panel already owns its own scrolling so the modal stays
              fixed-height. `minHeight: 0` is required so a panel's inner
              `overflow:auto` actually engages instead of the flex child
              growing to fit all content (which made the registry search
              results overflow and overlap the area below). */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {active === "models" && (
              <ModelsPanel
                config={config}
                providers={providers}
                onConfigChange={onConfigChange}
                onProvidersChange={onProvidersChange}
              />
            )}
            {active === "skills" && (
              <SkillsPanel
                skills={skills}
                workspaceRoot={config?.workspace_root ?? null}
                onSkillsChange={onSkillsChange}
              />
            )}
            {active === "mcp" && (
              <McpPanel mcpServers={mcpServers} onChange={onMcpChange} />
            )}
            {active === "rag" && (
              <RagPanel
                libraries={libraries}
                attachedLibrary={attachedLibrary}
                activeSessionId={activeSessionId}
                embeddingProvider={config?.embedding_provider ?? null}
                onChange={onLibrariesChange}
                onAttachedChange={onAttachedLibraryChange}
                onConfigChange={onConfigChange}
              />
            )}
            {active === "usage" && <UsagePanel sessionId={activeSessionId} />}
            {active === "summarizer" && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  overflow: "auto",
                }}
              >
                <SessionSummarizerForm
                  current={config?.session_summarizer ?? null}
                  onConfigChange={onConfigChange}
                />
                <div
                  style={{
                    padding: "12px 16px",
                    fontSize: 11.5,
                    color: "var(--text-dim)",
                    lineHeight: 1.55,
                  }}
                >
                  The summarizer model condenses prior sessions during cross-session{" "}
                  <strong>Absorb</strong>. Falls back to the main chat model when unset.
                  Set a cheap fast model (Claude Haiku, DeepSeek chat) for best UX.
                </div>
              </div>
            )}
            {active === "config" && <ConfigReadout config={config} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Read-only dump of resolved server config — used for debugging the
 *  exact state the backend sees. Editable parts have dedicated tabs above. */
function ConfigReadout({ config }: { config: ServerConfig | null }) {
  if (!config) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>
        Loading config…
      </div>
    );
  }
  const entries: [string, unknown][] = [
    ["model", config.model],
    ["permission_mode", config.permission_mode],
    ["workspace_root", config.workspace_root],
    ["max_session_tokens", config.max_session_tokens],
    ["max_tool_iterations_per_turn", config.max_tool_iterations_per_turn],
    ["context_window", config.context_window],
    [
      "embedding_provider",
      config.embedding_provider
        ? `${config.embedding_provider.model} · ${config.embedding_provider.dimensions}d (${config.embedding_provider.configured ? "configured" : "no api_key"})`
        : null,
    ],
    [
      "session_summarizer",
      config.session_summarizer
        ? `${config.session_summarizer.model} (${config.session_summarizer.configured ? "configured" : "env-fallback"})`
        : null,
    ],
    [
      "web_fetch_summarizer",
      config.web_fetch_summarizer
        ? `${config.web_fetch_summarizer.model} (${config.web_fetch_summarizer.configured ? "configured" : "env-fallback"})`
        : null,
    ],
  ];
  return (
    <div style={{ overflow: "auto", padding: "12px 16px" }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-muted)",
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        Resolved server config (read-only)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.map(([k, v]) => (
          <div
            key={k}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "6px 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span style={{ color: "var(--text-muted)", flexShrink: 0, minWidth: 200 }}>{k}</span>
            <span
              style={{
                color: v == null ? "var(--text-dim)" : "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {v == null ? "—" : String(v)}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: 10.5,
          color: "var(--text-dim)",
          lineHeight: 1.55,
        }}
      >
        These values are persisted under <code style={{ fontFamily: "var(--font-mono)" }}>~/.claw/state.json</code>.
        Edit them via the dedicated tabs above; this view is for diagnosing what the runtime sees.
      </div>
    </div>
  );
}

/** Settings → Usage: token counts + a rough cost estimate for the active
 *  session. Fetches `/sessions/:id/usage` on open + via Refresh. */
function UsagePanel({ sessionId }: { sessionId: SessionId | null }) {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      setUsage(await fetchSessionUsage(sessionId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

  if (!sessionId) {
    return (
      <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
        No active session. Start or open a session to see its usage.
      </div>
    );
  }

  const cap = usage?.budget_tokens ?? null;
  const fill = usage?.cumulative_tokens ?? 0;
  const pct = cap && cap > 0 ? Math.min(100, Math.round((fill / cap) * 100)) : null;

  return (
    <div style={{ overflow: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>Session usage</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={load}
          disabled={loading}
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            padding: "3px 8px",
            border: "1px solid var(--border)",
            borderRadius: 5,
            background: "var(--bg-panel)",
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      {error && (
        <div style={{ color: "var(--err)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{error}</div>
      )}
      {usage && (
        <>
          <UsageRow label="Model" value={usage.model ?? "(none)"} mono />
          <UsageRow label="Turns" value={`${usage.turns}`} />
          <UsageRow
            label="Context fill"
            value={
              pct != null
                ? `${fmt(fill)} / ${fmt(cap as number)} (${pct}%)`
                : `${fmt(fill)} tokens`
            }
          />
          {pct != null && (
            <div style={{ height: 6, background: "var(--bg-panel)", borderRadius: 3, overflow: "hidden", border: "1px solid var(--border)" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: pct >= 90 ? "var(--err)" : "var(--accent)" }} />
            </div>
          )}
          <UsageRow label="Total input tokens" value={fmt(usage.total_input_tokens)} />
          <UsageRow label="Total output tokens" value={fmt(usage.total_output_tokens)} />
          {usage.cache_read_tokens > 0 && (
            <UsageRow label="Cache-read tokens" value={fmt(usage.cache_read_tokens)} />
          )}
          {usage.last_turn && (
            <UsageRow
              label="Last turn (in / out)"
              value={`${fmt(usage.last_turn.input_tokens)} / ${fmt(usage.last_turn.output_tokens)}`}
            />
          )}
          <UsageRow
            label="Estimated cost"
            value={
              usage.estimated_cost_usd != null
                ? `$${usage.estimated_cost_usd.toFixed(usage.estimated_cost_usd < 1 ? 4 : 2)}`
                : "— (model not priced)"
            }
          />
          {usage.input_per_million != null && usage.output_per_million != null && (
            <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
              Price: ${usage.input_per_million}/${usage.output_per_million} per 1M tok (in/out).
              Rough estimate from a local table; cache discounts not modeled.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UsageRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span style={{ fontSize: 11.5, color: "var(--text-muted)", minWidth: 150 }}>{label}</span>
      <span
        style={{
          fontSize: 12.5,
          color: "var(--text)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}
