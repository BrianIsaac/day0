import { describe, expect, it } from 'vitest';
import {
  DECISION_APPROVE_ACTION,
  DECISION_REJECT_ACTION,
  decisionRequestBlocks,
  parseDecisionPress,
  SECTION_TEXT_MAX_CHARS,
  settledRequestBlocks,
  type SlackActionsBlock,
  type SlackBlock,
} from '../../../src/work/decision-blocks';

function actionsOf(blocks: readonly SlackBlock[]): SlackActionsBlock[] {
  return blocks.filter((block): block is SlackActionsBlock => block.type === 'actions');
}

describe('decisionRequestBlocks', (): void => {
  it('carries the request text and Approve and Reject buttons whose value is the code', (): void => {
    const blocks = decisionRequestBlocks({ id: 'ab3xyz', text: 'Decide this.', buttons: true });
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Decide this.' } });
    const [actions] = actionsOf(blocks);
    expect(actions).toBeDefined();
    expect(actions!.block_id).toBe('day0-decision-ab3xyz');
    const [approve, reject] = actions!.elements;
    expect(approve).toMatchObject({
      type: 'button',
      action_id: DECISION_APPROVE_ACTION,
      value: 'ab3xyz',
      style: 'primary',
      text: { type: 'plain_text', text: 'Approve' },
    });
    expect(approve!.confirm).toBeUndefined();
    expect(reject).toMatchObject({
      type: 'button',
      action_id: DECISION_REJECT_ACTION,
      value: 'ab3xyz',
      style: 'danger',
      text: { type: 'plain_text', text: 'Reject' },
    });
    expect(reject!.confirm).toMatchObject({
      title: { type: 'plain_text', text: 'Reject this request?' },
      confirm: { type: 'plain_text', text: 'Reject' },
      deny: { type: 'plain_text', text: 'Keep it open' },
      style: 'danger',
    });
    expect(reject!.confirm!.text.text).toContain('reject ab3xyz <reason>');
  });

  it('carries no actions block when the app has no buttons', (): void => {
    const blocks = decisionRequestBlocks({ id: 'ab3xyz', text: 'Decide this.', buttons: false });
    expect(actionsOf(blocks)).toEqual([]);
    expect(blocks).toHaveLength(1);
  });

  it('splits a text longer than one section at line breaks, keeping every line', (): void => {
    const line = 'x'.repeat(1_000);
    const text = [line, line, line, line, line].join('\n');
    const blocks = decisionRequestBlocks({ id: 'ab3xyz', text, buttons: true });
    const sections = blocks.filter((block) => block.type === 'section');
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.type === 'section' && section.text.text.length).toBeLessThanOrEqual(
        SECTION_TEXT_MAX_CHARS,
      );
    }
    expect(
      sections.map((section) => (section.type === 'section' ? section.text.text : '')).join('\n'),
    ).toBe(text);
    expect(blocks.at(-1)?.type).toBe('actions');
  });

  it('cuts a single line longer than one section rather than sending a block Slack refuses', (): void => {
    const blocks = decisionRequestBlocks({
      id: 'ab3xyz',
      text: 'y'.repeat(SECTION_TEXT_MAX_CHARS + 500),
      buttons: false,
    });
    for (const block of blocks) {
      expect(block.type === 'section' && block.text.text.length).toBeLessThanOrEqual(
        SECTION_TEXT_MAX_CHARS,
      );
    }
    expect(blocks.map((block) => (block.type === 'section' ? block.text.text : '')).join('')).toBe(
      'y'.repeat(SECTION_TEXT_MAX_CHARS + 500),
    );
  });
});

describe('settledRequestBlocks', (): void => {
  it('keeps the text and drops the buttons, for the edit that closes or replaces a request', (): void => {
    const blocks = settledRequestBlocks('Decided: approved in this DM (ab3xyz).');
    expect(actionsOf(blocks)).toEqual([]);
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Decided: approved in this DM (ab3xyz).' } },
    ]);
  });
});

describe('parseDecisionPress', (): void => {
  it('reads Approve as an approval of the button value', (): void => {
    expect(parseDecisionPress({ action_id: DECISION_APPROVE_ACTION, value: 'ab3xyz' })).toEqual({
      verb: 'approve',
      id: 'ab3xyz',
    });
  });

  it('reads Reject as a rejection with no reason', (): void => {
    expect(parseDecisionPress({ action_id: DECISION_REJECT_ACTION, value: 'AB3XYZ' })).toEqual({
      verb: 'reject',
      id: 'ab3xyz',
      reason: '',
    });
  });

  it('reads nothing from another action or a value that is not a code', (): void => {
    expect(parseDecisionPress({ action_id: 'something.else', value: 'ab3xyz' })).toBeUndefined();
    expect(
      parseDecisionPress({ action_id: DECISION_APPROVE_ACTION, value: 'ab3' }),
    ).toBeUndefined();
    expect(
      parseDecisionPress({ action_id: DECISION_APPROVE_ACTION, value: 'ab3xyz extra' }),
    ).toBeUndefined();
    expect(parseDecisionPress({ action_id: DECISION_APPROVE_ACTION })).toBeUndefined();
  });
});
