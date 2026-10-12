import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { ReorientationView } from '../../../../../app/agent/[agentId]/reorientation/ReorientationView';
import { asEmployee } from '../../../../fixtures/dom/employee';

/*
 * The reorientation page (16-O): the employee's cards, or the no-card state in section 7's words
 * (re-pinned from wave 15's "opens no card here yet", which a card now contradicts: RM24), and the
 * card the manager opens by hand.
 */

describe('ReorientationView', () => {
  it('says what opens a card in real mode when none is open, and points at the charter', () => {
    backend.queries['reorientationDecisions:listForAgent'] = [];
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />, { surfaceMode: 'real' }));
    expect(html).toContain('No reorientation card is open');
    expect(html).toContain(
      'A card opens when a person, a page, a skill or an access Mira relies on changes.',
    );
    expect(html).toContain('href="/agent/agent-1/charter"');
    expect(html).toContain('When the role changes');
    expect(html).toContain('Open a card');
  });

  it('says a handover opens a card in the hosted office, whose pages do not change', () => {
    backend.queries['reorientationDecisions:listForAgent'] = [];
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />));
    expect(html).toContain('pages do not change, so a card opens here when Mira');
    expect(html).toContain('is handed over to you');
  });

  it('says it is loading until the cards are read, and draws nothing else', () => {
    backend.queries['reorientationDecisions:listForAgent'] = undefined;
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />, { surfaceMode: 'real' }));
    expect(html).toContain('Loading the reorientation cards');
    expect(html).not.toContain('No reorientation card is open');
  });
});
