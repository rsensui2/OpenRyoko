"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { createGatewaySocket } from "@/lib/ws";
import { SessionList } from "@/components/sessions/session-list";
import { SessionDetail } from "@/components/sessions/session-detail";
import { PageLayout } from "@/components/page-layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RefreshCw } from "lucide-react";

interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  employee: string | null;
  model: string | null;
  title: string | null;
  parentSessionId: string | null;
  status: "idle" | "running" | "error";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("all");
  const closeRef = useRef<HTMLButtonElement>(null);

  const fetchSessions = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getSessions();
      setSessions(data as unknown as Session[]);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to load sessions",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Auto-refresh on WebSocket session events
  useEffect(() => {
    const socket = createGatewaySocket((event) => {
      if (event.startsWith("session")) {
        fetchSessions();
      }
    });
    return () => socket.close();
  }, [fetchSessions]);

  // ESC closes detail panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && selectedId) {
        setSelectedId(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId]);

  // Focus close button when panel opens
  useEffect(() => {
    if (selectedId && closeRef.current) {
      closeRef.current.focus();
    }
  }, [selectedId]);

  const selected = sessions.find((s) => s.id === selectedId) || null;

  const filteredSessions =
    tab === "all" ? sessions : sessions.filter((s) => s.status === tab);

  return (
    <PageLayout>
      <div
        style={{
          display: "flex",
          height: "100%",
          position: "relative",
          background: "var(--bg)",
        }}
      >
        {/* Main content */}
        <div
          style={{
            flex: 1,
            height: "100%",
            overflowY: "auto",
            padding: "var(--space-6)",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "var(--space-5)",
            }}
          >
            <div>
              <h2
                style={{
                  fontSize: "var(--text-title2)",
                  fontWeight: "var(--weight-bold)",
                  color: "var(--text-primary)",
                  marginBottom: "var(--space-1)",
                }}
              >
                Sessions
              </h2>
              <p
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--text-tertiary)",
                }}
              >
                Active and recent engine sessions
              </p>
            </div>
            <button
              onClick={() => {
                setLoading(true);
                fetchSessions();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-2) var(--space-3)",
                borderRadius: "var(--radius-md, 12px)",
                background: "var(--fill-secondary)",
                color: "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                fontSize: "var(--text-body)",
                fontWeight: "var(--weight-medium)",
              }}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>

          {error && (
            <div
              style={{
                marginBottom: "var(--space-4)",
                borderRadius: "var(--radius-md, 12px)",
                background:
                  "color-mix(in srgb, var(--system-red) 10%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
                padding: "var(--space-3) var(--space-4)",
                fontSize: "var(--text-body)",
                color: "var(--system-red)",
              }}
            >
              {error}
            </div>
          )}

          {/* Tabs */}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList style={{ marginBottom: "var(--space-4)" }}>
              <TabsTrigger value="all">
                All ({sessions.length})
              </TabsTrigger>
              <TabsTrigger value="running">
                Running (
                {sessions.filter((s) => s.status === "running").length})
              </TabsTrigger>
              <TabsTrigger value="idle">
                Idle ({sessions.filter((s) => s.status === "idle").length})
              </TabsTrigger>
              <TabsTrigger value="error">
                Error ({sessions.filter((s) => s.status === "error").length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value={tab}>
              {loading && sessions.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "var(--space-8)",
                    color: "var(--text-tertiary)",
                    fontSize: "var(--text-body)",
                  }}
                >
                  Loading sessions...
                </div>
              ) : (
                <SessionList
                  sessions={filteredSessions}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onDeleted={fetchSessions}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>

        {/* Mobile backdrop */}
        {selected && (
          <div
            className="fixed inset-0 z-30 lg:hidden"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setSelectedId(null)}
          />
        )}

        {/* Detail panel - slides in from right */}
        {selected && (
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              zIndex: 30,
            }}
          >
            <div
              style={{
                width: 400,
                maxWidth: "100vw",
                height: "100%",
                overflowY: "auto",
                background: "var(--bg)",
                boxShadow: "var(--shadow-overlay)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Close button */}
              <div
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  padding: "var(--space-3) var(--space-4)",
                  background: "var(--bg)",
                }}
              >
                <button
                  ref={closeRef}
                  onClick={() => setSelectedId(null)}
                  aria-label="Close detail panel"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "var(--fill-tertiary)",
                    color: "var(--text-secondary)",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 14,
                  }}
                >
                  &#x2715;
                </button>
              </div>

              {/* Session detail */}
              <div style={{ padding: "0 var(--space-4) var(--space-6)" }}>
                <SessionDetail
                  session={selected}
                  onClose={() => setSelectedId(null)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
