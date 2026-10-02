import { describe, expect, it } from 'vitest';
import {
  isOrganisationSystemKey,
  organisationSystemOf,
} from '../../../src/surfaces/access-request';

describe('the organisation system a key names (the access plan, section 4.1)', (): void => {
  it('takes a plain lower-case system or an MCP server by host', (): void => {
    for (const key of ['slack', 'linear', 'github', 'google-workspace', 'mcp:mcp.notion.com']) {
      expect(isOrganisationSystemKey(key), key).toBe(true);
    }
  });

  it('refuses anything else: case, spaces, a URL, an empty host or a bare prefix', (): void => {
    for (const key of [
      '',
      'Slack',
      'slack ',
      'https://slack.com',
      'mcp:',
      'mcp:https://mcp.notion.com',
      'mcp:MCP.notion.com',
      'linear:read',
      '-slack',
    ]) {
      expect(isOrganisationSystemKey(key), key).toBe(false);
    }
  });
});

describe('the organisation system a card needs', (): void => {
  const card = { path: 'documented-api' };

  it('reads Slack off the Web API base and Linear off its hosts, whatever the slug', (): void => {
    expect(organisationSystemOf({ ...card, endpoint: 'https://slack.com/api/' })).toBe('slack');
    expect(organisationSystemOf({ ...card, endpoint: 'https://api.linear.app/graphql' })).toBe(
      'linear',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://mcp.linear.app/mcp' })).toBe(
      'linear',
    );
  });

  it('reads the systems the kit knows by their API hosts', (): void => {
    expect(organisationSystemOf({ ...card, endpoint: 'https://api.github.com/repos' })).toBe(
      'github',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://acme.atlassian.net/rest' })).toBe(
      'atlassian',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://api.notion.com/v1' })).toBe('notion');
    expect(organisationSystemOf({ ...card, endpoint: 'https://graph.microsoft.com/v1.0' })).toBe(
      'microsoft',
    );
    expect(organisationSystemOf({ ...card, endpoint: 'https://sheets.googleapis.com/v4' })).toBe(
      'google',
    );
  });

  it('names any other MCP server by its host, and a look-alike host as nobody’s', (): void => {
    expect(
      organisationSystemOf({ ...card, path: 'mcp', endpoint: 'https://mcp.Example.com/sse' }),
    ).toBe('mcp:mcp.example.com');
    expect(
      organisationSystemOf({ ...card, endpoint: 'https://api.linear.app.evil.test/graphql' }),
    ).toBeUndefined();
    expect(organisationSystemOf({ ...card, endpoint: 'https://slack.com.evil.test/api/' })).toBe(
      undefined,
    );
  });

  it('names no system for a card with no endpoint, one it cannot parse, or a host the kit does not know', (): void => {
    expect(organisationSystemOf(card)).toBeUndefined();
    expect(organisationSystemOf({ ...card, endpoint: 'not a url' })).toBeUndefined();
    expect(
      organisationSystemOf({ ...card, endpoint: 'https://intranet.acme.test/api' }),
    ).toBeUndefined();
  });
});
