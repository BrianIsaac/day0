import { describe, expect, it } from 'vitest';
import { intakeFailureWords } from '../../../src/surfaces/intake-failure-words';
import { LINEAR_MCP_REVOKED_TOKEN_ERROR } from '../../fixtures/real-vendor-walk-2026-10-03';

const words = (error: unknown): string =>
  intakeFailureWords({
    system: 'Linear',
    error,
    credential: 'lin_oauth_access_1',
    fallback: 'Provider intake failed.',
  });

describe('intakeFailureWords', (): void => {
  it("names the walk's revoked token as Linear's refusal, never the MCP client's text (R41V-9)", (): void => {
    const said = words(new Error(LINEAR_MCP_REVOKED_TOKEN_ERROR));
    expect(said).toBe(
      'Linear refused the token Day0 holds for this card, so nothing was read; ' +
        "the card's next check renews the token or ends the card with the reason.",
    );
    expect(said).not.toContain('POSTing');
  });

  it('names a connection the MCP client could not make as the server not reached', (): void => {
    expect(
      words(
        new Error(
          'Failed to connect to MCP server linear: Error: Could not connect to server with any available HTTP transport',
        ),
      ),
    ).toBe(
      "Linear's MCP server could not be reached, so nothing was read; intake tries again at its next poll.",
    );
  });

  it('keeps any other failure in its own line, with the credential redacted', (): void => {
    expect(words(new Error('Slack conversations.history failed: not_in_channel'))).toBe(
      'Slack conversations.history failed: not_in_channel',
    );
    expect(words(new Error('refused lin_oauth_access_1'))).not.toContain('lin_oauth_access_1');
  });
});
