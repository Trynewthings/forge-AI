import { useMemo, useState } from "react";
import type { ConversationMessage, ContentBlock, TokenUsage } from "../types";
import { Markdown } from "../Markdown";
import { ChevronRightIcon } from "./Icons";

/** Result paired to a tool_use by id. Built once at the conversation level
 *  and threaded down so a single tool call renders as ONE bubble (yellow
 *  while running → green on success → red on error). */
export interface ToolResultMap {
  get(id: string): { output: string; isError: boolean; toolName: string } | undefined;
}

interface Props {
  message: ConversationMessage;
  /** Lookup for tool_results by tool_use id, so tool_use bubbles can fold
   *  their matching result inline. When omitted, tool_use renders as
   *  "running" and tool_result blocks render standalone. */
  results?: ToolResultMap;
}

export function MessageView({ message, results }: Props) {
  if (message.role === "user") return <UserMessage msg={message} />;
  if (message.role === "system") return <SystemMessage msg={message} />;
  return <AssistantMessage msg={message} results={results} />;
}

function UserMessage({ msg }: { msg: ConversationMessage }) {
  const text = msg.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 4,
        marginLeft: "auto",
        maxWidth: "85%",
      }}
    >
      <div
        style={{
          background: "var(--user-bg)",
          border: "1px solid var(--user-border)",
          borderRadius: 12,
          padding: "8px 12px",
          fontSize: 14,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          color: "var(--text)",
        }}
      >
        {text}
      </div>
      {msg.attachments && msg.attachments.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            justifyContent: "flex-end",
          }}
        >
          {msg.attachments.map((a, i) => (
            <span
              key={i}
              title={a.path}
              style={{
                fontSize: 10.5,
                color: "var(--text-dim)",
                padding: "2px 6px",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "var(--font-mono)",
              }}
            >
              📎 {basename(a.path)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SystemMessage({ msg }: { msg: ConversationMessage }) {
  const text = msg.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--bg-subtle)",
        border: "1px dashed var(--border)",
        borderRadius: 8,
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
        whiteSpace: "pre-wrap",
      }}
    >
      {text}
    </div>
  );
}

function AssistantMessage({
  msg,
  results,
}: {
  msg: ConversationMessage;
  results?: ToolResultMap;
}) {
  // When we have a results map, drop tool_result blocks — they're folded
  // into the matching tool_use's merged bubble.
  const visibleBlocks = results
    ? msg.blocks.filter((b) => b.type !== "tool_result")
    : msg.blocks;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: "100%",
      }}
    >
      {msg.model && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {msg.model}
        </div>
      )}
      {visibleBlocks.map((b, i) => (
        <BlockView key={i} block={b} results={results} />
      ))}
      {msg.usage && <UsageRow usage={msg.usage} />}
    </div>
  );
}

