import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { SendIcon, StopIcon, PaperclipIcon, CubeIcon, CloseIcon, BookIcon } from "./Icons";
import type { AttachmentRef, CommandSummary, LibrarySummary, TokenUsage } from "../types";
import { filterCommandsForPrefix } from "../slashCommands";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  streaming: boolean;
  disabled?: boolean;
  model: string | null;
  permissionMode: string;
  onOpenModelPicker: () => void;
  /** Attachments queued for the next send. */
  attachments: AttachmentRef[];
  onRemoveAttachment: (index: number) => void;
  /** OS file-picker (backend dialog). May error if the platform lacks GUI support. */
  onPickViaOs: () => Promise<void> | void;
  /** Browser `<input type=file>` upload — works headless too. */
  onUploadFromBrowser: (file: File) => Promise<void> | void;
  /** Image pasted from the clipboard (auto-uploaded). */
  onPasteImage: (file: File) => Promise<void> | void;
  /** Optional larger styling for the no-session hero placement. */
  hero?: boolean;
  /** Placeholder override. */
  placeholder?: string;
  /** Cumulative session tokens — drives the ctx budget badge. */
  cumulativeTokens?: number;
  /** Last `usage` event — `input_tokens` indicates current context fullness. */
  lastUsage?: TokenUsage | null;
  /** Per-session cap on cumulative tokens; null = unlimited. */
  maxSessionTokens?: number | null;
  /** Model's hard context window (from server config). Used as a denominator
   *  when no session budget is set. */
  contextWindow?: number | null;
  /** Known slash commands from /commands. When the input starts with `/`,
   *  a fuzzy-filtered popup over this list lets the user pick by name. */
  commands?: CommandSummary[];
  /** RAG library catalog for the popover next to the model button.
   *  Omit to hide the library picker entirely (e.g. hero mode). */
  libraries?: LibrarySummary[];
  attachedLibrary?: string | null;
  onAttachLibrary?: (library: string | null) => Promise<void> | void;
  /** Switch permission mode from the badge popover. Omit to make it
   *  read-only (e.g. hero-with-no-session can't change session-scoped
   *  config, though we still allow it since permission_mode is global). */
  onChangePermissionMode?: (mode: string) => Promise<void> | void;
}

