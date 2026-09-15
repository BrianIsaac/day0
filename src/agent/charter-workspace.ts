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

export function identityFromCharter(c: Charter): string {
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
