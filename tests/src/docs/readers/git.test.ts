import { describe, expect, it } from 'vitest';
import { archiveUrlFor, parseGitLocator } from '../../../../src/docs/readers/git';

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
});
