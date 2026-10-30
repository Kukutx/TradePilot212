// Reads a skill's SKILL.md the way scripts/build-prompts.ts writes it into skill-prompts.ts, so the test that keeps
// the two the same reads it the same way.

export interface SkillPrompt { name: string; description: string; body: string }

/**
 * The name and description from the front matter, and the steps after it. Only plain one-line values are read: a
 * quoted, folded or multi-line value would read differently here than in a YAML loader, so it is refused.
 */
export function parseSkill(folder: string, text: string): SkillPrompt {
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`skills/${folder}/SKILL.md has no front matter`);
  const field = (key: string) => {
    const value = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(match[1]!)?.[1]?.trim();
    if (!value || /^[>|"'[{]/.test(value)) throw new Error(`skills/${folder}/SKILL.md: write ${key} as plain text on one line`);
    return value;
  };
  const name = field("name");
  if (name !== folder) throw new Error(`skills/${folder}/SKILL.md names itself ${name}`);
  return { name, description: field("description"), body: match[2]!.trim() };
}
