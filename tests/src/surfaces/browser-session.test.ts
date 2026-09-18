import { describe, expect, it } from 'vitest';
import {
  sessionRecipe as recipeForRun,
  signsIn,
  type EarlierRows,
  type SessionRecipeStep,
} from '../../../src/surfaces/browser-session';
import type { ActionAuthority, AppliedAction } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const ENDPOINT = 'http://looker-tile:8080/';
const sessionRecipe = (slug: string, earlier: EarlierRows, endpoint: string | undefined, runId = 'run') =>
  recipeForRun(slug, earlier, endpoint, runId);

const call = (tool: string, args: Record<string, unknown> = {}, surface = 'looker'): MockAction => ({
  tool: 'mcp.call',
  args: { surface, tool, toolArgsJson: JSON.stringify(args) },
});
const navigate = (url = ENDPOINT): MockAction => call('browser_navigate', { url });
const signIn = call('browser_fill_form', {
  fields: [
    { name: 'Username', value: 'revops' },
    { name: 'Password', value: '{{secret}}' },
  ],
});
const clickSignIn = call('browser_click', { element: 'Sign in' });
const snapshot = call('browser_snapshot');
const fillCoverage = call('browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '74%' }] });
const clickSave = call('browser_click', { element: 'Save' });

const landed = (key: string, authority: ActionAuthority = 'autonomous'): AppliedAction => ({
  tool: 'mcp.call',
  ok: true,
  effect: 'ok',
  authority,
  idempotencyKey: key,
});

/** A ledger for one run: every action landed under the toggle, keyed by its index. */
function run(actions: MockAction[], runId = 'run', offset = 0): { actions: MockAction[]; applied: AppliedAction[] } {
  return { actions, applied: actions.map((_, index) => landed(`wi:${runId}:${index + offset}`)) };
}

const tools = (recipe: SessionRecipeStep[]): Array<[string, string | undefined]> =>
  recipe.map((step) => [String(step.action.args.tool), step.replayOf]);

describe('the steps that re-establish a browser session', (): void => {
  it('replays the navigate, the credential fill and the Sign in click of a sign-in then read', (): void => {
    const recipe = sessionRecipe('looker', run([navigate(), signIn, clickSignIn, snapshot]), ENDPOINT);
    expect(recipe).toEqual([
      { action: navigate(), replayOf: 'wi:run:0', authority: 'autonomous' },
      { action: signIn, replayOf: 'wi:run:1', authority: 'autonomous' },
      { action: clickSignIn, replayOf: 'wi:run:2', authority: 'autonomous' },
    ]);
  });

  it('ends on the page the run last navigated to after signing in', (): void => {
    const reports = navigate('http://looker-tile:8080/reports');
    const recipe = sessionRecipe(
      'looker',
      run([navigate(), signIn, clickSignIn, snapshot, reports, snapshot]),
      ENDPOINT,
    );
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:run:0'],
      ['browser_fill_form', 'wi:run:1'],
      ['browser_click', 'wi:run:2'],
      ['browser_navigate', 'wi:run:4'],
    ]);
    expect(recipe[3]!.action).toEqual(reports);
  });

  it('opens the surface endpoint first when the run never navigated', (): void => {
    const recipe = sessionRecipe('looker', run([signIn, clickSignIn]), ENDPOINT);
    expect(recipe).toEqual([
      { action: navigate() },
      { action: signIn, replayOf: 'wi:run:0', authority: 'autonomous' },
      { action: clickSignIn, replayOf: 'wi:run:1', authority: 'autonomous' },
    ]);
    expect(sessionRecipe('looker', { actions: [], applied: [] }, ENDPOINT)).toEqual([
      { action: navigate() },
    ]);
  });

  it('never replays a fill without the credential placeholder, a Save click or a snapshot', (): void => {
    const recipe = sessionRecipe(
      'looker',
      run([navigate(), signIn, clickSignIn, fillCoverage, clickSave, snapshot]),
      ENDPOINT,
    );
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:run:0'],
      ['browser_fill_form', 'wi:run:1'],
      ['browser_click', 'wi:run:2'],
    ]);
  });

  it('never treats a work Save after a secret-bearing fill as a sign-in', (): void => {
    const workFill = call('browser_fill_form', {
      fields: [{ name: 'Pipeline coverage', value: '{{secret}}' }],
    });
    const recipe = sessionRecipe(
      'looker',
      run([navigate(), signIn, clickSignIn, workFill, clickSave, snapshot]),
      ENDPOINT,
    );
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:run:0'],
      ['browser_fill_form', 'wi:run:1'],
      ['browser_click', 'wi:run:2'],
    ]);
  });

  it('does not replay an incomplete credential fill, including when another write separates it from a click', (): void => {
    for (const actions of [
      [navigate(), signIn],
      [navigate(), signIn, fillCoverage, clickSignIn],
    ]) {
      expect(() => sessionRecipe('looker', run(actions), ENDPOINT)).toThrow('incomplete sign-in');
    }
  });

  it('refuses a credential fill whose submit is separated by a read', (): void => {
    expect(() => sessionRecipe('looker', run([navigate(), signIn, snapshot, clickSignIn]), ENDPOINT)).toThrow(
      'incomplete sign-in',
    );
  });

  it('refuses a click separated from a credential fill by a held or failed row', (): void => {
    const actions = [navigate(), signIn, fillCoverage, clickSignIn];
    const separated = run(actions);
    for (const intervening of [
      { ...landed('wi:run:2'), ok: false, reason: 'provider refused' },
      { ...landed('wi:run:2'), held: true, reason: 'awaiting approval' },
    ]) {
      separated.applied[2] = intervening;
      expect(() => sessionRecipe('looker', separated, ENDPOINT)).toThrow('incomplete sign-in');
    }
  });

  it('selects only the second of two complete sign-ins', (): void => {
    const recipe = sessionRecipe(
      'looker',
      run([navigate(), signIn, clickSignIn, signIn, clickSignIn, snapshot]),
      ENDPOINT,
    );
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:run:0'],
      ['browser_fill_form', 'wi:run:3'],
      ['browser_click', 'wi:run:4'],
    ]);
  });

  it('ignores held, awaiting, refused and failed rows, and other surfaces', (): void => {
    const actions = [
      navigate(),
      signIn,
      signIn,
      signIn,
      call('browser_navigate', { url: 'https://example.invalid/' }, 'other'),
      signIn,
      clickSignIn,
    ];
    const applied: AppliedAction[] = [
      landed('wi:run:0'),
      { tool: 'mcp.call', ok: true, held: true, reason: 'held', idempotencyKey: 'wi:run:1' },
      { tool: 'mcp.call', ok: true, held: true, awaitingApproval: true, idempotencyKey: 'wi:run:2' },
      { tool: 'mcp.call', ok: false, reason: 'no grant (looker:write)', idempotencyKey: 'wi:run:3' },
      landed('wi:run:4'),
      landed('wi:run:5', 'manager'),
      landed('wi:run:6', 'manager'),
    ];
    expect(sessionRecipe('looker', { actions, applied }, ENDPOINT)).toEqual([
      { action: navigate(), replayOf: 'wi:run:0', authority: 'autonomous' },
      { action: signIn, replayOf: 'wi:run:5', authority: 'manager' },
      { action: clickSignIn, replayOf: 'wi:run:6', authority: 'manager' },
    ]);
  });

  it('reads the latest run only, so an earlier run\'s landed writes are not replayed before its own navigate', (): void => {
    // A retry's prerequisite ledger: the earlier run's landed writes first
    // (no navigate, which is a read), then this run's own phase one.
    const earlier = run([signIn, clickSignIn, fillCoverage, clickSave], 'first', 1);
    const own = run([navigate(), signIn, clickSignIn, snapshot], 'second');
    const recipe = sessionRecipe(
      'looker',
      { actions: [...earlier.actions, ...own.actions], applied: [...earlier.applied, ...own.applied] },
      ENDPOINT,
      'second',
    );
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:second:0'],
      ['browser_fill_form', 'wi:second:1'],
      ['browser_click', 'wi:second:2'],
    ]);
  });

  it('uses only the endpoint when the current run has no browser rows', (): void => {
    const older = run([navigate(), signIn, clickSignIn], 'older');
    expect(sessionRecipe('looker', older, ENDPOINT, 'retry')).toEqual([{ action: navigate() }]);
  });

  it('orders a run by its durable index and de-duplicates a row carried twice', (): void => {
    // A resumed closing set: the previous attempt's landed writes (its
    // closing sign-in included) carried ahead of its own phase one.
    const writes = {
      actions: [signIn, clickSignIn, signIn, clickSignIn, fillCoverage],
      applied: ['wi:first:1', 'wi:first:2', 'wi:first:4', 'wi:first:5', 'wi:first:6'].map((key) => landed(key)),
    };
    const phaseOne = run([navigate(), signIn, clickSignIn, snapshot], 'first');
    const recipe = sessionRecipe(
      'looker',
      {
        actions: [...writes.actions, ...phaseOne.actions],
        applied: [...writes.applied, ...phaseOne.applied],
      },
      ENDPOINT,
      'first',
    );
    // The run signed in twice; the session to restore is the last sign-in.
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:first:0'],
      ['browser_fill_form', 'wi:first:4'],
      ['browser_click', 'wi:first:5'],
    ]);
  });

  it('replays every credential fill of a sign-in that spans two pages', (): void => {
    const username = call('browser_fill_form', { fields: [{ name: 'Email', value: '{{secret:looker}}' }] });
    const next = call('browser_click', { element: 'Next' });
    const recipe = sessionRecipe(
      'looker',
      run([navigate(), username, next, signIn, clickSignIn, snapshot]),
      ENDPOINT,
    );
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:run:0'],
      ['browser_fill_form', 'wi:run:1'],
      ['browser_click', 'wi:run:2'],
      ['browser_fill_form', 'wi:run:3'],
      ['browser_click', 'wi:run:4'],
    ]);
  });

  it('reads a session an earlier invocation re-established from the steps it recorded', (): void => {
    const phaseOne = run([navigate(), signIn, clickSignIn, snapshot]);
    const restoredRow: AppliedAction = {
      ...landed('wi:run:4'),
      sessionRestore: {
        steps: [
          { ...landed('wi:run:4.session-0'), replayOf: 'wi:run:0', action: navigate() },
          { ...landed('wi:run:4.session-1'), replayOf: 'wi:run:1', action: signIn },
          { ...landed('wi:run:4.session-2'), replayOf: 'wi:run:2', action: clickSignIn },
        ],
      },
    };
    // Only the closing set's rows: the phase-one rows are not in this input.
    const recipe = sessionRecipe(
      'looker',
      { actions: [fillCoverage, clickSave], applied: [restoredRow, landed('wi:run:5')] },
      ENDPOINT,
    );
    expect(tools(recipe)).toEqual([
      ['browser_navigate', 'wi:run:0'],
      ['browser_fill_form', 'wi:run:1'],
      ['browser_click', 'wi:run:2'],
    ]);
    // With the phase-one rows as well, the one sign-in is still replayed once.
    const both = sessionRecipe(
      'looker',
      {
        actions: [...phaseOne.actions, fillCoverage, clickSave],
        applied: [...phaseOne.applied, restoredRow, landed('wi:run:5')],
      },
      ENDPOINT,
    );
    expect(tools(both)).toEqual([
      ['browser_navigate', 'wi:run:0'],
      ['browser_fill_form', 'wi:run:1'],
      ['browser_click', 'wi:run:2'],
    ]);
  });
});

describe('telling a sign-in from any other fill', (): void => {
  it('is a credential fill on the surface, and nothing else', (): void => {
    expect(signsIn(signIn, 'looker')).toBe(true);
    expect(signsIn(call('browser_fill_form', { fields: [{ name: 'Email', value: '{{ secret:looker }}' }] }), 'looker')).toBe(true);
    expect(signsIn(fillCoverage, 'looker')).toBe(false);
    expect(signsIn(call('browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '{{secret}}' }] }), 'looker')).toBe(false);
    expect(signsIn(clickSignIn, 'looker')).toBe(false);
    expect(signsIn(signIn, 'other')).toBe(false);
    expect(signsIn(undefined, 'looker')).toBe(false);
  });
});
