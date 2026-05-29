import { useCallback, useEffect, useState } from "react";
import { fetchWorkspaceFile, fetchWorkspaceTree } from "../../api";
import type { WorkspaceEntry, WorkspaceFileResponse } from "../../types";
import { ChevronRightIcon, FileIcon, FolderIcon, RefreshIcon } from "../Icons";

interface Props {
  workspaceRoot: string | null;
}

export function FilesPanel({ workspaceRoot }: Props) {
  // Lazy-loaded children keyed by full path. `""` (root) seeds the tree.
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{
    path: string;
    data: WorkspaceFileResponse | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading((s) => new Set(s).add(dirPath));
    setError(null);
    try {
      const resp = await fetchWorkspaceTree(dirPath || undefined);
      if (!dirPath) setRootPath(resp.root);
      setChildren((c) => ({ ...c, [dirPath]: resp.entries }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading((s) => {
        const n = new Set(s);
        n.delete(dirPath);
        return n;
      });
    }
  }, []);

  // Reset and reload when workspace changes
  useEffect(() => {
    setChildren({});
    setExpanded(new Set([""]));
    setOpenFile(null);
    setError(null);
    if (workspaceRoot) loadDir("");
  }, [workspaceRoot, loadDir]);

  const toggleDir = useCallback(
    (e: WorkspaceEntry) => {
      const wasExpanded = expanded.has(e.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (wasExpanded) next.delete(e.path);
        else next.add(e.path);
        return next;
      });
      if (!wasExpanded && !children[e.path]) loadDir(e.path);
    },
    [expanded, children, loadDir],
  );

  const openFileAt = useCallback(async (path: string) => {
    setOpenFile({ path, data: null, loading: true, error: null });
    try {
      const data = await fetchWorkspaceFile(path);
      setOpenFile({ path, data, loading: false, error: null });
    } catch (err) {
      setOpenFile({ path, data: null, loading: false, error: (err as Error).message });
    }
  }, []);

  if (!workspaceRoot) {
    return (
      <EmptyState>
        No workspace set.
        <br />
        Pick a workspace from the left sidebar.
      </EmptyState>
    );
  }

  if (openFile) {
    return (
      <FileViewer
        path={openFile.path}
        data={openFile.data}
        loading={openFile.loading}
        error={openFile.error}
        onBack={() => setOpenFile(null)}
        onReload={() => openFileAt(openFile.path)}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          fontSize: 11,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <FolderIcon size={11} />
        <span
          title={rootPath ?? workspaceRoot}
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
          }}
        >
          {rootPath ?? workspaceRoot}
        </span>
        <button
          onClick={() => loadDir("")}
          title="Reload tree"
          style={{
            width: 22,
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            color: "var(--text-muted)",
          }}
          className="pi-row"
        >
          <RefreshIcon size={11} />
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--err-soft)",
            color: "var(--err)",
            borderBottom: "1px solid var(--err-border)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        <DirChildren
          dirPath=""
          depth={0}
          children={children}
          expanded={expanded}
          loading={loading}
          onToggle={toggleDir}
          onOpenFile={openFileAt}
        />
      </div>
    </div>
  );
}

