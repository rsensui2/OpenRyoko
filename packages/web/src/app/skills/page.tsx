"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { renderMarkdown } from "@/lib/sanitize";
import { PageLayout } from "@/components/page-layout";
import { useBreadcrumbs } from "@/context/breadcrumb-context";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Zap } from "lucide-react";
import { useSettings } from "@/app/settings-provider";

interface Skill {
  name: string;
  description?: string;
  content?: string;
  [key: string]: unknown;
}

export default function SkillsPage() {
  useBreadcrumbs([{ label: 'Skills' }])
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Jinn";
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    api
      .getSkills()
      .then((data) => setSkills(data as Skill[]))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function openSkill(skill: Skill) {
    setSelectedSkill(skill);
    setDialogOpen(true);
    setContentLoading(true);
    api
      .getSkill(skill.name)
      .then((data) => {
        const d = data as Record<string, unknown>;
        setSkillContent(
          (d.content as string) ||
            (d.skillMd as string) ||
            JSON.stringify(d, null, 2),
        );
      })
      .catch(() => setSkillContent("Failed to load skill content"))
      .finally(() => setContentLoading(false));
  }

  function closeDialog() {
    setDialogOpen(false);
    setSelectedSkill(null);
    setSkillContent(null);
  }

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto p-[var(--space-6)]">
        {/* Header */}
        <div className="flex items-center justify-between mb-[var(--space-6)]">
          <div>
            <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-1)]">
              Skills
            </h2>
            <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
              Capabilities and learned behaviors
            </p>
          </div>
          <button
            onClick={() =>
              alert(
                `To create a new skill, chat with ${portalName} and ask to learn something new.`,
              )
            }
            className="py-[var(--space-2)] px-[var(--space-4)] rounded-[var(--radius-md,12px)] text-[var(--accent)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-medium)]"
            style={{
              background:
                "color-mix(in srgb, var(--accent) 12%, transparent)",
            }}
          >
            + Create Skill
          </button>
        </div>

        {error && (
          <div
            className="mb-[var(--space-4)] rounded-[var(--radius-md,12px)] py-[var(--space-3)] px-[var(--space-4)] text-[length:var(--text-body)] text-[var(--system-red)]"
            style={{
              background:
                "color-mix(in srgb, var(--system-red) 10%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
            }}
          >
            Failed to load skills: {error}
          </div>
        )}

        {loading ? (
          <div className="text-center p-[var(--space-8)] text-[var(--text-tertiary)] text-[length:var(--text-body)]">
            Loading...
          </div>
        ) : skills.length === 0 && !error ? (
          <Card>
            <CardContent>
              <div className="text-center p-[var(--space-6)]">
                <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
                  No skills yet
                </p>
                <p className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)] mt-[var(--space-1)]">
                  Chat with {portalName} to teach new skills
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-[var(--space-4)]">
            {skills.map((skill) => (
              <Card
                key={skill.name}
                className="py-4 cursor-pointer transition-colors hover:border-[var(--accent)]"
                onClick={() => openSkill(skill)}
              >
                <CardContent className="flex flex-col gap-3">
                  <div
                    className="w-10 h-10 rounded-[var(--radius-md,12px)] flex items-center justify-center text-[var(--system-yellow)]"
                    style={{
                      background:
                        "color-mix(in srgb, var(--system-yellow) 12%, transparent)",
                    }}
                  >
                    <Zap size={20} />
                  </div>
                  <div>
                    <p className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] mb-0.5">
                      {skill.name}
                    </p>
                    <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] line-clamp-2">
                      {skill.description || "No description"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Skill detail dialog */}
        <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>{selectedSkill?.name ?? "Skill"}</DialogTitle>
              <DialogDescription>
                {selectedSkill?.description || "Skill details"}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto py-[var(--space-2)]">
              {contentLoading ? (
                <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
                  Loading...
                </p>
              ) : skillContent ? (
                <div
                  className="text-[length:var(--text-body)] leading-[1.7] text-[var(--text-secondary)]"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(skillContent),
                  }}
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </PageLayout>
  );
}
