"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useGateway } from "@/hooks/use-gateway";
import { useSettings } from "@/app/settings-provider";
import { PageLayout } from "@/components/page-layout";
import { useBreadcrumbs } from "@/context/breadcrumb-context";
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
  useBreadcrumbs([{ label: 'ダッシュボード' }])
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Ryoko";
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
      <div className="h-full overflow-y-auto p-[var(--space-6)]">
        {/* Page header */}
        <div className="mb-[var(--space-6)]">
          <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-1)]">
            Dashboard
          </h2>
          <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
            Gateway overview and live activity
          </p>
        </div>

        {error && (
          <div
            className="mb-[var(--space-4)] rounded-[var(--radius-md,12px)] border px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body)] text-[var(--system-red)]"
            style={{
              background:
                "color-mix(in srgb, var(--system-red) 10%, transparent)",
              borderColor:
                "color-mix(in srgb, var(--system-red) 30%, transparent)",
            }}
          >
            Failed to connect: {error}
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[var(--space-4)] mb-[var(--space-6)]">
          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-[var(--radius-md,12px)] flex items-center justify-center text-[var(--system-blue)]"
                style={{
                  background:
                    "color-mix(in srgb, var(--system-blue) 12%, transparent)",
                }}
              >
                <Clock size={20} />
              </div>
              <div>
                <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)] uppercase tracking-[0.05em]">
                  Uptime
                </p>
                <p className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
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
                className="w-10 h-10 rounded-[var(--radius-md,12px)] flex items-center justify-center text-[var(--system-green)]"
                style={{
                  background:
                    "color-mix(in srgb, var(--system-green) 12%, transparent)",
                }}
              >
                <Users size={20} />
              </div>
              <div>
                <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)] uppercase tracking-[0.05em]">
                  Active Sessions
                </p>
                <p className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                  {status?.sessions?.active ?? "--"}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-[var(--radius-md,12px)] flex items-center justify-center text-[var(--accent)]"
                style={{
                  background:
                    "color-mix(in srgb, var(--accent) 12%, transparent)",
                }}
              >
                <Cpu size={20} />
              </div>
              <div>
                <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)] uppercase tracking-[0.05em]">
                  Engines
                </p>
                <p className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)] capitalize">
                  {defaultEngine}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="py-4">
            <CardContent className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-[var(--radius-md,12px)] flex items-center justify-center text-[var(--system-orange)]"
                style={{
                  background:
                    "color-mix(in srgb, var(--system-orange) 12%, transparent)",
                }}
              >
                <CalendarClock size={20} />
              </div>
              <div>
                <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)] uppercase tracking-[0.05em]">
                  Cron Jobs
                </p>
                <p className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                  {cronCount ?? "--"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Quick links */}
        <div className="mb-[var(--space-6)]">
          <h3 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] mb-[var(--space-3)]">
            Quick Links
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-[var(--space-3)]">
            {getQuickLinks(portalName).map((link) => {
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="no-underline"
                >
                  <Card className="py-4 h-full cursor-pointer transition-colors hover:border-[var(--accent)]">
                    <CardContent className="flex flex-col gap-2">
                      <div className="w-9 h-9 rounded-[var(--radius-sm,8px)] bg-[var(--fill-secondary)] flex items-center justify-center text-[var(--accent)]">
                        <Icon size={18} />
                      </div>
                      <div>
                        <p className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                          {link.name}
                        </p>
                        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-0.5">
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
          <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
            <h3 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              Recent Activity
            </h3>
            <span
              className={`w-2 h-2 rounded-full inline-block ${
                connected
                  ? "bg-[var(--system-green)]"
                  : "bg-[var(--text-quaternary)]"
              }`}
            />
          </div>
          <Card className="py-0 overflow-hidden">
            {recentEvents.length === 0 ? (
              <div className="p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--text-tertiary)]">
                Waiting for events...
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {recentEvents.map((evt, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)]"
                    style={
                      i < recentEvents.length - 1
                        ? { borderBottom: "1px solid var(--separator)" }
                        : undefined
                    }
                  >
                    <span
                      className="text-[length:var(--text-caption2)] font-[family-name:var(--font-mono)] text-[var(--accent)] rounded-[var(--radius-sm,8px)] whitespace-nowrap mt-px px-2 py-0.5"
                      style={{
                        background:
                          "color-mix(in srgb, var(--accent) 10%, transparent)",
                      }}
                    >
                      {evt.event}
                    </span>
                    <span className="text-[length:var(--text-caption2)] font-[family-name:var(--font-mono)] text-[var(--text-tertiary)] flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {JSON.stringify(evt.payload)}
                    </span>
                    <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] whitespace-nowrap">
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
