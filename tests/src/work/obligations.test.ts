import { describe, expect, it } from 'vitest';
import {
  isOpenQuestionStop,
  managerDmReachable,
  managerMessageTexts,
  openManagerQuestion,
  conflictRelationsOf,
  isConflictQuestion,
  joinedOpenQuestion,
  noteAnswersQuestion,
  openQuestionStopReason,
  ownQuestionOf,
  standingQuestionsOf,
} from '../../../src/work/obligations';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';
import { log1PhaseOne, log1Plan } from '../../fixtures/work/full-run-4-2026-09-19-log-1';

const slack = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage'],
  managerDmChannelId: 'D0MANAGER',
} as unknown as SurfaceRecord;
const linear = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
} as unknown as SurfaceRecord;

const dm = (text: string): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel: 'D0MANAGER', text }),
  },
});
const [, , comment, done] = log1PhaseOne.actions;

describe('the hold over a Chinese manager DM', () => {
  const ASKED =
    'SH-4471 在巴生港滞留，承运商没有给出新的到港时间。请问通知应使用哪个模板？下次更新时间定在几点？';

  it('hands the whole Chinese message to the reader of questions, not a sentence a mark picked out', (): void => {
    expect(managerMessageTexts([dm(ASKED), comment!, done!], [slack, linear])).toEqual([ASKED]);
  });

  it('withholds the writes that wait on a Chinese question, with or without the full-width mark', (): void => {
    for (const question of ['请问通知应使用哪个模板？', '请确认通知使用哪个模板。']) {
      const open = openManagerQuestion({
        plan: log1Plan,
        actions: [dm(ASKED), comment!, done!],
        surfaces: [slack, linear],
        question,
        answered: false,
      });
      expect(open?.withheld).toEqual([
        { index: 1, step: 2 },
        { index: 2, step: 3 },
      ]);
      expect(open?.question).toBe(question);
    }
  });
});

describe('managerDmReachable', () => {
  it('reaches the manager through a connected chat surface with a manager DM channel', (): void => {
    expect(managerDmReachable([slack, linear], 1)).toBe(true);
  });

  it('does not when no chat surface exists, it has gone stale, or it has no manager DM channel', (): void => {
    expect(managerDmReachable([linear], 1)).toBe(false);
    expect(managerDmReachable([slack, linear], 7 * 60 * 60 * 1_000)).toBe(false);
    expect(
      managerDmReachable([{ ...slack, managerDmChannelId: '' } as SurfaceRecord, linear], 1),
    ).toBe(false);
  });
});

describe('isOpenQuestionStop', (): void => {
  it('recognises the stop a run records with its question open, and no other (review D2)', (): void => {
    expect(
      isOpenQuestionStop(
        openQuestionStopReason({ question: '请确认通知使用哪个模板。', steps: [2, 3] }),
      ),
    ).toBe(true);
    expect(
      isOpenQuestionStop(
        'withheld before the first write: LOG-1 changed since the plan was made: it changed hands: it is assigned to another person. Nothing was sent.',
      ),
    ).toBe(false);
    expect(isOpenQuestionStop('the closing phase asked the manager for evidence')).toBe(false);
  });

  it('keeps recognising a stop recorded before v0.13.0, whose steps read "step step 2" (the real-Linear walk, m9)', (): void => {
    expect(
      isOpenQuestionStop(
        "the approved plan leaves step step 2 and step 3 to the manager's answer, and the question put to the manager is still open: Which template?",
      ),
    ).toBe(true);
  });
});

