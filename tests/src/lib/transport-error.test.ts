import { describe, expect, it } from 'vitest';
import { isTransportUnreachable } from '../../../src/lib/transport-error';

describe('transport failure classification', (): void => {
  it('walks causes and accepts the MCP client wording without classifying provider refusals', (): void => {
    expect(
      isTransportUnreachable(
        new Error('request failed', { cause: new Error('connect ECONNREFUSED 172.18.0.9:3000') }),
      ),
    ).toBe(true);
    expect(
      isTransportUnreachable(
        'Failed to connect to MCP server docs: Could not connect to server with any available HTTP transport',
      ),
    ).toBe(true);
    expect(isTransportUnreachable(new Error('Documentation provider returned 401'))).toBe(false);
  });
});
