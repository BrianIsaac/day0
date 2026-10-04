import { describe, expect, it } from 'vitest';
import {
  DECISION_APPROVE_ACTION,
  DECISION_REJECT_ACTION,
  decisionRequestBlocks,
  parseDecisionPress,
  pressFreeText,
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

  it('asks for no typed reason in Reject’s dialog when the app takes no messages (W12V-7)', (): void => {
    const blocks = decisionRequestBlocks({
      id: 'uacgcm',
      text: 'Decide this.',
      buttons: true,
      typedCode: false,
    });
    const [actions] = actionsOf(blocks);
    const reject = actions!.elements[1]!;
    expect(reject.confirm!.text.text).toBe(
      'Day0 will not do it. To say why, reject it in day0 instead.',
    );
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

describe('pressFreeText', (): void => {
  it('turns the reply line that names the buttons back into the typed one, for a message without them', (): void => {
    expect(
      pressFreeText(
        'Decide this.\n\nPress Approve or Reject below, or reply “approve ab3xyz” or “reject ab3xyz <reason>”.',
      ),
    ).toBe('Decide this.\n\nReply “approve ab3xyz” or “reject ab3xyz <reason>”.');
    expect(pressFreeText('Reply “approve ab3xyz”.')).toBe('Reply “approve ab3xyz”.');
  });

  it('leaves day0 as the only way on once the buttons of an app that takes no messages are gone (W12V-7)', (): void => {
    expect(
      pressFreeText(
        'Decide this.\n\nPress Approve or Reject below, or decide in day0. Slack does not let you message this app yet, so a typed reply cannot reach it.',
      ),
    ).toBe(
      'Decide this.\n\nDecide in day0. Slack does not let you message this app yet, so a typed reply cannot reach it.',
    );
  });
});
