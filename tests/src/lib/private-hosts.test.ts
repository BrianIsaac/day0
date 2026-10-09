import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredGitHosts,
  configuredPrivateHosts,
  gitHostAllowlist,
  isGitHostListed,
  isPrivateHostAllowed,
  privateHostAllowlist,
} from '../../../src/lib/private-hosts';

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
      '.0.0.1',
      '.168.1.1',
    ]) {
      expect(() => privateHostAllowlist(entry), entry).toThrow('DAY0_PRIVATE_HOSTS');
    }
  });

  it('refuses this machine and every address day0 never dials, whatever the list says', (): void => {
    for (const entry of [
      '127.0.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '224.0.0.1',
      '[::1]',
      'fe80::1',
      '::ffff:127.0.0.1',
      'localhost',
      'LocalHost.',
      'app.localhost',
      '.localhost',
    ]) {
      expect(() => privateHostAllowlist(`git.corp.internal, ${entry}`), entry).toThrow(
        'an address day0 never dials',
      );
    }
    expect(privateHostAllowlist('10.0.0.5 fd12::5').names).toEqual(['10.0.0.5', 'fd12::5']);
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

describe('the git hosts list (DAY0_GIT_HOSTS)', (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('takes the same entries as the private list and names its own variable in a refusal', (): void => {
    expect(gitHostAllowlist('Gitee.com., git.acme.example .code.acme.example')).toEqual({
      names: ['gitee.com', 'git.acme.example'],
      suffixes: ['.code.acme.example'],
    });
    expect(gitHostAllowlist(undefined)).toEqual({ names: [], suffixes: [] });
    expect(() => gitHostAllowlist('https://gitee.com')).toThrow('DAY0_GIT_HOSTS');
    expect(() => gitHostAllowlist('gitee.com 127.0.0.1')).toThrow(
      'DAY0_GIT_HOSTS lists "127.0.0.1", which is this machine or an address day0 never dials',
    );
  });

  it('refuses an address inside a private network, which belongs in DAY0_PRIVATE_HOSTS', (): void => {
    for (const entry of ['10.0.0.5', '192.168.1.20', 'fd12::5']) {
      expect(() => gitHostAllowlist(`gitee.com ${entry}`), entry).toThrow(
        `DAY0_GIT_HOSTS lists "${entry}", an address that is not public: list a host inside your network in DAY0_PRIVATE_HOSTS instead.`,
      );
    }
    expect(gitHostAllowlist('1.1.1.1').names).toEqual(['1.1.1.1']);
  });

  it('admits a listed git host and leaves it out of the private hosts', (): void => {
    vi.stubEnv('DAY0_GIT_HOSTS', 'gitee.com');
    vi.stubEnv('DAY0_PRIVATE_HOSTS', 'git.corp.internal');
    expect(isGitHostListed('GITEE.com.', configuredGitHosts())).toBe(true);
    expect(isPrivateHostAllowed('gitee.com', configuredPrivateHosts())).toBe(false);
    expect(isGitHostListed('git.corp.internal', configuredGitHosts())).toBe(false);
  });
});
