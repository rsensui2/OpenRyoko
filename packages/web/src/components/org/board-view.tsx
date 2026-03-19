"use client";
import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Task {
  id?: string;
  title: string;
  assignee?: string;
  priority?: string;
  status: string;
  [key: string]: unknown;
}

interface BoardData {
  name?: string;
  columns?: Record<string, Task[]>;
  tasks?: Task[];
  [key: string]: unknown;
}

const priorityStyles: Record<string, React.CSSProperties> = {
  high: { background: 'color-mix(in srgb, var(--system-red) 12%, transparent)', color: 'var(--system-red)', borderColor: 'color-mix(in srgb, var(--system-red) 25%, transparent)' },
  medium: { background: 'color-mix(in srgb, var(--system-orange) 12%, transparent)', color: 'var(--system-orange)', borderColor: 'color-mix(in srgb, var(--system-orange) 25%, transparent)' },
  low: { background: 'var(--fill-tertiary)', color: 'var(--text-tertiary)', borderColor: 'var(--separator)' },
};

const columnLabels: Record<string, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  inProgress: "In Progress",
  done: "Done",
};

function TaskCard({ task }: { task: Task }) {
  const pStyle = priorityStyles[task.priority || "low"] || priorityStyles.low;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-regular)] p-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
      <p className="mb-2 text-[length:var(--text-subheadline)] font-medium text-[var(--text-primary)]">{task.title}</p>
      <div className="flex items-center justify-between">
        {task.assignee && (
          <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{task.assignee}</span>
        )}
        {task.priority && (
          <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium" style={pStyle}>
            {task.priority}
          </span>
        )}
      </div>
    </div>
  );
}

function Column({ title, tasks }: { title: string; tasks: Task[] }) {
  return (
    <div className="min-w-[220px] flex-1">
      <div className="mb-3 flex items-center gap-2">
        <h4 className="text-[length:var(--text-caption1)] font-medium uppercase tracking-[0.05em] text-[var(--text-quaternary)]">
          {title}
        </h4>
        <span className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">{tasks.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {tasks.map((task, idx) => (
          <TaskCard key={task.id || idx} task={task} />
        ))}
        {tasks.length === 0 && (
          <p className="py-4 text-center text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
            No tasks
          </p>
        )}
      </div>
    </div>
  );
}

export function BoardView({ department }: { department: string }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    api
      .getDepartmentBoard(department)
      .then((data) => setBoard(data as BoardData))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [department]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-[length:var(--text-subheadline)] text-[var(--text-quaternary)]">
        Loading board...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-tertiary)] px-4 py-8 text-center">
        <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">
          No board found for {department}.
        </p>
        <p className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
          Tasks will appear here when the department has a board set up.
        </p>
      </div>
    );
  }

  if (!board) return null;

  // Support both { columns: { todo: [], ... } } and { tasks: [] } shapes
  let columns: Record<string, Task[]>;

  if (board.columns && typeof board.columns === "object") {
    columns = board.columns;
  } else if (Array.isArray(board.tasks)) {
    columns = {
      todo: board.tasks.filter((t) => t.status === "todo"),
      in_progress: board.tasks.filter(
        (t) => t.status === "in_progress" || t.status === "inProgress",
      ),
      done: board.tasks.filter((t) => t.status === "done"),
    };
  } else {
    columns = { todo: [], in_progress: [], done: [] };
  }

  const orderedKeys = ["todo", "in_progress", "inProgress", "done"];
  const displayColumns = orderedKeys
    .filter((key) => columns[key] !== undefined)
    .map((key) => ({
      key,
      title: columnLabels[key] || key,
      tasks: columns[key],
    }));

  // If no ordered keys found, show whatever columns exist
  if (displayColumns.length === 0) {
    for (const [key, tasks] of Object.entries(columns)) {
      displayColumns.push({
        key,
        title: columnLabels[key] || key,
        tasks,
      });
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-[length:var(--text-title2)] font-semibold capitalize tracking-[-0.3px] text-[var(--text-primary)]">
        {department}
      </h2>
      <p className="mb-6 text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">Department board</p>

      <div className={cn("flex gap-4 overflow-x-auto pb-4")}>
        {displayColumns.map((col) => (
          <Column key={col.key} title={col.title} tasks={col.tasks} />
        ))}
      </div>
    </div>
  );
}
