import { describe, expect, it } from 'vitest';
import { planPromisesClose, planWithholdsClose, promisedReads, promisesClose, promisesResult, withholdsClose } from '../../../src/work/plan-steps';
import {
  auditNotePlan,
  refreshPlan,
  REVOPS_5_STEP_2,
  REVOPS_5_STEP_5,
  REVOPS_7_STEP_3,
  RUN_3_REVOPS_7_STEP_1,
  RUN_3_REVOPS_7_STEP_2,
  RUN_3_REVOPS_7_STEP_3,
  run3RefreshPlan,
} from '../../convex/fixtures/closing-gates-2026-09-16';

describe('what a plan step promises, read from the 16 September plans', (): void => {
  it('does not read a write that quotes something "as evidence" as a promised result', (): void => {
    expect(promisesResult(REVOPS_7_STEP_3)).toBe(false);
    expect(promisesResult(auditNotePlan.steps[3]!)).toBe(false);
    expect(refreshPlan.steps.map(promisesResult)).toEqual([false, true, false, false]);
  });

  it('reads a result a capture verb gathers as a promise, even when the same clause writes', (): void => {
    for (const wording of [
      'Gather evidence from the Looker pipeline tile and post it to Linear.',
      'Collect evidence for the three checks and post the audit comment in one go.',
    ]) {
      expect(promisesResult(wording), wording).toBe(true);
    }
    expect(promisesResult('Record the result of the read-back on REVOPS-7.')).toBe(false);
    expect(promisesResult('Obtain the audit line as evidence and send it to the manager.')).toBe(false);
    expect(promisesResult('Post one save_comment on REVOPS-5 with the three checks in checklist order, quoting evidence.')).toBe(false);
  });

  it('still reads a captured result noun outside a write as a promise', (): void => {
    expect(promisesResult('Capture the Looker pipeline tile read-back evidence')).toBe(true);
    expect(promisesResult('Capture evidence of the figure from the Looker pipeline tile.')).toBe(true);
    expect(promisesResult('Check the three deals with Linear reads')).toBe(true);
  });

  it('does not read a period-named close such as "Q3 close project" as a promise to close', (): void => {
    expect(promisesClose(REVOPS_5_STEP_2)).toBe(false);
    for (const wording of [
      'Read the FY26 close checklist page before the note.',
      'Summarise the month-end close status for the manager.',
      'Read the 2026 close calendar in Notion.',
      'List the tickets in the Q3 close project.',
    ]) {
      expect(promisesClose(wording), wording).toBe(false);
    }
    expect(auditNotePlan.steps.map(promisesClose)).toEqual([false, false, false, false, false]);
  });

  it('reads an imperative close before a noun head as the instruction it is', (): void => {
    for (const wording of [
      'Complete task REVOPS-7.',
      'Close items REVOPS-5 and REVOPS-7 in Linear.',
      'Resolve work item REVOPS-7 once the comment lands.',
      'Then close project REVOPS in Linear.',
    ]) {
      expect(promisesClose(wording), wording).toBe(true);
    }
    expect(withholdsClose('Do not close tasks in this run.')).toBe(true);
    expect(withholdsClose('Never complete items without the audit comment.')).toBe(true);
    for (const wording of ['Review close tasks for the quarter.', 'Read the close status page.', 'Summarise the completed close checks.']) {
      expect(promisesClose(wording), wording).toBe(false);
    }
  });

  it('still reads an instruction to close as a promise', (): void => {
    expect(promisesClose('Close the ticket once the comment lands.')).toBe(true);
    expect(promisesClose('Move REVOPS-7 to Done via linear save_issue once the audit comment is saved.')).toBe(true);
    expect(promisesClose('Close REVOPS-5 in the Q3 close project.')).toBe(true);
    expect(promisesClose(REVOPS_5_STEP_5)).toBe(false);
  });
});

