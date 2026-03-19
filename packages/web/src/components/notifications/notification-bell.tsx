"use client";

import { useState, useRef, useEffect } from "react";
import { Bell, CheckCircle, XCircle, AlertTriangle, Info, Check, Trash2 } from "lucide-react";
import { useNotifications } from "@/hooks/use-notifications";
import type { NotificationType } from "@/lib/notifications";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<NotificationType, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const COLOR_MAP: Record<NotificationType, string> = {
  success: "text-[var(--system-green)]",
  error: "text-[var(--system-red)]",
  warning: "text-[var(--system-orange)]",
  info: "text-[var(--system-blue)]",
};

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function NotificationBell() {
  const { notifications, unreadCount, markAllRead, markRead, clearAll } =
    useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={panelRef} className="relative">
      <Button
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        variant="ghost"
        size="icon-sm"
        className="relative text-muted-foreground"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--system-red)] px-1 text-[10px] font-bold leading-none text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div className="animate-scale-up absolute right-0 top-[calc(100%+8px)] z-[200] flex max-h-[480px] w-[360px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-[40px]">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <span className="text-[15px] font-semibold text-foreground">Notifications</span>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  title="Mark all as read"
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--system-blue)] transition-colors hover:bg-accent"
                >
                  <Check size={14} />
                  Read all
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={() => {
                    clearAll();
                    setOpen(false);
                  }}
                  title="Clear all"
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                No notifications yet
              </div>
            ) : (
              notifications.map((notif) => {
                const Icon = ICON_MAP[notif.type];
                return (
                  <div
                    key={notif.id}
                    onClick={() => markRead(notif.id)}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 border-b border-border px-4 py-2.5 transition-colors hover:bg-accent",
                      notif.read ? "bg-transparent" : "bg-[var(--material-ultra-thin)]"
                    )}
                  >
                    <Icon size={16} className={cn("mt-0.5 shrink-0", COLOR_MAP[notif.type])} />
                    <div className="min-w-0 flex-1">
                      <div className={cn("text-[13px] leading-[1.3] text-foreground", notif.read ? "font-normal" : "font-semibold")}>
                        {notif.title}
                      </div>
                      <div className="mt-0.5 truncate text-xs leading-[1.3] text-[var(--text-secondary)]">
                        {notif.message}
                      </div>
                    </div>
                    <span className="mt-0.5 shrink-0 whitespace-nowrap text-[11px] text-[var(--text-quaternary)]">
                      {formatTimeAgo(notif.timestamp)}
                    </span>
                    {!notif.read && (
                      <span className="mt-[5px] size-2 shrink-0 rounded-full bg-[var(--system-blue)]" />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
