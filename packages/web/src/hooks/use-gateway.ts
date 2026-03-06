"use client";
import { useEffect, useState } from "react";
import { createGatewaySocket } from "@/lib/ws";

export function useGateway() {
  const [events, setEvents] = useState<Array<{ event: string; payload: unknown }>>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = createGatewaySocket((event, payload) => {
      setConnected(true);
      setEvents((prev) => [...prev.slice(-99), { event, payload }]);
    });
    setConnected(true);
    return () => socket.close();
  }, []);

  return { events, connected };
}
