import { ChatInput } from "./ChatInput";
import { ForgeLogo } from "./Icons";
import type { AttachmentRef, LibrarySummary } from "../types";

interface Props {
  composer: string;
  onComposerChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  model: string | null;
  permissionMode: string;
  attachments: AttachmentRef[];
  onRemoveAttachment: (i: number) => void;
  onPickViaOs: () => Promise<void> | void;
  onUploadFromBrowser: (file: File) => Promise<void> | void;
  onPasteImage: (file: File) => Promise<void> | void;
  onOpenModelPicker: () => void;
  busy?: boolean;
  /** RAG library state. `attachedLibrary` is a "pending" choice here
   *  (no session exists yet) — AppShell records it and attaches it to
   *  the new session right after hero submit creates one. */
  libraries: LibrarySummary[];
  attachedLibrary: string | null;
  onAttachLibrary: (library: string | null) => Promise<void> | void;
  /** Permission mode is a global config so we can change it even before
   *  a session exists — patchConfig hits /config directly. */
  onChangePermissionMode: (mode: string) => Promise<void> | void;
}

/** Centered hero shown when no session is selected. Submitting the
 *  composer auto-creates a session and sends the first message. */
export function EmptyHero({
  composer,
  onComposerChange,
  onSubmit,
  disabled,
  model,
  permissionMode,
  attachments,
  onRemoveAttachment,
  onPickViaOs,
  onUploadFromBrowser,
  onPasteImage,
  onOpenModelPicker,
  busy,
  libraries,
  attachedLibrary,
  onAttachLibrary,
  onChangePermissionMode,
}: Props) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: "40px 24px",
        overflow: "auto",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <ForgeLogo size={56} />
        <div
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "var(--text)",
            letterSpacing: "-0.01em",
            fontFamily: "var(--font-mono)",
          }}
        >
          Forge.ai
        </div>
        <div
          style={{
            fontSize: 13.5,
            color: "var(--text-muted)",
            lineHeight: 1.55,
            textAlign: "center",
            maxWidth: 520,
          }}
        >
          Pair-program with me — type a prompt below and I&apos;ll spin up a
          new session for you.
        </div>
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 720,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
        }}
      >
        <ChatInput
          hero
          value={composer}
          onChange={onComposerChange}
          onSend={onSubmit}
          onCancel={() => {}}
          streaming={false}
          disabled={disabled || busy}
          model={model}
          permissionMode={permissionMode}
          onOpenModelPicker={onOpenModelPicker}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          onPickViaOs={onPickViaOs}
          onUploadFromBrowser={onUploadFromBrowser}
          onPasteImage={onPasteImage}
          placeholder={busy ? "Creating session…" : "Ask anything — Enter to send"}
          libraries={libraries}
          attachedLibrary={attachedLibrary}
          onAttachLibrary={onAttachLibrary}
          onChangePermissionMode={onChangePermissionMode}
        />
      </div>
    </div>
  );
}
