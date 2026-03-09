"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useGateway } from "@/hooks/use-gateway";
import { useSettings } from "@/app/settings-provider";
import { PageLayout } from "@/components/page-layout";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import {
  Clock,
  Users,
  Cpu,
  CalendarClock,
  MessageSquare,
  Network,
  KanbanSquare,
  Timer,
  DollarSign,
  Activity,
} from "lucide-react";

interface StatusData {
  status?: string;
  uptime?: number;
  port?: number;
  engines?: Record<string, unknown>;
  sessions?: { active?: number };
  [key: string]: unknown;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function getQuickLinks(portalName: string) {
  return [
    {
      href: "/chat",
      icon: MessageSquare,
      name: "Chat",
      description: `Talk to ${portalName} directly`,
    },
    {
      href: "/org",
      icon: Network,
      name: "Organization",
      description: "View employees and departments",
    },
    {
      href: "/kanban",
      icon: KanbanSquare,
      name: "Kanban",
      description: "Manage tasks and boards",
    },
    {
      href: "/cron",
      icon: Timer,
      name: "Cron",
      description: "Scheduled jobs and automations",
    },
    {
      href: "/costs",
      icon: DollarSign,
      name: "Costs",
      description: "API usage and spending",
    },
    {
      href: "/logs",
      icon: Activity,
      name: "Activity",
      description: "Logs and event stream",
    },
  ];
}

export default function DashboardPage() {
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Jimmy";
  const [status, setStatus] = useState<StatusData | null>(null);
  const [cronCount, setCronCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialActivity, setInitialActivity] = useState<Array<{ event: string; payload: unknown }>>([]);
  const { events, connected } = useGateway();

  useEffect(() => {
    // Check if onboarding is needed -- redirect to chat if first visit
    api
      .getOnboarding()
      .then((data) => {
        if (data.needed) {
          window.location.href = "/chat?onboarding=1";
        }
      })
      .catch(() => {});

    api
      .getStatus()
      .then((data) => setStatus(data as StatusData))
      .catch((err) => setError(err.message));

    api
      .getCronJobs()
      .then((data) => setCronCount(data.length))
      .catch(() => {});

    // Load initial activity from recent sessions
    api
      .getActivity()
      .then((data) => {
        const initialEvents = data.map((e) => ({ event: e.event, payload: e.payload }));
        setInitialActivity(initialEvents);
      })
      .catch(() => {});
  }, []);

  const defaultEngine = status?.engines
    ? Object.keys(status.engines as Record<string, unknown>)[0] ?? "--"
    : "--";

  // Merge live WebSocket events with initial activity from API
  const allEvents = events.length > 0 ? events : initialActivity;
  const recentEvents = [...allEvents].reverse().slice(0, 20);

  return (
    <PageLayout>
      <div
        style={{
          height: "100%",
          overflowY: "auto",
          padding: "var(--space-6)",
        }}
      >
        {/* Page header */}
        <div style={{ marginBottom: "var(--space-6)" }}>
          <h2
            style={{
              fontSize: "var(--text-title2)",
              fontWeight: "var(--weight-bold)",
              color: "var(--text-primary)",
              marginBottom: "var(--space-1)",
            }}
          >
            Dashboard
          </h2>
          <p
            style={{
              fontSize: "var(--text-body)",
              color: "var(--text-tertiary)",
            }}
          >
            Gateway overview and live activity
          </p>
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
            Failed to connect: {error}
          </div>
        )}

