import { loadSkillsRegistry } from "../skills";

export async function runSkills(_args: string[]): Promise<void> {
  const reg = await loadSkillsRegistry();
  for (const s of reg.skills) {
    console.log(
      [
        `- ${s.id}`,
        `  name: ${s.name}`,
        `  description: ${s.description}`,
        `  entrypoint: ${s.entrypoint}`,
      ].join("\n")
    );
  }
}

