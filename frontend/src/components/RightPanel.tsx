import { useState } from "react";
import type { ReactNode } from "react";
import { TabBar } from "./TabBar";
import type { TabDef } from "./TabBar";
import { ToolsIcon, FolderIcon, PlugIcon } from "./Icons";
import type { ToolSummary, ServerConfig } from "../types";
import { FilesPanel } from "./panels/FilesPanel";

export type RightTab = "files" | "tools" | "browser";

interface Props {
  config: ServerConfig | null;
  tools: ToolSummary[];
}

/** Right side panel — narrowed to per-turn introspection now that
 *  Models / Skills / MCP / RAG / Summarizer / Config live in the
 *  Settings modal. Keeps:
 *    - Files: workspace tree + viewer (most-used)
 *    - Tools: read-only inventory of available tools
 *    - Browser: reserved placeholder for the upcoming browser-observation
 *      pane (agent driving a real browser). Stub renders an empty state.
 */
export function RightPanel({ config, tools }: Props) {
  const [active, setActive] = useState<RightTab>("files");

  const tabs: TabDef<RightTab>[] = [
    { id: "files", label: "Files", icon: <FolderIcon size={12} /> },
    { id: "tools", label: "Tools", icon: <ToolsIcon size={12} /> },
    { id: "browser", label: "Browser", icon: <PlugIcon size={12} /> },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
        minWidth: 0,
      }}
    >
      <TabBar tabs={tabs} active={active} onChange={setActive} />
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {active === "files" && <FilesPanel workspaceRoot={config?.workspace_root ?? null} />}
        {active === "tools" && <ToolsPanel tools={tools} />}
        {active === "browser" && <BrowserPlaceholder />}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
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
        {title}
      </div>
      {children}
    </div>
  );
}

function ToolsPanel({ tools }: { tools: ToolSummary[] }) {
  if (tools.length === 0) {
    return <EmptyPanelMessage>No tools registered.</EmptyPanelMessage>;
  }
  return (
    <div style={{ overflow: "auto" }}>
      <Section title={`Available tools (${tools.length})`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {tools.map((t) => (
            <div
              key={t.name}
              style={{
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-panel)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  fontSize: 12,
                  color: "var(--accent-hover)",
                }}
              >
                {t.name}
              </div>
              {t.description && (
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3 }}>
                  {t.description}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/** Placeholder for the future browser-observation pane (live DOM
 *  snapshot + agent driving the browser). Reserved so the tab slot
 *  exists from day one — easier than retrofitting later when the
 *  feature lands. */
function BrowserPlaceholder() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "32px 24px",
        color: "var(--text-dim)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 26,
          opacity: 0.6,
        }}
      >
        🪟
      </div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
        Browser pane
      </div>
      <div
        style={{
          fontSize: 11.5,
          maxWidth: 280,
          lineHeight: 1.55,
        }}
      >
        Reserved for the upcoming browser-observation surface — live DOM
        snapshot, console, and the agent driving a Chromium instance.
        Not implemented yet.
      </div>
    </div>
  );
}

function EmptyPanelMessage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "32px 16px",
        textAlign: "center",
        color: "var(--text-dim)",
        fontSize: 12.5,
      }}
    >
      {children}
    </div>
  );
}
