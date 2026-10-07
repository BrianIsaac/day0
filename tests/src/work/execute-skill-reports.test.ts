import { describe, expect, it } from 'vitest';
import type { MockSurfaceSnapshot } from '../../../src/work/types';
import {
  dependentExecuteSchemaForProcedureContract,
  executeSchemaForProcedureContract,
  executorInstructions,
  parseProcedureContract,
} from '../../../src/work/execute-skill';

/*
 * The wave 13 review's D-5 (b): a message names the writes of its set it reports, by index, in
 * the run's structured output, so the apply binds it to exactly those and no form list can miss
 * one. The lexical reading stays beside it as a tripwire (`src/work/evidence-claims.ts`).
 */

const mockEnv: MockSurfaceSnapshot = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
};

const REPORTS_LINE =
  'Reports: `reports`, beside `tool` and `args` on every action that can carry a comment, a post, a reply or a DM. On a message, it lists the indexes in `actions` of the writes earlier in this response that the message reports as made, counting every action from 0, reads included (a comment after a read and two posts lists [1, 2]), and is [] when it reports none of them; on an action that is not a message it is null. Day0 sends a message only once every write it lists has landed, and holds it back otherwise, so list each write the message reports, and never one after it.';

const post = {
  tool: 'slack.postMessage',
  args: { channelSlug: 'office-asks', threadKey: 'thread-monitor', body: 'Hi Sara, ...' },
  reports: null,
};
const comment = {
  tool: 'ticket.update',
  args: { slug: 'REVOPS-205', status: null, comment: 'Sara has her answer in the thread.' },
  reports: [0],
};

describe("the executor's declared reports (D-5 (b))", (): void => {
  it('asks for reports on every message in both modes', (): void => {
    for (const mode of ['mock', 'real'] as const) {
      const prompt = executorInstructions({
        mode,
        autonomousActions: false,
        skillBody: '# skill',
        surfaces: [],
        mockEnv,
        now: 0,
      });
      expect(prompt, mode).toContain(REPORTS_LINE);
    }
  });

  it('takes reports on a message action in both phases and both modes', (): void => {
    const contract = parseProcedureContract(mockEnv);
    const base = {
      draft: 'd',
      notes: 'n',
      workDone: 'done',
      workDoneWhy: 'Done.',
      actions: [post, comment],
      procedureTrails: [],
    };
    expect(
      executeSchemaForProcedureContract(contract).safeParse({ ...base, needsDependentPhase: false })
        .success,
    ).toBe(true);
    expect(
      dependentExecuteSchemaForProcedureContract(contract, 'mock').safeParse({
        ...base,
        planStepOutcomes: [],
      }).success,
    ).toBe(true);
    expect(
      executeSchemaForProcedureContract(contract).safeParse({
        ...base,
        needsDependentPhase: false,
        actions: [post, { ...comment, reports: [-1] }],
      }).success,
    ).toBe(false);
  });

  it('asks a message for reports, and a row append for none', (): void => {
    const contract = parseProcedureContract(mockEnv);
    const reply = (actions: unknown[]) => ({
      draft: 'd',
      notes: 'n',
      needsDependentPhase: false,
      workDone: 'done',
      workDoneWhy: 'Done.',
      actions,
      procedureTrails: [],
    });
    const { reports: _omitted, ...withoutReports } = comment;
    void _omitted;
    expect(
      executeSchemaForProcedureContract(contract).safeParse(reply([withoutReports])).success,
    ).toBe(false);
    const row = {
      tool: 'spreadsheet.appendRow',
      args: { sheetSlug: 'q4', tabName: 'closed-won', cells: [{ header: 'Deal', value: 'Acme' }] },
    };
    expect(executeSchemaForProcedureContract(contract).safeParse(reply([row])).success).toBe(true);
    expect(
      executeSchemaForProcedureContract(contract).safeParse(reply([{ ...row, reports: null }]))
        .success,
    ).toBe(false);
  });
});
