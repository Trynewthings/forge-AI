import { useCallback, useMemo, useState } from "react";
import {
  createSkill,
  deleteSkill,
  installFromSkillsSh,
  searchSkillsSh,
} from "../../api";
import type { SkillSummary } from "../../types";
import { PlusIcon, RefreshIcon, SparkleIcon } from "../Icons";

// Skills search now flows through the Rust backend's /skills/search
// route (pi-web's pattern — server-side proxy so the browser doesn't
// hit CORS). The "source" field returned by the backend is the upstream
// skills.sh base URL so we can link individual entries.

interface SkillsShEntry {
  /** Mapped from whatever shape skills.sh returns — kept loose since the
   * exact schema isn't documented. We display whatever fields show up. */
  name: string;
  /** Full skills.sh id (`source/name`), used to install via `npx skills add`. */
  id: string;
  description?: string | null;
  url?: string | null;
  installs?: number | null;
  tags?: string[];
  version?: string | null;
  raw: unknown;
}

type Mode = "installed" | "create" | "store";
export type InstallScope = "global" | "project";

interface Props {
  skills: SkillSummary[];
  workspaceRoot: string | null;
  onSkillsChange: () => void;
}

export function SkillsPanel({ skills, workspaceRoot, onSkillsChange }: Props) {
  const [mode, setMode] = useState<Mode>("installed");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <SubTabs mode={mode} onChange={setMode} installedCount={skills.length} />
      <div style={{ flex: 1, overflow: "auto" }}>
        {mode === "installed" && <InstalledList skills={skills} onChange={onSkillsChange} />}
        {mode === "create" && (
          <CreateForm
            onCreate={async (payload) => {
              await createSkill(payload);
              onSkillsChange();
              setMode("installed");
            }}
          />
        )}
        {mode === "store" && (
          <SkillsShSearch
            installedNames={skills.map((s) => s.name)}
            workspaceRoot={workspaceRoot}
            onInstalled={onSkillsChange}
          />
        )}
      </div>
    </div>
  );
}

function SubTabs({
  mode,
  onChange,
  installedCount,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  installedCount: number;
}) {
  const tabs: { id: Mode; label: string }[] = [
    { id: "installed", label: `Installed (${installedCount})` },
    { id: "create", label: "Create" },
    { id: "store", label: "Store" },
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

function InstalledList({ skills, onChange }: { skills: SkillSummary[]; onChange: () => void }) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.origin.toLowerCase().includes(q),
    );
  }, [filter, skills]);

  if (skills.length === 0) {
    return (
      <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-dim)", fontSize: 12.5 }}>
        No skills installed.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px" }}>
      <SearchInput value={filter} onChange={setFilter} placeholder="Filter…" />
      {filtered.map((s) => (
        <SkillRow key={`${s.origin}:${s.name}`} skill={s} onChange={onChange} />
      ))}
      {filtered.length === 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: 12, padding: 8, textAlign: "center" }}>
          No matches.
        </div>
      )}
    </div>
  );
}

