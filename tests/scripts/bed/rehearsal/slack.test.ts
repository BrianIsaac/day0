import { describe, expect, it } from 'vitest';
import { botMessagesSince } from '../../../../scripts/bed/rehearsal/slack';

describe('which messages are the run’s to delete', (): void => {
  it('does not delete a concurrent message from the same shared bot', () => {
    expect(botMessagesSince([
      { ts: '3.0', text: 'Other run\n\n-- another worker (Day0) · run another-item/run-2', botId: 'BBOT' },
      { ts: '3.1', text: 'Our run\n\n-- rehearsal worker (Day0) · run our-item/run-1', botId: 'BBOT' },
    ], 'BBOT', '2.0', ['our-item']).map(message => message.ts)).toEqual(['3.1']);
  });

  it("keeps only the bot's own messages at or after the run start", (): void => {
    const messages = [
      { ts: '3.0', text: 'bot after\n-- worker (Day0) · run ours/r1', botId: 'BBOT' },
      { ts: '2.5', text: 'human after', user: 'UHUMAN' },
      { ts: '1.0', text: 'bot before', botId: 'BBOT' },
      { ts: '2.0', text: 'bot at start\n-- worker (Day0) · run ours/r1', botId: 'BBOT' },
    ];
    expect(botMessagesSince(messages, 'BBOT', '2.0', ['ours']).map((m) => m.ts)).toEqual(['3.0', '2.0']);
  });
});
