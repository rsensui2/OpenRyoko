"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

interface Session {
  id: string;
  engine: string;
  source: string;
  employee: string | null;
  title: string | null;
  status: "idle" | "running" | "error";
  lastActivity: string;
}

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  idle: "secondary",
  running: "default",
  error: "destructive",
};

const statusLabel: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  error: "Error",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onDeleted,
}: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeleted?: () => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function handleContextMenu(e: React.MouseEvent, sessionId: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  }

  function handleDelete(id: string) {
    setContextMenu(null);
    setConfirmDelete(id);
  }

  async function confirmDeleteSession() {
    if (!confirmDelete) return;
    try {
      await api.deleteSession(confirmDelete);
      onDeleted?.();
    } catch { /* ignore */ }
    setConfirmDelete(null);
  }

  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent>
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-6)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-body)",
            }}
          >
            No sessions found
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
        onClick={() => setContextMenu(null)}
      >
        {sessions.map((s) => (
          <Card
            key={s.id}
            className="py-3 cursor-pointer transition-colors"
            onClick={() => onSelect(s.id)}
            onContextMenu={(e) => handleContextMenu(e, s.id)}
            style={{
              cursor: "pointer",
              borderColor:
                selectedId === s.id
                  ? "var(--accent)"
                  : undefined,
              background:
                selectedId === s.id
                  ? "color-mix(in srgb, var(--accent) 5%, var(--bg-card, var(--bg)))"
                  : undefined,
            }}
          >
            <CardContent className="flex items-center justify-between gap-4">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {/* Engine icon */}
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "var(--radius-sm, 8px)",
                    background: "var(--fill-secondary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-secondary)",
                    flexShrink: 0,
                    textTransform: "uppercase",
                  }}
                >
                  {s.engine.charAt(0)}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        fontSize: "var(--text-body)",
                        fontWeight: "var(--weight-semibold)",
                        color: "var(--text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.title || s.employee || "Jimmy"}
                    </span>
                    <Badge variant={statusVariant[s.status] ?? "secondary"}>
                      {statusLabel[s.status] || s.status}
                    </Badge>
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-caption1)",
                      color: "var(--text-tertiary)",
                      display: "flex",
                      gap: "var(--space-3)",
                    }}
                  >
                    <span>{s.source}</span>
                    <span>{s.employee || "Jimmy"}</span>
                  </div>
                </div>
              </div>

              {/* Time */}
              <span
                style={{
                  fontSize: "var(--text-caption2)",
                  color: "var(--text-quaternary)",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {relativeTime(s.lastActivity)}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
          }}
          onClick={() => setContextMenu(null)}
        >
          <div
            style={{
              position: "fixed",
              top: contextMenu.y,
              left: contextMenu.x,
              background: "var(--bg)",
              border: "1px solid var(--separator)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-lg)",
              padding: "var(--space-1)",
              zIndex: 51,
              minWidth: 160,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => handleDelete(contextMenu.sessionId)}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "var(--space-2) var(--space-3)",
                fontSize: "var(--text-footnote)",
                color: "var(--system-red)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                borderRadius: "var(--radius-sm)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Delete Session
            </button>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            style={{
              background: "var(--bg)",
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-6)",
              maxWidth: 400,
              width: "90%",
              boxShadow: "var(--shadow-overlay)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: "var(--text-headline)", fontWeight: "var(--weight-bold)", color: "var(--text-primary)", marginBottom: "var(--space-2)" }}>
              Delete Session?
            </h3>
            <p style={{ fontSize: "var(--text-body)", color: "var(--text-secondary)", marginBottom: "var(--space-5)" }}>
              This will permanently delete the session and all its messages. This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  padding: "var(--space-2) var(--space-4)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--fill-tertiary)",
                  color: "var(--text-primary)",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-medium)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteSession}
                style={{
                  padding: "var(--space-2) var(--space-4)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--system-red)",
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
