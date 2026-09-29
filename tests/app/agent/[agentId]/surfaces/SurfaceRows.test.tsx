import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ApprovalRow,
  DiscoveryProvenance,
  EvidenceQuote,
  IntakeScopeRow,
  ONE_APPROVER,
  ProvisioningRow,
  SurfaceLadder,
  type ProvisioningRowProps,
} from '../../../../../app/agent/[agentId]/surfaces/SurfaceRows';
import {
  presentProvisioning,
  type ProvisioningPresentation,
} from '../../../../../src/surfaces/credential-presentation';

describe('EvidenceQuote', (): void => {
  it('renders an index tag as the page title linked to the page', (): void => {
    const markup = renderToStaticMarkup(
      <EvidenceQuote quote='<page url="https://app.notion.com/p/3c7a382da0a080968de5fd7bf18e5f21">Linear Automation</page>' />,
    );
    expect(markup).toBe(
      '<a href="https://app.notion.com/p/3c7a382da0a080968de5fd7bf18e5f21" target="_blank" rel="noreferrer" class="text-[var(--color-fg)] underline decoration-[var(--color-border)]">Linear Automation</a>',
    );
    expect(markup).not.toContain('&lt;page');
  });

  it('leaves every other quote as stored', (): void => {
    expect(renderToStaticMarkup(<EvidenceQuote quote="# Linear automation" />)).toBe(
      '# Linear automation',
    );
    expect(renderToStaticMarkup(<EvidenceQuote quote='<page url="ftp://x">Linear</page>' />)).toBe(
      '&lt;page url=&quot;ftp://x&quot;&gt;Linear&lt;/page&gt;',
    );
    expect(renderToStaticMarkup(<EvidenceQuote quote={undefined} />)).toBe('');
  });
});