describe('a plan that withholds the transition in its own words', (): void => {
  it('reads a negated close and a "no status change" summary as withholding', (): void => {
    expect(withholdsClose(REVOPS_5_STEP_5)).toBe(true);
    expect(withholdsClose(auditNotePlan.summary)).toBe(true);
    expect(withholdsClose('Hold the Done transition for the manager.')).toBe(true);
    expect(withholdsClose('Leave REVOPS-5 open for the manager to close.')).toBe(true);
    expect(withholdsClose('Move REVOPS-7 to Done once the audit comment is saved.')).toBe(false);
    expect(withholdsClose(REVOPS_5_STEP_2)).toBe(false);
  });

  it('does not read the alternative branch of a stated condition as withholding, as the run 3 REVOPS-7 step 3 has it', (): void => {
    expect(withholdsClose(RUN_3_REVOPS_7_STEP_3)).toBe(false);
    expect(planWithholdsClose(run3RefreshPlan)).toBe(false);
    expect(planPromisesClose(run3RefreshPlan)).toBe(true);
    expect(withholdsClose('Move it to Done when the checks pass, otherwise leave it open.')).toBe(false);
    expect(withholdsClose('Close REVOPS-7 if the figure matches; else hold the Done transition.')).toBe(false);
    // The plan's own word before the alternative still withholds.
    expect(withholdsClose('Do not move REVOPS-5 to Done; otherwise the checklist is void.')).toBe(true);
    expect(withholdsClose('Leave REVOPS-5 open for the manager to close, otherwise the audit fails.')).toBe(true);
  });

  it('keeps an alternative branch that is the only word on the state: nothing before it promises the close', (): void => {
    // Commit c51e87a read every "otherwise ..." out; a plan whose primary branch is a comment, not a close, then let a Done through under the switch.
    for (const wording of [
      'Post the comment if the figure matches; otherwise leave REVOPS-7 in progress and flag the manager.',
      'Post the audit comment on REVOPS-7. Otherwise leave it in progress.',
      'Comment on REVOPS-7 only if the figure matches; otherwise leave the ticket open for the manager.',
      'Reply in the thread when the figure matches, or else do not move REVOPS-7 to Done.',
    ]) {
      expect(withholdsClose(wording), wording).toBe(true);
    }
    expect(planWithholdsClose({
      summary: 'Comment on REVOPS-7.',
      steps: ['Read the Looker pipeline tile.', 'Post the comment if the figure matches; otherwise leave REVOPS-7 in progress and flag the manager.'],
    })).toBe(true);
    // The alternative to a promised close is still conditional, whichever punctuation joins them.
    expect(withholdsClose('Move REVOPS-7 to Done when the checks pass. Otherwise leave it in progress.')).toBe(false);
    expect(withholdsClose("Set REVOPS-7 state to 'Done' if the figure matches, otherwise leave it open.")).toBe(false);
  });

  it('never promised the close, even when another step reads as completing something', (): void => {
    expect(planPromisesClose(refreshPlan)).toBe(true);
    expect(planPromisesClose(auditNotePlan)).toBe(false);
    expect(
      planPromisesClose({
        summary: 'Run the checks and record the note.',
        steps: [
          'Complete the three checks in checklist order and quote the evidence.',
          'Add an audit comment on REVOPS-5 via linear save_comment with the three checks.',
          REVOPS_5_STEP_5,
        ],
      }),
    ).toBe(false);
    expect(
      planPromisesClose({
        summary: 'Run the checks, record the note and close the ticket.',
        steps: ['Complete the three checks in checklist order.', 'Comment on REVOPS-5, then move it to Done.'],
      }),
    ).toBe(true);
  });
});

