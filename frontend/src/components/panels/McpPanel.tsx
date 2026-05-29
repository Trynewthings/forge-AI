import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteMcpServer,
  fetchRegistry,
  installFromRegistry,
  putMcpServer,
  setMcpServerEnabled,
} from "../../api";
import type {
  McpPresetUserInput,
  McpServerPayload,
  McpServerSummary,
  RegistryListingEntry,
} from "../../types";
import { ChevronRightIcon, PlugIcon, PlusIcon, RefreshIcon } from "../Icons";

interface Props {
  mcpServers: McpServerSummary[];
  onChange: () => void;
}

type Mode = "configured" | "registry";

export function McpPanel({ mcpServers, onChange }: Props) {
  const [mode, setMode] = useState<Mode>("configured");
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ModeTabs mode={mode} onChange={setMode} configuredCount={mcpServers.length} />
      {mode === "registry" ? (
        <RegistryBrowse
          configuredNames={mcpServers.map((s) => s.name)}
          onInstalled={onChange}
        />
      ) : (
        <ConfiguredServers
          mcpServers={mcpServers}
          onChange={onChange}
          addOpen={addOpen}
          setAddOpen={setAddOpen}
          error={error}
          setError={setError}
        />
      )}
    </div>
  );
}

function ModeTabs({
  mode,
  onChange,
  configuredCount,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  configuredCount: number;
}) {
  const tabs: { id: Mode; label: string }[] = [
    { id: "configured", label: `Configured (${configuredCount})` },
    { id: "registry", label: "Browse registry" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => {
        const active = t.id === mode;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: active ? "var(--accent-hover)" : "var(--text-muted)",
              background: active ? "var(--accent-soft)" : "transparent",
              border: `1px solid ${active ? "var(--accent-soft-border)" : "transparent"}`,
              transition: "background 0.1s",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function ConfiguredServers({
  mcpServers,
  onChange,
  addOpen,
  setAddOpen,
  error,
  setError,
}: {
  mcpServers: McpServerSummary[];
  onChange: () => void;
  addOpen: boolean;
  setAddOpen: (b: boolean) => void;
  error: string | null;
  setError: (msg: string | null) => void;
}) {
  return (
    <>
      {/* Header */}
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <PlugIcon size={12} style={{ color: "var(--text-muted)" }} />
        <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>
          MCP servers ({mcpServers.length})
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
        <button
          onClick={() => setAddOpen(!addOpen)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "0 10px",
            height: 26,
            borderRadius: 5,
            fontSize: 11.5,
            fontWeight: 600,
            background: addOpen ? "var(--bg-hover)" : "var(--accent)",
            color: addOpen ? "var(--text)" : "#0a0a0a",
            border: `1px solid ${addOpen ? "var(--border)" : "var(--accent)"}`,
          }}
        >
          <PlusIcon size={10} />
          {addOpen ? "Cancel" : "Add"}
        </button>
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
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {addOpen && (
          <ServerForm
            mode="create"
            initial={{ name: "", command: "", args: [], env: {} }}
            existingNames={mcpServers.map((s) => s.name)}
            onSubmit={async (name, payload) => {
              await putMcpServer(name, payload);
              setAddOpen(false);
              onChange();
            }}
            onCancel={() => setAddOpen(false)}
            onError={setError}
          />
        )}
        {mcpServers.length === 0 && !addOpen && (
          <div
            style={{
              padding: "32px 16px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 12.5,
            }}
          >
            No MCP servers configured. Click <strong>Add</strong> to register one.
          </div>
        )}
        {mcpServers.map((s) => (
          <ServerRow
            key={s.name}
            server={s}
            onError={setError}
            onToggle={async (enabled) => {
              await setMcpServerEnabled(s.name, enabled);
              onChange();
            }}
            onSave={async (payload) => {
              await putMcpServer(s.name, payload);
              onChange();
            }}
            onDelete={async () => {
              await deleteMcpServer(s.name);
              onChange();
            }}
          />
        ))}
      </div>
    </>
  );
}

function RegistryBrowse({
  configuredNames,
  onInstalled,
}: {
  configuredNames: string[];
  onInstalled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<RegistryListingEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [counts, setCounts] = useState<{ raw: number; installable: number } | null>(null);

  const load = useCallback(
    async (q: string, cursorArg?: string | null, append = false) => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetchRegistry(q || undefined, cursorArg ?? undefined);
        setEntries((prev) => (append ? [...prev, ...r.entries] : r.entries));
        setNextCursor(r.next_cursor ?? null);
        setCounts({ raw: r.raw_count, installable: r.installable_count });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial load on mount — same as pi-web's "powered by" registry.
  useEffect(() => {
    setSubmitted("");
    void load("", null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    setSubmitted(query.trim());
    void load(query.trim(), null, false);
  };

  const loadMore = () => {
    if (!nextCursor || loading) return;
    void load(submitted, nextCursor, true);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          gap: 6,
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Search MCP registry…"
          style={{
            flex: 1,
            padding: "6px 9px",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--text)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          onClick={submit}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 28,
            padding: "0 12px",
            background: "var(--accent)",
            color: "#0a0a0a",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            fontSize: 11.5,
            fontWeight: 600,
            opacity: loading ? 0.6 : 1,
            cursor: loading ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
        >
          {loading ? <span className="pi-spin" /> : <RefreshIcon size={11} />}
          {loading ? "" : "Search"}
        </button>
      </div>

      <div
        style={{
          padding: "8px 12px",
          fontSize: 10.5,
          color: "var(--text-dim)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        Listed from{" "}
        <a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noreferrer">
          registry.modelcontextprotocol.io
        </a>
        {counts && (
          <span style={{ marginLeft: 8 }}>
            · {counts.installable} installable / {counts.raw} total
          </span>
        )}
      </div>

      {error && (
        <div
          style={{
            margin: "10px 12px 0",
            padding: "8px 10px",
            background: "var(--err-soft)",
            border: "1px solid var(--err-border)",
            borderRadius: 6,
            color: "var(--err)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
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
        {entries.length === 0 && !loading && !error && (
          <div
            style={{
              padding: "20px 16px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 12.5,
            }}
          >
            {submitted ? `No matches for "${submitted}".` : "Registry is empty."}
          </div>
        )}
        {entries.map((e) => (
          <RegistryEntryRow
            key={e.registry_name + e.version}
            entry={e}
            configuredNames={configuredNames}
            onInstalled={onInstalled}
          />
        ))}
        {nextCursor && (
          <button
            onClick={loadMore}
            disabled={loading}
            style={{
              marginTop: 6,
              padding: "8px",
              borderRadius: 6,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              fontSize: 11.5,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}

function RegistryEntryRow({
  entry,
  configuredNames,
  onInstalled,
}: {
  entry: RegistryListingEntry;
  configuredNames: string[];
  onInstalled: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Default server_name to the short tail of the reverse-DNS id
  // (com.pulsemcp/slack → slack). Editable so users can disambiguate.
  const defaultServerName = useMemo(() => {
    const tail = entry.registry_name.split("/").pop() ?? entry.registry_name;
    return tail.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  }, [entry.registry_name]);
  const [serverName, setServerName] = useState(defaultServerName);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alreadyInstalled = configuredNames.includes(serverName);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installFromRegistry({
        registry_name: entry.registry_name,
        server_name: serverName.trim() || defaultServerName,
        inputs,
      });
      onInstalled();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling(false);
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
          alignItems: "flex-start",
          gap: 8,
          width: "100%",
          padding: "8px 10px",
          textAlign: "left",
        }}
      >
        <ChevronRightIcon
          size={10}
          style={{
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
            color: "var(--text-dim)",
            flexShrink: 0,
            marginTop: 3,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
              {entry.display_name}
            </span>
            {entry.version && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                v{entry.version}
              </span>
            )}
            {entry.category && (
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 5px",
                  background: "var(--bg-hover)",
                  borderRadius: 4,
                  color: "var(--text-muted)",
                }}
              >
                {entry.category}
              </span>
            )}
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 11,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.registry_name}
          </div>
          {entry.description && (
            <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {entry.description}
            </div>
          )}
        </div>
        {alreadyInstalled ? (
          <span
            style={{
              fontSize: 10.5,
              color: "var(--ok)",
              fontFamily: "var(--font-mono)",
              flexShrink: 0,
              alignSelf: "center",
            }}
          >
            installed
          </span>
        ) : (
          <span
            role="button"
            tabIndex={0}
            onClick={async (e) => {
              e.stopPropagation();
              if (entry.user_inputs.length > 0 || installing) {
                setOpen(true);
                return;
              }
              await install();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                (e.currentTarget as HTMLElement).click();
              }
            }}
            title={
              entry.user_inputs.length > 0
                ? "Configure inputs before installing"
                : "Install with defaults"
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              borderRadius: 5,
              fontSize: 11,
              fontWeight: 600,
              background: entry.user_inputs.length > 0 ? "var(--bg-hover)" : "var(--accent)",
              color: entry.user_inputs.length > 0 ? "var(--text)" : "#0a0a0a",
              border: `1px solid ${entry.user_inputs.length > 0 ? "var(--border)" : "var(--accent)"}`,
              flexShrink: 0,
              alignSelf: "center",
              opacity: installing ? 0.6 : 1,
              cursor: installing ? "wait" : "pointer",
            }}
          >
            {installing ? "…" : entry.user_inputs.length > 0 ? "Configure" : <><PlusIcon size={10} /> Install</>}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            padding: 10,
            borderTop: "1px solid var(--border)",
            background: "var(--bg)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {entry.command_hint && (
            <div>
              <SubLabel>Command hint</SubLabel>
              <pre
                style={{
                  margin: 0,
                  padding: "6px 8px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {entry.command_hint}
              </pre>
            </div>
          )}

          <div>
            <SubLabel>Local server name</SubLabel>
            <input
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder={defaultServerName}
              spellCheck={false}
              style={{
                width: "100%",
                padding: "5px 8px",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                color: "var(--text)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {entry.user_inputs.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <SubLabel>User inputs</SubLabel>
              {entry.user_inputs.map((inp) => (
                <UserInputField
                  key={inp.name}
                  input={inp}
                  value={inputs[inp.name] ?? ""}
                  onChange={(v) => setInputs((prev) => ({ ...prev, [inp.name]: v }))}
                />
              ))}
            </div>
          )}

          {entry.prerequisites.length > 0 && (
            <div>
              <SubLabel>Prerequisites</SubLabel>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-muted)",
                }}
              >
                {entry.prerequisites.map((p) => (
                  <div key={p.binary}>
                    {p.binary}
                    {p.min_version ? ` >= ${p.min_version}` : ""}
                    {p.install_hint && (
                      <span style={{ color: "var(--text-dim)" }}> — {p.install_hint}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {entry.homepage && (
            <a
              href={entry.homepage}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11.5 }}
            >
              {entry.homepage}
            </a>
          )}

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

          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={install}
              disabled={installing || !serverName.trim()}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                background: installing || !serverName.trim() ? "var(--bg-hover)" : "var(--accent)",
                color: installing || !serverName.trim() ? "var(--text-dim)" : "#0a0a0a",
                border: `1px solid ${installing || !serverName.trim() ? "var(--border)" : "var(--accent)"}`,
                cursor: installing || !serverName.trim() ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              {installing ? "Installing…" : <><PlusIcon size={10} /> Install</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function UserInputField({
  input,
  value,
  onChange,
}: {
  input: McpPresetUserInput;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = input.input_type;
  const isSecret = t.kind === "secret";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {input.label}
        {input.required && <span style={{ color: "var(--accent)" }}> *</span>}
        {input.env_key && (
          <span
            style={{ marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}
          >
            {input.env_key}
          </span>
        )}
      </div>
      {t.kind === "choice" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            padding: "5px 8px",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            outline: "none",
          }}
        >
          <option value="">(pick one)</option>
          {t.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={isSecret ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            t.kind === "text" && t.placeholder
              ? t.placeholder
              : t.kind === "secret"
                ? "••••••••"
                : t.kind === "path"
                  ? "/path"
                  : t.kind === "url"
                    ? "https://…"
                    : ""
          }
          spellCheck={false}
          style={{
            width: "100%",
            padding: "5px 8px",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      )}
      {input.help && (
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>{input.help}</div>
      )}
    </div>
  );
}

function ServerRow({
  server,
  onToggle,
  onSave,
  onDelete,
  onError,
}: {
  server: McpServerSummary;
  onToggle: (enabled: boolean) => Promise<void>;
  onSave: (payload: McpServerPayload) => Promise<void>;
  onDelete: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const statusColor =
    server.discovery_status === "ready"
      ? "var(--ok)"
      : server.discovery_status === "discovering"
        ? "var(--warn)"
        : server.discovery_status === "failed"
          ? "var(--err)"
          : "var(--text-dim)";

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setToggling(true);
    onError(null);
    try {
      await onToggle(!server.enabled);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete MCP server "${server.name}"?`)) return;
    setDeleting(true);
    onError(null);
    try {
      await onDelete();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--bg-panel)",
        overflow: "hidden",
        opacity: server.enabled ? 1 : 0.6,
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
          style={{
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.12s",
            color: "var(--text-dim)",
            flexShrink: 0,
          }}
        />
        <span
          title={server.discovery_status}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: statusColor,
            flexShrink: 0,
            boxShadow:
              server.discovery_status === "discovering"
                ? "0 0 6px var(--warn)"
                : "none",
            animation:
              server.discovery_status === "discovering"
                ? "pi-blink 1.2s ease-in-out infinite"
                : "none",
          }}
        />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
          {server.name}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
          {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
        </span>
        <span style={{ flex: 1 }} />
        <ToggleSwitch enabled={server.enabled} busy={toggling} onClick={handleToggle} />
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
          {/* Command summary */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <FieldLabel>Command</FieldLabel>
            <pre
              style={{
                margin: 0,
                padding: "6px 8px",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {server.command} {server.args.join(" ")}
            </pre>
          </div>

          {Object.keys(server.env).length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <FieldLabel>Environment</FieldLabel>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "6px 8px",
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                }}
              >
                {Object.entries(server.env).map(([k, v]) => (
                  <div key={k} style={{ color: "var(--text-muted)" }}>
                    <span style={{ color: "var(--accent-hover)" }}>{k}</span>=
                    <span>{redactSecret(k, v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {server.tools.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <FieldLabel>Tools ({server.tools.length})</FieldLabel>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                }}
              >
                {server.tools.map((t) => (
                  <span
                    key={t.raw_name}
                    title={t.description ?? undefined}
                    style={{
                      fontSize: 10.5,
                      padding: "2px 6px",
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {editing ? (
            <ServerForm
              mode="edit"
              initial={{ name: server.name, command: server.command, args: server.args, env: server.env }}
              existingNames={[]}
              onSubmit={async (_name, payload) => {
                onError(null);
                try {
                  await onSave(payload);
                  setEditing(false);
                } catch (err) {
                  onError((err as Error).message);
                }
              }}
              onCancel={() => setEditing(false)}
              onError={onError}
            />
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setEditing(true)}
                style={smallBtn({ kind: "default" })}
              >
                Edit
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={smallBtn({ kind: "destructive", disabled: deleting })}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ServerForm({
  mode,
  initial,
  existingNames,
  onSubmit,
  onCancel,
  onError,
}: {
  mode: "create" | "edit";
  initial: { name: string; command: string; args: string[]; env: Record<string, string> };
  existingNames: string[];
  onSubmit: (name: string, payload: McpServerPayload) => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [argsText, setArgsText] = useState(initial.args.join("\n"));
  const [envText, setEnvText] = useState(
    Object.entries(initial.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [saving, setSaving] = useState(false);

  const submit = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return onError("Name is required.");
    if (mode === "create" && existingNames.includes(trimmedName)) {
      return onError(`A server named "${trimmedName}" already exists.`);
    }
    if (!command.trim()) return onError("Command is required.");

    const args = argsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of envText.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq < 0) return onError(`Env line must be KEY=VALUE: ${t}`);
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1);
      if (!k) return onError(`Empty env key in line: ${t}`);
      env[k] = v;
    }

    setSaving(true);
    onError(null);
    try {
      await onSubmit(trimmedName, { command: command.trim(), args, env });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [name, command, argsText, envText, mode, existingNames, onSubmit, onError]);

  return (
    <div
      style={{
        padding: 10,
        border: "1px solid var(--accent-soft-border)",
        background: "var(--accent-soft)",
        borderRadius: 7,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <FieldLabel>{mode === "create" ? "New MCP server" : "Edit server"}</FieldLabel>
      <div>
        <SubLabel>Name</SubLabel>
        <TextInput
          value={name}
          onChange={setName}
          placeholder="server-name"
          disabled={mode === "edit"}
        />
      </div>
      <div>
        <SubLabel>Command</SubLabel>
        <TextInput value={command} onChange={setCommand} placeholder="npx" />
      </div>
      <div>
        <SubLabel>Args (one per line)</SubLabel>
        <TextArea
          value={argsText}
          onChange={setArgsText}
          rows={3}
          placeholder={"-y\n@modelcontextprotocol/server-everything"}
        />
      </div>
      <div>
        <SubLabel>Env (KEY=VALUE per line)</SubLabel>
        <TextArea value={envText} onChange={setEnvText} rows={3} placeholder="API_KEY=…" />
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
        <button
          onClick={submit}
          disabled={saving}
          style={smallBtn({ kind: "primary", disabled: saving })}
        >
          {saving ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
        <button onClick={onCancel} style={smallBtn({ kind: "default" })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ToggleSwitch({
  enabled,
  busy,
  onClick,
}: {
  enabled: boolean;
  busy: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={enabled ? "Disable" : "Enable"}
      style={{
        width: 30,
        height: 16,
        borderRadius: 8,
        background: enabled ? "var(--accent)" : "var(--bg-hover)",
        border: `1px solid ${enabled ? "var(--accent)" : "var(--border-strong)"}`,
        position: "relative",
        padding: 0,
        cursor: busy ? "wait" : "pointer",
        opacity: busy ? 0.6 : 1,
        transition: "background 0.15s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: enabled ? 15 : 1,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: enabled ? "#0a0a0a" : "var(--text-dim)",
          transition: "left 0.15s",
        }}
      />
    </button>
  );
}

function redactSecret(key: string, value: string): string {
  if (/key|token|secret|password|pat/i.test(key)) {
    return value.length > 0 ? "•".repeat(Math.min(value.length, 8)) : "";
  }
  return value;
}

function smallBtn({
  kind,
  disabled,
}: {
  kind: "primary" | "destructive" | "default";
  disabled?: boolean;
}): React.CSSProperties {
  const map = {
    primary: { bg: "var(--accent)", fg: "#0a0a0a", border: "var(--accent)" },
    destructive: { bg: "var(--err-soft)", fg: "var(--err)", border: "var(--err-border)" },
    default: { bg: "var(--bg-panel)", fg: "var(--text-muted)", border: "var(--border)" },
  } as const;
  const m = map[kind];
  return {
    padding: "5px 12px",
    borderRadius: 6,
    fontSize: 11.5,
    fontWeight: 600,
    background: m.bg,
    color: m.fg,
    border: `1px solid ${m.border}`,
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--text-muted)",
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>{children}</div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      style={{
        width: "100%",
        padding: "5px 8px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        color: disabled ? "var(--text-dim)" : "var(--text)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        outline: "none",
        boxSizing: "border-box",
      }}
    />
  );
}

function TextArea({
  value,
  onChange,
  rows,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows ?? 3}
      placeholder={placeholder}
      spellCheck={false}
      style={{
        width: "100%",
        padding: "6px 8px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        color: "var(--text)",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        outline: "none",
        boxSizing: "border-box",
        resize: "vertical",
        lineHeight: 1.5,
      }}
    />
  );
}
