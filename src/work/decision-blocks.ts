import {
  BUTTONS_DAY0_LEAD,
  BUTTONS_REPLY_LEAD,
  DAY0_ONLY_LEAD,
  DECISION_ID_ALPHABET,
  DECISION_ID_LENGTH,
  type DecisionReply,
} from './manager-channel';
import type { SlackActionsBlock, SlackBlock, SlackSectionBlock, SlackText } from './slack-blocks';

export type {
  SlackActionsBlock,
  SlackBlock,
  SlackButton,
  SlackConfirm,
  SlackSectionBlock,
  SlackText,
} from './slack-blocks';

/** The most characters one Slack section block's text takes (Block Kit's section block limit). */
export const SECTION_TEXT_MAX_CHARS = 3_000;

/** The `action_id` of a decision request's Approve button. */
export const DECISION_APPROVE_ACTION = 'day0.decision.approve';

/** The `action_id` of a decision request's Reject button. */
export const DECISION_REJECT_ACTION = 'day0.decision.reject';

/**
 * Split a message's text into section-sized runs at its line breaks, cutting only a single line
 * longer than a section. Joining the runs with a line break (or, for a cut line, with nothing)
 * gives the text back.
 */
function sectionRuns(text: string): string[] {
  const runs: string[] = [];
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const joined = current === undefined ? line : `${current}\n${line}`;
    if (joined.length <= SECTION_TEXT_MAX_CHARS) {
      current = joined;
      continue;
    }
    if (current !== undefined) runs.push(current);
    let rest = line;
    while (rest.length > SECTION_TEXT_MAX_CHARS) {
      runs.push(rest.slice(0, SECTION_TEXT_MAX_CHARS));
      rest = rest.slice(SECTION_TEXT_MAX_CHARS);
    }
    current = rest;
  }
  if (current !== undefined && current !== '') runs.push(current);
  return runs;
}

function sections(text: string): SlackSectionBlock[] {
  return sectionRuns(text).map((run) => ({ type: 'section', text: { type: 'mrkdwn', text: run } }));
}

function plain(text: string): SlackText {
  return { type: 'plain_text', text };
}

/**
 * The blocks of a decision request (wave 12, 12-M; RM3 (a)): the request's text, and, where the
 * employee's Slack app carries presses to Day0 over Socket Mode, Approve and Reject buttons whose
 * value is the code. The text keeps its typed-code line where the app takes messages, so the code
 * decides whether or not a button ever reaches Day0. Reject asks to confirm, since a press gives no
 * reason and the typed reply, or day0 for an app that takes no messages (W12V-7), does.
 *
 * @param args.id - The request's decision code.
 * @param args.text - The request's text as {@link decisionRequestText} words it.
 * @param args.buttons - Whether the employee's app can carry a press.
 */
export function decisionRequestBlocks(args: {
  readonly id: string;
  readonly text: string;
  readonly buttons: boolean;
  /** Whether the manager's typed code reaches the app (W12V-7); true unless said otherwise. */
  readonly typedCode?: boolean;
}): SlackBlock[] {
  if (!args.buttons) return sections(args.text);
  const actions: SlackActionsBlock = {
    type: 'actions',
    block_id: `day0-decision-${args.id}`,
    elements: [
      {
        type: 'button',
        action_id: DECISION_APPROVE_ACTION,
        value: args.id,
        text: plain('Approve'),
        style: 'primary',
      },
      {
        type: 'button',
        action_id: DECISION_REJECT_ACTION,
        value: args.id,
        text: plain('Reject'),
        style: 'danger',
        confirm: {
          title: plain('Reject this request?'),
          text: plain(
            args.typedCode === false
              ? 'Day0 will not do it. To say why, reject it in day0 instead.'
              : `Day0 will not do it. To say why, reply “reject ${args.id} <reason>” instead.`,
          ),
          confirm: plain('Reject'),
          deny: plain('Keep it open'),
          style: 'danger',
        },
      },
    ],
  };
  return [...sections(args.text), actions];
}

/**
 * The blocks of a request once it no longer decides anything (decided, or replaced by a newer
 * one): its text alone, no buttons. The edit always sends them, since Slack's `chat.update` given
 * text and no blocks removes the blocks and renders the text, and a request is edited exactly as
 * it is meant to read.
 */
export function settledRequestBlocks(text: string): SlackBlock[] {
  return sections(text);
}

/**
 * A request's text as it reads once its buttons are gone (decided, or replaced): the reply line
 * that named the buttons becomes the typed one, or day0 alone for an app that takes no messages
 * (W12V-7), so the edited message never asks for a press.
 */
export function pressFreeText(text: string): string {
  return text
    .split(BUTTONS_REPLY_LEAD)
    .join('Reply ')
    .split(BUTTONS_DAY0_LEAD)
    .join(DAY0_ONLY_LEAD);
}

/** What a pressed button carries, as a `block_actions` payload names it. */
export interface PressedAction {
  readonly action_id?: unknown;
  readonly value?: unknown;
}

const CODE = new RegExp(`^[${DECISION_ID_ALPHABET}]{${DECISION_ID_LENGTH}}$`);

/**
 * Read one pressed button as a manager's decision, exactly as a typed reply reads: Approve as
 * "approve <code>", Reject as "reject <code>" with no reason. Anything else reads as nothing.
 *
 * @param action - One entry of the payload's `actions`.
 */
export function parseDecisionPress(action: PressedAction): DecisionReply | undefined {
  if (typeof action.value !== 'string') return undefined;
  const id = action.value.trim().toLowerCase();
  if (!CODE.test(id)) return undefined;
  if (action.action_id === DECISION_APPROVE_ACTION) return { verb: 'approve', id };
  if (action.action_id === DECISION_REJECT_ACTION) return { verb: 'reject', id, reason: '' };
  return undefined;
}
