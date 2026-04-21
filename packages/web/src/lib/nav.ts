import {
  Home,
  MessageSquare,
  Users,
  Clock,
  LayoutGrid,
  Activity,
  Zap,
  Settings,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "ホーム", icon: Home },
  { href: "/chat", label: "チャット", icon: MessageSquare },
  { href: "/org", label: "組織", icon: Users },
  { href: "/kanban", label: "カンバン", icon: LayoutGrid },
  { href: "/cron", label: "スケジュール", icon: Clock },
  { href: "/logs", label: "アクティビティ", icon: Activity },
  { href: "/skills", label: "スキル", icon: Zap },
  { href: "/settings", label: "設定", icon: Settings },
]
