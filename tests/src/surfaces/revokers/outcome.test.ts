import { describe, expect, it } from 'vitest';
import {
  SOURCE_REVOCATION_OUTCOMES,
  systemDisplayName,
} from '../../../../src/surfaces/revokers/outcome';

describe('what an end of access did at the vendor, as the ledger records it', (): void => {
  it('keeps the outcomes the record lines are written for, once written', (): void => {
    expect([...SOURCE_REVOCATION_OUTCOMES]).toEqual([
      'token-revoked',
      'app-deleted',
      'app-uninstalled',
      'already-gone',
      'retrying',
      'failed',
      'not-supported',
      'shared',
      'not-at-vendor',
      'pasted-key',
    ]);
  });

  it('names Slack and Linear as they name themselves, an MCP system by its host, and the rest as stored', (): void => {
    expect(systemDisplayName('slack')).toBe('Slack');
    expect(systemDisplayName('linear')).toBe('Linear');
    expect(systemDisplayName('mcp:mcp.notion.com')).toBe('mcp.notion.com');
    expect(systemDisplayName('Zendesk')).toBe('Zendesk');
  });
});
