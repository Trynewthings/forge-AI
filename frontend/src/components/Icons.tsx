/* Inline SVG icons — no external icon library, matching pi-web's approach.
   All icons use currentColor so caller controls hue via CSS color. */

import type { CSSProperties } from "react";

interface IconProps {
  size?: number;
  style?: CSSProperties;
  strokeWidth?: number;
}

function base(size: number, strokeWidth: number, children: React.ReactNode, style?: CSSProperties) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = ({ size = 14, style, strokeWidth = 2 }: IconProps) =>
  base(size, strokeWidth, <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>, style);

export const RefreshIcon = ({ size = 13, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></>, style);

export const SendIcon = ({ size = 14, style, strokeWidth = 2 }: IconProps) =>
  base(size, strokeWidth, <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>, style);

export const StopIcon = ({ size = 12, style }: IconProps) =>
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;

export const ChevronRightIcon = ({ size = 12, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <polyline points="9 18 15 12 9 6" />, style);

export const ChevronDownIcon = ({ size = 12, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <polyline points="6 9 12 15 18 9" />, style);

export const CloseIcon = ({ size = 10, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>, style);

export const PaperclipIcon = ({ size = 14, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />, style);

export const BranchIcon = ({ size = 13, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 01-9 9" /></>, style);

export const FileIcon = ({ size = 13, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></>, style);

export const FolderIcon = ({ size = 13, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />, style);

export const SettingsIcon = ({ size = 14, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></>, style);

export const ToolsIcon = ({ size = 14, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />, style);

export const CubeIcon = ({ size = 14, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></>, style);

export const SparkleIcon = ({ size = 14, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" /></>, style);

export const PlugIcon = ({ size = 13, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><path d="M9 2v6" /><path d="M15 2v6" /><path d="M5 8h14v3a7 7 0 01-14 0z" /><path d="M12 18v4" /></>, style);

export const BookIcon = ({ size = 13, style, strokeWidth = 1.8 }: IconProps) =>
  base(
    size,
    strokeWidth,
    <>
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </>,
    style,
  );

export const CopyIcon = ({ size = 11, style, strokeWidth = 1.8 }: IconProps) =>
  base(size, strokeWidth, <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>, style);

/** Forge.ai logo — a stylised anvil silhouette with a spark, evoking
 *  "forge" (the agent hammers things into shape). Uses currentColor on
 *  the spark for accent, dark fill for the anvil body. Sized for both
 *  the sidebar header (~20) and the hero state (~48). */
export const ForgeLogo = ({
  size = 20,
  style,
}: {
  size?: number;
  style?: CSSProperties;
}) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: size,
      height: size,
      borderRadius: size > 32 ? 12 : 5,
      background: "var(--accent)",
      color: "#0a0a0a",
      ...style,
    }}
    aria-label="Forge.ai"
  >
    <svg
      width={size * 0.62}
      height={size * 0.62}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* anvil body — flat top, tapered base */}
      <path d="M3 9h14l-2 4H5z" fill="currentColor" />
      {/* horn on the right */}
      <path d="M17 9c2 0 4 1 4 3" />
      {/* base / stand */}
      <path d="M8 13v3M12 13v3M7 17h10" strokeWidth={2.2} />
      {/* spark above the anvil */}
      <path d="M12 3l1.2 2.6L16 6.5l-2.4 1.4L12 11l-1.2-3.1L8 6.5l2.8-0.9z" fill="currentColor" />
    </svg>
  </span>
);

/** @deprecated — use ForgeLogo. Kept around briefly so any forgotten
 *  imports don't break the build during the rebrand sweep. Remove after
 *  one cleanup pass. */
export const PiLogo = ForgeLogo;