function SkillRow({ skill, onChange }: { skill: SkillSummary; onChange: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!confirm(`Delete skill "${skill.name}"?`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteSkill(skill.name);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-panel)",
        opacity: skill.shadowed ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <SparkleIcon size={11} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12.5, color: "var(--text)" }}>
          {skill.name}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {skill.origin}
        </span>
        {skill.shadowed && (
          <span style={{ fontSize: 10, color: "var(--warn)", fontFamily: "var(--font-mono)" }}>shadowed</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={remove}
          disabled={deleting}
          title={`Uninstall ${skill.name} (${skill.origin})`}
          style={{
            fontSize: 10.5,
            color: "var(--err)",
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid var(--err-border)",
            background: "var(--err-soft)",
            opacity: deleting ? 0.6 : 1,
          }}
        >
          {deleting ? "…" : "uninstall"}
        </button>
      </div>
      {skill.description && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {skill.description}
        </div>
      )}
      <div
        style={{
          marginTop: 4,
          fontSize: 10.5,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          direction: "rtl",
        }}
        title={skill.path}
      >
        {skill.path}
      </div>
      {error && (
        <div style={{ marginTop: 4, color: "var(--err)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{error}</div>
      )}
    </div>
  );
}

function CreateForm({ onCreate }: { onCreate: (p: { name: string; description: string | null; prompt: string }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || null,
        prompt: prompt,
      });
      setName("");
      setDescription("");
      setPrompt("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 10 }}>
      <FieldLabel>Name</FieldLabel>
      <TextInput value={name} onChange={setName} placeholder="kebab-case-id" />
      <FieldLabel>Description (optional)</FieldLabel>
      <TextInput value={description} onChange={setDescription} placeholder="One-line summary shown in lists" />
      <FieldLabel>Prompt</FieldLabel>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Write the SKILL.md body — instructions for the agent when this skill is loaded."
        rows={10}
        style={{
          padding: "8px 10px",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--text)",
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          resize: "vertical",
          lineHeight: 1.55,
          minHeight: 140,
        }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={submit}
          disabled={!name.trim() || !prompt.trim() || saving}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            background: !name.trim() || !prompt.trim() ? "var(--bg-hover)" : "var(--accent)",
            color: !name.trim() || !prompt.trim() ? "var(--text-dim)" : "#0a0a0a",
            border: "1px solid var(--accent)",
            opacity: saving ? 0.7 : 1,
            cursor: !name.trim() || !prompt.trim() || saving ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "Creating…" : "Create skill"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          Writes to <code style={{ fontFamily: "var(--font-mono)" }}>~/.claw/skills/&lt;name&gt;/SKILL.md</code>
        </span>
      </div>
      {error && (
        <div
          style={{
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
    </div>
  );
}

function SkillsShSearch({
  installedNames,
  workspaceRoot,
  onInstalled,
}: {
  installedNames: string[];
  workspaceRoot: string | null;
  onInstalled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [results, setResults] = useState<SkillsShEntry[] | null>(null);
  const [sourceBase, setSourceBase] = useState<string>("https://skills.sh");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<InstallScope>("global");
  const installed = useMemo(() => new Set(installedNames), [installedNames]);
  // If workspace gets unset while user had picked project scope, revert to global.
  if (scope === "project" && !workspaceRoot && installedNames.length >= 0) {
    // direct setState in render is safe because this is conditional and idempotent
    // (subsequent renders see scope === "global" and skip).
    setTimeout(() => setScope("global"), 0);
  }

  const externalUrl = (q: string) =>
    q.trim() ? `${sourceBase}/?q=${encodeURIComponent(q.trim())}` : sourceBase;

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSubmitted(q);
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const data = (await searchSkillsSh(q, 50)) as {
        skills?: unknown[];
        results?: unknown[];
        source?: string;
      };
      if (typeof data?.source === "string") setSourceBase(data.source);
      setResults(normalizeSkillsSh(data));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
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
              search();
            }
          }}
          placeholder="Search skills.sh…"
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
          onClick={search}
          disabled={loading || !query.trim()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "5px 12px",
            height: 28,
            borderRadius: 5,
            fontSize: 11.5,
            fontWeight: 600,
            background: !query.trim() ? "var(--bg-hover)" : "var(--accent)",
            color: !query.trim() ? "var(--text-dim)" : "#0a0a0a",
            border: `1px solid ${!query.trim() ? "var(--border)" : "var(--accent)"}`,
            opacity: loading ? 0.6 : 1,
            cursor: loading || !query.trim() ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
        >
          {loading ? <span className="pi-spin" /> : <RefreshIcon size={11} />}
          {loading ? "" : "Search"}
        </button>
      </div>

      <ScopeToggle scope={scope} onChange={setScope} workspaceRoot={workspaceRoot} />

      <div
        style={{
          padding: "8px 12px",
          fontSize: 10.5,
          color: "var(--text-dim)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        Powered by{" "}
        <a href={sourceBase} target="_blank" rel="noreferrer">
          skills.sh
        </a>{" "}
        — proxied through the backend, no CORS dance required.
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
            lineHeight: 1.5,
          }}
        >
          {error}
          <div style={{ marginTop: 6 }}>
            <a
              href={externalUrl(submitted || query)}
              target="_blank"
              rel="noreferrer"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              Open skills.sh{submitted ? ` ?q=${submitted}` : ""} →
            </a>
          </div>
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
        {results === null && !loading && !error && (
          <div
            style={{
              padding: "32px 16px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 12.5,
            }}
          >
            Type a query and hit Enter to search skills.sh.
          </div>
        )}
        {results && results.length === 0 && (
          <div
            style={{
              padding: "20px 16px",
              textAlign: "center",
              color: "var(--text-dim)",
              fontSize: 12.5,
            }}
          >
            No results for &ldquo;{submitted}&rdquo;.
          </div>
        )}
        {results?.map((e) => (
          <SkillsShRow
            key={e.id}
            entry={e}
            isInstalled={installed.has(e.name)}
            scope={scope}
            workspaceRoot={workspaceRoot}
            onInstalled={onInstalled}
          />
        ))}
      </div>
    </div>
  );
}

function SkillsShRow({
  entry,
  isInstalled,
  scope,
  workspaceRoot,
  onInstalled,
}: {
  entry: SkillsShEntry;
  isInstalled: boolean;
  scope: InstallScope;
  workspaceRoot: string | null;
  onInstalled: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedLocally, setInstalledLocally] = useState(false);
  const showInstalled = isInstalled || installedLocally;
  const disabled = scope === "project" && !workspaceRoot;

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await installFromSkillsSh(entry.id, scope);
      setInstalledLocally(true);
      onInstalled();
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      style={{
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-panel)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <SparkleIcon size={11} style={{ color: "var(--accent-hover)", flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12.5 }}>{entry.name}</span>
        {entry.version && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            v{entry.version}
          </span>
        )}
        {typeof entry.installs === "number" && (
          <span
            style={{
              fontSize: 10,
              padding: "1px 5px",
              background: "var(--bg-hover)",
              borderRadius: 4,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {entry.installs.toLocaleString()} installs
          </span>
        )}
        <span style={{ flex: 1 }} />
        {entry.url && (
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 5,
              background: "var(--bg-hover)",
              color: "var(--text-muted)",
              fontWeight: 600,
            }}
          >
            view →
          </a>
        )}
        {showInstalled ? (
          <span
            style={{
              fontSize: 10.5,
              color: "var(--ok)",
              fontFamily: "var(--font-mono)",
              padding: "3px 8px",
              flexShrink: 0,
            }}
          >
            installed
          </span>
        ) : (
          <button
            onClick={install}
            disabled={installing || disabled}
            title={
              disabled
                ? "Pick a workspace before installing in project scope"
                : scope === "project"
                  ? `Install into ${workspaceRoot}/.claude/skills/`
                  : "Install into ~/.claude/skills/ (global)"
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 10px",
              borderRadius: 5,
              fontSize: 11,
              fontWeight: 600,
              background: disabled ? "var(--bg-hover)" : "var(--accent)",
              color: disabled ? "var(--text-dim)" : "#0a0a0a",
              border: `1px solid ${disabled ? "var(--border)" : "var(--accent)"}`,
              opacity: installing ? 0.6 : 1,
              cursor: installing ? "wait" : disabled ? "not-allowed" : "pointer",
              flexShrink: 0,
            }}
          >
            {installing ? "…" : <><PlusIcon size={10} /> Install · {scope === "project" ? "proj" : "global"}</>}
          </button>
        )}
      </div>
      {entry.description && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {entry.description}
        </div>
      )}
      {entry.tags && entry.tags.length > 0 && (
        <div style={{ marginTop: 5, display: "flex", flexWrap: "wrap", gap: 4 }}>
          {entry.tags.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 10,
                padding: "0 5px",
                background: "var(--bg-hover)",
                borderRadius: 3,
                color: "var(--text-dim)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {installError && (
        <pre
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "var(--err-soft)",
            border: "1px solid var(--err-border)",
            borderRadius: 5,
            color: "var(--err)",
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          {installError}
        </pre>
      )}
    </div>
  );
}

/** Upstream verified shape from skills.sh: `{ skills: [{ id, name,
 *  source, installs, skillId }] }`. `id` is the full unique path
 *  (`<source>/<name>`), `source` is the publishing repo. Backend also
 *  accepts `results`/`items`/`data` as alternatives in case skills.sh
 *  ever rotates the key. */
function normalizeSkillsSh(raw: unknown): SkillsShEntry[] {
  const bag = raw as Record<string, unknown> | undefined;
  const source = typeof bag?.source === "string" ? bag.source : "https://skills.sh";
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(bag?.skills)
      ? (bag!.skills as unknown[])
      : Array.isArray(bag?.results)
        ? (bag!.results as unknown[])
        : Array.isArray(bag?.items)
          ? (bag!.items as unknown[])
          : Array.isArray(bag?.data)
            ? (bag!.data as unknown[])
            : [];
  return list
    .map((it): SkillsShEntry | null => {
      if (!it || typeof it !== "object") return null;
      const o = it as Record<string, unknown>;
      const name = (o.name ?? o.package ?? o.id ?? o.slug) as string | undefined;
      if (!name || typeof name !== "string") return null;
      // Full unique path for the detail page; fall back to source-or-name.
      const fullId =
        (o.id as string | undefined) ??
        (o.slug as string | undefined) ??
        (o.source && typeof o.source === "string" ? `${o.source}/${name}` : name);
      const explicitUrl = (o.url ?? o.homepage ?? o.link) as string | null | undefined;
      const url = explicitUrl ?? (fullId ? `${source.replace(/\/$/, "")}/${fullId}` : null);
      return {
        name,
        id: fullId,
        description: (o.description ?? o.summary ?? null) as string | null,
        url,
        installs:
          typeof o.installs === "number"
            ? o.installs
            : typeof o.downloads === "number"
              ? o.downloads
              : null,
        tags: Array.isArray(o.tags) ? (o.tags as string[]).filter((t) => typeof t === "string") : [],
        version: (o.version ?? null) as string | null,
        raw: it,
      };
    })
    .filter((x): x is SkillsShEntry => x !== null)
    .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
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
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 500 }}>{children}</div>;
}

