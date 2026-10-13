import type { MockAction, WithheldAction } from '../../../src/work/types';

/*
 * Pip's P1 on the v0.19.0 hosted walk (11 October 2026, W19-2; `hosted-walk-v0.19.0-2026-10-11`,
 * row `A-Pip-tB-full.txt`): Hana's "Northwind charged twice on INV-2207" ticket, REVOPS-204. The
 * set posted the first reply in Hana's thread, then commented on and closed the ticket and sent the
 * manager a DM, each reporting the post in its words and neither declaring `reports`. The evidence
 * check withheld the comment and the DM though the post landed, so the comment was true and the
 * ticket stayed open against the ask. The comment's and the DM's words, the withheld reasons and
 * the draft are the row's, word for word; the row prints the post's body only to its first 100
 * characters, so the rest of it is the reply the draft describes, in the row's words.
 */

/** The ticket as the office filed it for Pip. */
export const PIP_TICKET_SUMMARY =
  'Hana wrote: "Northwind wrote in that invoice INV-2207 charged them twice this month. Can someone post the first reply here for me to send them?" Please draft the first reply following the customer billing replies doc, thank them and name invoice INV-2207, say billing reviews duplicate charges within two business days and writes back with the outcome, and ask them to keep the payment receipt until then. Post the reply in the thread for Hana to send, then comment on this ticket and close it.';

/** The post in Hana's thread: the one write of the set that landed on the walk. */
export const PIP_REPLY_POST: MockAction = {
  tool: 'slack.postMessage',
  args: {
    channelSlug: 'office-asks',
    threadKey: 'thread-double-charge',
    body: 'Hi Hana, here is the first reply for Northwind on invoice INV-2207, per the customer billing replies doc: Hi Northwind, thank you for letting us know about invoice INV-2207. Billing reviews duplicate charges within two business days and writes back with the outcome. Please keep your payment receipt until then.',
  },
  reports: null as unknown as number[],
};

/** The comment and close of REVOPS-204, which reports the post and declares no `reports`. */
export const PIP_COMMENT_AND_CLOSE: MockAction = {
  tool: 'ticket.update',
  args: {
    slug: 'REVOPS-204',
    status: 'done',
    comment:
      "Drafted the first reply to Northwind's duplicate charge on invoice INV-2207 following the customer billing replies doc: it thanks the customer, names INV-2207, states that billing reviews duplicate charges within two business days and writes back with the outcome, and asks them to keep the payment receipt until then, with no promise of a refund. The reply is posted in the #office-asks thread-double-charge thread for Hana to send.",
  },
  reports: null as unknown as number[],
};

/** The manager DM, which reports the post and the comment and declares no `reports`. */
export const PIP_MANAGER_DM: MockAction = {
  tool: 'slack.postMessage',
  args: {
    channelSlug: 'dm-manager',
    body: "Done: drafted the first reply for Northwind's duplicate charge on invoice INV-2207 and posted it in the #office-asks thread-double-charge thread for Hana to send, and ticket REVOPS-204 is commented and closed as done. No refund was promised, per the customer billing replies doc.",
  },
  reports: null as unknown as number[],
};

/** The set as the executor emitted it, in its order. */
export const PIP_SAME_SET: MockAction[] = [PIP_REPLY_POST, PIP_COMMENT_AND_CLOSE, PIP_MANAGER_DM];

/** The run's draft, word for word. */
export const PIP_SAME_SET_DRAFT =
  "Draft first reply for Northwind's duplicate charge on invoice INV-2207, following the customer billing replies doc: it thanks the customer, names invoice INV-2207, states that billing reviews duplicate charges within two business days and will write back with the outcome, and asks them to keep the payment receipt until then. The reply promises no refund, since refunds are billing's decision, so no escalation is needed. The reply is posted in the #office-asks thread-double-charge thread for Hana to send, ticket REVOPS-204 receives an audit comment naming the drafted reply and INV-2207 and closes as done, and a one-line completion note goes to the manager DM.";

/** The checker's reason on the comment, as the walk's card printed it. */
export const PIP_COMMENT_REASON =
  'action 1 (ticket.update) reports earlier writes of this set in its words and declares no `reports`: it says "The reply is posted in the #office-asks thread-double-charge thread for Hana to send.", which reports [0]; list in `reports` every earlier write of this set the message reports, or [] when it reports none';

/** The two rows the walk's card listed under "Withheld by the evidence check". */
export const PIP_WITHHELD_ROWS: WithheldAction[] = [
  { action: PIP_COMMENT_AND_CLOSE, reason: PIP_COMMENT_REASON },
  {
    action: PIP_MANAGER_DM,
    reason: `withheld with a write it reports, which was withheld: ${PIP_COMMENT_REASON}`,
  },
];

/*
 * Pip's docs item on the same walk (W19-4; row `A-Pip-docs-full.txt`): Hana's question about the
 * billing doc. Its one write was a DM to the manager; the row prints the DM's first 100
 * characters and the draft whole, and the DM carried the draft's words, so the body is the draft.
 */

/** The DM Pip sent in place of an answer to Hana, word for word as its draft. */
export const PIP_DOCS_DRAFT_DM: MockAction = {
  tool: 'slack.postMessage',
  args: {
    channelSlug: 'dm-manager',
    body: "Draft reply to Hana, held for your approval: Hi Hana, here is exactly what the Customer billing replies doc says our first reply to a duplicate charge should say. Thank the customer and name the invoice, then say that billing reviews duplicate charges within two business days and writes back with the outcome, and ask them to keep the payment receipt until then. The doc is explicit that we must never promise a refund, because refunds are billing's decision (Customer billing replies). So for Northwind on invoice INV-2207, the first reply names INV-2207, states the two-business-day review window, asks them to keep the payment receipt, and promises nothing beyond the review.",
  },
  reports: null as unknown as number[],
};
