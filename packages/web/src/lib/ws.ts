type EventHandler = (event: string, payload: unknown) => void;

export function createGatewaySocket(onEvent: EventHandler): { close: () => void } {
  const wsUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`
      : "ws://127.0.0.1:7777/ws";

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect() {
    if (closed) return;
    ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data.event, data.payload);
      } catch {
        // ignore malformed messages
      }
    };
    ws.onclose = () => {
      if (!closed) reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => ws?.close();
  }

  connect();
  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
