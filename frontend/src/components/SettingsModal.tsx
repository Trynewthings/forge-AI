import { useEffect, useState } from "react";
import type {
  LibrarySummary,
  McpServerSummary,
  ProviderSummary,
  ServerConfig,
  SessionId,
  SkillSummary,
} from "../types";
import {
  CloseIcon,
  CubeIcon,
  FileIcon,
  PlugIcon,
  SettingsIcon,
  SparkleIcon,
} from "./Icons";
import { ModelsPanel } from "./panels/ModelsPanel";
import { SkillsPanel } from "./panels/SkillsPanel";
import { McpPanel } from "./panels/McpPanel";
import { RagPanel } from "./panels/RagPanel";
import { SessionSummarizerForm } from "./panels/SummarizerForm";

export type SettingsTab = "models" | "skills" | "mcp" | "rag" | "summarizer" | "config";

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
              fixed-height. */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
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
