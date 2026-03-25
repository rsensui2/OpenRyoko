"use client";
import React, { useState } from "react";
import type { Employee, OrgData, OrgHierarchy } from "@/lib/api";

const rankStyles: Record<string, React.CSSProperties> = {
  executive: { background: 'color-mix(in srgb, var(--system-purple) 15%, transparent)', color: 'var(--system-purple)' },
  manager: { background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' },
  senior: { background: 'color-mix(in srgb, var(--system-green) 15%, transparent)', color: 'var(--system-green)' },
  employee: { background: 'var(--fill-tertiary)', color: 'var(--text-tertiary)' },
};

const engineIcons: Record<string, string> = {
  claude: "C",
  codex: "X",
};

function RankBadge({ rank }: { rank: string }) {
  const style = rankStyles[rank] || rankStyles.employee;
  return (
    <span
      className="text-[10px] font-medium py-[2px] px-[6px] rounded-full"
      style={style}
    >
      {rank}
    </span>
  );
}

function EngineIcon({ engine }: { engine: string }) {
  return (
    <span className="text-[10px] font-[family-name:var(--font-mono)] bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] py-[2px] px-[4px] rounded-[var(--radius-sm)]">
      {engineIcons[engine] || engine?.charAt(0)?.toUpperCase() || "?"}
    </span>
  );
}

function EmployeeNode({
  employee,
  selected,
  onSelect,
}: {
  employee: Employee;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(employee.name)}
      className="w-full text-left flex items-center gap-2 py-[6px] px-3 rounded-[var(--radius-md)] text-[length:var(--text-subheadline)] border-none cursor-pointer transition-[background,color] duration-150 ease-in-out"
      style={{
        background: selected ? 'var(--accent-fill)' : 'transparent',
        color: selected ? 'var(--accent)' : 'var(--text-secondary)',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--fill-tertiary)' }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent' }}
    >
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {employee.displayName || employee.name}
      </span>
      {employee.rank && <RankBadge rank={employee.rank} />}
      {employee.engine && <EngineIcon engine={employee.engine} />}
    </button>
  );
}

function HierarchyNode({
  name,
  employees,
  hierarchy,
  depth,
  selectedEmployee,
  onSelectEmployee,
}: {
  name: string;
  employees: Employee[];
  hierarchy: OrgHierarchy;
  depth: number;
  selectedEmployee: string | null;
  onSelectEmployee: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const employee = employees.find((e) => e.name === name);
  const directReports = employee?.directReports ?? [];
  const hasChildren = directReports.length > 0;

  if (!employee) return null;

  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: depth * 16 }}>
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-5 h-5 flex items-center justify-center text-[var(--text-quaternary)] text-xs shrink-0 bg-none border-none cursor-pointer"
          >
            {expanded ? "\u25BC" : "\u25B6"}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          onClick={() => onSelectEmployee(employee.name)}
          className="flex-1 text-left flex items-center gap-2 py-[6px] px-2 rounded-[var(--radius-md)] text-[length:var(--text-subheadline)] border-none cursor-pointer transition-[background,color] duration-150 ease-in-out"
          style={{
            background: selectedEmployee === employee.name ? 'var(--accent-fill)' : 'transparent',
            color: selectedEmployee === employee.name ? 'var(--accent)' : 'var(--text-secondary)',
          }}
          onMouseEnter={(e) => { if (selectedEmployee !== employee.name) e.currentTarget.style.background = 'var(--fill-tertiary)' }}
          onMouseLeave={(e) => { if (selectedEmployee !== employee.name) e.currentTarget.style.background = 'transparent' }}
        >
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {employee.displayName || employee.name}
          </span>
          {hasChildren && (
            <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--fill-tertiary)] py-[2px] px-[6px] rounded-full">
              {directReports.length}
            </span>
          )}
          {employee.rank && <RankBadge rank={employee.rank} />}
          {employee.engine && <EngineIcon engine={employee.engine} />}
        </button>
      </div>
      {expanded && hasChildren && directReports.map((childName) => (
        <HierarchyNode
          key={childName}
          name={childName}
          employees={employees}
          hierarchy={hierarchy}
          depth={depth + 1}
          selectedEmployee={selectedEmployee}
          onSelectEmployee={onSelectEmployee}
        />
      ))}
    </div>
  );
}

