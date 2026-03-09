"use client";
import { useEffect, useState, useRef } from "react";
import { createGatewaySocket } from "@/lib/ws";
import { useSettings } from "@/app/settings-provider";

function requestNotificationPermission() {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function showNotification(title: string, body: string) {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  // Only notify if tab is not focused
  if (!document.hidden) return;
  new Notification(title, {
    body,
    icon: "/favicon.ico",
    tag: "jimmy-session",
  });
}

export function useGateway() {
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Jimmy";
  const [events, setEvents] = useState<Array<{ event: string; payload: unknown }>>([]);
  const [connected, setConnected] = useState(false);
  const permissionRequested = useRef(false);
  const portalNameRef = useRef(portalName);
  portalNameRef.current = portalName;

  useEffect(() => {
    // Request notification permission on first mount
    if (!permissionRequested.current) {
      permissionRequested.current = true;
      requestNotificationPermission();
    }

    const socket = createGatewaySocket((event, payload) => {
      setConnected(true);
      setEvents((prev) => [...prev.slice(-99), { event, payload }]);

      // Push notification when a session completes
      if (event === "session:completed") {
        const p = payload as Record<string, unknown>;
        const employee = (p.employee as string) || portalNameRef.current;
        const error = p.error as string | null;
        if (error) {
          showNotification(`${employee} — Error`, error.slice(0, 100));
        } else {
          showNotification(`${employee} — Done`, "Session completed successfully");
        }
      }
    });
    setConnected(true);
    return () => socket.close();
  }, []);

  return { events, connected };
}
