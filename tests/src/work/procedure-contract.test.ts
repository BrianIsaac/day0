import { describe, expect, it } from 'vitest';
import { parseProcedureContract } from '../../../src/work/procedure-contract';
import { parseProcedureContract as reexported } from '../../../src/work/execute-skill';

const ticketRunbook = {
  slug: 'how-to-update-ticket',
  title: 'How to update a ticket',
  body: [
    'When work originated in the ticket-queue, use ticket.update on the originating ticket.',
    'Set status: done for full completion and in-progress for partial completion.',
    'Add a one-line comment summarising the work.',
  ].join('\n'),
};

describe('procedure-contract', (): void => {
  it('parses the ticket trail a runbook prescribes, with the page as its evidence', (): void => {
    const contract = parseProcedureContract({ howToGuides: [ticketRunbook], teamDocs: [] });
    expect(contract.trails).toHaveLength(1);
    expect(contract.trails[0]).toMatchObject({
      appliesTo: { sourceCategories: ['ticket-queue'] },
      effect: {
        tool: 'ticket.update',
        statusTransition: { argument: 'status', full: 'done', partial: 'in-progress' },
        requiredPayload: ['comment'],
      },
      evidence: { documentRef: 'how-to-update-ticket' },
    });
  });

  it('answers an empty contract for pages that prescribe no trail', (): void => {
    expect(
      parseProcedureContract({
        howToGuides: [],
        teamDocs: [{ slug: 'notes', title: 'Notes', body: 'The office opens at nine.' }],
      }),
    ).toEqual({ trails: [] });
  });

  it('is the parser the executor exports, so its callers read one contract', (): void => {
    expect(reexported).toBe(parseProcedureContract);
  });
});
