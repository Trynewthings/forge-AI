import { useEffect, useState } from "react";
import { patchConfig } from "../../api";
import type { ServerConfig, SessionSummarizerView } from "../../types";
import { ChevronRightIcon } from "../Icons";

interface SummarizerPreset {
  label: string;
  model: string;
  base_url?: string;
  max_tokens?: number;
}

const PRESETS: SummarizerPreset[] = [
  { label: "DeepSeek · chat", model: "deepseek-chat", base_url: "https://api.deepseek.com", max_tokens: 4000 },
  { label: "Claude · haiku", model: "claude-haiku-4-5", max_tokens: 4000 },
  { label: "GLM-4.6 (compat)", model: "openai-compat/GLM-4.6", base_url: "", max_tokens: 4000 },
];

/** Mirrors the RAG EmbeddingProviderForm shape but writes to
 *  `session_summarizer`. Sits inside the Config tab. */
export function SessionSummarizerForm({
  current,
  onConfigChange,
}: {
  current: SessionSummarizerView | null;
  onConfigChange: (cfg: ServerConfig) => void;
}) {
  const [open, setOpen] = useState<boolean>(!current);
  const [model, setModel] = useState(current?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(current?.base_url ?? "");
  const [maxTokens, setMaxTokens] = useState<string>(
    current?.max_tokens != null ? String(current.max_tokens) : "",
  );
  const [systemPrompt, setSystemPrompt] = useState<string>(current?.system_prompt ?? "");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setModel(current?.model ?? "");
    setBaseUrl(current?.base_url ?? "");
    setMaxTokens(current?.max_tokens != null ? String(current.max_tokens) : "");
    setSystemPrompt(current?.system_prompt ?? "");
  }, [current?.model, current?.base_url, current?.max_tokens, current?.system_prompt]);

  const applyPreset = (p: SummarizerPreset) => {
    setModel(p.model);
    if (p.base_url !== undefined) setBaseUrl(p.base_url);
    if (p.max_tokens !== undefined) setMaxTokens(String(p.max_tokens));
  };

  const save = async () => {
    setError(null);
    if (!model.trim()) return setError("Model is required.");
    const mt = maxTokens.trim();
    let parsedMt: number | null = null;
    if (mt) {
      const n = parseInt(mt, 10);
      if (!Number.isFinite(n) || n <= 0) return setError("Max tokens must be a positive integer.");
      parsedMt = n;
    }
    setSaving(true);
    try {
      const patch: import("../../types").SessionSummarizerPatch = {
        model: model.trim(),
        base_url: baseUrl.trim() ? baseUrl.trim() : null,
        max_tokens: parsedMt,
        system_prompt: systemPrompt.trim() ? systemPrompt : null,
      };
      // Only send api_key if user typed one — omitting it preserves the
      // existing key (vs sending "" which would clear it).
      if (apiKey.length > 0) patch.api_key = apiKey;
      const updated = await patchConfig({ session_summarizer: patch });
      onConfigChange(updated);
      setApiKey("");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!confirm("Clear the session summarizer? Absorb will fall back to the main chat model.")) return;
    setError(null);
    setClearing(true);
    try {
      const updated = await patchConfig({ session_summarizer: null });
      onConfigChange(updated);
      setApiKey("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearing(false);
    }
  };

  const statusColor = current?.configured ? "var(--ok)" : current ? "var(--warn)" : "var(--text-dim)";
  const statusLabel = current
    ? current.configured
      ? "configured"
      : "no api key (env fallback)"
    : "not set (uses main model)";

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 12px",
          textAlign: "left",
        }}
      >
        <ChevronRightIcon
          size={10}
          style={{
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
            color: "var(--text-dim)",
          }}
        />
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
          Session summarizer
        </span>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {statusLabel}
        </span>
        <span style={{ flex: 1 }} />
        {current && (
          <span
            style={{
              fontSize: 10.5,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={current.model}
          >
            {current.model}
          </span>
        )}
        {savedFlash && (
          <span style={{ fontSize: 10.5, color: "var(--ok)", fontFamily: "var(--font-mono)" }}>
            saved ✓
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            padding: "8px 12px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            background: "var(--bg)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Presets</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                title={`${p.model}${p.base_url ? " · " + p.base_url : ""}`}
                style={{
                  padding: "3px 8px",
                  fontSize: 10.5,
                  fontWeight: 500,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
                className="pi-row"
              >
                {p.label}
              </button>
            ))}
          </div>

          <FieldLabel>Model</FieldLabel>
          <SInput
            value={model}
            onChange={setModel}
            placeholder="deepseek-chat / claude-haiku-4-5 / openai-compat/<id>"
          />

          <FieldLabel>
            API key{" "}
            {current?.configured && (
              <span style={{ color: "var(--text-dim)" }}>(leave blank to keep existing)</span>
            )}
          </FieldLabel>
          <SInput
            value={apiKey}
            onChange={setApiKey}
            type="password"
            placeholder={current?.configured ? "•••••••• (set)" : "sk-... (or leave blank to use env var)"}
          />

          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 3 }}>
              <FieldLabel>Base URL (optional)</FieldLabel>
              <SInput
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder="https://api.deepseek.com (optional)"
              />
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
              <FieldLabel>Max tokens</FieldLabel>
              <SInput
                value={maxTokens}
                onChange={(v) => setMaxTokens(v.replace(/[^\d]/g, ""))}
                placeholder="4000"
              />
            </div>
          </div>

          <FieldLabel>System prompt (optional — overrides default template)</FieldLabel>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="(leave blank to use the built-in 5-section absorb template)"
            spellCheck={false}
            rows={4}
            style={{
              padding: "6px 8px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              lineHeight: 1.5,
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
            }}
          />

          {error && (
            <div
              style={{
                padding: "6px 8px",
                background: "var(--err-soft)",
                border: "1px solid var(--err-border)",
                borderRadius: 5,
                color: "var(--err)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button onClick={save} disabled={saving} style={btn("primary", saving)}>
              {saving ? "Saving…" : current ? "Update" : "Save"}
            </button>
            {current && (
              <button
                onClick={clear}
                disabled={clearing}
                style={btn("destructive", clearing)}
              >
                {clearing ? "Clearing…" : "Clear"}
              </button>
            )}
          </div>

          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>
            Used by cross-session <strong>Absorb</strong>: a cheap fast model condenses prior
            transcripts into a structured handoff that gets injected into the target
            session. Falls back to the main chat model when unset. Key is stored under{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>~/.claw/state.json</code>.
          </div>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 500 }}>
      {children}
    </div>
  );
}

function SInput({
  value,
  onChange,
  placeholder,
  type,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type ?? "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      style={{
        padding: "5px 8px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        color: "var(--text)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        outline: "none",
        width: "100%",
        boxSizing: "border-box",
      }}
    />
  );
}

function btn(kind: "primary" | "destructive", disabled: boolean): React.CSSProperties {
  const palette =
    kind === "primary"
      ? { bg: "var(--accent)", fg: "#0a0a0a", border: "var(--accent)" }
      : { bg: "var(--err-soft)", fg: "var(--err)", border: "var(--err-border)" };
  return {
    padding: "5px 12px",
    borderRadius: 5,
    fontSize: 11.5,
    fontWeight: 600,
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.border}`,
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
