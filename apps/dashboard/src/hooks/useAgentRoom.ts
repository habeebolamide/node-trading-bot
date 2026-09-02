import { useEffect, useRef, useState } from 'react';

export interface RoomEvent {
  type: string;
  eventTime: string;
  source: string;
  payload: unknown;
}
export interface RoomHello { kind: 'hello'; now: string }
export type RoomFrame = RoomEvent | RoomHello;

/**
 * Subscribe to /ws/agent-room. Ring-buffered on the client (default 200 events) so a long-lived
 * tab doesn't accumulate unbounded memory. Auto-reconnects with backoff on close.
 *
 * WS URL derives from the current origin — dev-server proxy handles /ws in vite.config.ts.
 */
export function useAgentRoom({ limit = 200 }: { limit?: number } = {}) {
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/agent-room`);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); attemptRef.current = 0; };
      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        const attempt = ++attemptRef.current;
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (msg) => {
        try {
          const frame = JSON.parse(String(msg.data)) as RoomFrame;
          if ('kind' in frame) return; // hello — ignore
          setEvents((prev) => {
            const next = [frame, ...prev];
            return next.length > limit ? next.slice(0, limit) : next;
          });
        } catch { /* skip malformed */ }
      };
    };
    connect();
    return () => { cancelled = true; wsRef.current?.close(); };
  }, [limit]);

  return { events, connected };
}
