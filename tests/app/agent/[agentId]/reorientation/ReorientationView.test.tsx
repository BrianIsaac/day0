import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  // The figures are read through `useQueries` (wave 18, 18-F): each read answered as `useQuery` is.
  useQueries: (queries: Record<string, { query: unknown }>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query }]) => [
        key,
        backend.queries[getFunctionName(query as never)],
      ]),
    ),
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

  it('says what opens a card in the hosted office, where a skill or an access can change and a page or a person cannot', () => {
    // Re-taken (17-O; the v0.20.0 hosted walk's finding 5): the sentence said a card opens here
    // "when Lark is handed over to you, or when you open one below", and Lark had a card opened
    // automatically when another employee wrote a new version of a skill it runs.
    backend.queries['reorientationDecisions:listForAgent'] = [];
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />));
    expect(html).toContain(
      'The hosted office&#x27;s pages and people do not change, so a card opens here when a skill or an access Mira relies on changes, when Mira is handed over to you, or when you open one below.',
    );
    expect(html).toContain('href="/agent/agent-1/charter"');
  });

  it('chooses neither sentence until the mode answers (W16-R24)', () => {
    // The review's W16-R24: the page tested `surfaceMode === 'real'` and sent an unanswered mode
    // to the hosted sentence, so a local install read the hosted office's words first.
    backend.queries['reorientationDecisions:listForAgent'] = [];
    const html = renderToStaticMarkup(
      asEmployee(<ReorientationView />, { surfaceMode: undefined }),
    );
    expect(html).not.toContain('hosted office');
    expect(html).not.toContain('A card opens when a person');
    expect(html).toContain('Loading the reorientation cards');
    expect(html).not.toContain('Open a card');
  });

  it('says it is loading until the cards are read, and draws nothing else', () => {
    backend.queries['reorientationDecisions:listForAgent'] = undefined;
    const html = renderToStaticMarkup(asEmployee(<ReorientationView />, { surfaceMode: 'real' }));
    expect(html).toContain('Loading the reorientation cards');
    expect(html).not.toContain('No reorientation card is open');
  });
});
