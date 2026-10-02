import { describe, expect, it } from 'vitest';
import {
  ACCESS_KIT,
  KNOWN_WITHOUT_ISSUER,
  documentedSystems,
  mcpConnectionSystem,
  recipeForSystem,
} from '../../../../src/surfaces/access-kit';
import { MCP_RECIPE, MCP_REDIRECT_PATH } from '../../../../src/surfaces/access-kit/mcp';
import {
  isOrganisationSystemKey,
  organisationSystemOf,
} from '../../../../src/surfaces/access-request';

describe('the access kit', (): void => {
  it('holds one recipe per system it connects, each keyed as the connection is', (): void => {
    expect(Object.keys(ACCESS_KIT).sort()).toEqual(['linear', 'mcp', 'slack']);
    for (const [system, recipe] of Object.entries(ACCESS_KIT)) {
      expect(recipe.system).toBe(system);
      expect(recipe.guide).toBe(`docs/running/access-${system}.md`);
    }
  });

  it('finds the recipe for a connection’s system key, an MCP server’s by its prefix', (): void => {
    expect(recipeForSystem('slack')?.displayName).toBe('Slack');
    expect(recipeForSystem('mcp:mcp.acme.com')).toBe(MCP_RECIPE);
    expect(recipeForSystem('github')).toBeUndefined();
  });

  it('keys an MCP server as the card’s system rule does: its host, lower case, no port', (): void => {
    const system = mcpConnectionSystem('https://MCP.Acme.com:8443/mcp');
    expect(system).toBe('mcp:mcp.acme.com');
    expect(isOrganisationSystemKey(system)).toBe(true);
    expect(organisationSystemOf({ endpoint: 'https://mcp.acme.com:8443/mcp', path: 'mcp' })).toBe(
      system,
    );
    expect(() => mcpConnectionSystem('http://mcp.acme.com/mcp')).toThrow(/https/);
  });

  it('lists the documentation’s systems by the cards’ own rule, each with the page that names it', (): void => {
    const found = documentedSystems([
      {
        path: 'revops/slack.md',
        markdown: 'Integration: Slack Web API over HTTPS at `https://slack.com/api/`.',
      },
      {
        path: 'revops/linear.md',
        markdown:
          'Tickets live in Linear (https://linear.app/acme/team/REV) and its MCP at https://mcp.linear.app/mcp.',
      },
      { path: 'revops/crm.md', markdown: 'The CRM speaks MCP at https://mcp.acme.com/mcp.' },
      { path: 'revops/code.md', markdown: 'Code is on https://github.com/acme/app.' },
      { path: 'revops/wiki.md', markdown: 'See https://example.org/handbook for the rest.' },
    ]);
    expect(found).toEqual([
      { system: 'slack', pages: ['revops/slack.md'] },
      { system: 'linear', pages: ['revops/linear.md'] },
      { system: 'mcp:mcp.acme.com', pages: ['revops/crm.md'] },
      { system: 'github', pages: ['revops/code.md'] },
    ]);
  });

  it('says which known systems keep the pasted key until their issuer lands (AI1)', (): void => {
    expect(KNOWN_WITHOUT_ISSUER).toEqual(['github', 'atlassian', 'notion', 'microsoft', 'google']);
    for (const system of KNOWN_WITHOUT_ISSUER) expect(recipeForSystem(system)).toBeUndefined();
  });
});

describe('the MCP recipe', (): void => {
  it('pre-registers a client per server, per employee, and returns to Day0’s MCP redirect (B12)', (): void => {
    expect(MCP_REDIRECT_PATH).toBe('/api/oauth/mcp');
    expect(MCP_RECIPE.modes.map((mode) => [mode.mode, mode.kind, mode.landsAtInstall])).toEqual([
      ['per-employee', 'mcp-client', true],
    ]);
    expect(MCP_RECIPE.modes[0].asks.map((ask) => [ask.field, ask.secret, ask.optional])).toEqual([
      ['serverUrl', false, false],
      ['clientId', false, false],
      ['secret', true, true],
      ['issuer', false, true],
      ['scopes', false, true],
    ]);
  });
});
