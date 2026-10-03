import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import { systemDisplayName } from '@/surfaces/revokers/outcome';
import type { InboxItem } from '../../../components/InboxEntry';

/** What `reset.retirePreview` answers for an employee that is still there. */
export type RetirePreview = NonNullable<FunctionReturnType<typeof api.reset.retirePreview>>;

/** The tables the dialog names row by row, in the order it names them, with their nouns. */
const NAMED_TABLES: ReadonlyArray<readonly [table: string, one: string, many: string]> = [
  ['charters', 'charter version', 'charter versions'],
  ['workItems', 'work item', 'work items'],
  ['skills', 'skill', 'skills'],
  ['surfaces', 'connection', 'connections'],
  ['corrections', 'correction', 'corrections'],
  ['events', 'event', 'events'],
];

/**
 * A list in prose: "a", "a and b", "a, b and c".
 *
 * @param parts - The items, in order.
 */
export function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * A count with its noun: "1 skill", "3 skills".
 *
 * @param one - The noun for one.
 * @param many - The noun for more than one.
 */
function counted(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;
}

/**
 * What a retire deletes, in the manager's words: the rows the manager knows by name, then every
 * other row as one count, then how many tables that spans. A table the preview stopped counting
 * at its bound makes the whole count a floor.
 *
 * @param preview - The preview's counts.
 * @returns "2 charter versions, 3 work items and 41 events across 5 tables", or what says
 *   there is nothing.
 */
export function deletedWords(preview: Pick<RetirePreview, 'rowCounts' | 'atLeast'>): string {
  const counts = Object.entries(preview.rowCounts).filter(([, count]) => count > 0);
  if (counts.length === 0) return 'nothing beyond the employee itself: it has made no rows yet';
  const named = new Set(NAMED_TABLES.map(([table]) => table));
  const parts = NAMED_TABLES.flatMap(([table, one, many]) => {
    const count = preview.rowCounts[table] ?? 0;
    return count > 0 ? [counted(count, one, many)] : [];
  });
  const others = counts
    .filter(([table]) => !named.has(table))
    .reduce((sum, [, count]) => sum + count, 0);
  if (others > 0) {
    parts.push(
      counted(
        others,
        parts.length > 0 ? 'other row' : 'row',
        parts.length > 0 ? 'other rows' : 'rows',
      ),
    );
  }
  const floor = preview.atLeast ? 'at least ' : '';
  return `${floor}${listed(parts)} across ${counted(counts.length, 'table', 'tables')}`;
}

/**
 * The connections named in a retire's revoked or kept line: "the Linear credential", "the Slack
 * and Linear credentials".
 *
 * @param surfaces - The connections.
 */
export function credentialsWords(surfaces: RetirePreview['revoked']): string {
  const names = [...new Set(surfaces.map((surface) => surface.displayName))];
  return `the ${listed(names)} ${names.length === 1 ? 'credential' : 'credentials'}`;
}

/** One connection's outcome at the vendor, as `reset.retirePreview` answers it (11-AR). */
type PreviewOutcome = RetirePreview['outcomes'][number];

/**
 * What the retire does at the vendor for one connection, after its name: the employee's own app
 * deleted or uninstalled, its access revoked, a shared app left for the others, a system with no
 * way to revoke, a token Day0 can no longer revoke, or nothing at the vendor. A pasted key and a
 * kept one are said elsewhere, so they have no line here.
 */
function outcomeLine(outcome: PreviewOutcome, name: string): string | undefined {
  const system = systemDisplayName(outcome.system);
  const access = `${name}'s ${outcome.displayName} access`;
  switch (outcome.outcome) {
    case 'app-deleted':
      return `${name}'s ${system} app: deleted in ${system}.`;
    case 'app-uninstalled':
      return `${name}'s ${system} app: uninstalled from ${system}.`;
    case 'token-revoked':
      // A Linear token Day0 revokes per employee is its own app's (the shared app's says
      // `shared`), and no call deletes a Linear app, so the app stays for IT (R41X-5).
      return outcome.system === 'linear'
        ? `${access}: revoked at ${system}. ${name}'s own ${system} app stays in ${system}'s settings for IT to delete.`
        : `${access}: revoked at ${system}.`;
    case 'shared':
      return `${access}: ends for ${name} only; the app your employees share is not revoked at ${system}.`;
    case 'not-supported':
      // The plan's own words where it gives them: what stays at the vendor for IT (R41V-11).
      return outcome.reason !== undefined
        ? `${access}: ends in Day0. ${outcome.reason}`
        : `${access}: ${system} offers no way to revoke it, so Day0 deletes its copy.`;
    case 'failed':
      return `${access}: Day0 can no longer revoke it at ${system}, so revoke it there.`;
    case 'not-at-vendor':
      return `${access}: ends in Day0, with nothing to revoke at ${system}.`;
    case 'pasted-key':
    case 'kept':
      return undefined;
    default: {
      const unknown: never = outcome.outcome;
      throw new Error(`unhandled retire outcome ${String(unknown)}`);
    }
  }
}