function DepartmentNode({
  name,
  employees,
  selectedEmployee,
  onSelectEmployee,
  onSelectDepartment,
  selectedDepartment,
}: {
  name: string;
  employees: Employee[];
  selectedEmployee: string | null;
  onSelectEmployee: (name: string) => void;
  onSelectDepartment: (name: string) => void;
  selectedDepartment: string | null;
}) {
  const [expanded, setExpanded] = useState(true);

  const isSelected = selectedDepartment === name;

  return (
    <div>
      <div className="flex items-center">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-5 h-5 flex items-center justify-center text-[var(--text-quaternary)] text-xs shrink-0 bg-none border-none cursor-pointer"
        >
          {expanded ? "\u25BC" : "\u25B6"}
        </button>
        <button
          onClick={() => onSelectDepartment(name)}
          className="flex-1 text-left py-[6px] px-2 rounded-[var(--radius-md)] text-[length:var(--text-subheadline)] font-medium border-none cursor-pointer transition-[background,color] duration-150 ease-in-out"
          style={{
            background: isSelected ? 'var(--accent-fill)' : 'transparent',
            color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
          }}
          onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--fill-tertiary)' }}
          onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
        >
          {name}
          <span className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)] ml-[6px]">
            ({employees.length})
          </span>
        </button>
      </div>
      {expanded && (
        <div className="ml-5 border-l border-[var(--separator)] pl-2 mt-[2px]">
          {employees.map((emp) => (
            <EmployeeNode
              key={emp.name}
              employee={emp}
              selected={selectedEmployee === emp.name}
              onSelect={onSelectEmployee}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ViewToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: "hierarchy" | "department";
  setViewMode: (mode: "hierarchy" | "department") => void;
}) {
  return (
    <div className="flex gap-1 mb-2 px-1">
      <button
        onClick={() => setViewMode("hierarchy")}
        className="text-[10px] py-[2px] px-[8px] rounded-full border-none cursor-pointer"
        style={{
          background: viewMode === "hierarchy" ? "var(--accent-fill)" : "var(--fill-tertiary)",
          color: viewMode === "hierarchy" ? "var(--accent)" : "var(--text-tertiary)",
        }}
      >
        Hierarchy
      </button>
      <button
        onClick={() => setViewMode("department")}
        className="text-[10px] py-[2px] px-[8px] rounded-full border-none cursor-pointer"
        style={{
          background: viewMode === "department" ? "var(--accent-fill)" : "var(--fill-tertiary)",
          color: viewMode === "department" ? "var(--accent)" : "var(--text-tertiary)",
        }}
      >
        Department
      </button>
    </div>
  );
}

export function OrgTree({
  data,
  selectedEmployee,
  selectedDepartment,
  onSelectEmployee,
  onSelectDepartment,
}: {
  data: OrgData;
  selectedEmployee: string | null;
  selectedDepartment: string | null;
  onSelectEmployee: (name: string) => void;
  onSelectDepartment: (name: string) => void;
}) {
  const hasHierarchy = data.employees.some((e) => e.directReports && e.directReports.length > 0);
  const [viewMode, setViewMode] = useState<"hierarchy" | "department">(hasHierarchy ? "hierarchy" : "department");

  if (viewMode === "hierarchy" && data.hierarchy) {
    const rootEmployees = data.employees.filter(
      (e) => e.parentName === null || e.parentName === undefined,
    );

    return (
      <div className="flex flex-col gap-1">
        {hasHierarchy && <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />}
        {rootEmployees.map((emp) => (
          <HierarchyNode
            key={emp.name}
            name={emp.name}
            employees={data.employees}
            hierarchy={data.hierarchy}
            depth={0}
            selectedEmployee={selectedEmployee}
            onSelectEmployee={onSelectEmployee}
          />
        ))}
      </div>
    );
  }

  // Department view (existing logic)
  const byDept: Record<string, Employee[]> = {};
  const ungrouped: Employee[] = [];

  for (const emp of data.employees) {
    if (emp.department) {
      if (!byDept[emp.department]) byDept[emp.department] = [];
      byDept[emp.department].push(emp);
    } else {
      ungrouped.push(emp);
    }
  }

  for (const dept of data.departments) {
    if (!byDept[dept]) byDept[dept] = [];
  }

  const executive = data.employees.find((e) => e.rank === "executive");

  return (
    <div className="flex flex-col gap-1">
      {hasHierarchy && <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />}

      {executive && (
        <div className="mb-2">
          <EmployeeNode
            employee={executive}
            selected={selectedEmployee === executive.name}
            onSelect={onSelectEmployee}
          />
        </div>
      )}

      {Object.entries(byDept)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dept, employees]) => (
          <DepartmentNode
            key={dept}
            name={dept}
            employees={employees.filter((e) => e.name !== executive?.name)}
            selectedEmployee={selectedEmployee}
            onSelectEmployee={onSelectEmployee}
            onSelectDepartment={onSelectDepartment}
            selectedDepartment={selectedDepartment}
          />
        ))}

      {ungrouped
        .filter((e) => e.name !== executive?.name)
        .map((emp) => (
          <EmployeeNode
            key={emp.name}
            employee={emp}
            selected={selectedEmployee === emp.name}
            onSelect={onSelectEmployee}
          />
        ))}
    </div>
  );
}
