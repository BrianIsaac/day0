import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { actsAsAtUpgrade, type ActsAs } from '../../../../../src/surfaces/access-identity';
import { slackActsAs } from '../../../../../src/surfaces/identity-issuers/slack';
import {
  SurfaceCard,
  type ListedSurface,
  type SurfaceCardActions,
  type SurfaceCardContext,
} from '../../../../../app/agent/[agentId]/surfaces/SurfaceCard';
import { withListedIdentity } from './fakes/listed-identity';
import { AgentZoneContext } from '../../../../../app/components/time';

/**
 * The access plan's cross-unit test 1, its words half (11-AC; the backend half is 11-AJ's, in
 * `tests/convex/linearIdentityActions.test.ts` and `tests/convex/mcpOauthActions.test.ts`, which
 * prove the vendor sees the identity each issuer writes in `surface.actsAs`): for each identity an
 * issuer writes, the card's Acts as row names that identity and no other. Slack's own app and a
 * pasted key come from the issuers' own builders; Linear's and the MCP authorisation's are the
 * shapes `convex/linearIdentity.ts` (`connectSharedCard`, `landEmployeeTokens`) and
 * `convex/mcpOauthActions.ts` (the completion's `actsAs`) write.
 */

const NOW = Date.UTC(2026, 9, 2, 12);

const context: SurfaceCardContext = {
  now: NOW,
  sourceLabels: new Map(),
  credentials: new Map(),
  installRedirectConfigured: true,
  browserPresent: true,
  employeeName: 'Leo',
  organisation: new Map(),
  managerDmReachable: false,
};

const actions: SurfaceCardActions = {
  approve: (): void => undefined,
  reject: (): void => undefined,
  probe: (): void => undefined,
  land: (): void => undefined,
  provision: (): void => undefined,
  landSocketToken: (): void => undefined,
  setDays: async () => ({ expiresAt: NOW }),
  approveTools: async () => undefined,
  disconnect: async () => undefined,
  draftAccessRequest: async () => undefined,
  recordAccessRequestSent: async () => undefined,
};

/** The card's Acts as row, as text, for a connected card holding the identity given. */
function actsAsRow(card: { displayName: string; endpoint: string; path: string }, actsAs: ActsAs) {
  const markup = renderToStaticMarkup(
    <AgentZoneContext value="UTC">
      <SurfaceCard
        surface={withListedIdentity(
          {
            _id: `surface-${card.displayName}`,
            _creationTime: 1,
            agentId: 'agent-leo',
            slug: card.displayName.toLowerCase(),
            class: 'kanban',
            verdict: 'connected',
            credentialLanded: true,
            credentialId: 'credential-1',
            managerApprovedAt: NOW - 86_400_000,
            expiresAt: NOW + 80 * 86_400_000,
            whereFound: [],
            createdAt: 1,
            actsAs,
            ...card,
          } as unknown as ListedSurface,
          context,
        )}
        context={context}
        operation={undefined}
        actions={actions}
      />
    </AgentZoneContext>,
  ).replace(/&#x27;/g, "'");
  const row = /<dt class="[^"]*">Acts as<\/dt><dd[^>]*>(.*?)<\/dd>/.exec(markup)?.[1] ?? '';
  return row.replace(/<[^>]+>/g, '');
}

const SLACK = { displayName: 'Slack', endpoint: 'https://slack.com/api/', path: 'documented-api' };
const LINEAR = { displayName: 'Linear', endpoint: 'https://mcp.linear.app/mcp', path: 'mcp' };
const DOCS = { displayName: 'Acme docs', endpoint: 'https://docs.acme.test/mcp', path: 'mcp' };

describe('an employee acts at the vendor only as the identity its card names (cross-unit test 1, words half)', (): void => {
  it("names the employee's own Slack app by the name Slack shows, as 11-AS's install writes it", (): void => {
    const actsAs = slackActsAs({ appName: 'Leo (Day0)', botUserId: 'U_DAY0_BOT' });
    expect(actsAsRow(SLACK, actsAs)).toBe('Leo, its own Slack app, named “Leo (Day0)” in Slack');
  });

  it("names the employee's own Linear app user, as 11-AL's per-employee install writes it", (): void => {
    const actsAs: ActsAs = { kind: 'own-app', label: 'Day0 Leo', providerIdentityId: 'user-app-1' };
    expect(actsAsRow(LINEAR, actsAs)).toBe('Leo, its own Linear app, named “Day0 Leo” in Linear');
  });

  it("names the organisation's shared Linear app and that Day0 records who did what, as 11-AL's shared connect writes it", (): void => {
    const actsAs: ActsAs = {
      kind: 'shared-app',
      label: 'Linear',
      providerIdentityId: 'user-app-0',
    };
    expect(actsAsRow(LINEAR, actsAs)).toBe(
      'the Day0 app shared by your employees; Day0 records which employee did what',
    );
  });

  it("names the manager's delegated grant, as 11-AM's authorisation writes it, with its warning chip", (): void => {
    const actsAs: ActsAs = { kind: 'delegated', label: 'sam@acme.test' };
    expect(actsAsRow(DOCS, actsAs)).toBe(
      'you in Acme docs: what it touches shows your name Delegated',
    );
  });

  it('names a pasted key as the key, whose owner the writes show, as landCredential writes it', (): void => {
    const actsAs = actsAsAtUpgrade(
      { displayName: 'Linear' },
      { kind: 'value', label: 'Linear API key' },
    );
    expect(actsAsRow(LINEAR, actsAs)).toBe(
      "a key someone pasted; its writes show that key's owner, and Day0 adds Leo's name to each write Pasted key",
    );
  });

  it('names a browser seat as the employee signed in to its own seat', (): void => {
    expect(actsAsRow(DOCS, { kind: 'browser-seat', label: 'leo@acme.test' })).toBe(
      'Leo, signed in to its own seat in Acme docs',
    );
  });
});
