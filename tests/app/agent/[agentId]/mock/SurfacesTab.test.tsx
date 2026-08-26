import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CredentialRow,
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

  it('shows the OAuth summary and procedure without a landing field', (): void => {
    const markup = renderCredentialRow({
      canLand: false,
      detail: 'Ask IT to approve the app and follow the install link.',
      kind: 'oauth',
      label: 'Slack OAuth access',
      text: 'OAuth install flow documented in Slack automation policy',
    });
    expect(markup).toContain(
      'Slack OAuth access - OAuth install flow documented in Slack automation policy',
    );
    expect(markup).toContain(
      'OAuth approval procedure: Ask IT to approve the app and follow the install link.',
    );
    expect(markup).not.toContain('type="password"');
  });
});
