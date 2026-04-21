"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useSettings } from "@/app/settings-provider";

interface Session {
  id: string;
  engine: string;
  source: string;
  connector: string | null;
  sessionKey: string;
  employee: string | null;
  title: string | null;
  status: "idle" | "running" | "error";
  transportState?: "idle" | "queued" | "running" | "error";
  queueDepth?: number;
  lastActivity: string;
}

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  idle: "secondary",
  queued: "outline",
  running: "default",
  error: "destructive",
};

const statusLabel: Record<string, string> = {
  idle: "Idle",
  queued: "Queued",
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
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Ryoko";
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
          <div className="text-center p-[var(--space-6)] text-[var(--text-tertiary)] text-[length:var(--text-body)]">
            No sessions found
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div
        className="flex flex-col gap-[var(--space-3)]"
        onClick={() => setContextMenu(null)}
      >
        {sessions.map((s) => (
          <Card
            key={s.id}
            className="py-3 cursor-pointer transition-colors"
            onClick={() => onSelect(s.id)}
            onContextMenu={(e) => handleContextMenu(e, s.id)}
            style={{
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
              <div className="flex items-center gap-[var(--space-3)] flex-1 min-w-0">
                {/* Engine icon */}
                <div className="w-9 h-9 rounded-[var(--radius-sm,8px)] bg-[var(--fill-secondary)] flex items-center justify-center font-[var(--font-mono)] text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)] shrink-0 uppercase">
                  {s.engine.charAt(0)}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)] mb-0.5">
                    <span className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">
                      {s.title || s.employee || portalName}
                    </span>
                    <Badge variant={statusVariant[s.status] ?? "secondary"}>
                      {statusLabel[s.transportState || s.status] || s.transportState || s.status}
                    </Badge>
                  </div>
                  <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] flex gap-[var(--space-3)]">
                    <span>{s.connector || s.source}</span>
                    <span>{s.employee || portalName}</span>
                    {typeof s.queueDepth === "number" && s.queueDepth > 0 ? <span>Queue {s.queueDepth}</span> : null}
                  </div>
                </div>
              </div>

              {/* Time */}
              <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] whitespace-nowrap shrink-0">
                {relativeTime(s.lastActivity)}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setContextMenu(null)}
        >
          <div
            className="fixed bg-[var(--bg)] border border-[var(--separator)] rounded-[var(--radius-md)] shadow-[var(--shadow-lg)] p-[var(--space-1)] z-[51] min-w-[160px]"
            style={{
              top: contextMenu.y,
              left: contextMenu.x,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => handleDelete(contextMenu.sessionId)}
              className="w-full text-left px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)] bg-transparent border-none cursor-pointer rounded-[var(--radius-sm)] flex items-center gap-[var(--space-2)]"
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
          className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-[var(--bg)] rounded-[var(--radius-lg)] p-[var(--space-6)] max-w-[400px] w-[90%] shadow-[var(--shadow-overlay)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[length:var(--text-headline)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-2)]">
              Delete Session?
            </h3>
            <p className="text-[length:var(--text-body)] text-[var(--text-secondary)] mb-[var(--space-5)]">
              This will permanently delete the session and all its messages. This cannot be undone.
            </p>
            <div className="flex gap-[var(--space-3)] justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-primary)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-medium)]"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteSession}
                className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--system-red)] text-white border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-semibold)]"
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
