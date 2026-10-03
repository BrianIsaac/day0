import { describe, expect, it } from 'vitest';
import {
  defaultInstallRecordDirectory,
  installRecordMarkdown,
  installRecordName,
  installRecordRunMarkdown,
} from '../../../scripts/lib/install-record';

const AT = new Date('2026-10-02T10:00:00.000Z');

describe('the install record', (): void => {
  it('is named by the day and lives beside the backups, outside the checkout', (): void => {
    expect(installRecordName(AT)).toBe('install-record-2026-10-02.md');
    expect(defaultInstallRecordDirectory('/home/it', 'day0-acme')).toBe(
      '/home/it/day0-install/day0-acme',
    );
  });

  it('says what was registered, where, with which scopes and modes, and when each secret expires', (): void => {
    const markdown = installRecordMarkdown({
      project: 'day0-acme',
      recordedAt: AT,
      publicUrl: 'https://day0.acme.test',
      administrators: ['ines@acme.test'],
      signIn: {
        issuer: 'https://id.acme.test',
        clientId: 'day0-app',
        allowedDomains: 'acme.test',
        redirectUri: 'https://day0.acme.test/api/auth/oidc/callback',
        signedOutUri: 'https://day0.acme.test/signed-out',
      },
      connections: [
        {
          displayName: 'Linear',
          system: 'linear',
          mode: 'shared',
          kind: 'oauth-app',
          scopes: ['read', 'write'],
          clientCredentialsScopes: ['read', 'write'],
          clientId: 'lin-client',
          redirectUrl: 'https://day0.acme.test/api/oauth/linear',
          secretLifetime: 'Lasts until IT rotates it; tokens last 30 days.',
          outcome: 'landed',
          guide: 'docs/running/access-linear.md',
        },
      ],
      skipped: [
        { system: 'github', reason: 'keeps the pasted key until Day0 has an issuer for it' },
      ],
      check: { command: 'pnpm run check:access', status: 0 },
    });
    expect(markdown).toContain('# Day0 install record: day0-acme');
    expect(markdown).toContain(
      '- Administrators (manage the organisation’s connections): ines@acme.test',
    );
    expect(markdown).toContain(
      '- Redirect URI registered at the issuer: https://day0.acme.test/api/auth/oidc/callback',
    );
    expect(markdown).toContain('### Linear, shared');
    expect(markdown).toContain('- Client-credentials scopes (fixed): read, write');
    expect(markdown).toContain(
      '- Secret’s lifetime: Lasts until IT rotates it; tokens last 30 days.',
    );
    expect(markdown).toContain('- github: keeps the pasted key until Day0 has an issuer for it');
    expect(markdown).toContain('`pnpm run check:access` exited 0: every connection passed.');
    expect(markdown).not.toMatch(/\u2014/);
  });

  it('heads each run by its time, and a later run carries no title of its own (R41V-12)', (): void => {
    const run = {
      project: 'day0-acme',
      recordedAt: AT,
      administrators: ['ines@acme.test'],
      connections: [],
      skipped: [],
    };
    const first = installRecordMarkdown(run);
    expect(first.startsWith('# Day0 install record: day0-acme\n')).toBe(true);
    expect(first).toContain('## The run of 2026-10-02T10:00:00.000Z');
    const later = installRecordRunMarkdown({
      ...run,
      recordedAt: new Date('2026-10-02T11:30:00.000Z'),
    });
    expect(later.startsWith('## The run of 2026-10-02T11:30:00.000Z\n')).toBe(true);
    expect(later).not.toContain('# Day0 install record');
  });

  it('says so when this run connected nothing', (): void => {
    const markdown = installRecordMarkdown({
      project: 'day0-acme',
      recordedAt: AT,
      administrators: [],
      connections: [],
      skipped: [],
    });
    expect(markdown).toContain('None was connected by this run.');
    expect(markdown).toContain('none named');
  });
});
