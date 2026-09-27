import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveUrlFor, cloneFailure, parseGitLocator } from '../../../../src/docs/readers/git';
import { privateHostAllowlist } from '../../../../src/lib/private-hosts';

describe('git documentation reader', (): void => {
  it('parses an explicit ref and builds a GitHub archive URL', (): void => {
    const locator = parseGitLocator('https://github.com/example/team-docs.git#release/demo');
    expect(locator.ref).toBe('release/demo');
    expect(archiveUrlFor(locator).href).toBe(
      'https://github.com/example/team-docs/archive/refs/heads/release/demo.tar.gz',
    );
  });

  it('builds a GitLab archive URL and defaults to main', (): void => {
    const locator = parseGitLocator('https://gitlab.com/example/team-docs');
    expect(locator.ref).toBe('main');
    expect(archiveUrlFor(locator).href).toBe(
      'https://gitlab.com/example/team-docs/-/archive/main/team-docs-main.tar.gz',
    );
  });

  it('refuses non-HTTPS and unsupported repository hosts', (): void => {
    expect(() => parseGitLocator('http://github.com/example/docs')).toThrow('must use HTTPS');
    expect(() => parseGitLocator('https://code.example.com/team/docs')).toThrow(
      'supports GitHub and GitLab',
    );
  });

  it('refuses a locator carrying a user name or token, and never repeats it', (): void => {
    for (const locator of [
      'https://ghp_secret123@github.com/example/docs',
      'https://deploy:hunter2@gitlab.com/example/docs#main',
      'https://oauth2:glpat-abc@git.corp.internal/team/docs',
    ]) {
      let message = '';
      try {
        parseGitLocator(locator, privateHostAllowlist('git.corp.internal'));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain('must not carry a user name or password');
      for (const secret of ['ghp_secret123', 'hunter2', 'glpat-abc', 'deploy', 'oauth2']) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it('refuses a locator that is not a URL without repeating it', (): void => {
    expect(() => parseGitLocator('ghp_secret@not a url')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('ghp_secret') }),
    );
  });
});

describe("a git server inside the operator's network", (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  it('is read once its host is listed in DAY0_PRIVATE_HOSTS', (): void => {
    const locator = parseGitLocator(
      'https://git.corp.internal/team/runbooks.git#ops',
      privateHostAllowlist('.corp.internal'),
    );
    expect([locator.url.hostname, locator.ref]).toEqual(['git.corp.internal', 'ops']);
  });

  it('reads the list from the environment when the caller passes none', (): void => {
    vi.stubEnv('DAY0_PRIVATE_HOSTS', 'git.corp.internal');
    expect(parseGitLocator('https://git.corp.internal/team/runbooks').url.hostname).toBe(
      'git.corp.internal',
    );
    expect(() => parseGitLocator('https://code.corp.internal/team/runbooks')).toThrow(
      'DAY0_PRIVATE_HOSTS',
    );
  });

  it('has no archive fallback, since only GitHub and GitLab publish one at a known path', (): void => {
    const locator = parseGitLocator(
      'https://git.corp.internal/team/runbooks',
      privateHostAllowlist('git.corp.internal'),
    );
    expect(() => archiveUrlFor(locator)).toThrow('no archive fallback');
  });

  it('says the backend has no git binary when that is why the clone failed', (): void => {
    const missing = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    expect(cloneFailure('git.corp.internal', { error: missing, stderr: '' })).toContain(
      'The backend has no git binary',
    );
    expect(
      cloneFailure('git.corp.internal', {
        error: undefined,
        stderr: "Cloning into 'checkout'...\nfatal: repository not found\n",
      }),
    ).toBe('Git clone from git.corp.internal failed: fatal: repository not found.');
  });
});
