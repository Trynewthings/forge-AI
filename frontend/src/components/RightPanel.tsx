import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { TabBar } from "./TabBar";
import type { TabDef } from "./TabBar";
import { ToolsIcon, FolderIcon, PlugIcon } from "./Icons";
import type { ToolSummary, ServerConfig, McpServerSummary, BrowserState } from "../types";
import { fetchBrowserState } from "../api";
import { FilesPanel } from "./panels/FilesPanel";

export type RightTab = "files" | "tools" | "browser";

interface Props {
  config: ServerConfig | null;
  tools: ToolSummary[];
  /** All configured MCP servers — used to detect whether the built-in
   *  browser (Playwright-MCP) is installed yet. */
  mcpServers: McpServerSummary[];
  /** One-click install of the `browser` preset. Resolves once installed +
   *  servers refreshed; rejects on failure. */
  onInstallBrowser: () => Promise<void>;
  /** True while the agent is running a turn. The live view only auto-polls
   *  then — when idle it never touches the browser, so closing the window
   *  isn't resurrected by the panel. */
  turnActive: boolean;
}

/** Right side panel — narrowed to per-turn introspection now that
 *  Models / Skills / MCP / RAG / Summarizer / Config live in the
 *  Settings modal. Keeps:
 *    - Files: workspace tree + viewer (most-used)
 *    - Tools: read-only inventory of available tools
 *    - Browser: reserved placeholder for the upcoming browser-observation
 *      pane (agent driving a real browser). Stub renders an empty state.
 */
