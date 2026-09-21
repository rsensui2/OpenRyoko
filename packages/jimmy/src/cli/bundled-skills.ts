import fs from "node:fs";
import path from "node:path";
import { applyTemplateReplacements, isTemplateFile } from "../shared/templateReplacements.js";

function entryExists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Add newly bundled skills on upgrade, including when no version migration is
 * pending. Existing skills (including user-managed symlinks) belong to the user. */
export function stageMissingBundledSkills(
  templateDir: string,
  home: string,
  replacements: Record<string, string>,
): string[] {
  const source = path.join(templateDir, "skills");
  if (!fs.existsSync(source)) return [];
  const added: string[] = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillSource = path.join(source, entry.name);
    if (!fs.existsSync(path.join(skillSource, "SKILL.md"))) continue;
    const destination = path.join(home, "skills", entry.name);
    if (entryExists(destination)) continue;

    // Stage outside skills/ so a running gateway never discovers a partial skill.
    const staging = fs.mkdtempSync(path.join(home, ".bundled-skill-"));
    const staged = path.join(staging, entry.name);
    try {
      fs.cpSync(skillSource, staged, { recursive: true });
      const render = (directory: string): void => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, item.name);
          if (item.isDirectory()) render(file);
          else if (item.isFile() && isTemplateFile(item.name)) {
            fs.writeFileSync(file, applyTemplateReplacements(fs.readFileSync(file, "utf8"), replacements));
          }
        }
      };
      render(staged);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (entryExists(destination)) continue;
      fs.renameSync(staged, destination);
      added.push(entry.name);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  return added;
}
