import { useState } from "react";
import type { QuestionOption } from "../types";

export interface PendingQuestion {
  questionId: string;
  question: string;
  header: string | null;
  options: QuestionOption[];
  allowOther: boolean;
}

export type QuestionAnswerPayload =
  | { type: "selected"; index: number; label: string }
  | { type: "other_text"; text: string }
  | { type: "dismissed" };

interface Props {
  pending: PendingQuestion[];
  answeringId: string | null;
  onAnswer: (questionId: string, payload: QuestionAnswerPayload) => Promise<void>;
}

/** Sibling of PermissionTray. When the agent fires AskUser the runtime
 *  is parked on a oneshot; this UI is what the user clicks to unblock
 *  it. Hidden when `pending` is empty so it adds zero visual weight in
 *  normal turns. */
export function QuestionTray({ pending, answeringId, onAnswer }: Props) {
  if (pending.length === 0) return null;
  return (
    <div
      style={{
        flexShrink: 0,
        // Slightly different tint from PermissionTray so the user
        // immediately reads "this is a question, not a permission gate".
        background: "color-mix(in srgb, #38bdf8 8%, transparent)",
        borderTop: "1px solid color-mix(in srgb, #38bdf8 40%, var(--border))",
        borderBottom: "1px solid color-mix(in srgb, #38bdf8 40%, var(--border))",
        padding: "10px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxHeight: "50vh",
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
          color: "#7dd3fc",
          fontWeight: 600,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "#38bdf8",
            boxShadow: "0 0 8px #38bdf8",
            animation: "pi-blink 1.4s ease-in-out infinite",
          }}
        />
        agent has a question — {pending.length} pending
      </div>
      {pending.map((entry) => (
        <QuestionRow
          key={entry.questionId}
          entry={entry}
          busy={answeringId === entry.questionId}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}

function QuestionRow({
  entry,
  busy,
  onAnswer,
}: {
  entry: PendingQuestion;
  busy: boolean;
  onAnswer: (questionId: string, payload: QuestionAnswerPayload) => Promise<void>;
}) {
  // When user clicks "Other" we swap to a text input. When `options` is
  // empty (pure free-text mode), we render the text input from the start.
  const [otherMode, setOtherMode] = useState(entry.options.length === 0);
  const [otherText, setOtherText] = useState("");

  const submitOther = () => {
    const trimmed = otherText.trim();
    if (!trimmed) return;
    void onAnswer(entry.questionId, { type: "other_text", text: trimmed });
  };

  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: "1px solid color-mix(in srgb, #38bdf8 40%, var(--border))",
        borderRadius: 7,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {entry.header && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              fontSize: 10.5,
              color: "#7dd3fc",
              padding: "1px 6px",
              borderRadius: 4,
              background: "color-mix(in srgb, #38bdf8 12%, transparent)",
              border: "1px solid color-mix(in srgb, #38bdf8 40%, var(--border))",
              flexShrink: 0,
            }}
          >
            {entry.header}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 10,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {entry.questionId}
        </span>
      </div>

      <div
        style={{
          fontSize: 13.5,
          lineHeight: 1.5,
          color: "var(--text)",
          whiteSpace: "pre-wrap",
          fontWeight: 500,
        }}
      >
        {entry.question}
      </div>

      {/* Option buttons */}
      {entry.options.length > 0 && !otherMode && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {entry.options.map((opt, i) => (
            <button
              key={i}
              onClick={() => void onAnswer(entry.questionId, {
                type: "selected",
                index: i,
                label: opt.label,
              })}
              disabled={busy}
              title={opt.description ?? undefined}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                textAlign: "left",
                padding: "6px 10px",
                borderRadius: 6,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                fontSize: 12.5,
                cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
              className="pi-row"
            >
              <span style={{ color: "var(--text-dim)" }}>{i + 1}.</span>
              <span style={{ flex: 1 }}>{opt.label}</span>
              {opt.description && (
                <span
                  style={{
                    fontSize: 10.5,
                    color: "var(--text-dim)",
                    maxWidth: 320,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {opt.description}
                </span>
              )}
            </button>
          ))}
          {entry.allowOther && (
            <button
              onClick={() => setOtherMode(true)}
              disabled={busy}
              style={{
                alignSelf: "flex-start",
                fontSize: 11,
                color: "var(--text-muted)",
                padding: "4px 8px",
                marginTop: 2,
              }}
              className="pi-row"
            >
              Other (type a reply) →
            </button>
          )}
        </div>
      )}

      {/* Free-text input (when no options OR user picked Other) */}
      {otherMode && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <textarea
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Type your answer…"
            spellCheck={false}
            autoFocus
            rows={2}
            onKeyDown={(e) => {
              // ⌘/Ctrl + Enter submits; plain Enter inserts newline so
              // users can give multi-line answers without the prompt
              // accidentally firing.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitOther();
              }
            }}
            style={{
              padding: "6px 8px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text)",
              fontSize: 12.5,
              fontFamily: "var(--font-sans)",
              lineHeight: 1.5,
              outline: "none",
              resize: "vertical",
              minHeight: 40,
              maxHeight: 200,
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={submitOther}
              disabled={busy || !otherText.trim()}
              style={{
                padding: "5px 14px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                background: !otherText.trim() ? "var(--bg-hover)" : "var(--accent)",
                color: !otherText.trim() ? "var(--text-dim)" : "#0a0a0a",
                border: `1px solid ${!otherText.trim() ? "var(--border)" : "var(--accent)"}`,
                opacity: busy ? 0.6 : 1,
                cursor: busy || !otherText.trim() ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "…" : "Submit"}
            </button>
            {entry.options.length > 0 && (
              <button
                onClick={() => {
                  setOtherMode(false);
                  setOtherText("");
                }}
                disabled={busy}
                style={{
                  padding: "5px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--text-muted)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                }}
              >
                Back to options
              </button>
            )}
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontSize: 10,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                alignSelf: "center",
              }}
            >
              ⌘+Enter to submit
            </span>
          </div>
        </div>
      )}

      {/* Skip — always available */}
      <button
        onClick={() => void onAnswer(entry.questionId, { type: "dismissed" })}
        disabled={busy}
        style={{
          alignSelf: "flex-end",
          fontSize: 11,
          color: "var(--text-dim)",
          padding: "2px 8px",
        }}
        className="pi-row"
      >
        Skip — let agent decide
      </button>
    </div>
  );
}
