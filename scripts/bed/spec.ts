/**
 * The company bed as tracked: `bed/company/linear.json` read and checked, and
 * the hand steps it implies, which both `./setup.sh --company` and the README
 * print. This module reads files only, so the setup can import it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const BED_DIR = 'bed/company';
export const LINEAR_KEY_ENV = 'DAY0_BED_LINEAR_API_KEY';
export const SLACK_TOKEN_ENV = 'DAY0_BED_SLACK_BOT_TOKEN';
export const NOTION_TOKEN_ENV = 'DAY0_BED_NOTION_TOKEN';
/** The five channels the bed's handbooks and Slack policy name, in the order the policy lists them. */
export const BED_CHANNELS: readonly string[] = [
  'revops-asks',
  'revops',
  'finance-close',
  'logistics-desk',
  'ops-requests',
];

const ticketSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  team: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  state: z.string().min(1),
  late: z.boolean().optional(),
});

const specSchema = z.object({
  label: z.string().min(1),
  states: z.array(z.string().min(1)).min(1),
  /** Named subsets of the tickets a sitting may file instead of all of them. */
  sets: z.record(z.string().regex(/^[a-z0-9-]+$/), z.array(z.string().min(1)).min(1)).default({}),
  teams: z
    .array(z.object({ key: z.string().min(1), name: z.string().min(1), project: z.string().min(1) }))
    .min(1),
  tickets: z.array(ticketSchema).min(1),
});

export type BedSpec = z.infer<typeof specSchema>;
export type BedTicket = z.infer<typeof ticketSchema>;

/**
 * Read and check `bed/company/linear.json`.
 *
 * Args:
 *   cwd: Repository root.
 *
 * Returns:
 *   The bed's teams and tickets.
 *
 * Raises:
 *   Error: If the file is malformed or names a team or state it does not declare.
 */
export function loadBedSpec(cwd: string): BedSpec {
  const spec = specSchema.parse(JSON.parse(readFileSync(join(cwd, BED_DIR, 'linear.json'), 'utf8')));
  const keys = new Set<string>();
  for (const ticket of spec.tickets) {
    if (keys.has(ticket.key)) throw new Error(`linear.json names ticket ${ticket.key} twice.`);
    keys.add(ticket.key);
    if (!spec.teams.some((team) => team.key === ticket.team)) {
      throw new Error(`linear.json puts ${ticket.key} in team ${ticket.team}, which it does not declare.`);
    }
    if (!spec.states.includes(ticket.state)) {
      throw new Error(`linear.json puts ${ticket.key} in state ${ticket.state}, which it does not declare.`);
    }
  }
  for (const [name, members] of Object.entries(spec.sets)) {
    for (const key of members) {
      const ticket = spec.tickets.find((candidate) => candidate.key === key);
      if (!ticket) throw new Error(`linear.json set ${name} names ticket ${key}, which it does not declare.`);
      if (ticket.late) throw new Error(`linear.json set ${name} names ${key}, a late ticket that post files.`);
    }
  }
  return spec;
}

/**
 * The tickets a seed files: a named set, or every ticket that is not late.
 *
 * Args:
 *   spec: The bed.
 *   set: The set's name, or undefined for the full seed.
 *
 * Returns:
 *   The tickets, in the file's order.
 *
 * Raises:
 *   Error: If the set is not declared; the message names the sets that are.
 */
export function ticketsToFile(spec: BedSpec, set: string | undefined): BedTicket[] {
  if (set === undefined) return spec.tickets.filter((ticket) => !ticket.late);
  const members = spec.sets[set];
  if (!members) {
    const names = Object.keys(spec.sets);
    throw new Error(`linear.json has no set ${set}; its sets are ${names.length > 0 ? names.join(', ') : 'none'}.`);
  }
  return spec.tickets.filter((ticket) => members.includes(ticket.key));
}

/**
 * What the operator makes by hand, once, before `pnpm bed:company check` can
 * be green.
 *
 * Args:
 *   spec: The bed.
 *
 * Returns:
 *   Lines to print, unindented.
 */
export function companyHandSteps(spec: BedSpec): string[] {
  const teams = spec.teams.map((team) => `${team.key} (${team.name}, project "${team.project}")`).join(', ');
  return [
    `1. Linear, as a workspace admin: the teams ${teams}, each with the workflow states ${spec.states.join(', ')}.`,
    `2. Slack: the public channels ${BED_CHANNELS.map((name) => `#${name}`).join(', ')}, and one shared bot app with chat:write.customize, invited to all five. Then the asks of ${BED_DIR}/slack-asks.md, posted once as yourself and left standing (that file says which a demo sitting keeps).`,
    `3. Notion: the two pages in ${BED_DIR}/notion/, pasted under one parent page shared with the integration (${BED_DIR}/notion/README.md).`,
    `4. .env.local: ${LINEAR_KEY_ENV}, ${SLACK_TOKEN_ENV} and ${NOTION_TOKEN_ENV}.`,
    'Then `pnpm bed:company check` until it is all green, and `pnpm bed:company seed`.',
    ...Object.entries(spec.sets).map(
      ([name, keys]) =>
        `For a sitting that files only ${keys.join(', ')}: \`pnpm bed:company check --set ${name}\`, then \`pnpm bed:company seed --set ${name}\`; every other bed ticket is archived.`,
    ),
  ];
}
