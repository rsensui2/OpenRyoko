"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import type { Employee, OrgData } from "@/lib/api";
import { EmployeeDetail } from "@/components/org/employee-detail";
import { GridView } from "@/components/org/grid-view";
import { FeedView } from "@/components/org/feed-view";
import { PageLayout } from "@/components/page-layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useSettings } from "@/app/settings-provider";

const OrgMap = dynamic(
  () =>
    import("@/components/org/org-map").then((m) => ({ default: m.OrgMap })),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: "var(--space-3)",
          color: "var(--text-tertiary)",
          fontSize: "var(--text-caption1)",
        }}
      >
        Loading map...
      </div>
    ),
  },
);

export default function OrgPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [view, setView] = useState<string>("map");
  const closeRef = useRef<HTMLButtonElement>(null);
  const { settings } = useSettings();

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getOrg()
      .then(async (data: OrgData) => {
        const details = await Promise.all(
          data.employees.map(async (name) => {
            try {
              return await api.getEmployee(name);
            } catch {
              return {
                name,
                displayName: name,
                department: "",
                rank: "employee" as const,
                engine: "unknown",
                model: "unknown",
                persona: "",
              };
            }
          }),
        );
        const coo: Employee = {
          name: (settings.portalName ?? "Jimmy").toLowerCase(),
          displayName: settings.portalName ?? "Jimmy",
          department: "",
          rank: "executive",
          engine: "claude",
          model: "opus",
          persona: "COO and AI gateway daemon",
        };
        setEmployees([coo, ...details]);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [settings.portalName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Focus close button when panel opens
  useEffect(() => {
    if (selected && closeRef.current) {
      closeRef.current.focus();
    }
  }, [selected]);

  // ESC closes panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && selected) {
        setSelected(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected]);

  const handleSelectEmployee = useCallback((emp: Employee) => {
    setSelected(emp);
  }, []);

  if (error) {
    return (
      <PageLayout>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: "var(--space-4)",
            color: "var(--text-tertiary)",
          }}
        >
          <div
            style={{
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
            Failed to load organization: {error}
          </div>
          <button
            onClick={loadData}
            style={{
              padding: "var(--space-2) var(--space-4)",
              borderRadius: "var(--radius-md, 12px)",
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              border: "none",
              cursor: "pointer",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            Retry
          </button>
        </div>
      </PageLayout>
    );
  }

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
        {/* Main content area */}
        <div style={{ flex: 1, height: "100%", position: "relative" }}>
          <Tabs
            value={view}
            onValueChange={setView}
            className="h-full flex flex-col"
          >
            {/* Tab bar at top */}
            <div
              style={{
                position: "absolute",
                top: "var(--space-4)",
                left: "var(--space-4)",
                zIndex: 10,
              }}
            >
              <TabsList>
                <TabsTrigger value="map">Map</TabsTrigger>
                <TabsTrigger value="grid">Grid</TabsTrigger>
                <TabsTrigger value="list">List</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="map" className="flex-1">
              {loading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    color: "var(--text-tertiary)",
                    fontSize: "var(--text-caption1)",
                  }}
                >
                  Loading...
                </div>
              ) : (
                <OrgMap
                  employees={employees}
                  selectedName={selected?.name ?? null}
                  onNodeClick={handleSelectEmployee}
                />
              )}
            </TabsContent>

            <TabsContent value="grid" className="flex-1 overflow-hidden">
              {loading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    color: "var(--text-tertiary)",
                    fontSize: "var(--text-caption1)",
                  }}
                >
                  Loading...
                </div>
              ) : (
                <GridView
                  employees={employees}
                  selectedName={selected?.name ?? null}
                  onSelect={handleSelectEmployee}
                />
              )}
            </TabsContent>

            <TabsContent value="list" className="flex-1 overflow-hidden">
              {loading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    color: "var(--text-tertiary)",
                    fontSize: "var(--text-caption1)",
                  }}
                >
                  Loading...
                </div>
              ) : (
                <FeedView
                  employees={employees}
                  selectedName={selected?.name ?? null}
                  onSelect={handleSelectEmployee}
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
            onClick={() => setSelected(null)}
          />
        )}

        {/* Detail panel */}
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
                width: 380,
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
                  onClick={() => setSelected(null)}
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

              {/* Employee detail */}
              <div style={{ padding: "0 var(--space-4) var(--space-6)" }}>
                <EmployeeDetail name={selected.name} />
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