export function BlockView({
  block,
  results,
}: {
  block: ContentBlock;
  results?: ToolResultMap;
}) {
  if (block.type === "text") {
    return <Markdown text={block.text} />;
  }
  if (block.type === "reasoning") {
    return <ReasoningBlock text={block.text} />;
  }
  if (block.type === "tool_use") {
    const paired = results?.get(block.id);
    return (
      <ToolCallBlock
        name={block.name}
        input={block.input}
        result={paired}
      />
    );
  }
  if (block.type === "tool_result") {
    // Only rendered when we lack a results-map context (legacy / standalone
    // tool message). In merged mode, AssistantMessage already filtered it.
    return (
      <ToolCallBlock
        name={block.tool_name}
        input=""
        result={{ output: block.output, isError: block.is_error, toolName: block.tool_name }}
      />
    );
  }
  return null;
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          fontSize: 12,
        }}
      >
        <ChevronRightIcon
          size={10}
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        />
        <span style={{ fontWeight: 500 }}>Thinking</span>
        <span style={{ flex: 1 }} />
      </button>
      {open && (
        <div
          style={{
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            background: "var(--bg-panel)",
            borderTop: "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.55,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

// ─── Merged tool_use + tool_result bubble ───────────────────────────────
//
// State machine:
//   no result      → yellow (var(--warn))     "running…"
//   has result OK  → green  (var(--ok))       "<N lines>"
//   has result ERR → red    (var(--err))      "error"

export function ToolCallBlock({
  name,
  input,
  result,
}: {
  name: string;
  input: string;
  result?: { output: string; isError: boolean; toolName: string };
}) {
  const running = !result;
  const isError = !!result?.isError;
  const output = result?.output ?? "";

  // Auto-open errors so failures are loud. Otherwise default to closed
  // so the conversation reads cleanly and the user opens what they care
  // about.
  const [open, setOpen] = useState(isError);

  // Parsed payloads — try in order; first one that matches wins the body.
  const diff = useMemo(() => (output ? tryParseDiff(output) : null), [output]);
  const todos = useMemo(
    () => (name === "TodoWrite" && output ? tryParseTodos(output) : null),
    [name, output],
  );
  const cleaned = useMemo(
    () => (output ? cleanedOutputForTool(name, output) : null),
    [name, output],
  );

  const summary = useMemo(() => summarizeToolInput(name, input), [name, input]);

  // Header palette by state.
  const headerColor = running
    ? "var(--warn)"
    : isError
      ? "var(--err)"
      : "var(--ok)";
  const headerBg = running
    ? "color-mix(in srgb, var(--warn) 8%, transparent)"
    : isError
      ? "var(--err-soft)"
      : "var(--ok-soft)";
  const headerBorder = running
    ? "color-mix(in srgb, var(--warn) 40%, var(--border))"
    : isError
      ? "var(--err-border)"
      : "var(--ok-border)";

  // Right-side status badge.
  let statusBadge = null as React.ReactNode;
  if (running) {
    statusBadge = (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
        <span className="pi-spin" style={{ width: 8, height: 8 }} />
        running…
      </span>
    );
  } else if (isError) {
    statusBadge = (
      <span style={{ fontSize: 10.5, color: "var(--err)", fontFamily: "var(--font-mono)" }}>
        error
      </span>
    );
  } else if (diff) {
    statusBadge = (
      <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)" }}>
        <span style={{ color: "var(--ok)" }}>+{diff.totalAdditions}</span>{" "}
        <span style={{ color: "var(--err)" }}>-{diff.totalDeletions}</span>
      </span>
    );
  } else if (output) {
    const lines = (cleaned?.text ?? output).split("\n").length;
    statusBadge = (
      <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {lines} line{lines === 1 ? "" : "s"}
      </span>
    );
  }

  const canExpand = !running && !!output;

  return (
    <div
      style={{
        border: `1px solid ${headerBorder}`,
        background: headerBg,
        borderRadius: 7,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => canExpand && setOpen((o) => !o)}
        disabled={!canExpand}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          textAlign: "left",
          cursor: canExpand ? "pointer" : "default",
        }}
      >
        <ChevronRightIcon
          size={10}
          style={{
            transform: open && canExpand ? "rotate(90deg)" : "none",
            transition: "transform 0.15s",
            color: "var(--text-dim)",
            opacity: canExpand ? 1 : 0.3,
          }}
        />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11.5, color: headerColor }}>
          {name}
        </span>
        {summary && (
          <span
            style={{
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
            title={summary}
          >
            {summary}
          </span>
        )}
        {!summary && <span style={{ flex: 1 }} />}
        {statusBadge}
      </button>
      {open && canExpand && (
        <ToolBody
          name={name}
          input={input}
          output={output}
          isError={isError}
          diff={diff}
          todos={todos}
          cleaned={cleaned}
        />
      )}
    </div>
  );
}

function ToolBody({
  name,
  input,
  output,
  isError,
  diff,
  todos,
  cleaned,
}: {
  name: string;
  input: string;
  output: string;
  isError: boolean;
  diff: ParsedDiff | null;
  todos: TodoItem[] | null;
  cleaned: CleanedOutput | null;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {input && input !== "{}" && (
        <InputPeek toolName={name} input={input} />
      )}
      <div style={{ padding: "8px 10px" }}>
        {todos ? (
          <TodoList todos={todos} />
        ) : diff ? (
          <DiffViewer diff={diff} />
        ) : cleaned ? (
          <FileContentView cleaned={cleaned} />
        ) : (
          <pre
            style={{
              margin: 0,
              fontSize: 11.5,
              fontFamily: "var(--font-mono)",
              color: isError ? "var(--err)" : "var(--text-muted)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 400,
              overflow: "auto",
              lineHeight: 1.5,
            }}
          >
            {output || "(no output)"}
          </pre>
        )}
      </div>
    </div>
  );
}

function InputPeek({ toolName: _toolName, input }: { toolName: string; input: string }) {
  const [open, setOpen] = useState(false);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }, [input]);
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          padding: "4px 10px",
          fontSize: 10.5,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          textAlign: "left",
        }}
      >
        <ChevronRightIcon
          size={9}
          style={{
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.15s",
          }}
        />
        input
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: "6px 10px 8px",
            background: "var(--bg-subtle)",
            color: "var(--text-muted)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 240,
            overflow: "auto",
            lineHeight: 1.45,
          }}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}

