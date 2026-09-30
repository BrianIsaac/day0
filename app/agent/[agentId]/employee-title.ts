import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { establishConvexCaller } from '@/lib/convex-caller';
import { log } from '@/lib/logger';
import { EMPLOYEE_TAB_LABELS } from './employee-tabs';

/**
 * Reads an employee's name as the signed-in manager.
 *
 * @returns The name, or null when the caller is not signed in or does not employ it.
 */
export type EmployeeNameReader = (agentId: Id<'agents'>) => Promise<string | null>;

/**
 * The employee's name, read on the server as the manager whose page it is, through the seam every
 * server route acts on Convex through.
 *
 * @param agentId - The employee, from the route.
 */
export async function readEmployeeName(agentId: Id<'agents'>): Promise<string | null> {
  const caller = await establishConvexCaller();
  if (!caller.ok) return null;
  const agent = await caller.client.query(api.agents.get, { agentId });
  return agent?.name ?? null;
}

/**
 * The browser tab's title for an employee's page: "<name> · <tab> · Day0", the tab filled in by
 * each tab's page and Needs you by default (the hosted walk's m16: every route read "Day0").
 *
 * A title is never worth a page that does not load: a name the server cannot read (signed out,
 * someone else's employee, the backend unreachable) leaves it out, and the failure is logged.
 *
 * @param agentId - The employee, from the route.
 * @param readName - How the name is read; the server read by default.
 */
export async function employeeTitle(
  agentId: Id<'agents'>,
  readName: EmployeeNameReader = readEmployeeName,
): Promise<NonNullable<Metadata['title']>> {
  const name = await readName(agentId).catch((error: unknown): null => {
    // A redirect or a dynamic-rendering signal is Next's own and must reach it.
    unstable_rethrow(error);
    log.warn('employee title read without the name', {
      agentId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  const who = name === null ? '' : `${name} · `;
  return {
    default: `${who}${EMPLOYEE_TAB_LABELS['needs-you']} · Day0`,
    template: `${who}%s · Day0`,
  };
}
