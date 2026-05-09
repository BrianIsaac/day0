/**
 * The 8-file workspace convention. Slot table is identical to
 * Protean's; Day0 stores the file content in Convex `workspace` rows
 * (one row per `(agentId, fileName)`) instead of S3.
 *
 * This module exports the slot constants + helpers; the actual reads
 * and writes happen via Convex queries/mutations.
 */

interface WorkspaceFileSpec {
  slot: number;
  name: string;
  dynamic?: boolean;
}

export const WORKSPACE_FILES = {
  AGENTS: { slot: 10, name: 'AGENTS.md' },
  SOUL: { slot: 20, name: 'SOUL.md' },
  IDENTITY: { slot: 30, name: 'IDENTITY.md' },
  USER: { slot: 40, name: 'USER.md' },
  TOOLS: { slot: 50, name: 'TOOLS.md' },
  BOOTSTRAP: { slot: 60, name: 'BOOTSTRAP.md' },
  MEMORY: { slot: 70, name: 'MEMORY.md' },
  HEARTBEAT: { slot: 999, name: 'HEARTBEAT.md', dynamic: true },
} as const satisfies Record<string, WorkspaceFileSpec>;

export type WorkspaceFileName = (typeof WORKSPACE_FILES)[keyof typeof WORKSPACE_FILES]['name'];

export const WORKSPACE_FILE_NAMES: readonly WorkspaceFileName[] = Object.values(
  WORKSPACE_FILES,
).map((f) => f.name) as readonly WorkspaceFileName[];

export function isKnownWorkspaceFile(name: string): name is WorkspaceFileName {
  return (WORKSPACE_FILE_NAMES as readonly string[]).includes(name);
}

export const SLOT_ORDER = Object.values(WORKSPACE_FILES)
  .filter((f) => !('dynamic' in f && f.dynamic))
  .sort((a, b) => a.slot - b.slot);

/**
 * Build a single system-prompt blob from the 8 workspace files in
 * slot order, plus the agent's skills index. OpenAI auto-caches
 * stable prefixes >1024 tokens; we don't need explicit cache_control
 * markers (that's an Anthropic-only concept).
 */
export function buildSystemPrompt(args: {
  workspace: Record<string, string>;
  skills: Array<{ name: string; description: string }>;
}): string {
  const sections: string[] = [];
  for (const file of SLOT_ORDER) {
    const body = args.workspace[file.name] ?? '';
    sections.push(`# ${file.name}\n${body}`.trimEnd());
  }
  const skillsBlock =
    args.skills.length === 0
      ? '# Available skills\n(none registered yet)'
      : `# Available skills\n${args.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
  sections.push(skillsBlock);
  const heartbeat = args.workspace[WORKSPACE_FILES.HEARTBEAT.name] ?? '';
  sections.push(`# ${WORKSPACE_FILES.HEARTBEAT.name}\n${heartbeat}`.trimEnd());
  return sections.join('\n\n');
}
