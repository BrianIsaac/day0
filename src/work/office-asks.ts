/**
 * The mock office's company-wide asks and the roles whose work each is (finding 2 of the v0.17.0
 * redeploy, 13-FD's R4).
 *
 * 13-FD seeded three asks from across the company in `#office-asks`, each answered by a team
 * document, so an employee in any role has work the office lets it finish. The generator was shown
 * all three whatever the role, and handed a role another role's ask: on the redeploy a support
 * triage coordinator and a facilities coordinator were each given the IT helpdesk's drive
 * lock-out, so "one finishes, one does not" held on four employees of five. A rule in the
 * generator's prompt keeping the read and the tickets to the role's own asks was tried and
 * withdrawn (`401fa37c`): the model judged a finance close role to have no ask of its own and
 * invented one the office could not back. So the office carries, with each ask, the words of the
 * roles it belongs to, and the generator is shown only the asks of the role it drafts for, as it
 * is shown none of the office's seeded tickets. The manager's own ask and the team's asks in
 * other channels are not pooled: they are the office's own team's, as before.
 */

/** One company-wide ask the office seeds, with the words that name the roles whose work it is. */
export interface OfficeAsk {
  readonly channelSlug: string;
  readonly threadKey: string;
  readonly sender: string;
  readonly body: string;
  /**
   * Words of four letters or more (the scope rule's tokens) naming the roles whose work the ask
   * is: a charter whose role or will-do clauses carry one is shown the ask.
   */
  readonly roleWords: readonly string[];
  /**
   * Words that mark another role however the role words read: a charter carrying one is not
   * shown the ask. "support" is a customer support role's word and an IT support role's too.
   */
  readonly notWith?: readonly string[];
}

/** The channel the office's company-wide asks arrive in. */
export const OFFICE_ASKS_CHANNEL = 'office-asks';

/** The three asks 13-FD seeded, in its words, each with the roles it belongs to. */
export const OFFICE_ASKS: readonly OfficeAsk[] = [
  {
    channelSlug: OFFICE_ASKS_CHANNEL,
    threadKey: 'thread-drive-access',
    sender: 'Kofi',
    body: 'I changed my password this morning and the shared drive now says access denied. What are the steps to get back in?',
    // Not "access": a customer support role grants access to articles and help centres.
    roleWords: ['helpdesk', 'password', 'passwords'],
  },
  {
    channelSlug: OFFICE_ASKS_CHANNEL,
    threadKey: 'thread-spare-monitor',
    sender: 'Sara',
    body: 'The monitor at desk 14 has died. Where can I get a spare, and does anyone need to know I took one?',
    roleWords: ['facilities', 'equipment', 'supplies', 'repairs', 'hardware', 'workplace'],
  },
  {
    channelSlug: OFFICE_ASKS_CHANNEL,
    threadKey: 'thread-double-charge',
    sender: 'Hana',
    body: 'Northwind wrote in that invoice INV-2207 charged them twice this month. Can someone post the first reply here for me to send them?',
    roleWords: ['support', 'customer', 'customers', 'billing', 'invoice', 'invoices'],
    notWith: ['helpdesk', 'password', 'passwords'],
  },
];

/**
 * The threads of the office's company-wide asks that are another role's work for a charter, as
 * `<channel>#<thread>`: those whose role words the charter's words (its role and will-do clauses,
 * as `charterWords` reads them) carry none of, or that carry a word marking another role. The
 * words are passed in so the seed, which reads this list, imports nothing of the scope rule.
 *
 * @param charterWords - The charter's words the generator drafts for.
 * @returns The threads to leave out of what the generator is shown.
 */
export function otherRolesAskThreads(charterWords: Iterable<string>): ReadonlySet<string> {
  const words = new Set(charterWords);
  return new Set(
    OFFICE_ASKS.filter(
      (ask) =>
        !ask.roleWords.some((word) => words.has(word)) ||
        (ask.notWith ?? []).some((word) => words.has(word)),
    ).map((ask) => `${ask.channelSlug}#${ask.threadKey}`),
  );
}
