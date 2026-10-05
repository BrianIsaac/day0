/**
 * The words the wave 12 review read the lexical not-done detector against (W12-R1), kept as the
 * cases of the rule that replaced it as the reader (12-D, decision D-1 (b)): the run answers
 * `workDone` and the status it sets is held to that answer.
 *
 * - `FINISHED_WORDS`: the review's attack corpus of finished runs (24, written to break the
 *   detector; 20 of them it read as unfinished) and the bed's two finished employees, Quill and Rook
 *   (section 6.2, word for word).
 * - `UNFINISHED_WORDS`: the attack corpus of unfinished runs (24; 20 of them it passed) and the
 *   bed's three unfinished employees, Moss (the 4 October demo's words), Nell and Pip.
 * - `RECORDED_UNFINISHED`: nine statements real runs wrote that say part of the work was not
 *   done, which the detector passes (the review's six quoted, and three more from the same
 *   exports), verbatim with their sources.
 */

/** One run's words: what a reader would call it, and where the words come from. */
export interface CorpusWords {
  readonly label: string;
  readonly text: string;
}

/** Quill's comment on the review's bed: finished, and read as unfinished by the detector. */
export const QUILL_COMMENT =
  "All three October deals reconciled against the tracker. I could not find a mismatch between the tracker and the ticket's figures.";

/** Rook's comment on the review's bed: finished, in plain words. */
export const ROOK_COMMENT =
  'All three October deals reconciled against the tracker. Every amount and close date matches.';

/** Nell's comment on the review's bed: nothing done, and closed as done by the detector's reading. */
export const NELL_COMMENT =
  'Blocked: the October deal list is missing from the Q4 Revenue Tracker. No reconciliation was performed.';

/** Pip's draft on the review's bed: part done, and closed as done by the detector's reading. */
export const PIP_DRAFT =
  'I only reconciled one of the three October deals. The other two need the CRM export, which I do not have access to.';

/** Moss's draft on the review's bed: the 4 October demo's own words. */
export const MOSS_DRAFT =
  "I could not reconcile the three October closed-won deals: I can't find them in the tracker or the CRM export.";

/** Finished runs' words: a run answering `done` over any of them is closed and unlabelled. */
export const FINISHED_WORDS: readonly CorpusWords[] = [
  {
    label: 'F1 negated inability',
    text: 'Reconciled all three October deals against the tracker. There was nothing I could not reconcile.',
  },
  {
    label: 'F2 quoted ticket words',
    text: 'The ticket said "we could not find the Q3 export". I found it in the shared drive and reconciled all 14 rows.',
  },
  {
    label: 'F3 echo of the ask',
    text: 'You asked whether the vendor charges could not be matched: they all match, 12 of 12.',
  },
  {
    label: 'F4 about someone else',
    text: 'Posted the summary. Finance said they were unable to confirm the date before Friday, so I noted it for them.',
  },
  {
    label: 'F5 could not, about another thing',
    text: 'Done: the close summary is posted. I could not find a reason to change the owner, so I left it.',
  },
  {
    label: 'F6 could not help',
    text: 'All deals reconciled. I could not get this done faster because the tracker was slow.',
  },
  {
    label: 'F7 past obstacle overcome',
    text: 'At first I could not find the deal list, then located it under Archive and reconciled every deal.',
  },
  {
    label: 'F8 no longer',
    text: 'The three deals that were not yet reconciled are now reconciled.',
  },
  {
    label: 'F9 hedge then done',
    text: 'I was not able to open the old export, so I used the new one instead and completed the reconciliation.',
  },
  {
    label: 'F10 is outstanding (an invoice)',
    text: 'Reconciled. One invoice for 1,200 is outstanding with the vendor, as the tracker shows.',
  },
  {
    label: 'F11 remains unresolved elsewhere',
    text: 'Closed the ticket as asked. The upstream vendor dispute remains unresolved, which is tracked in REVOPS-90.',
  },
  {
    label: 'F12 no data needed',
    text: 'Updated the tracker. No further information was provided in the ticket, and none was needed.',
  },
  { label: 'F13 colon label', text: 'Status: complete. Notes: none.' },
  {
    label: 'F14 did not find anything wrong',
    text: 'I checked every row and did not find anything wrong.',
  },
  {
    label: 'F15 could not find a mismatch',
    text: 'I could not find a mismatch between the tracker and the export.',
  },
  {
    label: 'F16 unable to find fault',
    text: 'Review complete. I was unable to find fault with any of the entries.',
  },
  {
    label: 'F17 a word to the manager',
    text: 'All done. If you cannot find the summary, it is pinned in #revops.',
  },
  { label: 'F18 nothing was found wrong', text: 'Audit finished: nothing was found.' },
  {
    label: 'F19 not yet done by others',
    text: 'I posted the summary. The sign-off by finance is not yet done, which is their step.',
  },
  {
    label: 'F20 we did not find duplicates',
    text: 'We did not find duplicates in the October list.',
  },
  {
    label: 'F21 quoted customer',
    text: 'Replied to the customer who wrote "I can\'t find my invoice" with the invoice link.',
  },
  {
    label: 'F22 conditional',
    text: 'Everything is reconciled. Tell me if you cannot find the report.',
  },
  {
    label: 'F23 was incomplete before',
    text: 'The October list was incomplete, so I added the two missing deals and reconciled all five.',
  },
  {
    label: 'F24 no records found means clean',
    text: 'No duplicate records are in the office tracker.',
  },
  { label: 'Quill (the review bed)', text: QUILL_COMMENT },
  { label: 'Rook (the review bed)', text: ROOK_COMMENT },
];

