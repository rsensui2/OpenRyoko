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
import { useSettings } from "@/app/settings-provider";

interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  connector: string | null;
  sessionKey: string;
  replyContext: Record<string, unknown> | null;
  messageId: string | null;
  employee: string | null;
  model: string | null;
  title: string | null;
  parentSessionId: string | null;
  status: "idle" | "running" | "error";
  transportState?: "idle" | "queued" | "running" | "error";
  queueDepth?: number;
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  idle: "secondary",
  queued: "outline",
  running: "default",
  error: "destructive",
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start gap-[var(--space-3)] py-[var(--space-2)] border-b border-[var(--separator)]">
      <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] uppercase tracking-[0.05em] text-[var(--text-tertiary)] shrink-0">
        {label}
      </span>
      <span className="text-[length:var(--text-body)] text-[var(--text-primary)] text-right break-all">
        {value || (
          <span className="text-[var(--text-quaternary)]">--</span>
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
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Jinn";
  const [children, setChildren] = useState<Session[]>([]);

  useEffect(() => {
    api.getSessionChildren(session.id)
      .then((data) => setChildren(data as unknown as Session[]))
      .catch(() => setChildren([]));
  }, [session.id]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[length:var(--text-headline)] text-[var(--text-primary)]">
          {session.title || "Session Detail"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col">
          <Field
            label="Session ID"
            value={
              <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption1)]">
                {session.id}
              </span>
            }
          />
          <Field
            label="Engine"
            value={
              <span className="capitalize">
                {session.engine}
                {session.model ? ` (${session.model})` : ""}
              </span>
            }
          />
          <Field label="Connector" value={session.connector || session.source} />
          <Field label="Session Key" value={session.sessionKey} />
          <Field label="Source" value={session.source} />
          <Field label="Employee" value={session.employee || portalName} />
          <Field
            label="Status"
            value={
              <Badge variant={statusVariant[session.transportState || session.status] ?? "secondary"}>
                {(session.transportState || session.status).charAt(0).toUpperCase() +
                  (session.transportState || session.status).slice(1)}
              </Badge>
            }
          />
          <Field label="Queue Depth" value={typeof session.queueDepth === "number" ? String(session.queueDepth) : "--"} />
          <Field label="Message ID" value={session.messageId || "--"} />
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
                  className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption1)] text-[var(--accent)] bg-none border-none cursor-pointer underline p-0"
                >
                  {session.parentSessionId.slice(0, 12)}...
                </button>
              }
            />
          )}

          {/* Child sessions */}
          {children.length > 0 && (
            <div className="mt-[var(--space-3)]">
              <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] uppercase tracking-[0.05em] text-[var(--text-tertiary)] block mb-[var(--space-2)]">
                Child Sessions ({children.length})
              </span>
              <div className="flex flex-col gap-[var(--space-1)]">
                {children.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => onNavigate?.(child.id)}
                    className="flex items-center justify-between py-[var(--space-2)] px-[var(--space-3)] bg-[var(--fill-secondary)] rounded-[var(--radius-sm,8px)] border-none cursor-pointer text-left"
                  >
                    <span className="text-[length:var(--text-caption1)] text-[var(--text-primary)] font-[var(--weight-medium)]">
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
            <div className="mt-[var(--space-3)]">
              <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] uppercase tracking-[0.05em] text-[var(--system-red)] block mb-[var(--space-2)]">
                Last Error
              </span>
              <div
                className="text-[length:var(--text-caption1)] font-[family-name:var(--font-mono)] text-[var(--system-red)] rounded-[var(--radius-sm,8px)] p-[var(--space-3)]"
                style={{
                  background:
                    "color-mix(in srgb, var(--system-red) 10%, transparent)",
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
