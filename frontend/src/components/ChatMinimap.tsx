import { useEffect, useRef, useState } from "react";
import type { ConversationMessage } from "../types";

interface Props {
  messages: ConversationMessage[];
  scrollContainer: HTMLElement | null;
}

/** Thin minimap rail showing one dot per message. Click jumps the chat
 *  scroll container to the message at that position. */
export function ChatMinimap({ messages, scrollContainer }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [scrollFrac, setScrollFrac] = useState(0);
  const [viewportFrac, setViewportFrac] = useState(1);

  useEffect(() => {
    if (!scrollContainer) return;
    const update = () => {
      const max = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      setScrollFrac(max <= 0 ? 0 : scrollContainer.scrollTop / max);
      setViewportFrac(
        scrollContainer.scrollHeight <= 0
          ? 1
          : scrollContainer.clientHeight / scrollContainer.scrollHeight,
      );
    };
    update();
    scrollContainer.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scrollContainer);
    return () => {
      scrollContainer.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollContainer]);

  const handleClick = (e: React.MouseEvent) => {
    if (!scrollContainer || !railRef.current) return;
    const rect = railRef.current.getBoundingClientRect();
    const frac = (e.clientY - rect.top) / rect.height;
    const max = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    scrollContainer.scrollTo({ top: frac * max, behavior: "smooth" });
  };

  if (messages.length === 0) return null;

  return (
    <div
      ref={railRef}
      onClick={handleClick}
      style={{
        width: 30,
        flexShrink: 0,
        position: "relative",
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        cursor: "pointer",
      }}
    >
      {/* Viewport indicator */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${scrollFrac * (1 - viewportFrac) * 100}%`,
          height: `${viewportFrac * 100}%`,
          background: "rgba(249, 115, 22, 0.06)",
          borderTop: "1px solid rgba(249, 115, 22, 0.18)",
          borderBottom: "1px solid rgba(249, 115, 22, 0.18)",
          pointerEvents: "none",
        }}
      />
      {/* Dots */}
      {messages.map((m, i) => {
        const top = ((i + 0.5) / messages.length) * 100;
        const user = m.role === "user";
        return (
          <span
            key={i}
            title={`${m.role} #${i + 1}`}
            style={{
              position: "absolute",
              left: "50%",
              top: `${top}%`,
              transform: "translate(-50%, -50%)",
              width: user ? 8 : 6,
              height: user ? 8 : 6,
              borderRadius: user ? 2 : "50%",
              background: user ? "var(--accent)" : "var(--text-dim)",
              opacity: user ? 0.95 : 0.6,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}
