import { describe, expect, it } from 'vitest';
import { emphasisSegments } from '../../../../app/agent/[agentId]/ChatRoom';

describe('the Day-1 transcript bubble', (): void => {
  it('leaves plain prose as one segment', (): void => {
    expect(emphasisSegments('Understood. What do you see me doing day-to-day?')).toEqual([
      { text: 'Understood. What do you see me doing day-to-day?', strong: false },
    ]);
  });

  it('marks an emphasised label as strong and drops its markers', (): void => {
    expect(emphasisSegments('Three intros queued. **Topic 4:** what should I read first?')).toEqual([
      { text: 'Three intros queued. ', strong: false },
      { text: 'Topic 4:', strong: true },
      { text: ' what should I read first?', strong: false },
    ]);
  });

  it('handles several emphasised runs in one turn', (): void => {
    expect(emphasisSegments('**One** and **two**')).toEqual([
      { text: 'One', strong: true },
      { text: ' and ', strong: false },
      { text: 'two', strong: true },
    ]);
  });

  it('leaves an unclosed marker exactly as the model wrote it', (): void => {
    expect(emphasisSegments('a ** b')).toEqual([{ text: 'a ** b', strong: false }]);
  });

  it('keeps an empty pair of markers as literal text', (): void => {
    expect(emphasisSegments('a **** b')).toEqual([{ text: 'a **** b', strong: false }]);
  });

  it('preserves the newlines the bubble renders', (): void => {
    expect(emphasisSegments('Hi Brian.\n\n**First up:** why this hire?')).toEqual([
      { text: 'Hi Brian.\n\n', strong: false },
      { text: 'First up:', strong: true },
      { text: ' why this hire?', strong: false },
    ]);
  });
});
