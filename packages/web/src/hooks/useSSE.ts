import { useState, useEffect, useRef } from "react";

/**
 * SSE hook. Connects to a URL, listens for events, returns accumulated lines.
 * Reconnects on URL change. Closes on unmount.
 */
export function useSSE(
  url: string | null,
  eventName: string = "log",
): { lines: string[]; connected: boolean; done: boolean } {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!url) {
      setLines([]);
      setConnected(false);
      setDone(false);
      return;
    }

    setLines([]);
    setDone(false);

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener(eventName, (e) => {
      setLines((prev) => [...prev, e.data]);
    });

    source.addEventListener("done", () => {
      setDone(true);
      source.close();
      setConnected(false);
    });

    source.addEventListener("error", (e) => {
      if (e instanceof MessageEvent) {
        setLines((prev) => [...prev, `[ERROR] ${e.data}`]);
      }
      setDone(true);
      source.close();
      setConnected(false);
    });

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [url, eventName]);

  return { lines, connected, done };
}
