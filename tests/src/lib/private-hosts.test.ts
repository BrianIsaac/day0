import { describe, expect, it } from 'vitest';
import { isPrivateHostAllowed, privateHostAllowlist } from '../../../src/lib/private-hosts';

describe('the private-host allowlist', (): void => {
  it('is empty when unset', (): void => {
    expect(privateHostAllowlist(undefined)).toEqual({ names: [], suffixes: [] });
    expect(privateHostAllowlist(' , ')).toEqual({ names: [], suffixes: [] });
  });

  it('takes names, IP addresses and dot-led suffixes, in any case, comma or space separated', (): void => {
    expect(
      privateHostAllowlist('Confluence.Corp.Internal., 10.20.0.5 [fd00::7]\n.git.corp.internal'),
    ).toEqual({
      names: ['confluence.corp.internal', '10.20.0.5', 'fd00::7'],
      suffixes: ['.git.corp.internal'],
    });
  });

  it('refuses an entry that is not a host, rather than guessing what it meant', (): void => {
    for (const entry of [
      'https://mcp.corp.internal',
      'mcp.corp.internal:8443',
      'corp/x',
      '*',
      '.',
      '*.corp',
    ]) {
      expect(() => privateHostAllowlist(entry), entry).toThrow('DAY0_PRIVATE_HOSTS');
    }
  });

  it('admits a named host and every host under a suffix, but not the suffix itself', (): void => {
    const allowlist = privateHostAllowlist('mcp.corp.internal .git.corp.internal');
    expect(isPrivateHostAllowed('MCP.corp.internal.', allowlist)).toBe(true);
    expect(isPrivateHostAllowed('docs.git.corp.internal', allowlist)).toBe(true);
    expect(isPrivateHostAllowed('git.corp.internal', allowlist)).toBe(false);
    expect(isPrivateHostAllowed('evil-mcp.corp.internal', allowlist)).toBe(false);
    expect(isPrivateHostAllowed('[fd00::7]', privateHostAllowlist('fd00::7'))).toBe(true);
  });
});
