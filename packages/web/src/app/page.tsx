"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useGateway } from "@/hooks/use-gateway";

interface StatusData {
  status?: string;
  uptime?: number;
  port?: number;
  engines?: Record<string, unknown>;
  sessions?: { active?: number };
  [key: string]: unknown;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { events, connected } = useGateway();

  useEffect(() => {
    api
      .getStatus()
      .then((data) => setStatus(data as StatusData))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-neutral-500 mt-1">
          Gateway overview and live activity
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Failed to connect: {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card title="Status">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                status?.status === "ok" ? "bg-green-500" : "bg-neutral-300"
              }`}
            />
            <span className="text-lg font-medium">
              {status?.status === "ok" ? "Running" : "Unknown"}
            </span>
          </div>
        </Card>

        <Card title="Uptime">
          <p className="text-lg font-medium">
            {status?.uptime != null
              ? formatUptime(status.uptime as number)
              : "--"}
          </p>
        </Card>

        <Card title="Port">
          <p className="text-lg font-medium">{status?.port ?? "--"}</p>
        </Card>

        <Card title="Active Sessions">
          <p className="text-lg font-medium">
            {status?.sessions?.active ?? "--"}
          </p>
        </Card>
      </div>

      {status?.engines && (
        <div className="mb-8">
          <h3 className="text-sm font-medium text-neutral-700 mb-3">
            Engines
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.entries(status.engines as Record<string, unknown>).map(
              ([name, info]) => {
                const engine = info as Record<string, unknown>;
                return (
                  <div
                    key={name}
                    className="rounded-xl border border-neutral-200 bg-white p-4 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium capitalize">{name}</p>
                      <p className="text-xs text-neutral-400">
                        {engine.model ? String(engine.model) : "default model"}
                      </p>
                    </div>
                    <span
                      className={`text-xs font-medium px-2 py-1 rounded-full ${
                        engine.available
                          ? "bg-green-50 text-green-700"
                          : "bg-neutral-100 text-neutral-500"
                      }`}
                    >
                      {engine.available ? "Available" : "Unavailable"}
                    </span>
                  </div>
                );
              }
            )}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-medium text-neutral-700">
            Live Activity
          </h3>
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              connected ? "bg-green-500" : "bg-neutral-300"
            }`}
          />
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
          {events.length === 0 ? (
            <p className="px-5 py-8 text-sm text-neutral-400 text-center">
              Waiting for events...
            </p>
          ) : (
            <div className="divide-y divide-neutral-100 max-h-80 overflow-y-auto">
              {[...events].reverse().map((evt, i) => (
                <div key={i} className="px-5 py-3 flex items-start gap-3">
                  <span className="text-xs font-mono text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded mt-0.5">
                    {evt.event}
                  </span>
                  <span className="text-xs text-neutral-500 font-mono truncate flex-1">
                    {JSON.stringify(evt.payload)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
