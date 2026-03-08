"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

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

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  idle: "secondary",
  running: "default",
  error: "destructive",
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        padding: "var(--space-2) 0",
        borderBottom: "1px solid var(--separator)",
      }}
    >
      <span
        style={{
          fontSize: "var(--text-caption1)",
          fontWeight: "var(--weight-medium)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: "var(--text-body)",
          color: "var(--text-primary)",
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value || (
          <span style={{ color: "var(--text-quaternary)" }}>--</span>
        )}
      </span>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function SessionDetail({
  session,
  onClose,
  onNavigate,
}: {
  session: Session;
  onClose: () => void;
  onNavigate?: (id: string) => void;
}) {
  const [children, setChildren] = useState<Session[]>([]);

  useEffect(() => {
    api.getSessionChildren(session.id)
      .then((data) => setChildren(data as unknown as Session[]))
      .catch(() => setChildren([]));
  }, [session.id]);

  return (
    <Card>
      <CardHeader>
        <CardTitle
          style={{
            fontSize: "var(--text-headline)",
            color: "var(--text-primary)",
          }}
        >
          {session.title || "Session Detail"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Field
            label="Session ID"
            value={
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-caption1)",
                }}
              >
                {session.id}
              </span>
            }
          />
          <Field
            label="Engine"
            value={
              <span style={{ textTransform: "capitalize" }}>
                {session.engine}
                {session.model ? ` (${session.model})` : ""}
              </span>
            }
          />
          <Field label="Source" value={session.source} />
          <Field label="Employee" value={session.employee || "Jimmy"} />
          <Field
            label="Status"
            value={
              <Badge variant={statusVariant[session.status] ?? "secondary"}>
                {session.status.charAt(0).toUpperCase() +
                  session.status.slice(1)}
              </Badge>
            }
          />
          <Field label="Created" value={formatDate(session.createdAt)} />
          <Field
            label="Last Activity"
            value={formatDate(session.lastActivity)}
          />

          {/* Parent session link */}
          {session.parentSessionId && (
            <Field
              label="Parent Session"
              value={
                <button
                  onClick={() => onNavigate?.(session.parentSessionId!)}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-caption1)",
                    color: "var(--accent)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textDecoration: "underline",
                    padding: 0,
                  }}
                >
                  {session.parentSessionId.slice(0, 12)}...
                </button>
              }
            />
          )}

          {/* Child sessions */}
          {children.length > 0 && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <span
                style={{
                  fontSize: "var(--text-caption1)",
                  fontWeight: "var(--weight-medium)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-tertiary)",
                  display: "block",
                  marginBottom: "var(--space-2)",
                }}
              >
                Child Sessions ({children.length})
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                {children.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => onNavigate?.(child.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "var(--space-2) var(--space-3)",
                      background: "var(--fill-secondary)",
                      borderRadius: "var(--radius-sm, 8px)",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: "var(--text-caption1)", color: "var(--text-primary)", fontWeight: "var(--weight-medium)" }}>
                      {child.title || child.employee || "Session"}
                    </span>
                    <Badge variant={statusVariant[child.status] ?? "secondary"}>
                      {child.status}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>
          )}

          {session.lastError && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <span
                style={{
                  fontSize: "var(--text-caption1)",
                  fontWeight: "var(--weight-medium)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--system-red)",
                  display: "block",
                  marginBottom: "var(--space-2)",
                }}
              >
                Last Error
              </span>
              <div
                style={{
                  fontSize: "var(--text-caption1)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--system-red)",
                  background:
                    "color-mix(in srgb, var(--system-red) 10%, transparent)",
                  borderRadius: "var(--radius-sm, 8px)",
                  padding: "var(--space-3)",
                }}
              >
                {session.lastError}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