/**
 * The retire dialog's Revoked lines (11-AR's `retirePreview.outcomes`; the wave file's words,
 * flagged as a product call): one per connection Day0 obtained access for, saying what happens at
 * the vendor ("Leo's Slack app: deleted in Slack."), then the sentence for the keys someone pasted,
 * kept as it was: Day0 deletes its copy and the key stays valid until revoked where it was made
 * (D5). A revoked connection the preview gives no outcome for is said with the pasted keys, as
 * before the outcomes existed.
 *
 * @param preview - The preview's outcomes and its revoked connections.
 * @param name - The employee's name.
 */
export function revokedLines(
  preview: Pick<RetirePreview, 'outcomes' | 'revoked'>,
  name: string,
): string[] {
  const described = new Set(preview.outcomes.map((outcome) => outcome.slug));
  const pasted = [
    ...preview.outcomes
      .filter((outcome) => outcome.outcome === 'pasted-key')
      .map(({ slug, displayName }) => ({ slug, displayName })),
    ...preview.revoked.filter((surface) => !described.has(surface.slug)),
  ];
  const atVendor = preview.outcomes.flatMap((outcome) => {
    const line = outcomeLine(outcome, name);
    return line === undefined ? [] : [line];
  });
  if (pasted.length === 0) return atVendor;
  const words = credentialsWords(pasted);
  return [
    ...atVendor,
    `${words.charAt(0).toLocaleUpperCase('en-GB')}${words.slice(1)}: Day0 deletes its copy at once, so no later run can use it. The token stays valid at the provider until you revoke it there.`,
  ];
}

/** How each kind of waiting entry is counted in the dialog, singular and plural. */
const WAITING_NOUNS: Readonly<Record<InboxItem['kind'], readonly [one: string, many: string]>> = {
  'one-to-one': ['one-to-one', 'one-to-ones'],
  charter: ['charter to review', 'charters to review'],
  plan: ['plan', 'plans'],
  held: ['held write', 'held writes'],
  skill: ['skill to approve', 'skills to approve'],
  parked: ['parked item', 'parked items'],
  stopped: ['stopped run', 'stopped runs'],
  surface: ['connection to approve', 'connections to approve'],
  // No employee's own inbox holds one (`work.needsYouForAgent` keeps the other eight); the map
  // is exhaustive over the kinds.
  transfer: ['employee to take on', 'employees to take on'],
};

/**
 * What waits on the manager and goes undecided with a retire, counted by kind in the order the
 * entries first appear: "1 held write and 1 plan". A held entry counts its writes. Entries past
 * the read the inbox returns are counted as "more" from its total.
 *
 * @param entries - The employee's needs-you entries, as `work.needsYouForAgent` lists them.
 * @param total - How many entries there are in all.
 * @returns The count in words, or the empty string when nothing waits.
 */
export function waitingWords(entries: readonly InboxItem[], total: number): string {
  // A connection IT answered for waits on Connect, not on an approval (11-AJ's join 12).
  const nounsOf = (entry: InboxItem): readonly [one: string, many: string] =>
    entry.kind === 'surface' && entry.ready === 'connect'
      ? ['connection waiting to be connected', 'connections waiting to be connected']
      : WAITING_NOUNS[entry.kind];
  const tally = new Map<string, { nouns: readonly [string, string]; count: number }>();
  for (const entry of entries) {
    const nouns = nounsOf(entry);
    const seen = tally.get(nouns[0]);
    tally.set(nouns[0], {
      nouns,
      count: (seen?.count ?? 0) + (entry.kind === 'held' ? entry.heldWrites : 1),
    });
  }
  const parts = [...tally.values()].map(({ nouns, count }) => counted(count, ...nouns));
  const unread = total - entries.length;
  if (unread > 0) parts.push(`${counted(unread, 'more entry', 'more entries')}`);
  return listed(parts);
}

/**
 * Whether the typed confirmation matches the phrase: case, the spaces around and between words
 * and how a character was composed (an accent typed as its own mark or as one letter) do not
 * matter, the words do.
 *
 * @param typed - What the manager typed.
 * @param phrase - What the dialog asks for.
 */
export function confirmationMatches(typed: string, phrase: string): boolean {
  const plain = (text: string): string =>
    text.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
  return plain(typed) === plain(phrase);
}
