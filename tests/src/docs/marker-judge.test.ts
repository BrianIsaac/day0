import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKER_JUDGE_AGENT,
  MARKER_JUDGEMENT_TIMEOUT_MS,
  judgeMarker,
} from '../../../src/docs/marker-judge';
import { MARKER_JUDGEMENT_INSTRUCTIONS, markerCandidate } from '../../../src/docs/status';

const model = vi.hoisted(() => ({
  agents: [] as Array<{ name: string; instructions: string }>,
  calls: [] as Array<{ agent: string; user: string; timeoutMs?: number }>,
  reply: { status: 'active', quote: '' } as unknown,
}));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string, instructions: string): { name: string } => {
    model.agents.push({ name, instructions });
    return { name };
  },
  agentJson: async (args: {
    agent: { name: string };
    user: string;
    timeoutMs?: number;
    schema: { parse(value: unknown): unknown };
  }): Promise<unknown> => {
    model.calls.push({ agent: args.agent.name, user: args.user, timeoutMs: args.timeoutMs });
    if (model.reply instanceof Error) throw model.reply;
    return args.schema.parse(model.reply);
  },
}));

const chinese = markerCandidate(
  '月结流程',
  '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。',
)!;

describe('judgeMarker', (): void => {
  beforeEach((): void => {
    model.calls.length = 0;
  });

  it('asks the model once about the top of the page alone, under its own agent and time bound', async (): Promise<void> => {
    model.reply = { status: 'superseded', quote: '本文件已废止' };
    await expect(judgeMarker(chinese)).resolves.toBe('superseded');
    expect(model.calls).toEqual([
      {
        agent: MARKER_JUDGE_AGENT,
        user: expect.stringContaining(chinese.excerpt),
        timeoutMs: MARKER_JUDGEMENT_TIMEOUT_MS,
      },
    ]);
    expect(model.agents).toEqual([
      { name: MARKER_JUDGE_AGENT, instructions: MARKER_JUDGEMENT_INSTRUCTIONS },
    ]);
    // The agent is made once, at the first call.
    await judgeMarker(chinese);
    expect(model.agents).toHaveLength(1);
  });

  it('answers active for a marker the model reads as the page’s subject, or cannot quote from the page', async (): Promise<void> => {
    const subject = markerCandidate(
      'How to archive a ticket',
      '# How to archive a ticket\n\nAn archived ticket leaves the board.',
    )!;
    model.reply = { status: 'active', quote: '' };
    await expect(judgeMarker(subject)).resolves.toBe('active');
    model.reply = { status: 'archived', quote: 'This page is archived.' };
    await expect(judgeMarker(subject)).resolves.toBe('active');
  });

  it('throws when the model cannot answer, so the caller leaves the page unjudged', async (): Promise<void> => {
    model.reply = new Error('the model is unreachable');
    await expect(judgeMarker(chinese)).rejects.toThrow('the model is unreachable');
    model.reply = { status: 'gone', quote: '' };
    await expect(judgeMarker(chinese)).rejects.toThrow();
  });
});
