"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";

const navItems = [
  { href: "/", label: "Dashboard", icon: "~" },
  { href: "/chat", label: "Chat", icon: ">" },
  { href: "/sessions", label: "Sessions", icon: "#" },
  { href: "/org", label: "Organization", icon: "@" },
  { href: "/cron", label: "Cron", icon: "%" },
  { href: "/skills", label: "Skills", icon: "*" },
  { href: "/logs", label: "Logs", icon: "$" },
  { href: "/settings", label: "Settings", icon: "=" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-56 bg-neutral-50 border-r border-neutral-200 flex flex-col">
      <div className="px-5 py-6">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
          Jimmy
        </h1>
        <p className="text-xs text-neutral-400 mt-0.5">AI Gateway</p>
      </div>
      <nav className="flex-1 px-3">
        {navItems.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${
                active
                  ? "bg-blue-50 text-blue-600 font-medium"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
              }`}
            >
              <span className="w-5 text-center font-mono text-xs opacity-60">
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-4 border-t border-neutral-200">
        <p className="text-xs text-neutral-400">v0.1.0</p>
      </div>
    </aside>
  );
}