export function ChatInput({
  value,
  onChange,
  onSend,
  onCancel,
  streaming,
  disabled,
  model,
  permissionMode,
  onOpenModelPicker,
  attachments,
  onRemoveAttachment,
  onPickViaOs,
  onUploadFromBrowser,
  onPasteImage,
  hero,
  placeholder,
  cumulativeTokens,
  lastUsage,
  maxSessionTokens,
  contextWindow,
  commands = [],
  libraries,
  attachedLibrary,
  onAttachLibrary,
  onChangePermissionMode,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [slashHighlight, setSlashHighlight] = useState(0);

  // Show the slash popup only while the user is typing the command name
  // (i.e. line starts with `/` and has no whitespace yet). Once they
  // type a space we assume they're filling in args and stop suggesting.
  const slashState = useMemo(() => {
    const m = value.match(/^\/(\S*)$/);
    if (!m) return null;
    const prefix = m[1];
    const matches = filterCommandsForPrefix(prefix, commands);
    if (matches.length === 0) return null;
    return { prefix, matches };
  }, [value, commands]);

  // Clamp highlight when results shrink as the user keeps typing.
  if (slashState && slashHighlight >= slashState.matches.length) {
    setTimeout(() => setSlashHighlight(0), 0);
  }
  // Reset to top when the popup closes so the next `/` press starts fresh.
  if (!slashState && slashHighlight !== 0) {
    setTimeout(() => setSlashHighlight(0), 0);
  }

  const acceptSlash = (name: string) => {
    onChange(`/${name} `);
    // Re-focus textarea so the user can keep typing args directly.
    setTimeout(() => taRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!attachMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!document.querySelector(".pi-attach-menu")?.contains(t)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [attachMenuOpen]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash autocomplete keyboard nav takes priority over send when the
    // popup is open. Escape dismisses (by clearing the field — the popup
    // closes automatically once it doesn't match the regex).
    if (slashState) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashHighlight((i) => (i + 1) % slashState.matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashHighlight((i) => (i - 1 + slashState.matches.length) % slashState.matches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        acceptSlash(slashState.matches[slashHighlight].name);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        acceptSlash(slashState.matches[slashHighlight].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onChange("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!streaming && (value.trim().length > 0 || attachments.length > 0)) onSend();
    }
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          setAttachError(null);
          try {
            await onPasteImage(file);
          } catch (err) {
            setAttachError(`paste failed: ${(err as Error).message}`);
          }
          break;
        }
      }
    }
  };

  const pickViaOs = async () => {
    setAttachMenuOpen(false);
    setAttachError(null);
    try {
      await onPickViaOs();
    } catch (err) {
      setAttachError((err as Error).message);
    }
  };

  const pickViaBrowser = () => {
    setAttachMenuOpen(false);
    fileInputRef.current?.click();
  };

  const onBrowserFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting same file
    if (!file) return;
    setAttachError(null);
    try {
      await onUploadFromBrowser(file);
    } catch (err) {
      setAttachError((err as Error).message);
    }
  };

  const empty = value.trim().length === 0 && attachments.length === 0;

  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: hero ? "0" : "0 16px 12px",
        width: hero ? "100%" : undefined,
        maxWidth: hero ? 720 : undefined,
        margin: hero ? "0 auto" : undefined,
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={onBrowserFile}
      />

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            marginBottom: 6,
          }}
        >
          {attachments.map((a, i) => (
            <span
              key={`${a.path}:${i}`}
              title={a.path}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--text-muted)",
                padding: "3px 4px 3px 8px",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                fontFamily: "var(--font-mono)",
              }}
            >
              <PaperclipIcon size={10} style={{ color: "var(--text-dim)" }} />
              <span style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {basename(a.path)}
              </span>
              <button
                onClick={() => onRemoveAttachment(i)}
                title="Remove"
                style={{
                  width: 16,
                  height: 16,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 3,
                  color: "var(--text-dim)",
                }}
                className="pi-row"
              >
                <CloseIcon size={8} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Slash autocomplete popup */}
      {slashState && (
        <div
          style={{
            position: "relative",
            marginBottom: 4,
          }}
        >
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              maxHeight: 220,
              overflowY: "auto",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 -4px 16px rgba(0,0,0,0.40)",
              padding: 4,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              zIndex: 30,
            }}
          >
            {slashState.matches.map((cmd, i) => {
              const active = i === slashHighlight;
              return (
                <button
                  key={cmd.name}
                  onMouseDown={(e) => {
                    // mousedown (not click) so textarea blur doesn't fire first.
                    e.preventDefault();
                    acceptSlash(cmd.name);
                  }}
                  onMouseEnter={() => setSlashHighlight(i)}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    padding: "6px 10px",
                    borderRadius: 5,
                    background: active ? "var(--bg-hover)" : "transparent",
                    color: "var(--text)",
                    textAlign: "left",
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontWeight: 600,
                      color: active ? "var(--accent-hover)" : "var(--text)",
                    }}
                  >
                    /{cmd.name}
                  </span>
                  {cmd.argument_hint && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                      {cmd.argument_hint}
                    </span>
                  )}
                  <span
                    style={{
                      flex: 1,
                      fontSize: 11,
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cmd.summary}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {cmd.category}
                  </span>
                </button>
              );
            })}
            <div
              style={{
                fontSize: 10,
                color: "var(--text-dim)",
                padding: "4px 8px",
                borderTop: "1px solid var(--border)",
                marginTop: 2,
                fontFamily: "var(--font-mono)",
              }}
            >
              ↑↓ navigate · Enter / Tab accept · Esc clear
            </div>
          </div>
        </div>
      )}

      {/* Pill container */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          background: "var(--bg)",
          border: streaming
            ? "1px solid var(--warn-border)"
            : focused
              ? "1px solid var(--accent-soft-border)"
              : "1px solid var(--border)",
          borderRadius: 14,
          padding: "10px 10px 10px 14px",
          boxShadow:
            "0 1px 2px rgba(0,0,0,0.30), 0 8px 24px -12px rgba(0,0,0,0.50)",
          transition: "border-color 0.15s, background 0.15s",
        }}
      >
        <textarea
          ref={taRef}
          value={value}
          placeholder={
            placeholder ??
            (streaming
              ? "Streaming… (cancel to interrupt)"
              : "Type a message — Enter to send, Shift+Enter for newline")
          }
          onChange={(e) => {
            onChange(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          rows={hero ? 2 : 1}
          disabled={disabled}
          style={{
            flex: 1,
            minHeight: hero ? 48 : 22,
            maxHeight: 200,
            fontSize: 14,
            lineHeight: 1.6,
            resize: "none",
            color: "var(--text)",
            background: "transparent",
            outline: "none",
            border: "none",
            fontFamily: "var(--font-sans)",
          }}
        />

        {streaming ? (
          <button
            onClick={onCancel}
            title="Cancel turn"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              height: 32,
              padding: "0 10px",
              background: "var(--err)",
              color: "#0a0a0a",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <StopIcon size={10} /> Stop
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={empty || disabled}
            title="Send (Enter)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              height: 32,
              padding: "0 14px",
              background: empty ? "var(--bg-hover)" : "var(--accent)",
              color: empty ? "var(--text-dim)" : "#0a0a0a",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              flexShrink: 0,
              boxShadow: empty ? "none" : "0 1px 3px rgba(249,115,22,0.35)",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            <SendIcon size={12} /> Send
          </button>
        )}
      </div>

      {attachError && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "var(--err)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {attachError}
        </div>
      )}

      {/* Control row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
          padding: "0 4px",
          position: "relative",
        }}
      >
        <div style={{ position: "relative" }} className="pi-attach-menu">
          <button
            onClick={() => setAttachMenuOpen((o) => !o)}
            title="Attach a file"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              height: 26,
              padding: "0 8px",
              color: attachMenuOpen ? "var(--accent-hover)" : "var(--text-muted)",
              background: attachMenuOpen ? "var(--bg-hover)" : "transparent",
              fontSize: 11,
              borderRadius: 6,
            }}
            className="pi-row"
          >
            <PaperclipIcon size={12} />
          </button>
          {attachMenuOpen && (
            <div
              style={{
                position: "absolute",
                bottom: "calc(100% + 4px)",
                left: 0,
                minWidth: 200,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 7,
                boxShadow:
                  "0 4px 16px rgba(0,0,0,0.45)",
                zIndex: 50,
                padding: 4,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <AttachMenuItem onClick={pickViaOs} title="OS file picker (native dialog)">
                Browse files (OS)
              </AttachMenuItem>
              <AttachMenuItem onClick={pickViaBrowser} title="Upload via browser">
                Upload from device
              </AttachMenuItem>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--text-dim)",
                  padding: "4px 8px",
                  borderTop: "1px solid var(--border)",
                  marginTop: 2,
                  fontFamily: "var(--font-mono)",
                }}
              >
                tip: paste images directly
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onOpenModelPicker}
          title="Switch model"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 26,
            padding: "0 10px",
            color: "var(--text-muted)",
            fontSize: 11,
            borderRadius: 6,
            fontFamily: "var(--font-mono)",
            maxWidth: 240,
          }}
          className="pi-row"
        >
          <CubeIcon size={11} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {model ?? "no model"}
          </span>
        </button>

        {libraries !== undefined && onAttachLibrary && (
          <LibraryButton
            libraries={libraries}
            attached={attachedLibrary ?? null}
            onAttach={onAttachLibrary}
          />
        )}

        <span style={{ flex: 1 }} />
        <CtxBadge
          cumulativeTokens={cumulativeTokens}
          lastUsage={lastUsage}
          maxSessionTokens={maxSessionTokens}
          contextWindow={contextWindow}
        />
        <ModeBadge mode={permissionMode} onChange={onChangePermissionMode} />
      </div>
    </div>
  );
}

function CtxBadge({
  cumulativeTokens,
  lastUsage,
  maxSessionTokens,
  contextWindow,
}: {
  cumulativeTokens?: number;
  lastUsage?: TokenUsage | null;
  maxSessionTokens?: number | null;
  contextWindow?: number | null;
}) {
  // Hide entirely when there's no session-level data to show — caller
  // (hero / no-session ChatInput) doesn't pass these props, and an
  // empty "ctx 0" badge is just noise.
  if (cumulativeTokens == null && !lastUsage) return null;

  // Best signal for "current context fullness" is the LAST input_tokens
  // (counts the full prompt sent to the model, including cached prefix).
  // Fall back to cumulative if no usage event yet.
  const ctx = lastUsage?.input_tokens ?? cumulativeTokens ?? 0;
  const cap = maxSessionTokens ?? contextWindow ?? null;
  const showCap = cap != null && cap > 0;
  const frac = showCap ? Math.min(1, ctx / cap!) : 0;
  // Threshold colors: <70% dim, 70–90% warn, >90% err.
  const color =
    !showCap || frac < 0.7
      ? "var(--text-dim)"
      : frac < 0.9
        ? "var(--warn)"
        : "var(--err)";
  const border =
    !showCap || frac < 0.7
      ? "var(--border)"
      : frac < 0.9
        ? "var(--warn-border)"
        : "var(--err-border)";
  const bg = !showCap || frac < 0.7 ? "var(--bg-subtle)" : frac < 0.9 ? "var(--warn-soft)" : "var(--err-soft)";

  const tooltipLines: string[] = [];
  if (lastUsage) {
    tooltipLines.push(`last turn input: ${lastUsage.input_tokens.toLocaleString()}`);
    tooltipLines.push(`last turn output: ${lastUsage.output_tokens.toLocaleString()}`);
    if (lastUsage.cache_read_input_tokens > 0)
      tooltipLines.push(`cache read: ${lastUsage.cache_read_input_tokens.toLocaleString()}`);
  }
  if (cumulativeTokens != null) {
    tooltipLines.push(`session cumulative: ${cumulativeTokens.toLocaleString()}`);
  }
  if (cap != null) {
    tooltipLines.push(`cap: ${cap.toLocaleString()} (${(frac * 100).toFixed(0)}%)`);
  } else {
    tooltipLines.push("no per-session cap configured");
  }

  return (
    <span
      title={tooltipLines.join("\n")}
      style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        padding: "2px 6px",
        borderRadius: 4,
        color,
        background: bg,
        border: `1px solid ${border}`,
      }}
    >
      ctx {formatTokens(ctx)}
      {showCap ? ` / ${formatTokens(cap!)}` : ""}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function AttachMenuItem({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        borderRadius: 5,
        fontSize: 12,
        color: "var(--text)",
      }}
      className="pi-row"
    >
      {children}
    </button>
  );
}

/** 5 permission modes the runtime understands. Kept in this fixed order
 *  because users tend to scan top→bottom and the natural progression is
 *  loosest → strictest (or vice versa, depending on direction). */
const PERMISSION_MODES: { id: string; label: string; description: string }[] = [
  { id: "read-only", label: "read-only", description: "Block any write/exec tool. Safe for exploration." },
  { id: "workspace-write", label: "workspace-write", description: "Allow edits inside workspace; prompt on shell." },
  { id: "danger-full-access", label: "danger-full-access", description: "Auto-allow everything including bash. Use with care." },
  { id: "prompt", label: "prompt", description: "Ask before any tool runs (slowest, safest)." },
  { id: "allow", label: "allow", description: "Auto-allow everything (alias of danger-full-access)." },
];

function ModeBadge({
  mode,
  onChange,
}: {
  mode: string;
  onChange?: (mode: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const danger = mode === "danger-full-access" || mode === "allow";
  const ro = mode === "read-only";
  const color = danger ? "var(--err)" : ro ? "var(--text-dim)" : "var(--accent-hover)";
  const background = danger
    ? "var(--err-soft)"
    : ro
      ? "var(--bg-subtle)"
      : "var(--accent-soft)";
  const border = danger
    ? "var(--err-border)"
    : ro
      ? "var(--border)"
      : "var(--accent-soft-border)";

  const choose = async (next: string) => {
    if (!onChange || next === mode) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await onChange(next);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const interactive = !!onChange;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => interactive && setOpen((v) => !v)}
        disabled={!interactive || busy}
        title={interactive ? "Click to change permission mode" : `Permission mode: ${mode}`}
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          padding: "2px 6px",
          borderRadius: 4,
          color,
          background,
          border: `1px solid ${border}`,
          cursor: interactive ? (busy ? "wait" : "pointer") : "default",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {mode}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            right: 0,
            minWidth: 280,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
            zIndex: 50,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              padding: "4px 8px",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            permission mode
          </div>
          {PERMISSION_MODES.map((opt) => {
            const active = opt.id === mode;
            const isDanger = opt.id === "danger-full-access" || opt.id === "allow";
            return (
              <button
                key={opt.id}
                onClick={() => void choose(opt.id)}
                disabled={busy}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  borderRadius: 5,
                  background: active ? "var(--bg-hover)" : "transparent",
                  color: "var(--text)",
                  cursor: busy ? "wait" : "pointer",
                }}
                className="pi-row"
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    fontWeight: active ? 600 : 500,
                    color: isDanger ? "var(--err)" : active ? "var(--accent-hover)" : "var(--text)",
                  }}
                >
                  {opt.label}
                  {active && (
                    <span style={{ marginLeft: "auto", color: "var(--accent)" }}>✓</span>
                  )}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>
                  {opt.description}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function basename(p: string) {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function LibraryButton({
  libraries,
  attached,
  onAttach,
}: {
  libraries: LibrarySummary[];
  attached: string | null;
  onAttach: (lib: string | null) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const choose = async (name: string | null) => {
    setBusy(true);
    try {
      await onAttach(name);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const isAttached = attached != null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={
          isAttached
            ? `RAG library attached: ${attached} — every turn retrieves top-5 chunks`
            : "Attach a RAG library to this session"
        }
        style={{
          // Always give the button a visible border/background even when
          // unattached — previously the no-library state used transparent
          // bg + muted text and was easy to miss next to the model chip.
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          padding: "0 10px",
          color: isAttached ? "var(--accent-hover)" : "var(--text-muted)",
          background: isAttached ? "var(--accent-soft)" : "var(--bg-subtle)",
          border: `1px solid ${
            isAttached ? "var(--accent-soft-border)" : "var(--border)"
          }`,
          fontSize: 11,
          borderRadius: 6,
          fontFamily: "var(--font-mono)",
          maxWidth: 200,
          opacity: busy ? 0.6 : 1,
          cursor: busy ? "not-allowed" : "pointer",
        }}
        className="pi-row"
      >
        <BookIcon size={11} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {attached ?? "RAG"}
        </span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            minWidth: 240,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
            zIndex: 50,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              padding: "4px 8px",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            knowledge libraries
          </div>
          <LibraryMenuItem
            active={!isAttached}
            onClick={() => void choose(null)}
          >
            <span style={{ color: "var(--text-dim)" }}>—</span>
            <span>(none)</span>
            {!isAttached && (
              <span style={{ marginLeft: "auto", color: "var(--accent)" }}>✓</span>
            )}
          </LibraryMenuItem>
          {libraries.length === 0 ? (
            <div
              style={{
                padding: "6px 10px",
                fontSize: 11,
                color: "var(--text-dim)",
                fontStyle: "italic",
              }}
            >
              no libraries — create one in the RAG tab
            </div>
          ) : (
            libraries.map((lib) => {
              const active = attached === lib.name;
              return (
                <LibraryMenuItem
                  key={lib.name}
                  active={active}
                  onClick={() => void choose(lib.name)}
                >
                  <span style={{ fontFamily: "var(--font-mono)" }}>{lib.name}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {lib.chunk_count}c
                  </span>
                  {active && (
                    <span style={{ color: "var(--accent)" }}>✓</span>
                  )}
                </LibraryMenuItem>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function LibraryMenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        borderRadius: 5,
        fontSize: 12,
        color: active ? "var(--text)" : "var(--text-muted)",
        background: active ? "var(--bg-hover)" : "transparent",
        fontWeight: active ? 600 : 400,
      }}
      className="pi-row"
    >
      {children}
    </button>
  );
}
