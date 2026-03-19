"use client";

import { useNotifications } from "@/hooks/use-notifications";
import { X, CheckCircle, AlertTriangle, Info, XCircle } from "lucide-react";
import type { NotificationType } from "@/lib/notifications";

const ICON_MAP: Record<NotificationType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const COLOR_MAP: Record<NotificationType, string> = {
  success: "var(--system-green)",
  error: "var(--system-red)",
  warning: "var(--system-orange)",
  info: "var(--system-blue)",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ToastContainer() {
  const { toasts, dismissToast } = useNotifications();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-[380px] w-full pointer-events-none">
      {toasts.map((toast) => {
        const Icon = ICON_MAP[toast.type];
        const color = COLOR_MAP[toast.type];
        return (
          <div
            key={toast.id}
            className="animate-slide-down pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 bg-[var(--material-thick)] backdrop-blur-[40px] backdrop-saturate-[1.8] border border-[var(--separator)] rounded-[var(--radius-md)] shadow-[var(--shadow-overlay)]"
            style={{
              WebkitBackdropFilter: "blur(40px) saturate(180%)",
            }}
          >
            <Icon size={18} className="shrink-0 mt-px" style={{ color }} />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-[var(--text-primary)] leading-[1.3]">
                {toast.title}
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5 leading-[1.3] overflow-hidden text-ellipsis whitespace-nowrap">
                {toast.message}
              </div>
              <div className="text-[11px] text-[var(--text-quaternary)] mt-1">
                {formatTime(toast.timestamp)}
              </div>
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss"
              className="bg-transparent border-none cursor-pointer text-[var(--text-tertiary)] p-0.5 shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
