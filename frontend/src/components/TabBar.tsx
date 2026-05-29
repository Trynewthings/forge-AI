import type { ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

interface Props<T extends string> {
  tabs: TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  rightSlot?: ReactNode;
}

/** Right-pane tab strip — matches pi-web's 36px-tall header with
 *  active tab "rising" to the body background. */
export function TabBar<T extends string>({ tabs, active, onChange, rightSlot }: Props<T>) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 36,
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          overflowX: "auto",
          flex: 1,
        }}
      >
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 36,
                padding: "0 14px",
                background: isActive ? "var(--bg)" : "transparent",
                color: isActive ? "var(--text)" : "var(--text-muted)",
                fontSize: 12,
                fontWeight: isActive ? 600 : 500,
                borderRight: "1px solid var(--border)",
                borderTop: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
                marginTop: -1,
                whiteSpace: "nowrap",
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>
      {rightSlot && (
        <div style={{ display: "flex", alignItems: "center", padding: "0 10px" }}>{rightSlot}</div>
      )}
    </div>
  );
}
