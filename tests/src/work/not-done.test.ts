import { describe, expect, it } from 'vitest';
import { isClosingState, notDoneStatements, runOwnWords } from '../../../src/work/not-done';

describe('notDoneStatements', () => {
  it('finds the sentences of the 4 October demo runs that say the work was not done', () => {
    expect(
      notDoneStatements([
        'Reconciliation of the three October closed-won deals is pending manager confirmation \u2014 the deal list is not yet identified in the tracker.',
        "Question on REVOPS-204: I can't find the three October deals named anywhere in the office.",
        "I couldn't fully reconcile October vendor charges \u2014 no vendor-charge data or reconciliation runbook is available.",
      ]),
    ).toEqual([
      'the deal list is not yet identified in the tracker.',
      "I can't find the three October deals named anywhere in the office.",
      "I couldn't fully reconcile October vendor charges",
      'no vendor-charge data or reconciliation runbook is available.',
    ]);
  });

  it('reads inability, a pending or unfinished state and nothing done, in other words too', () => {
    for (const text of [
      'I was unable to locate the export.',
      'We could not verify the totals against the CRM.',
      'The three deals could not be found in the tracker.',
      'The reconciliation remains incomplete.',
      'Nothing was reconciled.',
      'No CRM export is available in the office.',
      "I wasn't able to confirm the amounts.",
      // Rewordings of the demo failure the second pass found missed.
      'I did not find the three October deals.',
      "I didn't find any October deals.",
      'Could not locate the deals.',
      'The export has no vendor charges, so I did nothing.',
      "I haven't been able to find the deals.",
      'Not able to find the deals.',
      'Nothing is reconciled.',
    ]) {
      expect(notDoneStatements([text]), text).toHaveLength(1);
    }
  });

  it('reads no finished run as unfinished: a result, a careful word, a rule kept or a wait for someone else', () => {
    for (const text of [
      'Reconciled October vendor charges: $12,500 verified against the invoice. No discrepancies found.',
      'Appended 3 rows to closed-won: Acme $45k, Beta Corp $72k, Gamma LLC $28k. Close date and owner left blank \u2014 pending manager confirmation before committee.',
      'I did not change any deal amount, as the charter says.',
      'Nothing was changed in Salesforce; the tracker row is added.',
      "I can't see any mismatch between the tracker and the CRM.",
      'Ticket closed after the three rows matched.',
      'No errors were found.',
      // A finished run's results and hand-offs the second pass found read as unfinished.
      'No duplicate records found in the October export.',
      'No mismatched records were found.',
      'Reconciled all three deals. CFO sign-off is pending.',
      'The follow-up is pending your review.',
      'I could not find any errors in the ledger.',
      'The sheet is not yet available to the team so I attached a copy.',
      'I did not find any discrepancies.',
      'I did not open a new ticket, as the charter says.',
    ]) {
      expect(notDoneStatements([text]), text).toEqual([]);
    }
  });
});

describe('runOwnWords', () => {
  it('is the draft and every message the run wrote, never a status or a read', () => {
    expect(
      runOwnWords({
        draft: 'I could not reconcile it.',
        actions: [
          {
            tool: 'ticket.update',
            args: { slug: 'REVOPS-1', status: 'done', comment: 'Pending.' },
          },
          { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'Which deals?' } },
          { tool: 'spreadsheet.appendRow', args: { sheetSlug: 's', tabName: 't', cells: [] } },
        ],
      }),
    ).toEqual(['I could not reconcile it.', 'Pending.', 'Which deals?']);
  });
});

describe('isClosingState', () => {
  it('names the states that say the work is finished', () => {
    for (const state of ['done', 'Done', 'completed', 'Closed', 'resolved', 'Complete']) {
      expect(isClosingState(state), state).toBe(true);
    }
    for (const state of ['in-progress', 'In Progress', 'Todo', 'blocked', 'open', '']) {
      expect(isClosingState(state), state).toBe(false);
    }
  });
});
