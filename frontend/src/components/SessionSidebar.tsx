import { useState } from "react";
import type { SessionSummary, SessionId } from "../types";
import { ForgeLogo, PlusIcon, RefreshIcon, FolderIcon, SparkleIcon, CloseIcon, SettingsIcon } from "./Icons";

interface Props {
  sessions: SessionSummary[];
  activeId: SessionId | null;
  workspace: string | null;
  onSelect: (id: SessionId) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onPickWorkspace: () => void;
  /** Per-row ↓ button starts absorb mode with that row as the target.
   *  Caller (AppShell) owns the absorb state and renders the modal. */
  onStartAbsorb: (target: SessionId) => void;
  /** Non-null = currently in absorb-pick mode, with this session as the
   *  target. Renders checkboxes on non-target rows + a confirm bar below. */
  absorbTarget: SessionId | null;
  absorbSources: Set<SessionId>;
  onToggleAbsorbSource: (id: SessionId) => void;
  onCancelAbsorb: () => void;
  onConfirmAbsorb: () => void;
  /** Per-row ✕ hover button. Caller should confirm + call DELETE
   *  /sessions/{id}, then refresh + reset activeId if it matched. */
  onDelete: (id: SessionId) => void;
  /** Opens the Settings modal where Model / Skills / MCP / RAG /
   *  Summarizer / Config live. Moved out of the RightPanel so the right
   *  side stays focused on per-turn views (Files, Tools, Browser). */
  onOpenSettings: () => void;
}

export function SessionSidebar({
  sessions,
  activeId,
  workspace,
  onSelect,
  onCreate,
  onRefresh,
  onPickWorkspace,
  onStartAbsorb,
  absorbTarget,
  absorbSources,
  onToggleAbsorbSource,
  onCancelAbsorb,
  onConfirmAbsorb,
  onDelete,
  onOpenSettings,
}: Props) {
  const absorbing = absorbTarget != null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ForgeLogo size={20} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              fontSize: 13,
              letterSpacing: "-0.01em",
              color: "var(--text)",
            }}
          >
            Forge.ai
          </span>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onCreate}
            title="New session"
            style={{
              flex: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              height: 32,
              padding: "0 10px",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: 7,
              color: "var(--text)",
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: "-0.01em",
            }}
          >
            <PlusIcon size={12} />
            New session
          </button>
          <button
            onClick={onRefresh}
            title="Refresh"
            style={{
              width: 32,
              height: 32,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: 7,
              color: "var(--text-muted)",
            }}
          >
            <RefreshIcon size={12} />
          </button>
        </div>

        {/* Workspace picker */}
        <button
          onClick={onPickWorkspace}
          title={workspace ?? "Pick a workspace"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            background: workspace ? "var(--bg-hover)" : "var(--accent-soft)",
            border: `1px solid ${workspace ? "var(--border)" : "var(--accent-soft-border)"}`,
            borderRadius: 7,
            color: workspace ? "var(--text-muted)" : "var(--accent-hover)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            textAlign: "left",
            width: "100%",
            overflow: "hidden",
          }}
        >
          <FolderIcon size={11} />
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
            }}
          >
            {workspace ?? "Pick workspace…"}
          </span>
        </button>
      </div>

      {/* Session list */}
      <div
        style={{
          flex: "1 1 0",
          overflowY: "auto",
          minHeight: 80,
          padding: "4px 0",
        }}
      >
        {sessions.length === 0 ? (
          <div
            style={{
              padding: "16px 12px",
              color: "var(--text-dim)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            No sessions yet.
            <br />
            Click <strong>New session</strong> to start.
          </div>
        ) : (
          sessions.map((s) => {
            const isTarget = absorbTarget === s.id;
            const isSelected = absorbSources.has(s.id);
            return (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeId && !absorbing}
                absorbing={absorbing}
                isAbsorbTarget={isTarget}
                isAbsorbSource={isSelected}
                onClick={() => {
                  if (!absorbing) onSelect(s.id);
                  else if (!isTarget) onToggleAbsorbSource(s.id);
                }}
                onStartAbsorb={() => onStartAbsorb(s.id)}
                onDelete={() => onDelete(s.id)}
              />
            );
          })
        )}
      </div>

      {absorbing && (
        <AbsorbConfirmBar
          targetTitle={
            sessions.find((s) => s.id === absorbTarget)?.title ?? absorbTarget!
          }
          sourceCount={absorbSources.size}
          onCancel={onCancelAbsorb}
          onConfirm={onConfirmAbsorb}
        />
      )}

      {/* Bottom: Settings entry. Anchors the sidebar the way the old
          App.tsx did + Claude Code's Cmd+, modal style. Hidden during
          absorb mode so the confirm bar owns the bottom slot. */}
      {!absorbing && <SettingsButton onClick={onOpenSettings} />}
    </div>
  );
}

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Settings — Model, Skills, MCP, RAG, Summarizer"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "10px 14px",
        borderTop: "1px solid var(--border)",
        background: "transparent",
        color: "var(--text-muted)",
        fontSize: 12,
        textAlign: "left",
        cursor: "pointer",
      }}
      className="pi-row"
    >
      <SettingsIcon size={13} />
      <span style={{ fontWeight: 500 }}>Settings</span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
        }}
      >
        model · skills · mcp · rag
      </span>
    </button>
  );
}

