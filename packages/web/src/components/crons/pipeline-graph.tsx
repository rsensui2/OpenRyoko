"use client"

import { describeCron } from "@/lib/cron-utils"

interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  employee?: string
  engine?: string
  [key: string]: unknown
}

interface PipelineGraphProps {
  crons: CronJob[]
}

export function PipelineGraph({ crons }: PipelineGraphProps) {
  if (crons.length === 0) {
    return (
      <div className="bg-[var(--material-regular)] border border-[var(--separator)] rounded-[var(--radius-md)] px-6 py-8 text-center">
        <div className="text-sm font-bold text-[var(--text-primary)] mb-2">
          No cron jobs configured
        </div>
        <div className="text-xs text-[var(--text-secondary)] max-w-[480px] mx-auto leading-[1.6]">
          Cron jobs will appear here as cards once configured.
        </div>
      </div>
    )
  }

  const enabled = crons.filter(c => c.enabled)
  const disabled = crons.filter(c => !c.enabled)

  return (
    <div>
      {enabled.length > 0 && (
        <CronCardGroup crons={enabled} label="Enabled" />
      )}
      {disabled.length > 0 && (
        <CronCardGroup crons={disabled} label="Disabled" />
      )}
    </div>
  )
}

function CronCardGroup({ crons, label }: { crons: CronJob[]; label: string }) {
  return (
    <div className="mb-6">
      <div className="text-[13px] font-bold text-[var(--text-secondary)] mb-3">
        {label} ({crons.length})
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
        {crons.map(cron => {
          const borderColor = cron.enabled ? "var(--system-green)" : "var(--text-tertiary)"

          return (
            <div
              key={cron.id}
              className="bg-[var(--material-regular)] rounded-[var(--radius-md)] border border-[var(--separator)] px-3.5 py-2.5"
              style={{ borderLeft: `3px solid ${borderColor}` }}
            >
              {/* Name + status dot */}
              <div className="flex items-center gap-1.5 mb-1">
                <div
                  className={`w-[7px] h-[7px] rounded-full shrink-0 ${
                    cron.enabled ? "bg-[var(--system-green)]" : "bg-[var(--text-tertiary)]"
                  }`}
                />
                <div className="text-xs font-semibold text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis">
                  {cron.name}
                </div>
              </div>

              {/* Schedule (human-readable) */}
              <div className="text-[10px] text-[var(--text-secondary)] mb-0.5">
                {describeCron(cron.schedule)}
              </div>

              {/* Raw schedule */}
              <div className="text-[10px] font-[var(--font-mono)] text-[var(--text-tertiary)] mb-1">
                {cron.schedule}
              </div>

              {/* Badges row */}
              <div className="flex flex-wrap gap-1">
                {/* Employee badge */}
                {cron.employee && (
                  <span
                    className="inline-block text-[9px] px-1.5 py-px rounded text-[var(--system-blue)]"
                    style={{ background: "color-mix(in srgb, var(--system-blue) 15%, transparent)" }}
                  >
                    {cron.employee}
                  </span>
                )}
                {/* Engine badge */}
                {cron.engine && (
                  <span className="inline-block text-[9px] px-1.5 py-px rounded bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]">
                    {cron.engine}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
