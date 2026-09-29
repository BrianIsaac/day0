/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Charter tab in each of its states, rendered in a document and checked with axe and the 44 px
 * floor (N14): the review with one rule struck and one kept, its transcript and the note that asks
 * for changes; the approved record with its versions and the transcript open.
 */
const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
}));

import { CharterView } from '../../../../../app/agent/[agentId]/charter/CharterView';
import { strikeRefusalBody } from '../../../../fixtures/charter-strike-refusal-2026-09-15';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { APPROVED_CHARTER, asEmployee } from '../../../../fixtures/dom/employee';
import { mount, settle } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

const TRANSCRIPT =
  'ASSISTANT: Why this hire?\n\nUSER: Ops left.\n\nASSISTANT: Who first?\n\nUSER: Sam.';

function charter(approved: boolean): typeof APPROVED_CHARTER {
  const body = strikeRefusalBody(false);
  body.constraints![0] = { ...body.constraints![0]!, struck: true };
  return {
    ...APPROVED_CHARTER,
    approved,
    approvedAt: approved ? 3 : undefined,
    body: approved
      ? {
          ...body,
          struckClauses: [{ field: 'willNotDo', text: 'Access or execute work in Northstar CRM.' }],
          answeredQuestions: [
            {
              question: 'Who covers on-call?',
              answer: 'Sara.',
              answeredAt: '2026-09-29T14:38:00Z',
            },
          ],
        }
      : body,
  } as typeof APPROVED_CHARTER;
}

afterEach((): void => {
  backend.queries = {};
  document.body.replaceChildren();
});

describe('the Charter tab against the accessibility floor (N14)', (): void => {
  it.each([
    ['the review, one rule struck and one kept', false],
    ['the approved record, with its versions', true],
  ] as const)(
    'has no axe violation and 44 px targets in %s',
    async (_state, approved) => {
      const current = charter(approved);
      backend.queries = {
        'charters:transcriptOf': { transcript: TRANSCRIPT, endedAt: 1 },
        'charters:listForAgent': [current],
      };
      const view = mount(asEmployee(<CharterView />, { charter: current }));
      await settle();
      for (const disclosure of view.container.querySelectorAll('details')) disclosure.open = true;
      await settle();
      expect(await axeViolations(view.container, ['region'])).toEqual([]);
      expect(underTarget(view.container)).toEqual([]);
      view.unmount();
    },
    30_000,
  );
});
