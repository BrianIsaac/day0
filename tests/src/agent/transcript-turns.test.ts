import { describe, expect, it } from 'vitest';
import { answeredCount, transcriptTurns } from '../../../src/agent/transcript-turns';
import { DAY_ONE_TRANSCRIPT_2026_09_14 } from '../../fixtures/day-one-transcript-2026-09-14';

describe('a stored one-to-one read back', (): void => {
  it('reads the chat room and the voice room labels as the manager and the employee', (): void => {
    expect(
      transcriptTurns('ASSISTANT: Why this hire?\n\nUSER: The close.\n\nAGENT: Who first?'),
    ).toEqual([
      { speaker: 'employee', text: 'Why this hire?' },
      { speaker: 'manager', text: 'The close.' },
      { speaker: 'employee', text: 'Who first?' },
    ]);
  });

  it('keeps a reply written over several lines as one turn, an inner label of no speaker included', (): void => {
    expect(transcriptTurns('USER: Two things.\nNote: the deck.\n\nand the tracker')).toEqual([
      { speaker: 'manager', text: 'Two things.\nNote: the deck.\n\nand the tracker' },
    ]);
  });

  it('leaves out text before any speaker and empty turns', (): void => {
    expect(transcriptTurns('preamble\nUSER:   \nASSISTANT: Hello')).toEqual([
      { speaker: 'employee', text: 'Hello' },
    ]);
  });

  it('counts an answer only where the employee spoke first', (): void => {
    expect(
      answeredCount(
        transcriptTurns('USER: hi\n\nASSISTANT: Why?\n\nUSER: Close.\n\nUSER: And audit.'),
      ),
    ).toBe(1);
    expect(answeredCount(transcriptTurns(DAY_ONE_TRANSCRIPT_2026_09_14))).toBeGreaterThan(0);
  });
});
