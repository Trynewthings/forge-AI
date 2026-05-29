import { compactSession } from "./api";
import type {
  CommandSummary,
  ServerConfig,
  SessionId,
  TokenUsage,
} from "./types";

/** Parse `/<name> [args]` from the composer input. Returns null if the
 *  text doesn't start with `/`, otherwise the command name and the rest
 *  of the line (which may be empty). */
export function parseSlash(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const match = rest.match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  return { name: match[1], args: match[2] };
}

/** Commands that need an async backend call to resolve. The placeholder
 *  system bubble shows "Running /xxx…" until the call finishes. */
export function isAsyncLocalCommand(name: string, args: string): boolean {
  if (name === "compact") return true;
  if (name === "model") return true;
  if (name === "clear") return true;
  // /permissions becomes async only when a mode argument is given —
  // without args it just prints the current mode (synchronous render).
  if (name === "permissions" && args.trim().length > 0) return true;
  return false;
}

/** State the local-command runners need from AppShell (current session,
 *  config, etc.). Kept narrow so the helpers stay stateless. */
export interface LocalCtx {
  sessionId: SessionId;
  cumulativeTokens: number;
  lastUsage: TokenUsage | null;
  model: string | null;
  permissionMode: string;
  workspaceRoot: string | null;
  attachedLibrary: string | null;
  messageCount: number;
  contextWindow: number;
  maxSessionTokens: number | null;
  patchConfig: (patch: import("./api").ServerConfigPatch) => Promise<ServerConfig>;
  /** AppShell-supplied session creator. We don't call the raw
   *  `createSession()` from api here because the UX requires inheriting
   *  per-session attachments (MCP servers, RAG library) from the
   *  currently-active session, which only AppShell knows about. */
  createSession: () => Promise<SessionId>;
  /** Called by /clear after the new session is created so the UI can
   *  switch to it. The system-bubble text returned is what gets shown
   *  in the OLD session (briefly, since we switch right away). */
  switchSession: (newId: SessionId) => void;
}

const PERMISSION_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
  "prompt",
  "allow",
] as const;

/** Execute a local async command. Returns the final system-bubble text. */
export async function runAsyncLocalCommand(
  match: CommandSummary,
  args: string,
  ctx: LocalCtx,
): Promise<string> {
  if (match.name === "compact") {
    try {
      const r = await compactSession(ctx.sessionId);
      const before = formatTokenCount(r.before_tokens);
      const after = formatTokenCount(r.after_tokens);
      if (r.removed_message_count === 0) {
        return `/compact: nothing to compact (kept ${r.kept_message_count} messages, est. ${before} tokens).`;
      }
      return `/compact: compacted ${r.removed_message_count} messages → kept ${r.kept_message_count}. Est. tokens ${before} → ${after}.`;
    } catch (err) {
      return `/compact failed: ${(err as Error).message}`;
    }
  }
  if (match.name === "model") {
    const target = args.trim();
    if (!target) return "/model: type `/model <name>` to switch, or open the Models tab on the right to pick from chips.";
    try {
      const updated = await ctx.patchConfig({ model: target });
      return `/model: switched to \`${updated.model}\` (ctx ${formatTokenCount(updated.context_window)}).`;
    } catch (err) {
      return `/model failed: ${(err as Error).message}`;
    }
  }
  if (match.name === "clear") {
    try {
      // Goes through AppShell's createInheritingSession so the new
      // session keeps the current MCP attachments + RAG library.
      // workspace_root + model are inherited via global config.
      const newId = await ctx.createSession();
      ctx.switchSession(newId);
      return `/clear: started fresh session \`${newId}\` (workspace, model, MCPs, RAG library inherited) — switching now.`;
    } catch (err) {
      return `/clear failed: ${(err as Error).message}`;
    }
  }
  if (match.name === "permissions") {
    const target = args.trim();
    if (!PERMISSION_MODES.includes(target as (typeof PERMISSION_MODES)[number])) {
      return `/permissions: unknown mode \`${target}\`. Valid: ${PERMISSION_MODES.join(" | ")}.`;
    }
    try {
      const updated = await ctx.patchConfig({ permission_mode: target });
      return `/permissions: switched to \`${updated.permission_mode}\`.`;
    } catch (err) {
      return `/permissions failed: ${(err as Error).message}`;
    }
  }
  return `/${match.name}: not yet implemented`;
}

