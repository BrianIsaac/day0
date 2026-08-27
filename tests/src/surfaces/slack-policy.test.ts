import { describe, expect, it } from 'vitest';
import {
  channelsAwaitingInvite,
  documentedChannelNames,
} from '../../../src/surfaces/slack-policy';

const POLICY = {
  title: 'Slack automation policy',
  markdown: [
    '# Slack automation policy',
    '',
    '- Workspace: `day0`.',
    '- Channels: `#revops-asks` (inbound requests), `#revops` (team channel).',
    '- Integration: Slack Web API over HTTPS at `https://slack.com/api/`.',
  ].join('\n'),
};

describe('the channels the policy page names', (): void => {
  it('reads them from the explicit Channels line', (): void => {
    expect(documentedChannelNames([POLICY])).toEqual(['revops-asks', 'revops']);
  });

  it('ignores a page that is not about the chat system', (): void => {
    expect(
      documentedChannelNames([
        { title: 'Linear automation', markdown: 'Channels: #teams-general' },
      ]),
    ).toEqual([]);
  });

  it('ignores a hash that is not on a Channels line', (): void => {
    expect(
      documentedChannelNames([
        { title: 'Slack automation policy', markdown: 'Post a reply into #revops-asks.' },
      ]),
    ).toEqual([]);
  });

  it('deduplicates a channel named on two pages', (): void => {
    expect(documentedChannelNames([POLICY, POLICY])).toEqual(['revops-asks', 'revops']);
  });
});

describe('which documented channels still need an invite', (): void => {
  it('is empty when the app is a member of all of them', (): void => {
    expect(
      channelsAwaitingInvite(
        ['revops-asks', 'revops'],
        [
          { isMember: true, name: 'revops-asks' },
          { isMember: true, name: 'revops' },
        ],
      ),
    ).toEqual([]);
  });

  it('names a visible channel the app has not joined', (): void => {
    expect(
      channelsAwaitingInvite(
        ['revops-asks', 'revops'],
        [
          { isMember: false, name: 'revops-asks' },
          { isMember: true, name: 'revops' },
        ],
      ),
    ).toEqual(['#revops-asks']);
  });

  it('names a documented channel the workspace listing never showed', (): void => {
    expect(channelsAwaitingInvite(['revops-asks'], [])).toEqual(['#revops-asks']);
  });

  it('matches regardless of the case the provider returns', (): void => {
    expect(
      channelsAwaitingInvite(['RevOps-Asks'], [{ isMember: true, name: 'revops-asks' }]),
    ).toEqual([]);
  });

  it('has nothing to say when the page documents no channel', (): void => {
    expect(channelsAwaitingInvite([], [{ isMember: false, name: 'revops' }])).toEqual([]);
  });
});
