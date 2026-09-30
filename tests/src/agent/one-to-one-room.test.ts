import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { INIT_PROMPT } from '../../../src/agent/day-one-turn';
import { uiMessagesOf, type OneToOneTurn } from '../../../src/agent/one-to-one-conversation';
import {
  lastKeptReply,
  redrawn,
  replyInProgress,
  roomBehind,
  roomPosition,
  unkeptReplies,
} from '../../../src/agent/one-to-one-room';

function employee(id: string, text: string): OneToOneTurn {
  return { id, speaker: 'employee', text, topicIndex: 0, at: 1 };
}

function manager(id: string, text: string): OneToOneTurn {
  return { id, speaker: 'manager', text, at: 1 };
}

/** A reply the room drew, kept or not. */
function said(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** An answer the room drew whose stream failed or was refused: no kept mark. */
function failed(id: string, text = ''): UIMessage {
  return { id, role: 'assistant', parts: text ? [{ type: 'text', text }] : [] };
}

const KEPT: OneToOneTurn[] = [
  employee('e0', 'Why this hire?'),
  manager('m0', 'The close.'),
  employee('e1', 'Who?'),
];

describe('where the room stands', (): void => {
  it('names the last kept answer it drew as its question, and the replies after it', (): void => {
    expect(roomPosition([...uiMessagesOf(KEPT), said('m1', 'Priya.')])).toEqual({
      question: 'e1',
      replies: [{ id: 'm1', text: 'Priya.' }],
    });
  });

  it('reads past an answer that failed: the replies either side answer the question before it', (): void => {
    const messages = [
      ...uiMessagesOf(KEPT),
      said('m1', 'Priya.'),
      failed('f1'),
      said('m2', 'And Omar.'),
    ];
    expect(roomPosition(messages)).toEqual({
      question: 'e1',
      replies: [
        { id: 'm1', text: 'Priya.' },
        { id: 'm2', text: 'And Omar.' },
      ],
    });
  });

  it('has no question before the opening was kept, and never counts the priming turn as a reply', (): void => {
    expect(roomPosition([said('init', INIT_PROMPT), failed('f0')])).toEqual({
      question: null,
      replies: [],
    });
  });
});

describe('the replies the session never received', (): void => {
  it('are the replies after the question that the session does not hold', (): void => {
    const messages = [...uiMessagesOf(KEPT), said('m1', 'FIRST.'), said('m2', 'SECOND.')];
    expect(unkeptReplies(messages, [...KEPT, manager('m1', 'FIRST.')])).toEqual([
      { id: 'm2', text: 'SECOND.' },
    ]);
    expect(unkeptReplies(uiMessagesOf(KEPT), KEPT)).toEqual([]);
  });

  it('are kept with the field as the reply being typed, so a reload loses none of them (review M2)', (): void => {
    expect(replyInProgress([{ id: 'm1', text: 'Never contact customers.' }], 'And weekly.')).toBe(
      'Never contact customers.\n\nAnd weekly.',
    );
    expect(replyInProgress([], '  ')).toBe('');
    expect(lastKeptReply(KEPT)).toBe('m0');
    expect(lastKeptReply([employee('e0', 'Hi?')])).toBeNull();
  });
});

describe('a room the session has moved past', (): void => {
  it('is behind when another window replied and was answered (review F1)', (): void => {
    const tabB = uiMessagesOf(KEPT.slice(0, 1));
    expect(roomBehind(tabB, KEPT)).toBe(true);
  });

  it('is behind when the session kept an answer whose stream the room lost (review m7)', (): void => {
    const lost = [...uiMessagesOf(KEPT.slice(0, 2)), failed('e1', 'Wh')];
    expect(roomBehind(lost, KEPT)).toBe(true);
  });

  it('is not behind by a reply it sent that never arrived, nor by an answer not yet reported', (): void => {
    expect(roomBehind([...uiMessagesOf(KEPT), said('m1', 'Offline.')], KEPT)).toBe(false);
    const answered = [...uiMessagesOf([...KEPT, manager('m1', 'Priya.'), employee('e2', 'Next?')])];
    expect(roomBehind(answered, [...KEPT, manager('m1', 'Priya.')])).toBe(false);
  });

  it('is drawn again from the session, with its unsent replies handed back for the composer', (): void => {
    const tabB = [...uiMessagesOf(KEPT.slice(0, 1)), said('b1', 'Tab B, on question 1.')];
    const moved = [...KEPT.slice(0, 1), manager('a1', 'Tab A.'), employee('e1', 'Q2?')];
    expect(redrawn(tabB, moved)).toEqual({
      messages: uiMessagesOf(moved),
      unsent: ['Tab B, on question 1.'],
    });
  });
});
