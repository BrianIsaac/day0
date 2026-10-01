import type { Charter } from './charter';

/**
 * The workspace files rendered from a charter: IDENTITY.md and TOOLS.md.
 *
 * Kept apart from `charter.ts`, which builds the synthesis agent at module
 * load, so the Convex mutations that re-render these files on approval and
 * on amendment never pull the model client into the default runtime.
 */

export function renderBullets(values: string[], indent: string): string[] {
  if (values.length === 0) return [`${indent}- (none)`];
  return values.map((v) => `${indent}- ${v}`);
}

/**
 * Render USER.md, the file that names the employee's manager: from the one-to-one's label for the
 * manager at the draft, and from the manager's address once a handover moves the employee.
 *
 * @param manager - Who the employee reports to, as the file names them.
 */
export function userFromManager(manager: string): string {
  return `# USER\n\nBoss: ${manager}\n`;
}

/**
 * Render IDENTITY.md from a charter and the agent's manager.
 *
 * The manager is the agent row's `bossEmail`, the one source for who
 * approves (U9 D3 (b)): the charter's own `approvalChain` is what the 1:1
 * drafted and is not rendered, so the file cannot name a manager the product
 * does not ask. A draft is rendered without one until approval renders it.
 *
 * @param c - The charter body.
 * @param manager - The agent's manager, as the agent row holds it.
 * @returns The file's Markdown.
 */
export function identityFromCharter(c: Charter, manager?: string): string {
  const lines = [
    '# IDENTITY',
    '',
    `Role: ${c.proposedFunction}`,
    '',
    `Why this hire: ${c.whyThisHire}`,
    '',
    '## Short-term goals (manager-defined)',
    `- 30-day: ${c.shortTermGoals.day30}`,
    `- 60-day: ${c.shortTermGoals.day60}`,
    `- 90-day: ${c.shortTermGoals.day90}`,
    '',
    '## Boundaries — what I will do',
    ...renderBullets(c.proposedBoundaries.willDo, ''),
    '',
    '## Boundaries — what I will NOT do',
    ...renderBullets(c.proposedBoundaries.willNotDo, ''),
    '',
    '## Escalation triggers',
    ...renderBullets(c.proposedBoundaries.escalationTriggers, ''),
    '',
    ...(manager === undefined ? [] : ['## Manager (who approves)', `- ${manager}`, '']),
    '## Key relationships',
    ...c.namedCollaborators.map((n) => `- ${n.name} — ${n.topic} (intro path: ${n.introPath})`),
    '',
  ];
  return lines.join('\n');
}

export function toolsFromCharter(c: Charter): string {
  const reading =
    c.priorityReading.length > 0 ? c.priorityReading : ['(manager pointed nothing yet)'];
  const lines = [
    '# TOOLS',
    '',
    '## Priority reading (manager-pointed)',
    ...reading.map((r) => `- ${r}`),
    '',
    '## Known surfaces (open questions until the team names them)',
    ...(c.namedSystems ?? []).map(
      (system) => `- ${system.name} (${system.class}) - ${system.whereMentioned}`,
    ),
    ...c.openQuestions
      .filter((q) => /tool|stack|tracker|surface|dashboard|wiki|spreadsheet/i.test(q))
      .map((q) => `- ${q}`),
    '',
  ];
  return lines.join('\n');
}
