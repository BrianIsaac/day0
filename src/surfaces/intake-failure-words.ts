import { isTokenRefusal } from './identity-issuers/linear';

/*
 * The words a card's intake skip carries when a poll failed. A card shows Day0's words: the MCP
 * client's own text ("Failed to connect to MCP server surface: Error: Error POSTing to endpoint:
 * {...}", the real-vendor walk, 3 October 2026, R41V-9) is the client's, not the manager's, and is
 * named here by what it means; the caller logs the client's own line. Any other failure keeps its
 * own redacted, bounded line.
 */

/** How the MCP client words a connection it could not make, whatever stopped it. */
const MCP_CONNECTION_FAILED = /^Failed to connect to MCP server\b/;

/** How the MCP client words a server it could not reach over any transport (R41V-5). */
const MCP_UNREACHABLE = /\bCould not connect to server with any available HTTP transport\b/;

/** The text of a thrown value, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The words for a card's failed poll: a token the system refused, an MCP server not reached, an
 * MCP server that did not accept the connection, or the failure's own words.
 *
 * @param input.system - The system's name as the card shows it (`Linear`).
 * @param input.error - What the poll threw.
 * @param input.otherwise - The failure's own redacted, bounded line, for any other failure.
 */
export function intakeFailureWords(input: {
  readonly system: string;
  readonly error: unknown;
  readonly otherwise: () => string;
}): string {
  const message = messageOf(input.error);
  if (isTokenRefusal(input.error)) {
    return (
      `${input.system} refused the token Day0 holds for this card, so nothing was read; the ` +
      "card's next check says whether the connection still works."
    );
  }
  if (MCP_UNREACHABLE.test(message)) {
    return (
      `${input.system}'s MCP server could not be reached, so nothing was read; intake tries ` +
      'again at its next poll.'
    );
  }
  if (MCP_CONNECTION_FAILED.test(message)) {
    return (
      `${input.system}'s MCP server did not accept the connection, so nothing was read; intake ` +
      'tries again at its next poll.'
    );
  }
  return input.otherwise();
}
