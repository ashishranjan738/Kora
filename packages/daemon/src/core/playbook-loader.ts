import fs from "fs/promises";
import path from "path";

export interface Playbook {
  name: string;
  description: string;
  agents: PlaybookAgent[];
}

export interface PlaybookAgent {
  name: string;
  role: "master" | "worker";
  provider?: string;
  model: string;
  persona?: string;
  initialTask?: string;
  extraCliArgs?: string[];
}

/** Load a playbook from the global playbooks directory */
export async function loadPlaybook(globalConfigDir: string, name: string): Promise<Playbook | null> {
  const filePath = path.join(globalConfigDir, "playbooks", `${name}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as Playbook;
  } catch {
    return null;
  }
}

/** List all available playbooks */
export async function listPlaybooks(globalConfigDir: string): Promise<string[]> {
  const dir = path.join(globalConfigDir, "playbooks");
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  } catch {
    return [];
  }
}

/** Save a playbook */
export async function savePlaybook(globalConfigDir: string, playbook: Playbook): Promise<void> {
  const dir = path.join(globalConfigDir, "playbooks");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${slugify(playbook.name)}.json`);
  await fs.writeFile(filePath, JSON.stringify(playbook, null, 2), "utf-8");
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Create built-in playbooks on first run */
export async function ensureBuiltinPlaybooks(globalConfigDir: string): Promise<void> {
  const dir = path.join(globalConfigDir, "playbooks");
  await fs.mkdir(dir, { recursive: true });

  const skipPerms = ["--dangerously-skip-permissions"];

  const builtins: Playbook[] = [
    {
      name: "Solo Agent",
      description: "Single master agent for simple tasks",
      agents: [
        { name: "Agent", role: "master", model: "default", persona: "You are a helpful coding assistant.", extraCliArgs: skipPerms },
      ],
    },
    {
      name: "Master + 2 Workers",
      description: "One master that delegates to two workers",
      agents: [
        { name: "Orchestrator", role: "master", model: "default", persona: "builtin:architect", extraCliArgs: skipPerms },
        { name: "Worker A", role: "worker", model: "default", persona: "builtin:backend", extraCliArgs: skipPerms },
        { name: "Worker B", role: "worker", model: "default", persona: "builtin:frontend", extraCliArgs: skipPerms },
      ],
    },
    {
      name: "Full Stack Team",
      description: "Architect + Frontend + Backend + Tests + Reviewer",
      agents: [
        { name: "Architect", role: "master", model: "default", persona: "builtin:architect", extraCliArgs: skipPerms },
        { name: "Frontend", role: "worker", model: "default", persona: "builtin:frontend", extraCliArgs: skipPerms },
        { name: "Backend", role: "worker", model: "default", persona: "builtin:backend", extraCliArgs: skipPerms },
        { name: "Tests", role: "worker", model: "default", persona: "builtin:tester", extraCliArgs: skipPerms },
        { name: "Reviewer", role: "worker", model: "default", persona: "builtin:reviewer", extraCliArgs: skipPerms },
      ],
    },
    {
      name: "Research Team",
      description: "Architect + Researcher + Backend + Frontend",
      agents: [
        { name: "Architect", role: "master", model: "default", persona: "builtin:architect", extraCliArgs: skipPerms },
        { name: "Researcher", role: "worker", model: "default", persona: "builtin:researcher", extraCliArgs: skipPerms },
        { name: "Backend", role: "worker", model: "default", persona: "builtin:backend", extraCliArgs: skipPerms },
        { name: "Frontend", role: "worker", model: "default", persona: "builtin:frontend", extraCliArgs: skipPerms },
      ],
    },
  ];

  for (const pb of builtins) {
    const filePath = path.join(dir, `${slugify(pb.name)}.json`);
    // Always overwrite built-in playbooks to pick up fixes (provider, model, args)
    await fs.writeFile(filePath, JSON.stringify(pb, null, 2), "utf-8");
  }
}
