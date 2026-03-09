"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { renderMarkdown } from "@/lib/sanitize";
import { PageLayout } from "@/components/page-layout";
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
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Jimmy";
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
      <div
        style={{
          height: "100%",
          overflowY: "auto",
          padding: "var(--space-6)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--space-6)",
          }}
        >
          <div>
            <h2
              style={{
                fontSize: "var(--text-title2)",
                fontWeight: "var(--weight-bold)",
                color: "var(--text-primary)",
                marginBottom: "var(--space-1)",
              }}
            >
              Skills
            </h2>
            <p
              style={{
                fontSize: "var(--text-body)",
                color: "var(--text-tertiary)",
              }}
            >
              Capabilities and learned behaviors
            </p>
          </div>
          <button
            onClick={() =>
              alert(
                `To create a new skill, chat with ${portalName} and ask to learn something new.`,
              )
            }
            style={{
              padding: "var(--space-2) var(--space-4)",
              borderRadius: "var(--radius-md, 12px)",
              background:
                "color-mix(in srgb, var(--accent) 12%, transparent)",
              color: "var(--accent)",
              border: "none",
              cursor: "pointer",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-medium)",
            }}
          >
            + Create Skill
          </button>
        </div>

        {error && (
          <div
            style={{
              marginBottom: "var(--space-4)",
              borderRadius: "var(--radius-md, 12px)",
              background:
                "color-mix(in srgb, var(--system-red) 10%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
              padding: "var(--space-3) var(--space-4)",
              fontSize: "var(--text-body)",
              color: "var(--system-red)",
            }}
          >
            Failed to load skills: {error}
          </div>
        )}

        {loading ? (
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-8)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-body)",
            }}
          >
            Loading...
          </div>
        ) : skills.length === 0 && !error ? (
          <Card>
            <CardContent>
              <div
                style={{
                  textAlign: "center",
                  padding: "var(--space-6)",
                }}
              >
                <p
                  style={{
                    fontSize: "var(--text-body)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  No skills yet
                </p>
                <p
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-quaternary)",
                    marginTop: "var(--space-1)",
                  }}
                >
                  Chat with {portalName} to teach new skills
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            {skills.map((skill) => (
              <Card
                key={skill.name}
                className="py-4 cursor-pointer transition-colors hover:border-[var(--accent)]"
                onClick={() => openSkill(skill)}
                style={{ cursor: "pointer" }}
              >
                <CardContent className="flex flex-col gap-3">
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "var(--radius-md, 12px)",
                      background:
                        "color-mix(in srgb, var(--system-yellow) 12%, transparent)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--system-yellow)",
                    }}
                  >
                    <Zap size={20} />
                  </div>
                  <div>
                    <p
                      style={{
                        fontSize: "var(--text-body)",
                        fontWeight: "var(--weight-semibold)",
                        color: "var(--text-primary)",
                        marginBottom: 2,
                      }}
                    >
                      {skill.name}
                    </p>
                    <p
                      style={{
                        fontSize: "var(--text-caption1)",
                        color: "var(--text-tertiary)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
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
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "var(--space-2) 0",
              }}
            >
              {contentLoading ? (
                <p
                  style={{
                    fontSize: "var(--text-body)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  Loading...
                </p>
              ) : skillContent ? (
                <div
                  style={{
                    fontSize: "var(--text-body)",
                    lineHeight: 1.7,
                    color: "var(--text-secondary)",
                  }}
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