function DirChildren({
  dirPath,
  depth,
  children,
  expanded,
  loading,
  onToggle,
  onOpenFile,
}: {
  dirPath: string;
  depth: number;
  children: Record<string, WorkspaceEntry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  onToggle: (e: WorkspaceEntry) => void;
  onOpenFile: (path: string) => void;
}) {
  const entries = children[dirPath];
  if (entries === undefined) {
    if (loading.has(dirPath)) {
      return (
        <div style={{ paddingLeft: 12 + depth * 14, padding: "4px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          <span className="pi-spin" style={{ marginRight: 6, width: 10, height: 10 }} /> loading…
        </div>
      );
    }
    return null;
  }
  if (entries.length === 0) {
    return (
      <div
        style={{
          paddingLeft: 12 + depth * 14,
          padding: "2px 12px 2px",
          fontSize: 11,
          color: "var(--text-dim)",
          fontStyle: "italic",
        }}
      >
        (empty)
      </div>
    );
  }
  // Directories first, alphabetical
  const sorted = [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return (
    <>
      {sorted.map((e) => (
        <EntryRow
          key={e.path}
          entry={e}
          depth={depth}
          expanded={expanded.has(e.path)}
          children={children}
          expandedSet={expanded}
          loadingSet={loading}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

function EntryRow({
  entry,
  depth,
  expanded,
  children,
  expandedSet,
  loadingSet,
  onToggle,
  onOpenFile,
}: {
  entry: WorkspaceEntry;
  depth: number;
  expanded: boolean;
  children: Record<string, WorkspaceEntry[]>;
  expandedSet: Set<string>;
  loadingSet: Set<string>;
  onToggle: (e: WorkspaceEntry) => void;
  onOpenFile: (path: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const isDir = entry.kind === "dir";
  return (
    <>
      <button
        onClick={() => (isDir ? onToggle(entry) : onOpenFile(entry.path))}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          width: "100%",
          paddingLeft: 8 + depth * 14,
          paddingRight: 10,
          height: 24,
          background: hover ? "var(--bg-hover)" : "transparent",
          color: "var(--text)",
          fontSize: 12,
          textAlign: "left",
          fontFamily: "var(--font-mono)",
        }}
      >
        {isDir ? (
          <ChevronRightIcon
            size={10}
            style={{
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 0.12s",
              color: "var(--text-dim)",
              flexShrink: 0,
            }}
          />
        ) : (
          <span style={{ width: 10, flexShrink: 0 }} />
        )}
        {isDir ? <FolderIcon size={12} style={{ color: "var(--accent-hover)", flexShrink: 0 }} /> : <FileIcon size={12} style={{ color: "var(--text-dim)", flexShrink: 0 }} />}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: isDir ? "var(--text)" : "var(--text-muted)",
          }}
        >
          {entry.name}
        </span>
        {entry.kind === "file" && entry.size !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>{humanBytes(entry.size)}</span>
        )}
      </button>
      {isDir && expanded && (
        <DirChildren
          dirPath={entry.path}
          depth={depth + 1}
          children={children}
          expanded={expandedSet}
          loading={loadingSet}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      )}
    </>
  );
}

function FileViewer({
  path,
  data,
  loading,
  error,
  onBack,
  onReload,
}: {
  path: string;
  data: WorkspaceFileResponse | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onReload: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(data.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          fontSize: 11,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <button
          onClick={onBack}
          title="Back to tree"
          style={{
            width: 22,
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            color: "var(--text-muted)",
          }}
          className="pi-row"
        >
          ‹
        </button>
        <span
          title={path}
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            direction: "rtl",
            color: "var(--text)",
          }}
        >
          {path}
        </span>
        {data && (
          <>
            <span>{humanBytes(data.size)}</span>
            {data.truncated && <span style={{ color: "var(--warn)" }}>truncated</span>}
            <button
              onClick={copy}
              title="Copy contents"
              style={{
                height: 22,
                padding: "0 8px",
                borderRadius: 4,
                color: copied ? "var(--ok)" : "var(--text-muted)",
                fontSize: 11,
              }}
              className="pi-row"
            >
              {copied ? "✓" : "copy"}
            </button>
          </>
        )}
        <button
          onClick={onReload}
          title="Reload"
          style={{
            width: 22,
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            color: "var(--text-muted)",
          }}
          className="pi-row"
        >
          <RefreshIcon size={11} />
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
        {loading && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>
            <span className="pi-spin" style={{ marginRight: 6 }} /> loading…
          </div>
        )}
        {error && (
          <div
            style={{
              margin: 12,
              padding: "8px 10px",
              background: "var(--err-soft)",
              border: "1px solid var(--err-border)",
              borderRadius: 6,
              color: "var(--err)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          >
            {error}
          </div>
        )}
        {data && data.binary && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontStyle: "italic", fontSize: 12 }}>
            (binary file — {humanBytes(data.size)})
          </div>
        )}
        {data && !data.binary && (
          <pre
            style={{
              margin: 0,
              padding: "10px 12px",
              fontSize: 12,
              lineHeight: 1.55,
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              whiteSpace: "pre",
            }}
          >
            {data.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "32px 16px",
        textAlign: "center",
        color: "var(--text-dim)",
        fontSize: 12.5,
      }}
    >
      {children}
    </div>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}
