"use client";
import { useState } from "react";

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

const rankColors: Record<string, string> = {
  executive: "bg-purple-100 text-purple-700",
  manager: "bg-blue-100 text-blue-700",
  senior: "bg-green-100 text-green-700",
  employee: "bg-neutral-100 text-neutral-500",
};

const engineIcons: Record<string, string> = {
  claude: "C",
  codex: "X",
};

function RankBadge({ rank }: { rank: string }) {
  const colors = rankColors[rank] || rankColors.employee;
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${colors}`}>
      {rank}
    </span>
  );
}

function EngineIcon({ engine }: { engine: string }) {
  return (
    <span className="text-[10px] font-mono bg-neutral-100 text-neutral-500 px-1 py-0.5 rounded">
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
      className={`w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
        selected
          ? "bg-blue-50 text-blue-700"
          : "text-neutral-700 hover:bg-neutral-100"
      }`}
    >
      <span className="truncate flex-1">
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

  return (
    <div>
      <div className="flex items-center">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-5 h-5 flex items-center justify-center text-neutral-400 hover:text-neutral-600 text-xs flex-shrink-0"
        >
          {expanded ? "\u25BC" : "\u25B6"}
        </button>
        <button
          onClick={() => onSelectDepartment(name)}
          className={`flex-1 text-left px-2 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            selectedDepartment === name
              ? "bg-blue-50 text-blue-700"
              : "text-neutral-800 hover:bg-neutral-100"
          }`}
        >
          {name}
          <span className="text-xs text-neutral-400 ml-1.5">
            ({employees.length})
          </span>
        </button>
      </div>
      {expanded && (
        <div className="ml-5 border-l border-neutral-200 pl-2 mt-0.5">
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
    <div className="space-y-1">
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