function AbsorbConfirmBar({
  targetTitle,
  sourceCount,
  onCancel,
  onConfirm,
}: {
  targetTitle: string;
  sourceCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        flexShrink: 0,
        padding: "10px 12px",
        borderTop: "1px solid var(--accent-soft-border)",
        background: "var(--accent-soft)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--accent-hover)",
          fontWeight: 600,
        }}
      >
        Absorb into {targetTitle.slice(0, 24)}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
        Tick the sessions whose conversation should be summarised and
        injected into the target as a system message.
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1,
            padding: "6px 10px",
            background: "var(--bg)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            fontSize: 11.5,
          }}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={sourceCount === 0}
          style={{
            flex: 2,
            padding: "6px 10px",
            background: sourceCount === 0 ? "var(--bg-hover)" : "var(--accent)",
            color: sourceCount === 0 ? "var(--text-dim)" : "#0a0a0a",
            border: `1px solid ${sourceCount === 0 ? "var(--border)" : "var(--accent)"}`,
            borderRadius: 5,
            fontSize: 11.5,
            fontWeight: 600,
            cursor: sourceCount === 0 ? "not-allowed" : "pointer",
          }}
        >
          Absorb {sourceCount} source{sourceCount === 1 ? "" : "s"} →
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  absorbing,
  isAbsorbTarget,
  isAbsorbSource,
  onClick,
  onStartAbsorb,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  absorbing: boolean;
  isAbsorbTarget: boolean;
  isAbsorbSource: boolean;
  onClick: () => void;
  onStartAbsorb: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  // `created_at` is already ms since epoch (matches Date.now()).
  const ts = new Date(session.created_at);
  // Strip a leading `session_` / `session-` so the fallback title isn't
  // dominated by the literal word "session" (`Session session…`).
  const shortId = session.id.replace(/^session[_-]/i, "").slice(0, 8);
  const title = session.title || `Session ${shortId}`;

  // Background priority: target > selected > active > hover > transparent.
  // Target uses orange-soft so the user immediately sees where the
  // summary will land; selected sources use a slightly weaker tint.
  const background = isAbsorbTarget
    ? "var(--accent-soft-strong)"
    : isAbsorbSource
      ? "var(--accent-soft)"
      : active
        ? "var(--bg-selected)"
        : hover
          ? "var(--bg-hover)"
          : "transparent";
  const borderLeft = isAbsorbTarget
    ? "2px solid var(--accent)"
    : isAbsorbSource
      ? "2px solid var(--accent-hover)"
      : `2px solid ${active ? "var(--accent)" : "transparent"}`;
  const targetGreyedOut = isAbsorbTarget; // target shouldn't look clickable

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={targetGreyedOut}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        width: "100%",
        padding: "7px 10px 7px 12px",
        background,
        borderLeft,
        color: "var(--text)",
        textAlign: "left",
        transition: "background 0.1s",
        cursor: targetGreyedOut ? "default" : "pointer",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
          fontWeight: active || isAbsorbTarget || isAbsorbSource ? 600 : 500,
          color: active || isAbsorbTarget || isAbsorbSource ? "var(--text)" : "var(--text-muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {absorbing && !isAbsorbTarget && (
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 13,
              height: 13,
              borderRadius: 3,
              border: `1.5px solid ${isAbsorbSource ? "var(--accent)" : "var(--border-strong)"}`,
              background: isAbsorbSource ? "var(--accent)" : "transparent",
              color: "#0a0a0a",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {isAbsorbSource ? "✓" : ""}
          </span>
        )}
        {session.turn_in_flight && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--accent)",
              flexShrink: 0,
              animation: "pi-blink 1.2s ease-in-out infinite",
            }}
          />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{title}</span>
        {isAbsorbTarget && (
          <span
            style={{
              fontSize: 9.5,
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--accent)",
              color: "#0a0a0a",
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              letterSpacing: "0.05em",
              flexShrink: 0,
            }}
          >
            TARGET
          </span>
        )}
        {!absorbing && hover && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onStartAbsorb();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onStartAbsorb();
              }
            }}
            title="Absorb other sessions into this one"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              fontSize: 9.5,
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              flexShrink: 0,
              cursor: "pointer",
            }}
          >
            <SparkleIcon size={8} /> ABSORB
          </span>
        )}
        {!absorbing && hover && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete session "${title}"? This cannot be undone.`)) {
                onDelete();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                if (confirm(`Delete session "${title}"? This cannot be undone.`)) {
                  onDelete();
                }
              }
            }}
            title="Delete session"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: 3,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              flexShrink: 0,
              cursor: "pointer",
            }}
            className="pi-row"
          >
            <CloseIcon size={9} />
          </span>
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          fontSize: 10.5,
          color: "var(--text-dim)",
          marginTop: 2,
        }}
      >
        <span>{ts.toLocaleString()}</span>
        <span>·</span>
        <span>{session.message_count} msg</span>
      </div>
    </button>
  );
}