describe('openQuestionStopReason', (): void => {
  it('names the steps that wait on the answer once each, never "step step" (the real-Linear walk, m9)', (): void => {
    const reason = (steps: number[]): string =>
      openQuestionStopReason({ question: 'Which template?', steps });
    expect(reason([2])).toBe(
      "the approved plan leaves step 2 to the manager's answer, and the question put to the manager is still open: Which template?",
    );
    expect(reason([2, 3])).toBe(
      "the approved plan leaves steps 2 and 3 to the manager's answer, and the question put to the manager is still open: Which template?",
    );
    expect(reason([1, 2, 4])).toContain('leaves steps 1, 2 and 4 to');
  });

  it('names every question a set waits on, and the steps of them all, in one stop (17-C, C-2)', (): void => {
    const reason = openQuestionStopReason({
      question: 'Which template?',
      steps: [3],
      also: [{ question: 'Two pages disagree. Which is right?', steps: [2], relationId: 'r1' }],
    });
    expect(reason).toBe(
      "the approved plan leaves steps 2 and 3 to the manager's answer, and the question put to the manager is still open: Which template? Also open: Two pages disagree. Which is right?",
    );
    // It is still the question stop, so a note given with Retry answers the executor's question.
    expect(isOpenQuestionStop(reason)).toBe(true);
  });
});

describe('the questions a set waits on, each with its own mark (17-C, C-2; the pre-tag’s second pass)', (): void => {
  const own = { question: 'Which template?', steps: [3] };
  const conflict = {
    question: 'Two pages disagree. Which is right?',
    steps: [2],
    relationId: 'r1',
  };

  it('keeps the conflict’s mark beside the executor’s own question, whichever was recorded first', (): void => {
    const mixed = joinedOpenQuestion(joinedOpenQuestion(undefined, own), conflict);
    expect(mixed).toEqual({ ...own, also: [conflict] });
    expect(standingQuestionsOf(mixed)).toEqual([own, conflict]);
    expect(joinedOpenQuestion(conflict, own)).toEqual({ ...conflict, also: [own] });
    // The stored output says so to every reader: a conflict's question is among them, and the
    // executor's own is the one a note answers.
    expect(isConflictQuestion({ openQuestion: mixed })).toBe(true);
    expect(conflictRelationsOf({ openQuestion: mixed })).toEqual(['r1']);
    expect(ownQuestionOf({ openQuestion: mixed })).toBe('Which template?');
    expect(ownQuestionOf({ initial: { openQuestion: mixed } })).toBe('Which template?');
  });

  it('joins the steps of the same question, by its relation or by its words, and never doubles it', (): void => {
    expect(joinedOpenQuestion(own, { question: 'Which template?', steps: [2, 3] })).toEqual({
      question: 'Which template?',
      steps: [2, 3],
    });
    const again = { question: 'Asked in other words.', steps: [4], relationId: 'r1' };
    expect(joinedOpenQuestion({ ...own, also: [conflict] }, again)).toEqual({
      ...own,
      also: [{ ...conflict, steps: [2, 4] }],
    });
    // A second conflict stands beside the first with its own steps.
    const second = { question: 'Two more pages disagree.', steps: [5], relationId: 'r2' };
    expect(joinedOpenQuestion(conflict, second)).toEqual({ ...conflict, also: [second] });
    expect(conflictRelationsOf({ openQuestion: { ...conflict, also: [second] } })).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('reads a row stored before the shape widened as its one question', (): void => {
    expect(standingQuestionsOf(own)).toEqual([own]);
    expect(isConflictQuestion({ openQuestion: own })).toBe(false);
    expect(ownQuestionOf({ openQuestion: own })).toBe('Which template?');
    expect(isConflictQuestion({ openQuestion: conflict })).toBe(true);
    expect(ownQuestionOf({ openQuestion: conflict })).toBeUndefined();
    expect(ownQuestionOf({})).toBeUndefined();
    expect(conflictRelationsOf(undefined)).toEqual([]);
  });

  it('takes a Retry’s note as an answer unless every question the run stopped on is a conflict’s', (): void => {
    expect(noteAnswersQuestion({ openQuestion: own })).toBe(true);
    expect(noteAnswersQuestion({ openQuestion: { ...own, also: [conflict] } })).toBe(true);
    expect(noteAnswersQuestion({ openQuestion: { ...conflict, also: [own] } })).toBe(true);
    // A stop whose reason alone carries the question, with none kept on the output (review D2).
    expect(noteAnswersQuestion({})).toBe(true);
    expect(noteAnswersQuestion(undefined)).toBe(true);
    expect(noteAnswersQuestion({ openQuestion: conflict })).toBe(false);
  });
});