function ScopeToggle({
  scope,
  onChange,
  workspaceRoot,
}: {
  scope: InstallScope;
  onChange: (s: InstallScope) => void;
  workspaceRoot: string | null;
}) {
  const projectDisabled = !workspaceRoot;
  const tab = (id: InstallScope, label: string, hint: string, disabled = false) => {
    const active = scope === id;
    return (
      <button
        key={id}
        onClick={() => !disabled && onChange(id)}
        disabled={disabled}
        title={disabled ? "Pick a workspace first" : hint}
        style={{
          flex: 1,
          padding: "5px 8px",
          borderRadius: 5,
          fontSize: 11,
          fontWeight: 600,
          background: active ? "var(--bg)" : "transparent",
          color: disabled
            ? "var(--text-dim)"
            : active
              ? "var(--accent-hover)"
              : "var(--text-muted)",
          border: `1px solid ${active ? "var(--accent-soft-border)" : "transparent"}`,
          boxShadow: active ? "0 1px 2px rgba(0,0,0,0.2)" : "none",
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "background 0.1s, color 0.1s",
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 500 }}>
        Install scope
      </div>
      <div
        style={{
          display: "flex",
          gap: 3,
          padding: 3,
          background: "var(--bg-subtle)",
          borderRadius: 7,
          border: "1px solid var(--border)",
        }}
      >
        {tab("global", "Global", "~/.claude/skills/")}
        {tab(
          "project",
          "Workspace",
          workspaceRoot ? `${workspaceRoot}/.claude/skills/` : "",
          projectDisabled,
        )}
      </div>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          direction: "rtl",
        }}
      >
        {scope === "project" && workspaceRoot
          ? `${workspaceRoot}/.claude/skills/`
          : "~/.claude/skills/"}
      </div>
    </div>
  );
}
