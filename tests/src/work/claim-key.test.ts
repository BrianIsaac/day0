import { describe, expect, it } from 'vitest';
import { providerItemKey, type ClaimKeySurface } from '../../../src/work/claim-key';

const linear: ClaimKeySurface = {
  slug: 'linear',
  class: 'kanban',
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
};

const slack = (workspace: string, slug = 'slack'): ClaimKeySurface => ({
  slug,
  class: 'chat',
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  providerWorkspaceId: workspace,
});

const jira: ClaimKeySurface = {
  slug: 'jira',
  class: 'kanban',
  path: 'documented-api',
  endpoint: 'https://acme.atlassian.net/rest/api/3',
};

const ISSUE = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const ASK = 'C0OPSREQ:1789000000.000100';

describe('providerItemKey', (): void => {
  it('keys a Linear issue by its provider id', (): void => {
    expect(providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'real')).toBe(
      `linear:${ISSUE}`,
    );
  });

  it('gives one Linear issue one key whatever the surface is called', (): void => {
    const finance = { ...linear, slug: 'linear-finance' };
    const key = providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'real');
    expect(key).toBeDefined();
    expect(providerItemKey(finance, { sourceSystem: 'linear-finance', externalId: ISSUE }, 'real')).toBe(key);
  });

  it.fails('gives one Linear issue one key whichever Linear API the surface reads it over', (): void => {
    const graphql = { slug: 'linear-api', class: 'kanban', path: 'documented-api', endpoint: 'https://api.linear.app/graphql' };
    expect(providerItemKey(graphql, { sourceSystem: 'linear-api', externalId: ISSUE }, 'real')).toBe(
      `linear:${ISSUE}`,
    );
    const lookalike = { ...graphql, endpoint: 'https://linear.app.example.com/graphql' };
    expect(providerItemKey(lookalike, { sourceSystem: 'linear-api', externalId: ISSUE }, 'real')).toBe(
      `https://linear.app.example.com|${ISSUE}`,
    );
  });

  it('keys a Slack message by its workspace, channel and timestamp', (): void => {
    expect(providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real')).toBe(
      `slack:T0COMPANY:${ASK}`,
    );
  });

  it('never lets two Slack workspaces collide on one channel and timestamp', (): void => {
    const first = providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real');
    const second = providerItemKey(slack('T0PARTNER'), { sourceSystem: 'slack', externalId: ASK }, 'real');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('gives one Slack message one key on two surfaces of the same workspace', (): void => {
    const key = providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real');
    expect(key).toBeDefined();
    expect(
      providerItemKey(slack('T0COMPANY', 'slack-ops'), { sourceSystem: 'slack-ops', externalId: ASK }, 'real'),
    ).toBe(key);
  });

  it('keys any other surface by its endpoint origin and the external id', (): void => {
    expect(providerItemKey(jira, { sourceSystem: 'jira', externalId: 'OPS-12' }, 'real')).toBe(
      'https://acme.atlassian.net|OPS-12',
    );
    const agile = { ...jira, slug: 'jira-agile', endpoint: 'https://acme.atlassian.net/rest/agile/1.0' };
    expect(providerItemKey(agile, { sourceSystem: 'jira-agile', externalId: 'OPS-12' }, 'real')).toBe(
      'https://acme.atlassian.net|OPS-12',
    );
  });

  it('falls back to the slug when the surface has no endpoint or is gone', (): void => {
    const unlisted = { slug: 'tracker', class: 'kanban' };
    expect(providerItemKey(unlisted, { sourceSystem: 'tracker', externalId: 'T-1' }, 'real')).toBe(
      'slug:tracker|T-1',
    );
    expect(providerItemKey(undefined, { sourceSystem: 'tracker', externalId: 'T-1' }, 'real')).toBe(
      'slug:tracker|T-1',
    );
  });

  it('keeps the kinds of key apart', (): void => {
    const keys = [
      providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'real'),
      providerItemKey(undefined, { sourceSystem: 'linear', externalId: ISSUE }, 'real'),
      providerItemKey(
        { ...jira, endpoint: 'https://mcp.linear.app/other' },
        { sourceSystem: 'jira', externalId: ISSUE },
        'real',
      ),
      providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real'),
      providerItemKey(undefined, { sourceSystem: 'slack', externalId: `T0COMPANY:${ASK}` }, 'real'),
    ];
    expect(keys.every((key) => key !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys nothing in mock mode', (): void => {
    expect(providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'mock')).toBeUndefined();
    expect(providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'mock')).toBeUndefined();
    expect(providerItemKey(jira, { sourceSystem: 'jira', externalId: 'OPS-12' }, 'mock')).toBeUndefined();
    expect(providerItemKey(undefined, { sourceSystem: 'jira', externalId: 'OPS-12' }, 'mock')).toBeUndefined();
  });
});
