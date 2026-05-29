import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationMessage } from "../types";
import { MessageView } from "./MessageView";
import type { ToolResultMap } from "./MessageView";
import { ChatMinimap } from "./ChatMinimap";
import { Markdown } from "../Markdown";
import { ForgeLogo } from "./Icons";

interface Props {
  messages: ConversationMessage[];
  streamText: string;
  streamReasoning: string;
  turnState: "idle" | "running" | "error";
  turnError: string | null;
  emptyTitle?: string;
}

export function ChatWindow({
  messages,
  streamText,
  streamReasoning,
  turnState,
  turnError,
  emptyTitle,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    setScrollEl(scrollRef.current);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const slack = 24;
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < slack);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to bottom on new content if user was already at bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamText, streamReasoning, atBottom]);

  const showStreamSection = turnState === "running" || streamText.length > 0 || streamReasoning.length > 0;

  // Build a tool_use_id → {output, isError, toolName} index so each
  // tool_use block can fold its matching tool_result into a single
  // merged bubble (yellow → green/red on completion). tool_use that
  // doesn't have a result yet stays yellow ("running…").
  const resultMap = useMemo<ToolResultMap>(() => {
    const map = new Map<string, { output: string; isError: boolean; toolName: string }>();
    for (const m of messages) {
      if (m.role !== "assistant" && m.role !== "tool") continue;
      for (const b of m.blocks) {
        if (b.type === "tool_result") {
          map.set(b.tool_use_id, {
            output: b.output,
            isError: b.is_error,
            toolName: b.tool_name,
          });
        }
      }
    }
    return { get: (id: string) => map.get(id) };
  }, [messages]);

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          padding: "20px 24px 16px",
        }}
      >
        {messages.length === 0 && !showStreamSection ? (
          <EmptyState title={emptyTitle} />
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 18,
              maxWidth: 880,
              margin: "0 auto",
            }}
          >
            {messages.map((m, i) => {
              // Drop assistant/tool messages that ONLY carried tool_results —
              // those results are now folded into the matching tool_use bubble
              // so rendering an empty message wrapper would just leave a model
              // label hanging.
              const hasContentOtherThanToolResult = m.blocks.some(
                (b) => b.type !== "tool_result",
              );
              if (!hasContentOtherThanToolResult) return null;
              return <MessageView key={i} message={m} results={resultMap} />;
            })}

            {showStreamSection && (
              <StreamingView
                turnState={turnState}
                streamText={streamText}
                streamReasoning={streamReasoning}
              />
            )}

            {turnError && (
              <div
                style={{
                  padding: "10px 12px",
                  background: "var(--err-soft)",
                  border: "1px solid var(--err-border)",
                  borderRadius: 7,
                  color: "var(--err)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {turnError}
              </div>
            )}
          </div>
        )}
      </div>
      <ChatMinimap messages={messages} scrollContainer={scrollEl} />
    </div>
  );
}

function EmptyState({ title }: { title?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 12,
        color: "var(--text-dim)",
      }}
    >
      <ForgeLogo size={48} />
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: "var(--text-muted)",
          letterSpacing: "-0.01em",
        }}
      >
        {title ?? "Forge.ai"}
      </div>
      <div style={{ fontSize: 13 }}>Pair-program with me — type a message below.</div>
    </div>
  );
}

function StreamingView({
  turnState,
  streamText,
  streamReasoning,
}: {
  turnState: "idle" | "running" | "error";
  streamText: string;
  streamReasoning: string;
}) {
  const running = turnState === "running";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {streamReasoning && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 10px 8px",
            background: "var(--bg-panel)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginBottom: 4,
              fontWeight: 500,
              letterSpacing: "0.02em",
            }}
          >
            Thinking…
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              whiteSpace: "pre-wrap",
              fontFamily: "var(--font-mono)",
              lineHeight: 1.55,
            }}
          >
            {streamReasoning}
          </div>
        </div>
      )}
      <div style={{ position: "relative" }}>
        {streamText ? (
          <Markdown text={streamText} />
        ) : running ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text-dim)",
              fontSize: 13,
            }}
          >
            <span className="pi-spin" />
            Waiting for model…
          </div>
        ) : null}
        {running && streamText && (
          <span className="pi-caret" style={{ background: "var(--accent)" }} />
        )}
      </div>
    </div>
  );
}
