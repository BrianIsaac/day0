import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CredentialRow,
  EvidenceQuote,
  type CredentialRowProps,
} from '../../../../../app/agent/[agentId]/mock/SurfacesTab';
import type { CredentialPresentation } from '../../../../../src/surfaces/credential-presentation';

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