describe('which surface a promised read binds to', (): void => {
  const linear = { slug: 'linear', displayName: 'Linear' };
  const tile = { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile' };
  const surfaces = [linear, { slug: 'slack', displayName: 'Slack' }, tile];
  const bound = (steps: string[]): string[] =>
    promisedReads(steps, surfaces).map((read) => `${read.step}:${read.surface.slug}${read.conditional ? '?' : ''}`);

  it('binds the run 3 REVOPS-7 read-back to the tile and never to Linear, the write target', (): void => {
    expect(bound(run3RefreshPlan.steps)).toEqual(['1:looker-pipeline-tile']);
    expect(bound([RUN_3_REVOPS_7_STEP_3])).toEqual([]);
    expect(bound([RUN_3_REVOPS_7_STEP_2])).toEqual([]);
    const [read] = promisedReads([RUN_3_REVOPS_7_STEP_1], surfaces);
    expect(read).toMatchObject({ step: 1, term: 'read', surface: tile, conditional: false });
    expect(read!.clause).toBe("browser_snapshot to read back the visible figure and the audit line 'Last updated by <user> at <time> UTC'");
  });

  it('binds the run 2 reads to the surface each reads from, and an unnamed read-back to nothing', (): void => {
    expect(bound([auditNotePlan.steps[0]!])).toEqual(['1:looker-pipeline-tile']);
    expect(bound([REVOPS_5_STEP_2])).toEqual(['1:linear']);
    expect(bound(auditNotePlan.steps)).toEqual(['1:looker-pipeline-tile', '2:linear']);
    expect(bound(refreshPlan.steps)).toEqual([]);
    expect(bound(['Read back the audit line and stop if it is absent.'])).toEqual([]);
  });

  it('binds a read naming two surfaces to both, and a write beside a read to the read alone', (): void => {
    expect(bound(['Read the ticket on Linear and the figure on the Looker pipeline tile.'])).toEqual(['1:linear', '1:looker-pipeline-tile']);
    expect(bound(['Read the figure on the Looker pipeline tile and post it to Linear.'])).toEqual(['1:looker-pipeline-tile']);
    expect(bound(['Gather evidence from the Looker pipeline tile and post it to Linear.'])).toEqual(['1:looker-pipeline-tile']);
    expect(bound(['Check the three deals with Linear reads'])).toEqual(['1:linear']);
    expect(bound(['Capture the Looker pipeline tile read-back evidence'])).toEqual(['1:looker-pipeline-tile']);
    expect(bound(['Read the connected Linear queue to locate the “Refresh the Looker pipeline tile” request and confirm its issue id.'])).toEqual(['1:linear']);
  });

  it('never reads a surface named only as a write target', (): void => {
    for (const wording of [
      "On linear, set REVOPS-7 state to 'Done' only if the audit line was read back.",
      'Add a comment on REVOPS-7 via linear save_comment once you read back the figure.',
      'Verify the figure, then post it on Linear.',
      'Post the figure to Linear and read the tile.',
    ]) {
      expect(bound([wording]), wording).toEqual([]);
    }
    expect(bound(['Post the figure to Linear and read the Looker pipeline tile.'])).toEqual(['1:looker-pipeline-tile']);
  });

  it('reads a surface the sentence opens on as where the sentence acts, through its later clauses but not past its end', (): void => {
    expect(bound(['On linear, add a comment, then read back the ticket state.'])).toEqual(['1:linear']);
    expect(bound(['On linear, add a comment. Then read back the figure.'])).toEqual([]);
    expect(bound(['In Linear, read REVOPS-7 and confirm it has an owner.'])).toEqual(['1:linear']);
    expect(bound(['Sign in to the Looker pipeline tile, set 74%, save and snapshot the audit line.'])).toEqual(['1:looker-pipeline-tile']);
    // The read has a surface of its own, so the opening surface is only written.
    expect(bound(['On linear, add a comment quoting the figure you read on the Looker pipeline tile.'])).toEqual(['1:looker-pipeline-tile']);
    expect(bound(['Read the ticket on Linear, then post the figure.'])).toEqual(['1:linear']);
    expect(bound(['Open the Linear REVOPS ticket and inspect any linked context or runbook instructions for the pipeline tile refresh.'])).toEqual(['1:linear']);
  });

  it('does not take a ticket identifier or a name inside a longer surface name for a mention', (): void => {
    const withChannel = [...surfaces, { slug: 'revops', displayName: '#revops' }, { slug: 'looker', displayName: 'Looker' }];
    const names = (step: string): string[] => promisedReads([step], withChannel).map((read) => read.surface.slug);
    expect(names('Read back the audit line and comment on REVOPS-7')).toEqual([]);
    expect(names('Read REVOPS-7 in Linear and the figure on the Looker pipeline tile.')).toEqual(['linear', 'looker-pipeline-tile']);
    expect(names('Read the figure in Looker.')).toEqual(['looker']);
    expect(names('Read the thread in #revops.')).toEqual(['revops']);
  });

  it('binds a read in a condition to the surface it names only when no other step reads that surface', (): void => {
    const conditional = 'Move REVOPS-7 to Done only if Linear reports the ticket in Backlog.';
    expect(promisedReads([conditional], surfaces)).toEqual([
      expect.objectContaining({ step: 1, term: 'reports', surface: linear, conditional: true, clause: 'only if Linear reports the ticket in Backlog' }),
    ]);
    expect(bound(['Read REVOPS-7 in Linear via get_issue.', conditional])).toEqual(['1:linear']);
    expect(bound(['Move REVOPS-7 to Done only if the audit line was read back on the Looker pipeline tile.', RUN_3_REVOPS_7_STEP_1])).toEqual(['2:looker-pipeline-tile']);
    expect(bound(['Move REVOPS-7 to Done only if the audit line was read back on the Looker pipeline tile.'])).toEqual(['1:looker-pipeline-tile?']);
    // A condition that opens the clause ends at its comma: the read after it is the instruction itself.
    expect(bound(['If the page redirects, read the error on the Looker pipeline tile and stop.'])).toEqual(['1:looker-pipeline-tile']);
  });
});
