import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultInstallRecordDirectory,
  installRecordInstallMarkdown,
  installRecordLifecycleMarkdown,
  installRecordMarkdown,
  installRecordName,
  installRecordRunMarkdown,
  writeInstallRecordSection,
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

describe('what the record says was installed (wave 17, 17-P)', (): void => {
  const IMAGE = `sha256:${'5'.repeat(64)}`;
  const BASE = `sha256:${'d'.repeat(64)}`;
  const INSTALLATION = {
    release: '0.21.0',
    commit: '15753ce8ebd0',
    publicUrl: 'https://day0.acme.test',
    backendUrl: 'https://convex.day0.acme.test',
    image: { id: IMAGE, base: BASE },
    backupDirectory: '/home/it/day0-backups/day0-acme',
  };

  it('names the release, the commit, the image by its id and base, both public addresses and where backups go', (): void => {
    const markdown = installRecordInstallMarkdown({
      project: 'day0-acme',
      recordedAt: AT,
      installation: INSTALLATION,
      steps: [
        { step: 'The company sign-in', outcome: 'passed' },
        { step: 'The organisation’s systems', outcome: 'stopped: it exited 1' },
      ],
    });
    expect(markdown.split('\n')[0]).toBe('## The install of 2026-10-02T10:00:00.000Z');
    expect(markdown).toContain('- Release: v0.21.0');
    expect(markdown).toContain('- Commit: 15753ce8ebd0');
    expect(markdown).toContain('- Day0’s public address: https://day0.acme.test');
    expect(markdown).toContain('- The backend’s public address: https://convex.day0.acme.test');
    expect(markdown).toContain(`- Backend image: ${IMAGE}`);
    expect(markdown).toContain(`- Built from the pinned backend: ${BASE}`);
    expect(markdown).toContain('- Backups go to: /home/it/day0-backups/day0-acme');
    expect(markdown).toContain('- The organisation’s systems: stopped: it exited 1');
    expect(markdown).not.toContain('### The reverse proxy');
  });

  it("carries the proxy check's rows as it printed them, and says so when there is no proxy to check", (): void => {
    const checked = installRecordInstallMarkdown({
      project: 'day0-acme',
      recordedAt: AT,
      installation: INSTALLATION,
      steps: [],
      proxy: [
        'pass https://day0.acme.test answers as Day0 over https.',
        'pass https://convex.day0.acme.test carries the live connection.',
      ],
    });
    expect(checked).toContain(
      '### The reverse proxy\n\n- pass https://day0.acme.test answers as Day0 over https.',
    );
    const none = installRecordInstallMarkdown({
      project: 'day0-acme',
      recordedAt: AT,
      installation: { release: '0.21.0' },
      steps: [],
      proxy: [],
    });
    expect(none).toContain('- Not checked: the public address is this machine itself.');
  });

  it('says an image carries no base label rather than leave the line out', (): void => {
    expect(
      installRecordInstallMarkdown({
        project: 'day0-acme',
        recordedAt: AT,
        installation: { image: { id: IMAGE } },
        steps: [],
      }),
    ).toContain('- Built from the pinned backend: not labelled: built by another checkout');
  });

  it("names an upgrade's backup, its checksum, the commit that wrote its rows and the way back (17-K's F5)", (): void => {
    const markdown = installRecordLifecycleMarkdown({
      verb: 'upgrade',
      project: 'day0-acme',
      recordedAt: AT,
      outcome: 'completed',
      installation: INSTALLATION,
      fromRelease: '0.20.0',
      backup: {
        file: '/home/it/day0-backups/day0-acme/day0-acme-20261002T100000Z.tar.gz',
        sha256: '7'.repeat(64),
        rowsRelease: '0.20.0',
        rowsCommit: '26d76e0d31d2',
        takenByCommit: '15753ce8ebd0',
      },
      wayBack:
        'The way back: ./setup.sh restore /home/it/day0-backups/day0-acme/day0-acme-20261002T100000Z.tar.gz ' +
        'from a checkout of v0.20.0. Never start the old image over this volume.',
    });
    expect(markdown.split('\n')[0]).toBe('## The upgrade of 2026-10-02T10:00:00.000Z');
    expect(markdown).toContain('- Outcome: completed');
    expect(markdown).toContain('- From release: v0.20.0');
    expect(markdown).toContain('- Release: v0.21.0');
    expect(markdown).toContain(
      '- Backup: /home/it/day0-backups/day0-acme/day0-acme-20261002T100000Z.tar.gz',
    );
    expect(markdown).toContain(`- Its sha256: ${'7'.repeat(64)}`);
    expect(markdown).toContain('- Its rows are at: v0.20.0, stamped by commit 26d76e0d31d2');
    expect(markdown).toContain('- Taken by the checkout at commit: 15753ce8ebd0');
    expect(markdown).toContain('### The way back\n\nThe way back: ./setup.sh restore ');
  });

  it('names what a restore put back and the copy of what it replaced', (): void => {
    const markdown = installRecordLifecycleMarkdown({
      verb: 'restore',
      project: 'day0-acme',
      recordedAt: AT,
      outcome: 'completed',
      installation: { release: '0.20.0', commit: '26d76e0d31d2' },
      restored: { file: '/b/upgrade.tar.gz', sha256: '7'.repeat(64), rowsRelease: '0.20.0' },
      backup: { file: '/b/replaced.tar.gz', sha256: '8'.repeat(64), rowsRelease: '0.21.0' },
    });
    expect(markdown).toContain('### What was put back\n\n- Backup: /b/upgrade.tar.gz');
    expect(markdown).toContain(
      '### What it replaced, backed up first\n\n- Backup: /b/replaced.tar.gz',
    );
    expect(markdown).not.toContain('From release');
  });

  it('says an upgrade could not read the release it came from, rather than nothing', (): void => {
    expect(
      installRecordLifecycleMarkdown({
        verb: 'upgrade',
        project: 'day0-acme',
        recordedAt: AT,
        outcome: 'completed',
        installation: {},
      }),
    ).toContain('- From release: not read (the backend was not running when the upgrade began)');
  });

  it('writes a secret’s expiry as a date where the recipe gives its lifetime in days', (): void => {
    const run = installRecordRunMarkdown({
      project: 'day0-acme',
      recordedAt: AT,
      administrators: [],
      connections: [
        {
          displayName: 'Example',
          system: 'example',
          mode: 'shared',
          kind: 'oauth-app',
          scopes: [],
          secretLifetime: 'Lasts 90 days.',
          secretExpires: new Date('2026-12-31T10:00:00.000Z'),
          outcome: 'landed',
          guide: 'docs/running/access-mcp.md',
        },
      ],
      skipped: [],
    });
    expect(run).toContain('- Secret expires: 2026-12-31');
  });
});