        {/* Summary cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "var(--space-4)",
            marginBottom: "var(--space-6)",
          }}
        >
          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "var(--radius-md, 12px)",
                  background:
                    "color-mix(in srgb, var(--system-blue) 12%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--system-blue)",
                }}
              >
                <Clock size={20} />
              </div>
              <div>
                <p
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    fontWeight: "var(--weight-medium)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Uptime
                </p>
                <p
                  style={{
                    fontSize: "var(--text-title3)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-primary)",
                  }}
                >
                  {status?.uptime != null
                    ? formatUptime(status.uptime as number)
                    : "--"}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "var(--radius-md, 12px)",
                  background:
                    "color-mix(in srgb, var(--system-green) 12%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--system-green)",
                }}
              >
                <Users size={20} />
              </div>
              <div>
                <p
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    fontWeight: "var(--weight-medium)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Active Sessions
                </p>
                <p
                  style={{
                    fontSize: "var(--text-title3)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-primary)",
                  }}
                >
                  {status?.sessions?.active ?? "--"}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "var(--radius-md, 12px)",
                  background:
                    "color-mix(in srgb, var(--accent) 12%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)",
                }}
              >
                <Cpu size={20} />
              </div>
              <div>
                <p
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    fontWeight: "var(--weight-medium)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Engines
                </p>
                <p
                  style={{
                    fontSize: "var(--text-title3)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-primary)",
                    textTransform: "capitalize",
                  }}
                >
                  {defaultEngine}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "var(--radius-md, 12px)",
                  background:
                    "color-mix(in srgb, var(--system-orange) 12%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--system-orange)",
                }}
              >
                <CalendarClock size={20} />
              </div>
              <div>
                <p
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    fontWeight: "var(--weight-medium)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Cron Jobs
                </p>
                <p
                  style={{
                    fontSize: "var(--text-title3)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-primary)",
                  }}
                >
                  {cronCount ?? "--"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Quick links */}
        <div style={{ marginBottom: "var(--space-6)" }}>
          <h3
            style={{
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--text-primary)",
              marginBottom: "var(--space-3)",
            }}
          >
            Quick Links
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: "var(--space-3)",
            }}
          >
            {getQuickLinks(portalName).map((link) => {
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  style={{ textDecoration: "none" }}
                >
                  <Card className="py-4 h-full cursor-pointer transition-colors hover:border-[var(--accent)]">
                    <CardContent className="flex flex-col gap-2">
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: "var(--radius-sm, 8px)",
                          background: "var(--fill-secondary)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "var(--accent)",
                        }}
                      >
                        <Icon size={18} />
                      </div>
                      <div>
                        <p
                          style={{
                            fontSize: "var(--text-body)",
                            fontWeight: "var(--weight-semibold)",
                            color: "var(--text-primary)",
                          }}
                        >
                          {link.name}
                        </p>
                        <p
                          style={{
                            fontSize: "var(--text-caption1)",
                            color: "var(--text-tertiary)",
                            marginTop: 2,
                          }}
                        >
                          {link.description}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Recent activity feed */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginBottom: "var(--space-3)",
            }}
          >
            <h3
              style={{
                fontSize: "var(--text-body)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--text-primary)",
              }}
            >
              Recent Activity
            </h3>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: connected
                  ? "var(--system-green)"
                  : "var(--text-quaternary)",
                display: "inline-block",
              }}
            />
          </div>
          <Card className="py-0 overflow-hidden">
            {recentEvents.length === 0 ? (
              <div
                style={{
                  padding: "var(--space-6)",
                  textAlign: "center",
                  fontSize: "var(--text-body)",
                  color: "var(--text-tertiary)",
                }}
              >
                Waiting for events...
              </div>
            ) : (
              <div
                style={{
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                {recentEvents.map((evt, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "var(--space-3)",
                      padding: "var(--space-3) var(--space-4)",
                      borderBottom:
                        i < recentEvents.length - 1
                          ? "1px solid var(--separator)"
                          : "none",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "var(--text-caption2)",
                        fontFamily: "var(--font-mono)",
                        color: "var(--accent)",
                        background:
                          "color-mix(in srgb, var(--accent) 10%, transparent)",
                        padding: "2px 8px",
                        borderRadius: "var(--radius-sm, 8px)",
                        whiteSpace: "nowrap",
                        marginTop: 1,
                      }}
                    >
                      {evt.event}
                    </span>
                    <span
                      style={{
                        fontSize: "var(--text-caption2)",
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-tertiary)",
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {JSON.stringify(evt.payload)}
                    </span>
                    <span
                      style={{
                        fontSize: "var(--text-caption2)",
                        color: "var(--text-quaternary)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatTimestamp(Date.now() - (recentEvents.length - 1 - i) * 1000)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </PageLayout>
  );
}
