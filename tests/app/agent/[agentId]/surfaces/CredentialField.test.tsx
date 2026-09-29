import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CredentialField,
  type CredentialFieldProps,
} from '../../../../../app/agent/[agentId]/surfaces/CredentialField';
import type { CredentialPresentation } from '../../../../../src/surfaces/credential-presentation';

/** What a Linear card's field expects, as `expectedCredential` words it. */
const LINEAR = {
  label: 'The Linear service token the documentation names',
  hint: 'It is stored encrypted and never shown again.',
};

/** Render one isolated credential field on an approved card, without running dashboard hooks. */
function renderCredentialRow(
  presentation: CredentialPresentation,
  overrides: Partial<CredentialFieldProps> = {},
): string {
  return renderToStaticMarkup(
    <CredentialField
      credentialLabel="Linear credential"
      expected={LINEAR}
      approved
      landing={false}
      onLand={(): void => undefined}
      presentation={presentation}
      {...overrides}
    />,
  );
}

describe('CredentialField', (): void => {
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

  it('renders an uncontrolled write-only landing field, labelled with whose credential it takes', (): void => {
    const markup = renderCredentialRow({
      canLand: true,
      kind: 'landing',
      text: 'not in the docs - ask the Linear administrator',
    });
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="new-password"');
    expect(markup).not.toContain('value=');
    expect(markup).toContain('Land credential');
    expect(markup).toContain(
      '<label for="credential-Linear credential" class="text-[13px] font-medium text-[var(--color-fg-2)]">The Linear service token the documentation names</label>',
    );
    expect(markup).toContain('aria-describedby="credential-Linear credential-hint"');
    expect(markup).toContain('It is stored encrypted and never shown again.');
  });

  it('offers no field before the card is approved, and says what it will ask for (B D6)', (): void => {
    const markup = renderCredentialRow(
      { canLand: true, kind: 'landing', text: 'not in the docs - ask the Slack administrator' },
      {
        approved: false,
        expected: {
          label: "The Slack app's bot token, the one that begins xoxb-",
          hint: 'A user token would post as that person.',
        },
      },
    );
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('Land credential');
    expect(markup.replace(/&#x27;/g, "'")).toContain(
      "Once you approve, the card asks for the Slack app's bot token, the one that begins xoxb-.",
    );
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
      'Slack OAuth access: OAuth install flow documented in Slack automation policy',
    );
    expect(markup).toContain(
      'OAuth approval procedure: Ask IT to approve the app and follow the install link.',
    );
    expect(markup).toContain(
      'Until the install flow exists the administrator may land the shared token.',
    );
    expect(markup).toContain('type="password"');
    expect(markup).toContain('Land a shared bot token (fallback)');
    expect(markup).not.toContain('>Land credential<');
  });

  it('keeps the OAuth row read-only once the fallback token is stored', (): void => {
    const markup = renderCredentialRow({
      canLand: false,
      kind: 'masked',
      label: 'Slack shared bot token',
      text: 'entered on the card (masked)',
    });
    expect(markup).toContain('Slack shared bot token: entered on the card (masked)');
    expect(markup).not.toContain('type="password"');
  });

  it('is printed on the credential row beside the page-derived credential', (): void => {
    const markup = renderCredentialRow(
      {
        canLand: false,
        kind: 'masked',
        label: 'linear service token',
        text: 'located in Revenue operations / Linear automation (masked)',
      },
      { status: 'Superseded: No longer detected in synced documentation.' },
    );
    expect(markup).toContain('Status: Superseded: No longer detected in synced documentation.');
  });
});
