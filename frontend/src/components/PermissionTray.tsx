import { useMemo, useState } from "react";
import { ChevronRightIcon } from "./Icons";

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: string;
  currentMode: string;
  requiredMode: string;
}

interface Props {
  pending: PendingPermission[];
  decidingId: string | null;
  onDecide: (requestId: string, allowed: boolean, remember?: boolean) => Promise<void>;
}

/** Floating tray rendered between the chat scroller and ChatInput when
 *  the agent is waiting on the user to allow/deny a tool call. Without
 *  this UI the turn just hangs — backend has emitted `permission_request`
 *  and is parked until the matching `decidePermission` POST. */
export function PermissionTray({ pending, decidingId, onDecide }: Props) {
  if (pending.length === 0) return null;
  return (
    <div
      style={{
        flexShrink: 0,
        background: "var(--accent-soft)",
        borderTop: "1px solid var(--accent-soft-border)",
        borderBottom: "1px solid var(--accent-soft-border)",
        padding: "10px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        maxHeight: "40vh",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--accent-hover)",
          fontWeight: 600,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 0 8px var(--accent)",
            animation: "pi-blink 1.4s ease-in-out infinite",
          }}
        />
        agent is waiting — {pending.length} permission request{pending.length === 1 ? "" : "s"}
      </div>
      {pending.map((entry) => (
        <PermissionRow
          key={entry.requestId}
          entry={entry}
          busy={decidingId === entry.requestId}
          onDecide={onDecide}
        />
      ))}
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
  onDecide: (requestId: string, allowed: boolean, remember?: boolean) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const formattedInput = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(entry.input), null, 2);
    } catch {
      return entry.input;
    }
  }, [entry.input]);

  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--accent-soft-border)",
        borderRadius: 7,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            fontSize: 12.5,
            color: "var(--accent-hover)",
          }}
        >
          {entry.toolName}
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {entry.currentMode} → needs {entry.requiredMode}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 10,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {entry.requestId}
        </span>
      </div>

      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          color: "var(--text-muted)",
          padding: "2px 0",
          alignSelf: "flex-start",
        }}
      >
        <ChevronRightIcon
          size={10}
          style={{
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
          }}
        />
        {expanded ? "hide input" : "show input"}
      </button>
      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "6px 8px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            maxHeight: 200,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {formattedInput}
        </pre>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
        <button
          onClick={() => onDecide(entry.requestId, true)}
          disabled={busy}
          style={{
            padding: "5px 14px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            background: "var(--ok)",
            color: "#0a0a0a",
            border: "1px solid var(--ok)",
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "…" : "Allow"}
        </button>
        <button
          onClick={() => onDecide(entry.requestId, true, true)}
          disabled={busy}
          title="Approve and stop asking for this command for the rest of the session"
          style={{
            padding: "5px 14px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            background: "var(--ok-soft, var(--accent-soft))",
            color: "var(--ok)",
            border: "1px solid var(--ok)",
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Allow always
        </button>
        <button
          onClick={() => onDecide(entry.requestId, false)}
          disabled={busy}
          style={{
            padding: "5px 14px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            background: "var(--err-soft)",
            color: "var(--err)",
            border: "1px solid var(--err-border)",
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