/** Unfinished runs' words: a run answering `partial` or `not-done` over any of them is not closed. */
export const UNFINISHED_WORDS: readonly CorpusWords[] = [
  { label: 'U1 the demo', text: "I can't find the three October deals" },
  {
    label: 'U2 the demo',
    text: 'I could not fully reconcile October vendor charges - no vendor-charge data is available in the office',
  },
  {
    label: 'U3 no access',
    text: 'I do not have access to the vendor portal, so the charges are unverified.',
  },
  {
    label: 'U4 missing',
    text: 'The October deal list is missing from the tracker, so this is blocked.',
  },
  { label: 'U5 blocked', text: 'Blocked: waiting on the finance export before I can start.' },
  { label: 'U6 failed to', text: 'I failed to locate the three deals in the tracker.' },
  { label: 'U7 there is no', text: 'There is no deal list for October in the tracker.' },
  {
    label: 'U8 does not exist',
    text: 'The deals named in the ticket do not exist in the tracker.',
  },
  {
    label: 'U9 partial',
    text: 'I only reconciled one of the three deals; the other two need the export.',
  },
  { label: 'U10 need more', text: 'I need the vendor-charge export to do this. Please attach it.' },
  { label: 'U11 third person', text: 'Lark could not find the deals.' },
  { label: 'U12 it', text: 'The reconciliation was not possible with the data on hand.' },
  { label: 'U13 cannot proceed', text: "This can't proceed until the list is shared." },
  { label: 'U14 not completed, passive', text: 'The reconciliation has not been completed.' },
  { label: 'U15 not yet', text: "I haven't reconciled the charges yet." },
  { label: 'U16 no luck', text: 'Searched the tracker for the October deals with no luck.' },
  { label: 'U17 unable', text: 'Unable to locate the deals.' },
  { label: 'U18 not found', text: 'October deals: not found in tracker.' },
  { label: 'U19 could not access', text: "I couldn't access the spreadsheet." },
  { label: 'U20 lacking', text: 'The ticket lacks the deal names, so I stopped.' },
  {
    label: 'U21 not enough',
    text: 'There was not enough information to reconcile the charges.',
  },
  {
    label: 'U22 did not have',
    text: 'I did not have the data needed, so no reconciliation took place.',
  },
  { label: 'U23 zero progress', text: 'No reconciliation was performed.' },
  {
    label: 'U24 skipped',
    text: 'I skipped the reconciliation because the export was absent.',
  },
  { label: 'Moss (the review bed, the demo)', text: MOSS_DRAFT },
  { label: 'Nell (the review bed)', text: NELL_COMMENT },
  { label: 'Pip (the review bed)', text: PIP_DRAFT },
];

/**
 * Nine statements recorded runs wrote that say part of the work was not done, each of which the
 * detector passes (W12-R1, "on words models really wrote"), verbatim.
 */
export const RECORDED_UNFINISHED: readonly CorpusWords[] = [
  {
    label: 'readme-loop-export.json, REVOPS-5 comment',
    text: 'Read REVOPS-5 but could not summarize completed close checks because the applied evidence did not include completed close-check details.',
  },
  {
    label: 'recording-run-2026-09-17/export.zip, REVOPS-5',
    text: 'Not confirmed: the Q4 pipeline tracker is not among the connected surfaces, so its rows could not be read.',
  },
  {
    label: 'hosted-demo after-dev-prod-move.zip, pipeline clean-up',
    text: 'I’m blocked because the current ticket snapshot I can see does not include the unowned follow-up-note text, and the Q4 tracker pipeline tab visible here has headers Account, Amount, Stage, Close date, Owner with no follow-up-notes field.',
  },
  {
    label: 'recording-drive-export.json, the Looker refresh',
    text: 'The Looker refresh audit line was not recorded, so I cannot cite a verified tile read-back.',
  },
  {
    label: 'tests/fixtures/recording-2026-09-17-trace.json, the standup deals',
    text: 'The thread reply quoting the figure and audit line cannot be truthfully authored until that read-back returns, so it is not emitted here; per-deal reconciliation for the three Friday standup deals remains unconfirmable because no Q4 pipeline tracker surface is connected and Northstar CRM has no approved access path (Northstar CRM page).',
  },
  {
    label: 'hosted-demo after-dev-prod-move.zip, the Q4 sheet',
    text: 'I need the tracker link/write access and the standup transcript or CRM references to verify required fields before I make the sheet update.',
  },
  {
    label: 'hosted-demo after-dev-prod-move.zip, pipeline clean-up draft',
    text: 'I did not edit the spreadsheet yet because the available REVOPS-203 context does not show the follow-up-note text, and the visible pipeline tab headers are only Account, Amount, Stage, Close date, Owner — no follow-up-notes field.',
  },
  {
    label: 'full-run-validation-2026-09-18/export.zip',
    text: 'The Q4 pipeline tracker has no approved connection surface, so the tracker rows for the three standup deals could not be read.',
  },
  {
    label: 'full-run-validation-2-2026-09-19/export.zip',
    text: 'Steps 3 and 5 of the plan are therefore not done; the ticket creation needs a retry or manager guidance.',
  },
];
