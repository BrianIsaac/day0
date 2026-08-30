import { describe, expect, it } from 'vitest';
import { replyTargetFor } from '../../../src/work/reply-target';

describe('the reply target of a work item', (): void => {
  it('prefers the stored target', (): void => {
    const stored = { channel: 'C0BSF04TZ19', channelName: 'revops-asks', threadTs: '1787746453.202809' };
    expect(
      replyTargetFor({ replyTarget: stored, sourceCategory: 'event-stream', externalId: 'x', title: 'y' }),
    ).toBe(stored);
  });

  it('pins a stored target to the source channel and thread carried by the external id', (): void => {
    expect(
      replyTargetFor({
        replyTarget: {
          channel: 'C0OTHER',
          channelName: 'revops-asks',
          threadTs: '1787000000.000001',
        },
        sourceCategory: 'event-stream',
        externalId: 'C0SOURCE:1787746453.202809',
        title: 'Slack mention in #revops-asks',
      }),
    ).toEqual({
      channel: 'C0SOURCE',
      channelName: 'revops-asks',
      threadTs: '1787746453.202809',
    });
  });

  it('derives one for a Slack mention seeded before the field existed', (): void => {
    expect(
      replyTargetFor({
        sourceCategory: 'event-stream',
        externalId: 'C0BSF04TZ19:1787746453.202809',
        title: 'Slack mention in #revops-asks',
      }),
    ).toEqual({ channel: 'C0BSF04TZ19', threadTs: '1787746453.202809', channelName: 'revops-asks' });
    expect(
      replyTargetFor({ sourceCategory: 'event-stream', externalId: 'G0PRIVATE:1.2', title: 'Slack mention' }),
    ).toEqual({ channel: 'G0PRIVATE', threadTs: '1.2' });
  });

  it('gives a ticket, or an unrecognised id, no target', (): void => {
    expect(replyTargetFor({ sourceCategory: 'ticket-queue', externalId: 'REVOPS-10', title: 'x' })).toBeUndefined();
    expect(replyTargetFor({ sourceCategory: 'event-stream', externalId: 'not-a-slack-id', title: 'x' })).toBeUndefined();
  });
});
