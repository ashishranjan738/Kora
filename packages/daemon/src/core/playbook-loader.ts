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

  const builtins: Playbook[] = [
    {
      name: "Solo Agent",
      description: "Single master agent for simple tasks",
      agents: [
        { name: "Agent", role: "master", model: "default", persona: "You are a helpful coding assistant." },
      ],
    },
    {
      name: "Master + 2 Workers",
      description: "One master that delegates to two workers",
      agents: [
        { name: "Orchestrator", role: "master", model: "default", persona: "builtin:architect" },
        { name: "Worker A", role: "worker", model: "default", persona: "builtin:backend" },
        { name: "Worker B", role: "worker", model: "default", persona: "builtin:frontend" },
      ],
    },
    {
      name: "Full Stack Team",
      description: "Architect + Frontend + Backend + Tests + Reviewer",
      agents: [
        { name: "Architect", role: "master", model: "default", persona: "builtin:architect" },
        { name: "Frontend", role: "worker", model: "default", persona: "builtin:frontend" },
        { name: "Backend", role: "worker", model: "default", persona: "builtin:backend" },
        { name: "Tests", role: "worker", model: "default", persona: "builtin:tester" },
        { name: "Reviewer", role: "worker", model: "default", persona: "builtin:reviewer" },
      ],
    },
    {
      name: "Research Team",
      description: "Architect + Researcher + Backend + Frontend",
      agents: [
        { name: "Architect", role: "master", model: "default", persona: "builtin:architect" },
        { name: "Researcher", role: "worker", model: "default", persona: "builtin:researcher" },
        { name: "Backend", role: "worker", model: "default", persona: "builtin:backend" },
        { name: "Frontend", role: "worker", model: "default", persona: "builtin:frontend" },
      ],
    },
    {
      name: "Two-Pizza Team",
      description: "Full product team: Engineering Manager, Product Manager, Researcher, 3 Devs, Tester, Reviewer",
      agents: [
        {
          name: "Engineering Manager",
          role: "master",
          model: "default",
          persona: "You are the Engineering Manager (EM) leading a two-pizza team. You coordinate all work, break down tasks, assign them to the right engineers, unblock team members, and ensure the project ships on time. You make architectural decisions when the team is stuck. You communicate status updates and prioritize ruthlessly. Delegate implementation — you should NOT write code yourself. Focus on: task breakdown, assignment, sequencing, unblocking, and quality.",
        },
        {
          name: "Product Manager",
          role: "worker",
          model: "default",
          persona: "You are the Product Manager (PM). You define requirements, write user stories, clarify acceptance criteria, and prioritize the backlog. When engineers have questions about what to build or edge cases, you provide definitive answers. You review completed work from a product perspective — does it meet the spec? You never write code. Focus on: requirements, user stories, acceptance criteria, product review.",
        },
        {
          name: "Researcher",
          role: "worker",
          model: "default",
          persona: "builtin:researcher",
        },
        {
          name: "Dev 1",
          role: "worker",
          model: "default",
          persona: "builtin:backend",
        },
        {
          name: "Dev 2",
          role: "worker",
          model: "default",
          persona: "builtin:frontend",
        },
        {
          name: "Dev 3",
          role: "worker",
          model: "default",
          persona: "You are a full-stack developer. You work on both frontend and backend tasks as assigned by the Engineering Manager. You write clean TypeScript code, follow existing patterns, and write tests for your changes. You pick up overflow work from either frontend or backend as needed.",
        },
        {
          name: "Tester",
          role: "worker",
          model: "default",
          persona: "builtin:tester",
        },
        {
          name: "Reviewer",
          role: "worker",
          model: "default",
          persona: "builtin:reviewer",
        },
      ],
    },
  ];

  for (const pb of builtins) {
    const filePath = path.join(dir, `${slugify(pb.name)}.json`);
    // Always overwrite built-in playbooks to pick up fixes (provider, model, args)
    await fs.writeFile(filePath, JSON.stringify(pb, null, 2), "utf-8");
  }
}
