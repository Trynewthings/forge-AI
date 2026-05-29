import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachSessionLibrary,
  createLibrary,
  deleteLibrary,
  ingestLibrary,
  patchConfig,
} from "../../api";
import type {
  EmbeddingProviderView,
  LibrarySummary,
  ServerConfig,
  SessionId,
} from "../../types";
import { ChevronRightIcon, PlusIcon, RefreshIcon, FileIcon } from "../Icons";

interface Props {
  libraries: LibrarySummary[];
  attachedLibrary: string | null;
  activeSessionId: SessionId | null;
  embeddingProvider: EmbeddingProviderView | null;
  onChange: () => void;
  onAttachedChange: (lib: string | null) => void;
  onConfigChange: (cfg: ServerConfig) => void;
}

export function RagPanel({
  libraries,
  attachedLibrary,
  activeSessionId,
  embeddingProvider,
  onChange,
  onAttachedChange,
  onConfigChange,
}: Props) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const n = newName.trim();
    if (!n) return;
    setCreating(true);
    setError(null);
    try {
      await createLibrary(n);
      setNewName("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <EmbeddingProviderForm
        current={embeddingProvider}
        onConfigChange={onConfigChange}
      />

      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>
            RAG libraries ({libraries.length})
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={onChange}
            title="Refresh"
            style={{
              width: 26,
              height: 26,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 5,
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              background: "var(--bg)",
            }}
            className="pi-row"
          >
            <RefreshIcon size={11} />
          </button>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="new library name"
            spellCheck={false}
            style={{
              flex: 1,
              padding: "5px 8px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
          />
          <button
            onClick={create}
            disabled={creating || !newName.trim()}
            title="Create empty library"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "0 10px",
              height: 28,
              borderRadius: 5,
              fontSize: 11.5,
              fontWeight: 600,
              background: !newName.trim() ? "var(--bg-hover)" : "var(--accent)",
              color: !newName.trim() ? "var(--text-dim)" : "#0a0a0a",
              border: `1px solid ${!newName.trim() ? "var(--border)" : "var(--accent)"}`,
              opacity: creating ? 0.6 : 1,
              cursor: !newName.trim() || creating ? "not-allowed" : "pointer",
              flexShrink: 0,
            }}
          >
            <PlusIcon size={10} /> New
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            margin: "8px 12px 0",
            padding: "6px 10px",
            background: "var(--err-soft)",
            border: "1px solid var(--err-border)",
            borderRadius: 6,
            color: "var(--err)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 12px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {libraries.length === 0 ? (
          <div
            style={{
              padding: "24px 12px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 12.5,
            }}
          >
            No libraries yet. Create one above to start ingesting.
          </div>
        ) : (
          libraries.map((lib) => (
            <LibraryRow
              key={lib.name}
              lib={lib}
              isAttached={attachedLibrary === lib.name}
              activeSessionId={activeSessionId}
              onError={setError}
              onChange={onChange}
              onAttachedChange={onAttachedChange}
            />
          ))
        )}
      </div>
    </div>
  );
}

