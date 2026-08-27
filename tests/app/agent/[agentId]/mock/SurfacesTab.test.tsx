import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CredentialRow,
  EvidenceQuote,
  ProvisioningRow,
  type CredentialRowProps,
  type ProvisioningRowProps,
} from '../../../../../app/agent/[agentId]/mock/SurfacesTab';
import {
  presentProvisioning,
  type CredentialPresentation,
  type ProvisioningPresentation,
} from '../../../../../src/surfaces/credential-presentation';

/** Render one isolated credential row without running dashboard hooks. */
function renderCredentialRow(
  presentation: CredentialPresentation,
  overrides: Partial<CredentialRowProps> = {},
): string {
  return renderToStaticMarkup(
    <CredentialRow
      credentialLabel="Linear credential"
      landing={false}
      onLand={(): void => undefined}
      presentation={presentation}
      {...overrides}
    />,
  );
}

describe('SurfacesTab credential row', (): void => {
  it('shows shared-page metadata as masked with its governance finding', (): void => {
    const markup = renderCredentialRow({
      canLand: false,
      governanceFinding: 'credential found in a shared page - rotate into a vault',
      kind: 'masked',
      label: 'linear service token',
      text: 'located in Revenue operations / Linear automation (masked)',
    });
    expect(markup).toContain('located in Revenue operations / Linear automation (masked)');
    expect(markup).toContain('credential found in a shared page - rotate into a vault');
    expect(markup).not.toContain('type="password"');
  });

  it('renders an uncontrolled write-only landing field for IT', (): void => {
    const markup = renderCredentialRow({
      canLand: true,
      kind: 'landing',
      text: 'not in the docs - ask the Linear administrator',
    });
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).not.toContain('value=');
    expect(markup).toContain('Land credential');
  });

  it('shows the OAuth summary, the procedure and the labelled fallback landing field', (): void => {
    const markup = renderCredentialRow({
      canLand: true,
      detail: 'Ask IT to approve the app and follow the install link.',
      kind: 'oauth',
      label: 'Slack OAuth access',
      landingLabel: 'Land a shared bot token (fallback)',
      landingNote: 'Until the install flow exists the administrator may land the shared token.',
      text: 'OAuth install flow documented in Slack automation policy',
    });
    expect(markup).toContain(
      'Slack OAuth access - OAuth install flow documented in Slack automation policy',
    );
    expect(markup).toContain(
      'OAuth approval procedure: Ask IT to approve the app and follow the install link.',
    );
    expect(markup).toContain('Until the install flow exists the administrator may land the shared token.');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('Land a shared bot token (fallback)');
    expect(markup).not.toContain('>Land credential<');
  });

  it('keeps the OAuth row read-only once the fallback token is stored', (): void => {
    const markup = renderCredentialRow({
      canLand: false,
      kind: 'masked',
      label: 'Slack shared bot token',
      text: 'entered by IT (masked)',
    });
    expect(markup).toContain('Slack shared bot token - entered by IT (masked)');
    expect(markup).not.toContain('type="password"');
  });
});

describe('SurfacesTab evidence quote', (): void => {
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
    expect(renderToStaticMarkup(<EvidenceQuote quote="# Linear automation" />)).toBe('# Linear automation');
    expect(renderToStaticMarkup(<EvidenceQuote quote='<page url="ftp://x">Linear</page>' />)).toBe(
      '&lt;page url=&quot;ftp://x&quot;&gt;Linear&lt;/page&gt;',
    );
    expect(renderToStaticMarkup(<EvidenceQuote quote={undefined} />)).toBe('');
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

describe('SurfacesTab dedicated-app row', (): void => {
  it('renders nothing for a system whose docs describe no install procedure', (): void => {
    expect(
      renderProvisioningRow(
        presentProvisioning({ credential: { found: 'value', method: 'api-key' }, hasPublicUrl: true }),
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
    expect(markup).toContain('revoked');
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
    expect(markup).toContain('Registering the app...');
    expect(markup).toContain('disabled=""');
  });
});