describe('DiscoveryProvenance', (): void => {
  it('shows the manager and documentation page when both named the system', (): void => {
    const markup = renderToStaticMarkup(
      <DiscoveryProvenance
        evidence={[
          {
            kind: 'charter',
            ref: 'manager 1:1',
            quote: 'We use Linear.',
            current: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
          {
            kind: 'documentation',
            sourceId: 'source-1',
            ref: 'systems/linear.md',
            quote: '# Linear',
            url: 'https://notion.example/linear',
            current: true,
            firstSeenAt: 2,
            lastSeenAt: 2,
          },
        ]}
        sourceLabels={new Map([['source-1', 'RevOps handbook']])}
      />,
    );
    expect(markup).toContain('System discovered from');
    expect(markup).toContain('manager 1:1');
    expect(markup).toContain('RevOps handbook / systems/linear.md');
    expect(markup).toContain('href="https://notion.example/linear"');
    expect(markup).toContain('We use Linear.');
    expect(markup).toContain('# Linear');
    // A page link here is the same affordance as a route-evidence page link a
    // few lines down the same card, so it carries the same accent treatment
    // rather than reading as muted and disabled.
    expect(markup).toContain(
      '<a href="https://notion.example/linear" target="_blank" rel="noreferrer" class="text-[var(--color-accent)] underline">',
    );
  });

  it('keeps edited-away documentation provenance visible as historical', (): void => {
    const markup = renderToStaticMarkup(
      <DiscoveryProvenance
        evidence={[
          {
            kind: 'documentation',
            sourceId: 'source-1',
            ref: 'systems/northstar-crm.md',
            quote: '# Northstar CRM',
            current: false,
            firstSeenAt: 1,
            lastSeenAt: 2,
          },
        ]}
        sourceLabels={new Map([['source-1', 'Team folder']])}
      />,
    );
    expect(markup).toContain('Team folder / systems/northstar-crm.md');
    expect(markup).toContain('no longer named in the current page');
  });
});

describe('SurfaceLadder', (): void => {
  it('shows the ratified route and every failed rung after a successful demotion', (): void => {
    const markup = renderToStaticMarkup(
      <SurfaceLadder
        candidates={[
          { path: 'mcp', endpoint: 'https://mcp.jira.example/mcp' },
          { path: 'browser-driven', endpoint: 'https://jira.example/issues' },
        ]}
        attempts={[
          {
            path: 'mcp',
            endpoint: 'https://mcp.jira.example/mcp',
            outcome: 'demoted',
            reason: 'MCP server returned HTTP 503',
            attemptedAt: 100,
          },
        ]}
      />,
    );

    expect(markup).toContain('Approved ladder:');
    expect(markup).toContain('mcp → browser-driven');
    expect(markup).toContain('mcp attempt failed');
    expect(markup).toContain('MCP server returned HTTP 503');
    expect(markup).toContain('Fell to the next approved rung.');
  });

  it('says a first probe failed and was retried, without calling it a failed attempt', (): void => {
    const markup = renderToStaticMarkup(
      <SurfaceLadder
        attempts={[
          {
            path: 'mcp',
            endpoint: 'https://mcp.linear.app/mcp',
            outcome: 'retried',
            reason:
              'Failed to connect to MCP server surface: Error: Could not connect to server with any available HTTP transport A request without the key was answered, so the endpoint is reachable.',
            attemptedAt: 100,
            retryAfterMs: 5_000,
          },
        ]}
      />,
    );

    expect(markup).toContain('mcp first probe failed: ');
    expect(markup).toContain('the endpoint is reachable');
    expect(markup).toContain('Retried after 5 s.');
    expect(markup).not.toContain('attempt failed');
    expect(markup).not.toContain('No approved fallback connected.');
  });
});

/** Render one isolated provisioning row without running dashboard hooks. */
function renderProvisioningRow(
  presentation: ProvisioningPresentation,
  overrides: Partial<ProvisioningRowProps> = {},
): string {
  return renderToStaticMarkup(
    <ProvisioningRow
      onProvision={(): void => undefined}
      presentation={presentation}
      provisioning={false}
      surfaceSlug="slack"
      {...overrides}
    />,
  );
}

describe('ProvisioningRow', (): void => {
  it('renders nothing for a system whose docs describe no install procedure', (): void => {
    expect(
      renderProvisioningRow(
        presentProvisioning({
          credential: { found: 'value', method: 'api-key' },
          hasPublicUrl: true,
        }),
      ),
    ).toBe('');
  });

  it('offers a write-only configuration-token field beside the shared-token fallback', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: true }),
    );
    expect(markup).toContain('Provision a dedicated app');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).not.toContain('value=');
    expect(markup).toContain('asks Slack to revoke it');
  });

  it('says why it cannot offer one without a public address', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: false }),
    );
    expect(markup).toContain('DAY0_PUBLIC_URL');
    expect(markup).not.toContain('type="password"');
  });

  it('shows the install link and hides the field once the app exists', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({
        credential: { found: 'none', method: 'oauth' },
        hasPublicUrl: true,
        provisioning: {
          appId: 'A1',
          appName: 'ops worker (Day0)',
          installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1&state=abc',
        },
      }),
    );
    expect(markup).toContain('Awaiting the install click');
    expect(markup).toContain('client_id=1&amp;state=abc');
    expect(markup).toContain('Install link for the administrator');
    expect(markup).not.toContain('type="password"');
  });

  it('reports the dedicated identity once the install has landed', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({
        credential: { found: 'none', method: 'oauth' },
        hasPublicUrl: true,
        provisioning: {
          appId: 'A1',
          appName: 'ops worker (Day0)',
          installUrl: 'https://slack.com/oauth/v2/authorize',
          installedAt: 5,
        },
      }),
    );
    expect(markup).toContain('Dedicated app installed');
    expect(markup).toContain('acts as its own app');
    expect(markup).not.toContain('Install link for the administrator');
  });

  it('names a failed install and offers a fresh link', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({
        credential: { found: 'none', method: 'oauth' },
        hasPublicUrl: true,
        provisioning: {
          appId: 'A1',
          appName: 'ops worker (Day0)',
          installUrl: 'https://slack.com/oauth/v2/authorize',
          lastError: 'Slack oauth.v2.access failed: invalid_code.',
        },
      }),
    );
    expect(markup).toContain('Install did not complete');
    expect(markup).toContain('invalid_code');
    expect(markup).toContain('type="password"');
  });

  it('shows an operation error under the row', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: true }),
      { error: 'Slack apps.manifest.create failed: token_expired' },
    );
    expect(markup).toContain('token_expired');
  });

  it('disables the control while an app is being registered', (): void => {
    const markup = renderProvisioningRow(
      presentProvisioning({ credential: { found: 'none', method: 'oauth' }, hasPublicUrl: true }),
      { provisioning: true },
    );
    expect(markup).toContain('Registering the app…');
    expect(markup).toContain('disabled=""');
  });
});

describe('ApprovalRow', (): void => {
  const idle = {
    blocked: false,
    onApprove: (): void => undefined,
    onReject: (): void => undefined,
  };

  it('offers Approve and Reject while nothing is in flight', (): void => {
    const markup = renderToStaticMarkup(<ApprovalRow {...idle} />);
    expect(markup).toMatch(/<button type="button" class="[^"]*">Approve<\/button>/);
    expect(markup).toMatch(/<button type="button" class="[^"]*">Reject<\/button>/);
    expect(markup).not.toContain('role="alert"');
  });

  it('holds both controls while a decision is in flight', (): void => {
    const markup = renderToStaticMarkup(<ApprovalRow {...idle} pending="approve" />);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Approving…<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);
  });

  it('says why the approval was refused, where the manager clicked', (): void => {
    const refusal =
      'A documented intake queue changed; reject this card and re-run orientation before approval.';
    const markup = renderToStaticMarkup(<ApprovalRow {...idle} error={refusal} />);
    expect(markup).toContain(`role="alert"`);
    expect(markup).toContain(refusal);
    expect(markup).toMatch(/<button type="button" class="[^"]*">Approve<\/button>/);
  });

  it("disables Approve with the server's reason beside it, the reason naming the control (E-63)", (): void => {
    const refusal =
      'A documented intake queue changed; reject this card and re-run orientation before approval.';
    const markup = renderToStaticMarkup(<ApprovalRow {...idle} refusal={refusal} />);
    const describedBy = /aria-describedby="([^"]+)"[^>]*>Approve<\/button>/.exec(markup)?.[1];
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(markup).toContain(
      `id="${describedBy}" class="text-sm text-[var(--color-warn)]">${refusal}</p>`,
    );
    expect(markup).not.toContain('role="alert"');
    expect(markup).toMatch(/<button[^>]*>Reject<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);
  });

  it('says the manager is the one approver (Q10)', (): void => {
    expect(renderToStaticMarkup(<ApprovalRow {...idle} />)).toContain(
      `${ONE_APPROVER} Day0 checks the connection as soon as you approve.`,
    );
  });
});

