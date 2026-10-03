import { describe, expect, it } from 'vitest';
import { intakeFailureWords } from '../../../src/surfaces/intake-failure-words';
import {
  LINEAR_MCP_REVOKED_TOKEN_ERROR,
  LINEAR_MCP_TRANSPORT_ERROR,
} from '../../fixtures/real-vendor-walk-2026-10-03';

const words = (error: unknown): string =>
  intakeFailureWords({ system: 'Linear', error, otherwise: () => 'its own words' });

describe('intakeFailureWords', (): void => {
  it("names the walk's revoked token as Linear's refusal, never the MCP client's text (R41V-9)", (): void => {
    const said = words(new Error(LINEAR_MCP_REVOKED_TOKEN_ERROR));
    expect(said).toBe(
      'Linear refused the token Day0 holds for this card, so nothing was read; ' +
        "the card's next check says whether the connection still works.",
    );
    expect(said).not.toContain('POSTing');
  });

  it('names a server the MCP client could not reach over any transport as not reached', (): void => {
    expect(words(new Error(LINEAR_MCP_TRANSPORT_ERROR))).toBe(
      "Linear's MCP server could not be reached, so nothing was read; intake tries again at its next poll.",
    );
  });

  it('names any other connection the MCP client could not make without its text', (): void => {
    expect(
      words(new Error('Failed to connect to MCP server linear: Error: HTTP 403 Forbidden')),
    ).toBe(
      "Linear's MCP server did not accept the connection, so nothing was read; intake tries again at its next poll.",
    );
  });

  it('keeps any other failure in its own words', (): void => {
    expect(words(new Error('Slack conversations.history failed: not_in_channel'))).toBe(
      'its own words',
    );
  });
});