describe('the day’s record on disk', (): void => {
  it('opens with its title readable by its owner alone, and adds each later section below the earlier ones', (): void => {
    const directory = mkdtempSync(join(tmpdir(), 'day0-install-record-'));
    try {
      const first = writeInstallRecordSection({
        directory: join(directory, 'nested'),
        at: AT,
        project: 'day0-acme',
        section: '## The backup of 2026-10-02T10:00:00.000Z\n\n- Outcome: completed\n',
      });
      expect(first).toBe(join(directory, 'nested', 'install-record-2026-10-02.md'));
      expect(statSync(first).mode & 0o777).toBe(0o600);
      const second = writeInstallRecordSection({
        directory: join(directory, 'nested'),
        at: new Date('2026-10-02T11:00:00.000Z'),
        project: 'day0-acme',
        section: '## The upgrade of 2026-10-02T11:00:00.000Z\n',
      });
      expect(second).toBe(first);
      const text = readFileSync(first, 'utf8');
      expect(text.match(/^# Day0 install record: day0-acme$/gm)).toHaveLength(1);
      expect(text).toContain('`./setup.sh install`, `access`, `upgrade`, `backup` and `restore`');
      expect(text.indexOf('## The backup of')).toBeLessThan(text.indexOf('## The upgrade of'));
      expect(text).not.toMatch(/\u2014/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