/** Render the sync system bubble for a local command. */
export function renderLocalCommand(
  match: CommandSummary,
  args: string,
  all: CommandSummary[],
  ctx: LocalCtx,
): string {
  if (match.name === "help") return renderHelp(all);
  if (match.name === "status") return renderStatus(ctx);
  if (match.name === "cost") return renderCost(ctx);
  if (match.name === "permissions") return renderPermissionsStatus(ctx);
  if (match.name === "resume") return renderResumeHint(args);
  const argSuffix = args ? ` (args: ${args})` : "";
  return `/${match.name}${argSuffix}: not yet implemented locally`;
}

function renderHelp(all: CommandSummary[]): string {
  const byCategory = new Map<string, CommandSummary[]>();
  for (const c of all) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  const sections: string[] = ["Available slash commands:"];
  for (const [cat, list] of byCategory) {
    sections.push("");
    sections.push(`${cat}:`);
    for (const c of list) {
      const hint = c.argument_hint ? ` ${c.argument_hint}` : "";
      sections.push(`  /${c.name}${hint}  —  ${c.summary}`);
    }
  }
  return sections.join("\n");
}

function renderStatus(ctx: LocalCtx): string {
  const ctxFill = ctx.lastUsage?.input_tokens ?? ctx.cumulativeTokens;
  const cap = ctx.maxSessionTokens ?? ctx.contextWindow;
  const pct = cap > 0 ? Math.round((ctxFill / cap) * 100) : 0;
  const capLabel = cap > 0 ? `${formatTokenCount(cap)} (${pct}%)` : "—";
  const lines = [
    "Session status:",
    `  session     ${ctx.sessionId}`,
    `  model       ${ctx.model ?? "(none)"}`,
    `  mode        ${ctx.permissionMode}`,
    `  workspace   ${ctx.workspaceRoot ?? "(not set)"}`,
    `  library     ${ctx.attachedLibrary ?? "(not attached)"}`,
    `  messages    ${ctx.messageCount}`,
    `  ctx         ${formatTokenCount(ctxFill)} / ${capLabel}`,
  ];
  return lines.join("\n");
}

function renderCost(ctx: LocalCtx): string {
  const usage = ctx.lastUsage;
  const lines: string[] = ["Token usage:"];
  lines.push(`  cumulative   ${formatTokenCount(ctx.cumulativeTokens)}`);
  if (usage) {
    lines.push(`  last turn:`);
    lines.push(`    input      ${formatTokenCount(usage.input_tokens)}`);
    lines.push(`    output     ${formatTokenCount(usage.output_tokens)}`);
    if (usage.cache_read_input_tokens > 0) {
      lines.push(`    cache hit  ${formatTokenCount(usage.cache_read_input_tokens)}`);
    }
    if (usage.cache_creation_input_tokens > 0) {
      lines.push(`    cache write ${formatTokenCount(usage.cache_creation_input_tokens)}`);
    }
  } else {
    lines.push(`  last turn    (no usage event yet)`);
  }
  if (ctx.maxSessionTokens != null && ctx.maxSessionTokens > 0) {
    const remaining = Math.max(0, ctx.maxSessionTokens - ctx.cumulativeTokens);
    lines.push(`  budget cap   ${formatTokenCount(ctx.maxSessionTokens)} (${formatTokenCount(remaining)} left)`);
  } else {
    lines.push(`  budget cap   (none — set max_session_tokens in Config to enforce)`);
  }
  return lines.join("\n");
}

function renderPermissionsStatus(ctx: LocalCtx): string {
  const list = PERMISSION_MODES.map((m) => (m === ctx.permissionMode ? `• ${m} ←` : `  ${m}`)).join("\n");
  return [
    `Permission mode: \`${ctx.permissionMode}\``,
    "",
    "Available modes (type `/permissions <mode>` to switch):",
    list,
  ].join("\n");
}

function renderResumeHint(args: string): string {
  if (args.trim()) {
    return `/resume \`${args.trim()}\` is a CLI-only command (loads a .jsonl file). In the web UI, click any session in the left sidebar to switch to it.`;
  }
  return "/resume is a CLI-only command in this build. Pick a session from the left sidebar to switch instead.";
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value}`;
}

/** Lightweight filter used by the autocomplete popup in ChatInput. */
export function filterCommandsForPrefix(
  prefix: string,
  commands: CommandSummary[],
): CommandSummary[] {
  const q = prefix.toLowerCase();
  if (!q) return commands.slice(0, 12);
  return commands
    .filter((c) => {
      if (c.name.toLowerCase().startsWith(q)) return true;
      if (c.aliases.some((a) => a.toLowerCase().startsWith(q))) return true;
      return false;
    })
    .slice(0, 12);
}

export { fetchCommands } from "./api";
