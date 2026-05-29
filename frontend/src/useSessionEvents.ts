import { useEffect, useRef, useState } from "react";
import { sessionEventsUrl } from "./api";
import type { SessionEvent, SessionId } from "./types";

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

export interface SessionEventsState {
  events: SessionEvent[];
  /** Monotonic count of every event ever received on the current session.
   * Survives the MAX_EVENTS sliding-window slice, so consumers can use
   * `totalCount - prevTotalCount` as a stable cursor instead of array
   * indices (which silently break once the window starts dropping
   * head events on long-running turns). */
  totalCount: number;
  connection: ConnectionState;
  lastError: string | null;
}

const MAX_EVENTS = 500;

export function useSessionEvents(sessionId: SessionId | null): SessionEventsState {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setEvents([]);
    setTotalCount(0);
    setLastError(null);

    if (!sessionId) {
      setConnection("idle");
      return;
    }

    setConnection("connecting");
    const source = new EventSource(sessionEventsUrl(sessionId));
    sourceRef.current = source;

    const eventNames: SessionEvent["type"][] = [
      "session_snapshot",
      "turn_started",
      "user_message",
      "assistant_delta",
      "reasoning_delta",
      "assistant_message",
      "tool_use",
      "tool_result",
      "permission_request",
      "permission_decision",
      // AskUser flow — without these listeners the SSE arrives at the
      // browser but EventSource dispatches by name, so any unregistered
      // event is silently dropped. Skipping them broke AskUser end-to-end.
      "user_question",
      "user_answer",
      "usage",
      "error",
      "turn_finished",
      "turn_cancelled",
    ];

    const handler = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as SessionEvent;
        setEvents((prev) => {
          const next = prev.concat(parsed);
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
        });
        setTotalCount((c) => c + 1);
      } catch (error) {
        setLastError(`failed to parse event: ${(error as Error).message}`);
      }
    };

    eventNames.forEach((name) => source.addEventListener(name, handler as EventListener));

    source.onopen = () => {
      setConnection("open");
      setLastError(null);
    };
    source.onerror = () => {
      setConnection((current) => (current === "open" ? "error" : "error"));
    };

    return () => {
      eventNames.forEach((name) => source.removeEventListener(name, handler as EventListener));
      source.close();
      sourceRef.current = null;
      setConnection("closed");
    };
  }, [sessionId]);

  return { events, totalCount, connection, lastError };
}