describe('IntakeScopeRow: what each employee reads', (): void => {
  const sourceId = 'source-folder';
  const scopeValue = (value: string, quote: string) => ({
    value,
    sourceId,
    ref: 'finance/handbook.md',
    quote,
  });

  it('lists each approved project and channel on its own card line', (): void => {
    const project = (value: string) => scopeValue(value, `- Project: \`${value}\``);
    const linear = renderToStaticMarkup(
      <IntakeScopeRow
        scope={{
          team: scopeValue('FIN', '- Team: `FIN`'),
          project: project('September close'),
          projects: [project('October close')],
        }}
        sourceLabels={new Map()}
        surfaceClass="kanban"
        system="Linear"
      />,
    );
    const slack = renderToStaticMarkup(
      <IntakeScopeRow
        scope={{
          channels: [
            scopeValue('finance-close', '- Channels: #finance-close, #ops-requests'),
            scopeValue('ops-requests', '- Channels: #finance-close, #ops-requests'),
          ],
        }}
        sourceLabels={new Map()}
        surfaceClass="chat"
        system="Slack"
      />,
    );
    expect(linear).toContain('<li>Project September close</li><li>Project October close</li>');
    expect(slack).toContain('<li>#finance-close</li><li>#ops-requests</li>');
    expect(slack.match(/- Channels: #finance-close, #ops-requests/g)).toHaveLength(1);
  });
  it('does not repeat a single queue under the reads line that already names it', (): void => {
    const linear = renderToStaticMarkup(
      <IntakeScopeRow
        scope={{
          team: scopeValue('REVOPS', '- Team: `REVOPS`'),
          project: scopeValue('Q3 close', '- Project: `Q3 close`'),
        }}
        sourceLabels={new Map()}
        surfaceClass="kanban"
        system="Linear"
      />,
    );
    expect(linear).toContain('Reads: Linear team REVOPS, project Q3 close');
    expect(linear).not.toContain('<li>');
    const teamOnly = renderToStaticMarkup(
      <IntakeScopeRow
        scope={{ team: scopeValue('REVOPS', '- Team: `REVOPS`') }}
        sourceLabels={new Map()}
        surfaceClass="kanban"
        system="Linear"
      />,
    );
    expect(teamOnly).not.toContain('<li>');
    const oneChannel = renderToStaticMarkup(
      <IntakeScopeRow
        scope={{ channels: [scopeValue('finance-close', '- Channels: #finance-close')] }}
        sourceLabels={new Map()}
        surfaceClass="chat"
        system="Slack"
      />,
    );
    expect(oneChannel).not.toContain('<li>');
  });

  it('renders the code spans of a handbook line and of a note as code, never as raw backticks', (): void => {
    const markup = renderToStaticMarkup(
      <IntakeScopeRow
        scope={{
          team: scopeValue('REVOPS', '- Team: `REVOPS`'),
          project: scopeValue(
            'Q3 close',
            'Linear, team `REVOPS`, project `Q3 close`: an odd ` tick',
          ),
          notes: [
            'Dropped pick 4: team `FIN` was not kept; intake reads one team, and `REVOPS` was picked first.',
          ],
        }}
        sourceLabels={new Map()}
        surfaceClass="kanban"
        system="Linear"
      />,
    );
    expect(markup).toMatch(/- Team: <code[^>]*>REVOPS<\/code>/);
    expect(markup).toMatch(
      /Linear, team <code[^>]*>REVOPS<\/code>, project <code[^>]*>Q3 close<\/code>: an odd ` tick/,
    );
    expect(markup).toMatch(/Dropped pick 4: team <code[^>]*>FIN<\/code> was not kept/);
    expect(markup).not.toContain('`REVOPS`');
    expect(markup).not.toContain('`FIN`');
  });

  it("says what the server found changed on the scope's pages (D D4)", (): void => {
    const changed =
      'Changed since this card was proposed: project September close is no longer stated on finance/handbook.md.';
    const markup = renderToStaticMarkup(
      <IntakeScopeRow
        changed={changed}
        scope={{ team: scopeValue('FIN', '- Team: `FIN`') }}
        sourceLabels={new Map()}
        surfaceClass="kanban"
        system="Linear"
      />,
    );
    expect(markup).toContain(`<p class="mt-2 text-[var(--color-warn)]">${changed}</p>`);
  });
});