function LibraryRow({
  lib,
  isAttached,
  activeSessionId,
  onError,
  onChange,
  onAttachedChange,
}: {
  lib: LibrarySummary;
  isAttached: boolean;
  activeSessionId: SessionId | null;
  onError: (msg: string | null) => void;
  onChange: () => void;
  onAttachedChange: (lib: string | null) => void;
}) {
  const [ingesting, setIngesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleIngest = useCallback(
    async (file: File) => {
      setIngesting(true);
      onError(null);
      try {
        await ingestLibrary(lib.name, file);
        onChange();
      } catch (err) {
        onError((err as Error).message);
      } finally {
        setIngesting(false);
      }
    },
    [lib.name, onChange, onError],
  );

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) void handleIngest(f);
  };

  const handleDelete = async () => {
    if (!confirm(`Delete library "${lib.name}"? All ingested chunks will be lost.`)) return;
    setDeleting(true);
    onError(null);
    try {
      await deleteLibrary(lib.name);
      if (isAttached) onAttachedChange(null);
      onChange();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const toggleAttach = async () => {
    if (!activeSessionId) return;
    setAttaching(true);
    onError(null);
    try {
      const target = isAttached ? null : lib.name;
      const r = await attachSessionLibrary(activeSessionId, target);
      onAttachedChange(r.library ?? null);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setAttaching(false);
    }
  };

  return (
    <div
      style={{
        padding: "8px 10px",
        border: `1px solid ${isAttached ? "var(--accent-soft-border)" : "var(--border)"}`,
        background: isAttached ? "var(--accent-soft)" : "var(--bg-panel)",
        borderRadius: 7,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={onPickFile} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <FileIcon size={12} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12.5 }}>{lib.name}</span>
        {isAttached && (
          <span
            style={{
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 4,
              background: "var(--accent)",
              color: "#0a0a0a",
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.04em",
            }}
          >
            ATTACHED
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {lib.chunk_count} chunks · {humanBytes(lib.size_bytes)}
        </span>
      </div>

      {lib.sources.length > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>
          {lib.sources.slice(0, 4).map((s, i) => (
            <span key={i} style={{ display: "inline-block", marginRight: 6 }}>
              {basename(s)}
            </span>
          ))}
          {lib.sources.length > 4 && <span>+ {lib.sources.length - 4} more</span>}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={ingesting}
          style={btn({ kind: "default", disabled: ingesting })}
        >
          {ingesting ? "Ingesting…" : "+ Ingest file"}
        </button>
        {activeSessionId && (
          <button
            onClick={toggleAttach}
            disabled={attaching}
            title={isAttached ? "Detach from this session" : "Attach to this session"}
            style={btn({
              kind: isAttached ? "destructive" : "primary",
              disabled: attaching,
            })}
          >
            {attaching ? "…" : isAttached ? "Detach" : "Attach to session"}
          </button>
        )}
        <button
          onClick={handleDelete}
          disabled={deleting}
          style={btn({ kind: "destructive", disabled: deleting })}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function btn({
  kind,
  disabled,
}: {
  kind: "primary" | "destructive" | "default";
  disabled?: boolean;
}): React.CSSProperties {
  const map = {
    primary: { bg: "var(--accent)", fg: "#0a0a0a", border: "var(--accent)" },
    destructive: { bg: "var(--err-soft)", fg: "var(--err)", border: "var(--err-border)" },
    default: { bg: "var(--bg)", fg: "var(--text-muted)", border: "var(--border)" },
  } as const;
  const m = map[kind];
  return {
    padding: "4px 10px",
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    background: m.bg,
    color: m.fg,
    border: `1px solid ${m.border}`,
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

// ─── Embedding provider form ────────────────────────────────────────

interface EmbeddingPreset {
  label: string;
  base_url: string;
  model: string;
  dimensions: number;
}

const EMBEDDING_PRESETS: EmbeddingPreset[] = [
  {
    label: "OpenAI · 3-small",
    base_url: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  {
    label: "OpenAI · 3-large",
    base_url: "https://api.openai.com/v1",
    model: "text-embedding-3-large",
    dimensions: 3072,
  },
  {
    label: "DashScope · v4",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v4",
    dimensions: 1024,
  },
  {
    label: "Voyage · 3",
    base_url: "https://api.voyageai.com/v1",
    model: "voyage-3",
    dimensions: 1024,
  },
];

function EmbeddingProviderForm({
  current,
  onConfigChange,
}: {
  current: EmbeddingProviderView | null;
  onConfigChange: (cfg: ServerConfig) => void;
}) {
  const [open, setOpen] = useState<boolean>(!current);
  const [baseUrl, setBaseUrl] = useState(current?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(current?.model ?? "");
  const [dimensions, setDimensions] = useState<string>(
    current?.dimensions ? String(current.dimensions) : "",
  );
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Re-sync when the parent supplies an updated `current` (e.g. after
  // a successful patch elsewhere). We don't clobber a half-typed api_key.
  useEffect(() => {
    setBaseUrl(current?.base_url ?? "");
    setModel(current?.model ?? "");
    setDimensions(current?.dimensions ? String(current.dimensions) : "");
  }, [current?.base_url, current?.model, current?.dimensions]);

  const applyPreset = (p: EmbeddingPreset) => {
    setBaseUrl(p.base_url);
    setModel(p.model);
    setDimensions(String(p.dimensions));
  };

  const save = async () => {
    setError(null);
    const dim = parseInt(dimensions.trim(), 10);
    if (!baseUrl.trim()) return setError("Base URL is required.");
    if (!model.trim()) return setError("Model is required.");
    if (!Number.isFinite(dim) || dim <= 0) return setError("Dimensions must be a positive integer.");
    if (!current?.configured && !apiKey.trim()) {
      return setError("API key is required for first-time setup.");
    }
    setSaving(true);
    try {
      const updated = await patchConfig({
        embedding_provider: {
          base_url: baseUrl.trim(),
          api_key: apiKey,
          model: model.trim(),
          dimensions: dim,
        },
      });
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
    if (!confirm("Clear the embedding provider? Existing libraries will fail to retrieve until you reconfigure.")) return;
    setError(null);
    setClearing(true);
    try {
      const updated = await patchConfig({ embedding_provider: null });
      onConfigChange(updated);
      setApiKey("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearing(false);
    }
  };

  const statusColor = current?.configured ? "var(--ok)" : "var(--warn)";
  const statusLabel = current
    ? current.configured
      ? "configured"
      : "no api key"
    : "not set";

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
          Embedding provider
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
            title={`${current.model} · ${current.dimensions}d`}
          >
            {current.model} · {current.dimensions}d
          </span>
        )}
        {savedFlash && (
          <span style={{ fontSize: 10.5, color: "var(--ok)", fontFamily: "var(--font-mono)" }}>saved ✓</span>
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
            {EMBEDDING_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                title={`${p.base_url} · ${p.model} · ${p.dimensions}d`}
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

          <FieldLabel>Base URL</FieldLabel>
          <EmbedInput
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://api.openai.com/v1"
          />

          <FieldLabel>
            API key {current?.configured && <span style={{ color: "var(--text-dim)" }}>(leave blank to keep existing)</span>}
          </FieldLabel>
          <EmbedInput
            value={apiKey}
            onChange={setApiKey}
            type="password"
            placeholder={current?.configured ? "•••••••• (set)" : "sk-..."}
          />

          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 3 }}>
              <FieldLabel>Model</FieldLabel>
              <EmbedInput
                value={model}
                onChange={setModel}
                placeholder="text-embedding-3-small"
              />
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
              <FieldLabel>Dimensions</FieldLabel>
              <EmbedInput
                value={dimensions}
                onChange={(v) => setDimensions(v.replace(/[^\d]/g, ""))}
                placeholder="1536"
              />
            </div>
          </div>

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
            <button
              onClick={save}
              disabled={saving}
              style={btn({ kind: "primary", disabled: saving })}
            >
              {saving ? "Saving…" : current ? "Update" : "Save"}
            </button>
            {current && (
              <button
                onClick={clear}
                disabled={clearing}
                style={btn({ kind: "destructive", disabled: clearing })}
              >
                {clearing ? "Clearing…" : "Clear"}
              </button>
            )}
          </div>

          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>
            Dimensions must match what the library store was created with —
            switching after ingest may require deleting existing libraries.
            The api key is stored on disk under <code style={{ fontFamily: "var(--font-mono)" }}>~/.claw/state.json</code> alongside provider creds.
          </div>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 500 }}>{children}</div>
  );
}

function EmbedInput({
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
