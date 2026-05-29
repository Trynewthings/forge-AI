import { useCallback, useMemo, useState } from "react";
import { absorbSessions } from "../api";
import type { AbsorbResponse, SessionId, SessionSummary } from "../types";
import { CloseIcon, SparkleIcon } from "./Icons";

interface Props {
  targetId: SessionId;
  sourceIds: SessionId[];
  sessions: SessionSummary[];
  summarizerLabel: string | null;
  onClose: () => void;
  /** Fired after a successful inject so AppShell can re-fetch the target's
   *  conversation and the user sees the new system message. */
  onInjected: () => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "generating" }
  | { kind: "previewing"; result: AbsorbResponse }
  | { kind: "injecting" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** Two-step absorb dialog: Generate → edit → Inject. */
export function AbsorbModal({
  targetId,
  sourceIds,
  sessions,
  summarizerLabel,
  onClose,
  onInjected,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [draft, setDraft] = useState<string>("");

  const sourceMap = useMemo(() => {
    const m = new Map<SessionId, SessionSummary>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);
  const targetLabel = sourceMap.get(targetId)?.title || `Session ${targetId}`;

  const totalSourceMsgs = sourceIds.reduce(
    (acc, id) => acc + (sourceMap.get(id)?.message_count ?? 0),
    0,
  );

  const generate = useCallback(async () => {
    setPhase({ kind: "generating" });
    try {
      const result = await absorbSessions(targetId, {
        source_session_ids: sourceIds,
        inject: false,
      });
      setDraft(result.summary);
      setPhase({ kind: "previewing", result });
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, [targetId, sourceIds]);

  const inject = useCallback(async () => {
    if (!draft.trim()) {
      setPhase({ kind: "error", message: "Summary is empty — nothing to inject." });
      return;
    }
    setPhase({ kind: "injecting" });
    try {
      await absorbSessions(targetId, {
        source_session_ids: sourceIds,
        inject: true,
        override_summary: draft,
      });
      setPhase({ kind: "done" });
      onInjected();
      // Auto-close shortly after success so the user sees the new system
      // message in the target session.
      setTimeout(onClose, 600);
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, [draft, sourceIds, targetId, onInjected, onClose]);

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
          width: "min(720px, 92vw)",
          maxHeight: "88vh",
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
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <SparkleIcon size={14} style={{ color: "var(--accent-hover)" }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            Absorb {sourceIds.length} session{sourceIds.length === 1 ? "" : "s"} into{" "}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent-hover)" }}>
              {targetLabel}
            </span>
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{
              width: 26,
              height: 26,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 5,
              color: "var(--text-dim)",
            }}
            className="pi-row"
          >
            <CloseIcon size={11} />
          </button>
        </div>

        {/* Sources list */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-muted)",
              fontWeight: 600,
            }}
          >
            Sources ({totalSourceMsgs} total messages)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {sourceIds.map((id) => {
              const s = sourceMap.get(id);
              return (
                <span
                  key={id}
                  title={id}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {(s?.title || id).slice(0, 40)} · {s?.message_count ?? "?"} msg
                </span>
              );
            })}
          </div>
          {summarizerLabel && (
            <div
              style={{
                marginTop: 6,
                fontSize: 10.5,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Summarizer: {summarizerLabel}
            </div>
          )}
        </div>

        {/* Body — phase-dependent */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {phase.kind === "idle" && (
            <IdleBody onGenerate={generate} sourceCount={sourceIds.length} />
          )}
          {phase.kind === "generating" && <GeneratingBody />}
          {(phase.kind === "previewing" ||
            phase.kind === "injecting" ||
            phase.kind === "done") && (
            <PreviewBody
              draft={draft}
              setDraft={setDraft}
              fallbackWarning={
                phase.kind === "previewing" && phase.result.fallback_to_main_model
                  ? phase.result.summarizer_model
                  : null
              }
              busy={phase.kind === "injecting"}
              done={phase.kind === "done"}
              onRegenerate={generate}
              onInject={inject}
              onCancel={onClose}
            />
          )}
          {phase.kind === "error" && (
            <ErrorBody
              message={phase.message}
              onRetry={() => setPhase({ kind: "idle" })}
              onCancel={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function IdleBody({
  onGenerate,
  sourceCount,
}: {
  onGenerate: () => void;
  sourceCount: number;
}) {
  return (
    <div
      style={{
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        color: "var(--text-muted)",
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      <p style={{ margin: 0 }}>
        The summarizer will read the {sourceCount} selected session
        {sourceCount === 1 ? "" : "s"} and produce a structured handoff (Task /
        Established / Decisions / Open / Recommended next step). The original
        sessions stay intact — only the target gets a new system message.
      </p>
      <p style={{ margin: 0 }}>
        You'll be able to edit the summary before it's injected.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
        <button
          onClick={onGenerate}
          style={{
            padding: "8px 16px",
            background: "var(--accent)",
            color: "#0a0a0a",
            border: "1px solid var(--accent)",
            borderRadius: 7,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Generate summary →
        </button>
      </div>
    </div>
  );
}

function GeneratingBody() {
  return (
    <div
      style={{
        padding: 30,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        color: "var(--text-muted)",
        fontSize: 13,
      }}
    >
      <span
        className="pi-spin"
        style={{ width: 24, height: 24, borderWidth: 2 }}
      />
      <span>Reading sources and generating summary…</span>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
        Can take 10-60 seconds depending on session size.
      </span>
    </div>
  );
}

function PreviewBody({
  draft,
  setDraft,
  fallbackWarning,
  busy,
  done,
  onRegenerate,
  onInject,
  onCancel,
}: {
  draft: string;
  setDraft: (v: string) => void;
  fallbackWarning: string | null;
  busy: boolean;
  done: boolean;
  onRegenerate: () => void;
  onInject: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      {fallbackWarning && (
        <div
          style={{
            margin: "10px 14px 0",
            padding: "8px 10px",
            background: "var(--warn-soft)",
            border: "1px solid var(--warn-border)",
            borderRadius: 6,
            color: "var(--warn)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          No <code style={{ fontFamily: "var(--font-mono)" }}>session_summarizer</code> configured —
          fell back to <code style={{ fontFamily: "var(--font-mono)" }}>{fallbackWarning}</code>. Same-model
          summarising itself can carry over reasoning bias from the original sessions.
          Configure a distinct summarizer model in Config for better results.
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, padding: "10px 14px", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-muted)",
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          Summary (editable)
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          disabled={busy || done}
          style={{
            flex: 1,
            minHeight: 220,
            padding: "10px 12px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            fontSize: 12.5,
            lineHeight: 1.55,
            fontFamily: "var(--font-mono)",
            outline: "none",
            resize: "none",
            whiteSpace: "pre-wrap",
          }}
        />
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 4 }}>
          {draft.length.toLocaleString()} chars · gets injected as a system message in the target session.
        </div>
      </div>
      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <button
          onClick={onRegenerate}
          disabled={busy || done}
          style={{
            padding: "6px 12px",
            background: "var(--bg)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 11.5,
            cursor: busy || done ? "not-allowed" : "pointer",
            opacity: busy || done ? 0.6 : 1,
          }}
        >
          ↻ Regenerate
        </button>
        <span style={{ flex: 1 }} />
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            padding: "6px 12px",
            background: "var(--bg)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 11.5,
          }}
        >
          Cancel
        </button>
        <button
          onClick={onInject}
          disabled={busy || done || !draft.trim()}
          style={{
            padding: "7px 16px",
            background: done ? "var(--ok)" : "var(--accent)",
            color: "#0a0a0a",
            border: `1px solid ${done ? "var(--ok)" : "var(--accent)"}`,
            borderRadius: 7,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: busy || done || !draft.trim() ? "not-allowed" : "pointer",
            opacity: !draft.trim() ? 0.6 : 1,
          }}
        >
          {busy ? "Injecting…" : done ? "✓ Injected" : "Inject into target →"}
        </button>
      </div>
    </>
  );
}

function ErrorBody({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: "10px 12px",
          background: "var(--err-soft)",
          border: "1px solid var(--err-border)",
          borderRadius: 6,
          color: "var(--err)",
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 240,
          overflow: "auto",
        }}
      >
        {message}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{
            padding: "6px 12px",
            background: "var(--bg)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 11.5,
          }}
        >
          Close
        </button>
        <button
          onClick={onRetry}
          style={{
            padding: "6px 12px",
            background: "var(--accent)",
            color: "#0a0a0a",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            fontSize: 11.5,
            fontWeight: 600,
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