export function RightPanel({ config, tools, mcpServers, onInstallBrowser, turnActive }: Props) {
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
        {active === "browser" && (
          <BrowserPane servers={mcpServers} onInstall={onInstallBrowser} turnActive={turnActive} />
        )}
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

/** Detect whether the built-in browser (Playwright-MCP) is installed: either
 *  a server registered under the `browser` preset name, or any server exposing
 *  `browser_*` tools (robust to a custom name). */
function findBrowserServer(servers: McpServerSummary[]): McpServerSummary | undefined {
  return servers.find(
    (s) =>
      s.name === "browser" ||
      s.tools.some((t) => (t.raw_name ?? t.name).startsWith("browser_")),
  );
}

/** Browser tab. Drives a real Chrome window via the Playwright MCP server:
 *  not-installed → one-click install; installed → status + usage guidance.
 *  The live in-pane screenshot/snapshot view is the next phase — for now the
 *  agent drives a real window you can watch and take over directly. */
function BrowserPane({
  servers,
  onInstall,
  turnActive,
}: {
  servers: McpServerSummary[];
  onInstall: () => Promise<void>;
  turnActive: boolean;
}) {
  const server = findBrowserServer(servers);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await onInstall();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  if (!server) {
    return (
      <div style={{ overflow: "auto" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            padding: "32px 24px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 26, opacity: 0.7 }}>🌐</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 600 }}>
            Built-in browser
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", maxWidth: 300, lineHeight: 1.55 }}>
            Let the agent drive a real Chrome window — navigate, read pages via
            accessibility snapshots, click, and type. It runs headed with a
            dedicated persistent profile, so logins survive restarts and you can
            take over in the window.
          </div>
          <button
            onClick={install}
            disabled={installing}
            style={{
              marginTop: 4,
              padding: "7px 16px",
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 600,
              background: "var(--accent)",
              color: "#0a0a0a",
              border: "1px solid var(--accent)",
              cursor: installing ? "wait" : "pointer",
              opacity: installing ? 0.7 : 1,
            }}
          >
            {installing ? "Installing…" : "Install browser"}
          </button>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", maxWidth: 300, lineHeight: 1.5 }}>
            Requires Node.js 18+. First launch downloads Chromium via
            <span style={{ fontFamily: "var(--font-mono)" }}> npx @playwright/mcp</span> (can take a moment).
          </div>
          {error && (
            <div style={{ color: "var(--err)", fontSize: 11, fontFamily: "var(--font-mono)", maxWidth: 300 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  const statusLabel: Record<McpServerSummary["discovery_status"], string> = {
    ready: "ready",
    discovering: "starting…",
    failed: "failed to start",
    disabled: "disabled",
  };
  const statusColor =
    server.discovery_status === "ready"
      ? "var(--ok)"
      : server.discovery_status === "failed"
        ? "var(--err)"
        : "var(--text-dim)";

  return (
    <div style={{ overflow: "auto" }}>
      <Section title="Built-in browser">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span
            style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, flexShrink: 0 }}
          />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{server.name}</span>
          <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {statusLabel[server.discovery_status]} · {server.tools.length} tools
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
          Attach it to a session (MCP settings), then ask the agent to open a page.
          A real Chrome window opens — log in or take over there directly. Read-only
          actions (navigate, snapshot, screenshot) run freely; clicks, typing, and
          form fills require approval.
        </div>
        {server.discovery_status === "failed" && (
          <div style={{ fontSize: 11, color: "var(--err)", marginTop: 8, lineHeight: 1.5 }}>
            The browser server failed to start. Check that Node.js 18+ is installed
            and that <span style={{ fontFamily: "var(--font-mono)" }}>npx @playwright/mcp</span> can
            run.
          </div>
        )}
      </Section>
      <Section title="Live view">
        <BrowserLiveView ready={server.discovery_status === "ready"} turnActive={turnActive} />
      </Section>
    </div>
  );
}

/** Read-only mirror of the agent's browser. Auto-polls GET /browser/state
 *  ONLY while the agent is running a turn — calling a browser tool relaunches
 *  the window if it was closed, so polling when idle would resurrect a window
 *  the user deliberately closed. When idle we freeze the last frame and offer
 *  a manual Refresh; if the user closes the window mid-turn (detected as
 *  about:blank after a real page) we stop reviving it. */
function BrowserLiveView({ ready, turnActive }: { ready: boolean; turnActive: boolean }) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [showSnapshot, setShowSnapshot] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Latches when the user closes the window mid-turn so we stop re-launching it.
  const closedRef = useRef(false);
  const prevUrlRef = useRef<string | null>(null);

  const fetchOnce = useCallback(async () => {
    const s = await fetchBrowserState();
    // @playwright/mcp relaunches at about:blank when a tool runs with no open
    // window. If we'd shown a real page and now see about:blank, the user
    // closed it — latch closed so the auto-poll stops resurrecting it.
    if (s.available && s.url === "about:blank" && prevUrlRef.current && prevUrlRef.current !== "about:blank") {
      closedRef.current = true;
    } else if (s.url && s.url !== "about:blank") {
      prevUrlRef.current = s.url;
    }
    setState(s);
  }, []);

  // A new turn means the agent may use the browser again — clear the latch.
  useEffect(() => {
    if (turnActive) closedRef.current = false;
  }, [turnActive]);

  // Auto-poll ONLY during an active turn (and not after a user-close). When
  // idle we never touch the browser, so closing it stays closed.
  useEffect(() => {
    if (!ready || !turnActive) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || closedRef.current) return;
      try {
        await fetchOnce();
      } catch {
        // Transient (e.g. mid-turn lock contention) — keep the last frame.
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ready, turnActive, fetchOnce]);

  const refresh = async () => {
    setRefreshing(true);
    closedRef.current = false;
    prevUrlRef.current = null;
    try {
      await fetchOnce();
    } catch {
      // ignore — note stays
    } finally {
      setRefreshing(false);
    }
  };

  const note = (text: string) => (
    <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.55 }}>{text}</div>
  );

  const refreshBtn = (
    <button
      onClick={refresh}
      disabled={!ready || refreshing}
      style={{
        alignSelf: "flex-start",
        fontSize: 11,
        color: "var(--text-muted)",
        padding: "3px 8px",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: "var(--bg-panel)",
        cursor: ready && !refreshing ? "pointer" : "default",
        opacity: ready ? 1 : 0.5,
      }}
    >
      {refreshing ? "capturing…" : "Refresh"}
    </button>
  );

  if (!ready) return note("Browser is starting — the live view appears once it's ready.");
  // Idle with no frame captured yet: don't auto-touch the browser (that would
  // re-open a closed window). Let the user pull a frame on demand.
  if (!state) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {note(
          turnActive
            ? "Capturing the agent's browser…"
            : "Idle. The view updates live while the agent uses the browser — or click Refresh to capture the current page.",
        )}
        {refreshBtn}
      </div>
    );
  }
  if (!state.available) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {note("No browser window open. It opens when the agent navigates, or Refresh to launch one.")}
        {refreshBtn}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {refreshBtn}
      <div
        style={{
          fontSize: 10.5,
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
          padding: "4px 8px",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 5,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={state.url ?? undefined}
      >
        {state.url ?? "no page open"}
      </div>
      {state.error && (
        <div style={{ color: "var(--err)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
          {state.error}
        </div>
      )}
      {state.screenshot ? (
        <img
          src={state.screenshot}
          alt="Browser screenshot"
          style={{
            width: "100%",
            border: "1px solid var(--border)",
            borderRadius: 6,
            display: "block",
          }}
        />
      ) : (
        note("No page open yet — ask the agent to navigate to a URL.")
      )}
      {state.snapshot && (
        <div>
          <button
            onClick={() => setShowSnapshot((s) => !s)}
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              padding: "2px 0",
            }}
          >
            {showSnapshot ? "hide" : "show"} DOM snapshot
          </button>
          {showSnapshot && (
            <pre
              style={{
                margin: "4px 0 0",
                padding: "6px 8px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                color: "var(--text-muted)",
                maxHeight: 220,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {state.snapshot}
            </pre>
          )}
        </div>
      )}
      <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {turnActive
          ? "Live — updating while the agent works."
          : "Showing the last frame. Closing the window ends it; click Refresh to capture again."}
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
