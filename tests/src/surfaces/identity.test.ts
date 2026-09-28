import { describe, expect, it } from 'vitest';
import {
  missingSurfaceResolvedBy,
  sameSurfaceSystem,
  surfaceIdentity,
} from '../../../src/surfaces/identity';

/** The documented Slack, with the endpoint its page names. */
const slackApi = {
  slug: 'slack-web-api',
  displayName: 'Slack Web API',
  class: 'chat',
  endpoint: 'https://slack.com/api/',
  discoveryEvidence: [{ quote: 'Post through the Slack Web API at https://slack.com/api/.' }],
};
/** The manager's bare mention of the same system, with nothing but the name. */
const slackMention = { slug: 'slack', displayName: 'Slack', class: 'chat' };
const linear = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  endpoint: 'https://mcp.linear.app/mcp',
};

describe('surfaceIdentity', (): void => {
  it('reads the slugs, the name key and the hosts from the name, the quotes and the endpoint', (): void => {
    const identity = surfaceIdentity(slackApi);
    expect(identity.slugs).toContain('slack-web-api');
    expect(identity.hosts).toEqual(['slack.com']);
    expect(surfaceIdentity(slackMention).hosts).toEqual([]);
  });
});

describe('sameSurfaceSystem', (): void => {
  it('matches a bare mention with the qualified documented name of the same class', (): void => {
    expect(sameSurfaceSystem(slackMention, slackApi)).toBe(true);
    expect(sameSurfaceSystem(slackApi, slackMention)).toBe(true);
  });

  it('keeps two systems apart', (): void => {
    expect(sameSurfaceSystem(linear, slackApi)).toBe(false);
    expect(sameSurfaceSystem(linear, slackMention)).toBe(false);
  });
});

describe('missingSurfaceResolvedBy', (): void => {
  it('is the surface itself, a persisted alias of it, or a bare name that reads as it', (): void => {
    expect(missingSurfaceResolvedBy('linear', linear, [linear, slackApi])).toBe(true);
    expect(missingSurfaceResolvedBy('slack', slackApi, [slackMention, slackApi])).toBe(true);
    expect(missingSurfaceResolvedBy('slack', slackApi, [slackApi])).toBe(true);
  });

  it('is not a different system', (): void => {
    expect(missingSurfaceResolvedBy('slack', linear, [linear, slackApi])).toBe(false);
    expect(missingSurfaceResolvedBy('northstar-crm', linear, [linear])).toBe(false);
  });
});
