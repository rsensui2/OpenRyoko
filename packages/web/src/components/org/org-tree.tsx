"use client";
import React, { useState } from "react";

interface Employee {
  name: string;
  displayName?: string;
  rank?: string;
  engine?: string;
  department?: string;
}

interface OrgData {
  departments: string[];
  employees: Employee[];
}

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
  // Group employees by department
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

  // Include departments from data.departments even if no employees
  for (const dept of data.departments) {
    if (!byDept[dept]) byDept[dept] = [];
  }

  // Find the executive (COO) to show at top
  const executive = data.employees.find(
    (e) => e.rank === "executive",
  );

  return (
    <div className="flex flex-col gap-1">
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
