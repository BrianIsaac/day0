/**
 * The Slack mention's first attempt on the 17 September recording, as its
 * `work.failed` payload in the export records it
 * (`docs/plans/progress/recording-run-2026-09-17/export/events/documents.jsonl`,
 * item `n57d5ekg1grzcgk9atf2698mgn8ehqq9`): phase one signed in and read the
 * tile at 68%, the closing fill and Save found nothing on a blank page, the
 * closing snapshot read `about:blank`, and the DM went out saying the refresh
 * had been applied. The retry resumed at the closing phase from this ledger
 * and its reply told the thread the tile "currently shows 68%", four minutes
 * after REVOPS-7 had saved 74%.
 */
import type { AppliedAction } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';
import { slackClosing, slackClosingReply, slackPhaseOne } from '../../fixtures/browser-phase-split-2026-09-16';

/** The first attempt's run id, the claim event the export names. */
export const FIRST_RUN_2026_09_17 = 'k57bve1hwbp8wyz0d23hcc98gs8egr5c';

/** The reason the first attempt failed with. */
export const FIRST_FAILURE_2026_09_17 =
  '2 of 4 actions did not change the work environment: mcp.call (the page has no element called "Pipeline coverage" (nothing named on the page)); mcp.call (the page has no element called "Save" (nothing named on the page))';

/**
 * The first attempt's flattened output, keyed for the work item it is seeded on.
 *
 * Args:
 *   workItemId: The seeded item; the export's keys carry its own id.
 *
 * Returns:
 *   The output the failed row carried.
 */
export function firstAttempt2026_09_17(workItemId: string): {
  draft: string;
  notes: string;
  needsDependentPhase: false;
  actions: MockAction[];
  applied: AppliedAction[];
  planStepOutcomes: typeof slackClosingReply.planStepOutcomes;
  prerequisiteCount: number;
  procedureTrails: never[];
} {
  const key = (index: number): string => `${workItemId}:${FIRST_RUN_2026_09_17}:${index}`;
  const landed = (index: number, effect: string): AppliedAction => ({
    tool: 'mcp.call',
    ok: true,
    authority: 'autonomous',
    effect,
    idempotencyKey: key(index),
  });
  return {
    draft: slackClosingReply.draft,
    notes: slackClosingReply.notes,
    needsDependentPhase: false,
    actions: [...slackPhaseOne, ...slackClosing],
    applied: [
      landed(
        0,
        "browser_navigate on looker · ### Ran Playwright code ```js await page.goto('http://looker-tile:8080/'); ``` ### Page - Page URL: http://looker-tile:8080/ - Page Title: Sign in - Looker",
      ),
      landed(
        1,
        "browser_fill_form on looker · ### Ran Playwright code ```js await page.getByRole('textbox', { name: 'Username' }).fill('revops'); await page.getByRole('textbox', { name: 'Password…",
      ),
      landed(
        2,
        "browser_click on looker · ### Ran Playwright code ```js await page.getByRole('button', { name: 'Sign in' }).click(); ``` ### Page - Page URL: http://looker-tile:8080/login - Page …",
      ),
      landed(3, 'browser_snapshot on looker · visible figure 68%'),
      {
        tool: 'mcp.call',
        ok: false,
        reason: 'the page has no element called "Pipeline coverage" (nothing named on the page)',
        idempotencyKey: key(4),
      },
      {
        tool: 'mcp.call',
        ok: false,
        reason: 'the page has no element called "Save" (nothing named on the page)',
        idempotencyKey: key(5),
      },
      landed(6, 'browser_snapshot on looker · ### Page - Page URL: about:blank ### Snapshot ```yaml ```'),
      {
        tool: 'http.request',
        ok: true,
        authority: 'autonomous',
        effect:
          'HTTP 200 · {"ok":true,"channel":"D0BS5SXMXPZ","ts":"1789592857.505309","message":{"user":"U0BTFK6FLNL","type":"message","ts":"1789592857.505309"',
        providerId: '1789592857.505309',
        idempotencyKey: key(7),
      },
    ],
    planStepOutcomes: slackClosingReply.planStepOutcomes,
    prerequisiteCount: 4,
    procedureTrails: [],
  };
}