function FileContentView({ cleaned }: { cleaned: CleanedOutput }) {
  return (
    <div style={{ overflow: "hidden", borderRadius: 5, border: "1px solid var(--border)" }}>
      {cleaned.meta && (
        <div
          style={{
            padding: "3px 8px",
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border)",
            fontSize: 10.5,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {cleaned.meta}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: "6px 10px",
          background: "var(--bg-subtle)",
          color: "var(--text)",
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          whiteSpace: "pre",
          maxHeight: 360,
          overflow: "auto",
          lineHeight: 1.5,
        }}
      >
        {cleaned.text}
      </pre>
    </div>
  );
}

// ─── Diff viewer (ported from old App.tsx) ─────────────────────────────

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface ParsedDiff {
  filePath?: string;
  hunks: DiffHunk[];
  totalAdditions: number;
  totalDeletions: number;
}

function tryParseDiff(raw: string): ParsedDiff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const patchValue = obj.structuredPatch;
  if (!Array.isArray(patchValue) || patchValue.length === 0) return null;

  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (const hunkRaw of patchValue) {
    if (!hunkRaw || typeof hunkRaw !== "object") continue;
    const h = hunkRaw as Record<string, unknown>;
    const lines = Array.isArray(h.lines)
      ? (h.lines.filter((l) => typeof l === "string") as string[])
      : [];
    for (const line of lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    hunks.push({
      oldStart: Number(h.oldStart ?? 0),
      oldLines: Number(h.oldLines ?? 0),
      newStart: Number(h.newStart ?? 0),
      newLines: Number(h.newLines ?? 0),
      lines,
    });
  }
  if (hunks.length === 0) return null;
  const filePath = typeof obj.filePath === "string" ? obj.filePath : undefined;
  return { filePath, hunks, totalAdditions: additions, totalDeletions: deletions };
}

function DiffViewer({ diff }: { diff: ParsedDiff }) {
  return (
    <div style={{ overflow: "hidden", borderRadius: 5, border: "1px solid var(--border)" }}>
      {diff.filePath && (
        <div
          style={{
            padding: "3px 8px",
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border)",
            fontSize: 10.5,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {diff.filePath}
          <span style={{ color: "var(--ok)", marginLeft: 8 }}>+{diff.totalAdditions}</span>
          <span style={{ color: "var(--err)", marginLeft: 4 }}>-{diff.totalDeletions}</span>
        </div>
      )}
      <div style={{ maxHeight: 360, overflow: "auto" }}>
        {diff.hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx} style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.45 }}>
            <div
              style={{
                background: "color-mix(in srgb, #38bdf8 12%, transparent)",
                padding: "1px 8px",
                fontSize: 10,
                color: "#7dd3fc",
              }}
            >
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, idx) => {
              const first = line.charAt(0);
              const bg =
                first === "+"
                  ? "color-mix(in srgb, var(--ok) 12%, transparent)"
                  : first === "-"
                    ? "color-mix(in srgb, var(--err) 12%, transparent)"
                    : "transparent";
              const fg =
                first === "+"
                  ? "var(--ok)"
                  : first === "-"
                    ? "var(--err)"
                    : "var(--text-muted)";
              return (
                <div
                  key={idx}
                  style={{
                    whiteSpace: "pre",
                    padding: "0px 8px",
                    background: bg,
                    color: fg,
                  }}
                >
                  {line || " "}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TodoWrite viewer ──────────────────────────────────────────────────

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

function tryParseTodos(raw: string): TodoItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const list = (parsed as { newTodos?: unknown }).newTodos;
  if (!Array.isArray(list)) return null;
  const todos: TodoItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const content = typeof row.content === "string" ? row.content : null;
    const status = row.status;
    if (
      !content ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    ) {
      return null;
    }
    todos.push({
      content,
      status,
      activeForm: typeof row.activeForm === "string" ? row.activeForm : undefined,
    });
  }
  return todos.length > 0 ? todos : null;
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul
      style={{
        margin: 0,
        padding: "6px 10px",
        listStyle: "none",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12.5,
      }}
    >
      {todos.map((todo, i) => {
        const style = todoStyle(todo.status);
        return (
          <li
            key={i}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
            }}
          >
            <span style={{ color: style.iconColor, userSelect: "none" }}>{style.icon}</span>
            <span
              style={{
                color: style.textColor,
                textDecoration: style.strike ? "line-through" : "none",
                fontWeight: style.bold ? 500 : 400,
              }}
            >
              {todo.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function todoStyle(status: TodoItem["status"]) {
  switch (status) {
    case "completed":
      return {
        icon: "☑",
        iconColor: "var(--ok)",
        textColor: "var(--text-dim)",
        strike: true,
        bold: false,
      };
    case "in_progress":
      return {
        icon: "◐",
        iconColor: "var(--accent)",
        textColor: "var(--text)",
        strike: false,
        bold: true,
      };
    default:
      return {
        icon: "☐",
        iconColor: "var(--text-dim)",
        textColor: "var(--text-muted)",
        strike: false,
        bold: false,
      };
  }
}

// ─── Output cleaners (read_file etc.) ──────────────────────────────────

interface CleanedOutput {
  text: string;
  meta?: string;
}

function cleanedOutputForTool(toolName: string, raw: string): CleanedOutput | null {
  if (toolName === "read_file") {
    try {
      const parsed = JSON.parse(raw);
      const file = (parsed as { file?: Record<string, unknown> })?.file;
      const content = file?.content;
      const filePath = file?.filePath;
      if (typeof content === "string") {
        return { text: content, meta: typeof filePath === "string" ? filePath : undefined };
      }
    } catch {
      /* fall through */
    }
  }
  // WebSearch returns `{ query, results: [Commentary, SearchResult{...}] }`.
  // Render it as a tidy bullet list of links instead of dumping the raw JSON.
  if (toolName === "WebSearch") {
    try {
      const parsed = JSON.parse(raw);
      const results = (parsed as { results?: unknown }).results;
      if (Array.isArray(results)) {
        const lines: string[] = [];
        let firstSummary: string | null = null;
        for (const item of results) {
          if (typeof item === "string") {
            if (!firstSummary) firstSummary = item;
            continue;
          }
          if (item && typeof item === "object") {
            const content = (item as Record<string, unknown>).content;
            if (Array.isArray(content)) {
              for (const hit of content) {
                if (!hit || typeof hit !== "object") continue;
                const title = (hit as Record<string, unknown>).title;
                const url = (hit as Record<string, unknown>).url;
                if (typeof title === "string" && typeof url === "string") {
                  lines.push(`• ${title}\n  ${url}`);
                }
              }
            }
          }
        }
        if (lines.length > 0 || firstSummary) {
          const text = (firstSummary ? firstSummary + "\n\n" : "") + lines.join("\n");
          return { text, meta: undefined };
        }
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ─── Input summarizers ─────────────────────────────────────────────────

function summarizeToolInput(toolName: string, rawJson: string): string {
  if (!rawJson) return "";
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
  } catch {
    return truncate(rawJson, 120);
  }
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const num = (key: string) => (typeof input[key] === "number" ? (input[key] as number) : null);

  switch (toolName) {
    case "bash":
    case "REPL":
    case "PowerShell":
      return `$ ${truncate(str("command"), 140)}`;
    case "read_file": {
      const limit = num("limit");
      const offset = num("offset");
      const range = offset || limit ? ` [${offset ?? 0}${limit ? ":+" + limit : ""}]` : "";
      return `${truncate(str("path"), 120)}${range}`;
    }
    case "write_file": {
      const content = str("content");
      return `${truncate(str("path"), 80)} (${humanBytes(content.length)})`;
    }
    case "edit_file":
      return truncate(str("path"), 100);
    case "glob_search":
      return truncate(str("pattern"), 100);
    case "grep_search": {
      const pat = truncate(str("pattern"), 80);
      const path = str("path") || str("file");
      return path ? `${pat} in ${truncate(path, 60)}` : pat;
    }
    case "WebFetch":
    case "WebSearch":
      return truncate(str("url") || str("query"), 120);
    case "Agent":
      return truncate(str("prompt") || str("description"), 120);
    case "TodoWrite": {
      const todos = (input.todos as unknown[]) ?? [];
      let done = 0;
      let active = 0;
      for (const item of todos) {
        if (item && typeof item === "object") {
          const s = (item as Record<string, unknown>).status;
          if (s === "completed") done += 1;
          else if (s === "in_progress") active += 1;
        }
      }
      const parts = [`${todos.length} todo${todos.length === 1 ? "" : "s"}`];
      if (done > 0) parts.push(`${done} done`);
      if (active > 0) parts.push(`${active} active`);
      return parts.join(" · ");
    }
    case "Skill":
      return truncate(str("skill") || str("name"), 80);
    case "NotebookEdit":
      return truncate(str("notebook_path") || str("path"), 100);
    case "Sleep":
      return `${num("seconds") ?? "?"}s`;
    default: {
      const first = Object.entries(input)[0];
      if (!first) return "";
      const [k, v] = first;
      return `${k}: ${truncate(typeof v === "string" ? v : JSON.stringify(v), 100)}`;
    }
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`;
  return `${(n / (1024 * 1024)).toFixed(1)}mb`;
}

function UsageRow({ usage }: { usage: TokenUsage }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        color: "var(--text-dim)",
        fontFamily: "var(--font-mono)",
        display: "flex",
        gap: 10,
      }}
    >
      <span>{usage.input_tokens} in</span>
      <span>{usage.output_tokens} out</span>
      {usage.cache_read_input_tokens > 0 && <span>{usage.cache_read_input_tokens} cache</span>}
    </div>
  );
}

function basename(p: string) {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
