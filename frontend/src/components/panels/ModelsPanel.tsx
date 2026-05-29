import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteProvider,
  fetchLiveModels,
  patchConfig,
  putProvider,
} from "../../api";
import type {
  LiveModel,
  ProviderSummary,
  ServerConfig,
} from "../../types";
import {
  ChevronRightIcon,
  CubeIcon,
  RefreshIcon,
} from "../Icons";

interface Props {
  config: ServerConfig | null;
  providers: ProviderSummary[];
  onConfigChange: (c: ServerConfig) => void;
  onProvidersChange: () => void;
}

const RECENT_MODELS_KEY = "claw.recent-models";
const RECENT_MODELS_CAP = 10;

function loadRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

function saveRecentModels(list: string[]) {
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(list));
  } catch {
    /* localStorage may be unavailable (private mode); silently skip */
  }
}

export function ModelsPanel({ config, providers, onConfigChange, onProvidersChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  // Editable buffer for the current-model field. Seeded from config and
  // re-synced when config.model changes externally (e.g. chip click) — so
  // proxies/gateways that don't expose `/models` can still be driven by
  // typing the id directly.
  const [modelDraft, setModelDraft] = useState(config?.model ?? "");
  const [savingModel, setSavingModel] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // Persisted list of model ids the user has Set in this browser. Lets
  // arbitrary OpenAI-compat / custom proxy ids stick around as quick-pick
  // chips even though no /models endpoint advertises them.
  const [recentModels, setRecentModels] = useState<string[]>(() => loadRecentModels());
  useEffect(() => {
    setModelDraft(config?.model ?? "");
  }, [config?.model]);

  // Backfill: the model that's active when the panel first mounts (e.g.
  // because state.json persisted it) should appear in Recent right away
  // — otherwise the user has no chip to switch back to after picking
  // something else.
  useEffect(() => {
    const active = config?.model;
    if (!active) return;
    setRecentModels((prev) => {
      if (prev.includes(active)) return prev;
      const next = [active, ...prev].slice(0, RECENT_MODELS_CAP);
      saveRecentModels(next);
      return next;
    });
  }, [config?.model]);

  const pushRecent = useCallback((modelId: string) => {
    setRecentModels((prev) => {
      const filtered = prev.filter((m) => m !== modelId);
      const next = [modelId, ...filtered].slice(0, RECENT_MODELS_CAP);
      saveRecentModels(next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((modelId: string) => {
    setRecentModels((prev) => {
      const next = prev.filter((m) => m !== modelId);
      saveRecentModels(next);
      return next;
    });
  }, []);

  const setActiveModel = useCallback(
    async (modelId: string | null) => {
      setError(null);
      setSavingModel(true);
      try {
        const updated = await patchConfig({ model: modelId });
        onConfigChange(updated);
        if (modelId) pushRecent(modelId);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1200);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSavingModel(false);
      }
    },
    [onConfigChange, pushRecent],
  );

  // Hide chips that already appear as a provider's known model — those
  // get rendered inside the ProviderRow below, so showing them up here
  // too would just duplicate. Custom / openai-compat ids that no
  // provider advertises stay in the Recent strip where they're useful.
  const knownProviderIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers) {
      for (const m of p.models) set.add(m);
    }
    return set;
  }, [providers]);
  const customRecents = useMemo(
    () => recentModels.filter((m) => !knownProviderIds.has(m)),
    [recentModels, knownProviderIds],
  );

  const draftTrimmed = modelDraft.trim();
  const draftDirty = draftTrimmed !== (config?.model ?? "");

  const submitDraft = () => {
    if (savingModel) return;
    setActiveModel(draftTrimmed === "" ? null : draftTrimmed);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Current model bar — editable. Type any id and Enter / Set to apply. */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 6,
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
            Current model
          </div>
          {savedFlash && (
            <span style={{ fontSize: 10.5, color: "var(--ok)", fontFamily: "var(--font-mono)" }}>saved ✓</span>
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            background: "var(--bg)",
            border: `1px solid ${draftDirty ? "var(--accent)" : "var(--accent-soft-border)"}`,
            borderRadius: 6,
            transition: "border-color 0.15s",
          }}
        >
          <CubeIcon size={12} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
          <input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitDraft();
              }
            }}
            placeholder="model id — type or pick a chip below"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: modelDraft ? "var(--text)" : "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
            }}
          />
          <button
            onClick={submitDraft}
            disabled={savingModel || !draftDirty}
            title={draftTrimmed === "" ? "Clear current model" : "Apply this model id"}
            style={{
              padding: "3px 10px",
              borderRadius: 5,
              fontSize: 11,
              fontWeight: 600,
              background: !draftDirty ? "var(--bg-hover)" : draftTrimmed === "" ? "var(--err-soft)" : "var(--accent)",
              color: !draftDirty ? "var(--text-dim)" : draftTrimmed === "" ? "var(--err)" : "#0a0a0a",
              border: `1px solid ${!draftDirty ? "var(--border)" : draftTrimmed === "" ? "var(--err-border)" : "var(--accent)"}`,
              opacity: savingModel ? 0.6 : 1,
              cursor: savingModel || !draftDirty ? "not-allowed" : "pointer",
              flexShrink: 0,
            }}
          >
            {savingModel ? "…" : draftTrimmed === "" ? "Clear" : "Set"}
          </button>
        </div>
        <div
          style={{
            marginTop: 5,
            fontSize: 10.5,
            color: "var(--text-dim)",
            lineHeight: 1.55,
          }}
        >
          Provider is inferred from the id prefix:{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>claude-* / opus / sonnet / haiku</code> → Anthropic,{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>deepseek*</code> → DeepSeek,{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>grok*</code> → xAI. For an{" "}
          <strong>OpenAI-compatible</strong> proxy you must type the literal id{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>openai-compatible</code> — the
          real upstream model is configured server-side via{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>OPENAI_COMPAT_*</code> env vars
          / provider credentials below. Any other unknown id falls back to Anthropic and
          will error if no Anthropic key is set.
        </div>
      </div>

      {customRecents.length > 0 && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-muted)",
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            Recently used ({customRecents.length})
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {customRecents.map((id) => (
              <RecentChip
                key={id}
                id={id}
                active={config?.model === id}
                onPick={() => setActiveModel(id)}
                onRemove={() => removeRecent(id)}
              />
            ))}
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            margin: "8px 12px 0",
            padding: "6px 10px",
            background: "var(--err-soft)",
            color: "var(--err)",
            border: "1px solid var(--err-border)",
            borderRadius: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto" }}>
        <div
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-muted)",
            fontWeight: 600,
            padding: "12px 16px 6px",
          }}
        >
          Providers ({providers.length})
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 12px 12px" }}>
          {providers.length === 0 && (
            <div style={{ padding: "16px", color: "var(--text-dim)", fontSize: 12.5, textAlign: "center" }}>
              No providers configured server-side.
            </div>
          )}
          {providers.map((p) => (
            <ProviderRow
              key={p.name}
              provider={p}
              activeModel={config?.model ?? null}
              onSetModel={setActiveModel}
              onSaveCreds={async (apiKey, baseUrl) => {
                await putProvider(p.name, { api_key: apiKey, base_url: baseUrl });
                onProvidersChange();
              }}
              onForget={async () => {
                await deleteProvider(p.name);
                onProvidersChange();
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  activeModel,
  onSetModel,
  onSaveCreds,
  onForget,
}: {
  provider: ProviderSummary;
  activeModel: string | null;
  onSetModel: (id: string) => void;
  onSaveCreds: (apiKey: string, baseUrl: string | null) => Promise<void>;
  onForget: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const [saving, setSaving] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveModels, setLiveModels] = useState<LiveModel[] | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  const knownModels = provider.models;

  const loadLive = useCallback(async () => {
    setLiveLoading(true);
    setLiveError(null);
    try {
      const r = await fetchLiveModels(provider.name);
      setLiveModels(r.models);
    } catch (err) {
      setLiveError((err as Error).message);
    } finally {
      setLiveLoading(false);
    }
  }, [provider.name]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSaveCreds(apiKey, baseUrl.trim() || null);
      setApiKey("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const forget = async () => {
    if (!confirm(`Forget credentials for ${provider.label}?`)) return;
    setForgetting(true);
    setError(null);
    try {
      await onForget();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setForgetting(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--bg-panel)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 10px",
          textAlign: "left",
        }}
      >
        <ChevronRightIcon
          size={10}
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s", color: "var(--text-dim)" }}
        />
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: provider.configured ? "var(--ok)" : "var(--text-dim)",
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{provider.label}</span>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {provider.name}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: "10px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Credentials */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <FieldLabel>API key {provider.configured ? "(replace)" : ""}</FieldLabel>
            <Input
              type="password"
              value={apiKey}
              onChange={setApiKey}
              placeholder={provider.configured ? "•••••••• (set)" : `set ${provider.env_keys.join(" / ") || "API key"}`}
            />
            <FieldLabel>Base URL</FieldLabel>
            <Input
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder={provider.default_base_url || "(default)"}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
              <button
                onClick={save}
                disabled={saving || (!apiKey && !provider.configured && !baseUrl.trim())}
                style={pillBtn({ primary: true, disabled: saving })}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              {provider.configured && (
                <button onClick={forget} disabled={forgetting} style={pillBtn({ destructive: true, disabled: forgetting })}>
                  {forgetting ? "Forgetting…" : "Forget"}
                </button>
              )}
            </div>
            {error && (
              <div style={{ color: "var(--err)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{error}</div>
            )}
          </div>

          {/* Known models */}
          {knownModels.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <FieldLabel>Models</FieldLabel>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {knownModels.map((m) => (
                  <ModelChip key={m} id={m} active={activeModel === m} onClick={() => onSetModel(m)} />
                ))}
              </div>
            </div>
          )}

          {/* Live models */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <FieldLabel>Live models from provider</FieldLabel>
              <button
                onClick={loadLive}
                disabled={liveLoading}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 6px",
                  borderRadius: 4,
                  fontSize: 10.5,
                  color: "var(--text-muted)",
                }}
                className="pi-row"
              >
                <RefreshIcon size={10} /> {liveLoading ? "fetching…" : liveModels ? "refresh" : "fetch"}
              </button>
            </div>
            {liveError && (
              <div style={{ color: "var(--err)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{liveError}</div>
            )}
            {liveModels && liveModels.length === 0 && (
              <div style={{ color: "var(--text-dim)", fontSize: 11, fontStyle: "italic" }}>(empty)</div>
            )}
            {liveModels && liveModels.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {liveModels.map((m) => (
                  <ModelChip
                    key={m.id}
                    id={m.id}
                    active={activeModel === m.id}
                    onClick={() => onSetModel(m.id)}
                    ctx={m.context_window}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RecentChip({
  id,
  active,
  onPick,
  onRemove,
}: {
  id: string;
  active: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        borderRadius: 5,
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--accent-soft)" : "var(--bg-panel)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={onPick}
        title={active ? `${id} (current)` : `Switch to ${id}`}
        style={{
          padding: "3px 8px",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: active ? "var(--accent-hover)" : "var(--text-muted)",
          fontWeight: active ? 600 : 500,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {id}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="Remove from recent"
        style={{
          padding: "0 6px",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "transparent",
          border: "none",
          borderLeft: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
          cursor: "pointer",
          opacity: 0.75,
        }}
      >
        ×
      </button>
    </span>
  );
}

function ModelChip({ id, active, onClick, ctx }: { id: string; active: boolean; onClick: () => void; ctx?: number | null }) {
  return (
    <button
      onClick={onClick}
      title={ctx ? `${id} · ${ctx.toLocaleString()} ctx` : id}
      style={{
        padding: "3px 8px",
        borderRadius: 5,
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--accent-soft)" : "var(--bg-panel)",
        color: active ? "var(--accent-hover)" : "var(--text-muted)",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        whiteSpace: "nowrap",
        fontWeight: active ? 600 : 500,
      }}
    >
      {id}
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 500 }}>{children}</div>
  );
}

function Input({
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
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      style={{
        padding: "6px 9px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        color: "var(--text)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        outline: "none",
      }}
    />
  );
}

function pillBtn({
  primary,
  destructive,
  disabled,
}: {
  primary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}): React.CSSProperties {
  const bg = destructive ? "var(--err-soft)" : primary ? "var(--accent)" : "var(--bg-panel)";
  const color = destructive ? "var(--err)" : primary ? "#0a0a0a" : "var(--text-muted)";
  const border = destructive ? "var(--err-border)" : primary ? "var(--accent)" : "var(--border)";
  return {
    padding: "5px 12px",
    borderRadius: 6,
    fontSize: 11.5,
    fontWeight: 600,
    background: bg,
    color,
    border: `1px solid ${border}`,
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
