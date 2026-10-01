import 'server-only';
import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { isEmployeeNotYours } from '@/agent/employee-access';
import { establishConvexCaller } from '@/lib/convex-caller';
import { log } from '@/lib/logger';
import { departedTabTitle } from '../../handover-words';
import { EMPLOYEE_TAB_LABELS } from './employee-tabs';

/**
 * What the tab's title is about: the manager's employee by name, one the manager handed over by
 * name, or nothing the manager can name (signed out, no such employee, another account's).
 */
export type TitleSubject =
  | { readonly kind: 'employee'; readonly name: string }
  | { readonly kind: 'departed'; readonly name: string }
  | { readonly kind: 'unnamed' };

/** Reads what an employee page's title is about, as the signed-in manager. */
export type TitleSubjectReader = (agentId: Id<'agents'>) => Promise<TitleSubject>;

/**
 * What the employee page's title is about, read on the server as the manager whose page it is,
 * through the seam every server route acts on Convex through. The manager's own employee is one
 * read; only when that read refuses the employee as another account's, or finds no row, is the
 * departure asked,
 * so a link to an employee the manager handed over is titled by where it went (the v0.12.0 walk:
 * it read "Needs you", the tab of an employee that was no longer theirs).
 *
 * @param agentId - The employee, from the route.
 */
export async function readTitleSubject(agentId: Id<'agents'>): Promise<TitleSubject> {
  const caller = await establishConvexCaller();
  if (!caller.ok) return { kind: 'unnamed' };
  try {
    const agent = await caller.client.query(api.agents.get, { agentId });
    if (agent !== null) return { kind: 'employee', name: agent.name };
    // No row: retired, or never there. One the caller handed over and its new manager retired
    // since is titled by where it went, as its page says.
  } catch (error) {
    if (!isEmployeeNotYours(error)) throw error;
  }
  const page = await caller.client.query(api.transferDepartures.employeePage, { agentId });
  return page.page === 'departed'
    ? { kind: 'departed', name: page.departure.agentName }
    : { kind: 'unnamed' };
}

/**
 * The browser tab's title for an employee's page: "<name> · <tab> · Day0", the tab filled in by
 * each tab's page and Needs you by default (the hosted walk's m16: every route read "Day0"). An
 * employee the manager handed over is titled by where it went on every tab, since the template
 * carries no tab.
 *
 * A title is never worth a page that does not load: a name the server cannot read (signed out,
 * someone else's employee, the backend unreachable) leaves it out, and a failure is logged.
 *
 * @param agentId - The employee, from the route.
 * @param readSubject - How the title's subject is read; the server read by default.
 */
export async function employeeTitle(
  agentId: Id<'agents'>,
  readSubject: TitleSubjectReader = readTitleSubject,
): Promise<NonNullable<Metadata['title']>> {
  const subject = await readSubject(agentId).catch((error: unknown): TitleSubject => {
    // A redirect or a dynamic-rendering signal is Next's own and must reach it.
    unstable_rethrow(error);
    log.warn('employee title read without the name', {
      agentId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'unnamed' };
  });
  if (subject.kind === 'departed') {
    const departed = departedTabTitle(subject.name);
    return { default: departed, template: departed };
  }
  const who = subject.kind === 'employee' ? `${subject.name} · ` : '';
  return {
    default: `${who}${EMPLOYEE_TAB_LABELS['needs-you']} · Day0`,
    template: `${who}%s · Day0`,
  };
}
