import { describe, expect, it } from 'vitest';
import {
  clientChunkPaths,
  countsText,
  deployedAppUrl,
  deploymentEnv,
  deploymentSiteUrl,
  deploymentUrl,
  DEPLOYMENT_NAME_PATTERN,
  exportLayout,
  listedTables,
  pageNamesRelease,
  parseFrameworkPreset,
  parseVercelInspect,
  pushTarget,
  rowCount,
  vercelEnvNames,
} from '../../../scripts/cloud/outputs';

/** The first lines of a real dry run's output, with the colour codes the CLI prints. */
const DRY_RUN = [
  '- Deploying to https://brisk-heron-417.convex.cloud... [dry run]',
  '',
  'Command would write file: /tmp/day0-tags/v0.10.1/convex/_generated/server.d.ts',
  '\u001b[36mA minor update is available for Convex\u001b[39m \u001b[2m(1.38.0 → 1.46.0)\u001b[22m',
  '\u001b[32m✔\u001b[39m No indexes are deleted by this push',
].join('\n');

/** `vercel inspect` as the move recorded it, the ids replaced. */
const INSPECT = [
  'Vercel CLI 50.22.1',
  'Fetching deployment "day0-example.vercel.app" in example-team',
  '> Fetched deployment "day0-abc123-example-team.vercel.app" in example-team [901ms]',
  '',
  '  General',
  '',
  '    id\t\tdpl_Example123abc',
  '    name\tday0',
  '    target\tproduction',
  '    status\t● Ready',
  '    url\t\thttps://day0-abc123-example-team.vercel.app',
  '    created\tWed Sep 30 2026 22:46:33 GMT+0800 (Singapore Standard Time) [3m ago]',
  '',
  '',
  '  Aliases',
  '',
  '    ╶ https://day0-example.vercel.app',
  '    ╶ https://day0-example-team.vercel.app',
  '    ',
  '',
  '  Builds',
  '',
  '    ┌ .        [0ms]',
  '    ├── λ index (1.73MB) [iad1]',
].join('\n');

describe('the deployment addresses', (): void => {
  it('are the cloud and site URLs of a generated name', (): void => {
    expect(deploymentUrl('brisk-heron-417')).toBe('https://brisk-heron-417.convex.cloud');
    expect(deploymentSiteUrl('brisk-heron-417')).toBe('https://brisk-heron-417.convex.site');
    expect(DEPLOYMENT_NAME_PATTERN.test('brisk-heron-417')).toBe(true);
    expect(DEPLOYMENT_NAME_PATTERN.test('dev:brisk-heron-417')).toBe(false);
    expect(DEPLOYMENT_NAME_PATTERN.test('production')).toBe(false);
  });
});

describe('pushTarget', (): void => {
  it('reads the deployment a dry run would push to, through the colour codes', (): void => {
    expect(pushTarget(DRY_RUN, 'dry-run')).toBe('brisk-heron-417');
  });

  it('reads the deployment a push reached, and only from the line of its own phase', (): void => {
    const pushed =
      '\u001b[32m✔\u001b[39m Deployed Convex functions to https://brisk-heron-417.convex.cloud';
    expect(pushTarget(pushed, 'push')).toBe('brisk-heron-417');
    expect(pushTarget(pushed, 'dry-run')).toBeUndefined();
    expect(pushTarget(DRY_RUN, 'push')).toBeUndefined();
  });

  it('names nothing when the CLI stopped before choosing a deployment', (): void => {
    expect(pushTarget('✖ Cannot prompt for input in non-interactive terminals.', 'dry-run')).toBe(
      undefined,
    );
  });
});

describe('listedTables', (): void => {
  it('lists one table per line and nothing for a deployment never pushed to', (): void => {
    expect(listedTables('agents\ndeploymentVersions\nmigrations\n')).toEqual([
      'agents',
      'deploymentVersions',
      'migrations',
    ]);
    expect(listedTables('')).toEqual([]);
  });
});

describe('deploymentEnv', (): void => {
  it('reads every name with its value unquoted as the CLI quotes it', (): void => {
    const listed = deploymentEnv(
      [
        'CLERK_JWT_ISSUER_DOMAIN=https://example.clerk.accounts.dev',
        "DAY0_CRONS_PAUSED='upgrade to 0.11.0 at 2026-10-01T00:00:00Z'",
        'OPENAI_API_KEY="sk-synthetic"',
        '',
      ].join('\n'),
    );
    expect([...listed.keys()]).toEqual([
      'CLERK_JWT_ISSUER_DOMAIN',
      'DAY0_CRONS_PAUSED',
      'OPENAI_API_KEY',
    ]);
    expect(listed.get('DAY0_CRONS_PAUSED')).toBe('upgrade to 0.11.0 at 2026-10-01T00:00:00Z');
    expect(listed.get('OPENAI_API_KEY')).toBe('sk-synthetic');
  });
});

describe('parseVercelInspect', (): void => {
  it('reads the id, the target, the status, the URL and every alias', (): void => {
    expect(parseVercelInspect(INSPECT)).toEqual({
      id: 'dpl_Example123abc',
      name: 'day0',
      target: 'production',
      ready: true,
      url: 'https://day0-abc123-example-team.vercel.app',
      aliases: ['https://day0-example.vercel.app', 'https://day0-example-team.vercel.app'],
    });
  });

  it('reads a building deployment as not ready, and an error as no deployment', (): void => {
    expect(parseVercelInspect(INSPECT.replace('● Ready', '● Building'))?.ready).toBe(false);
    expect(parseVercelInspect('Error: Can\'t find the deployment "x"')).toBeUndefined();
  });
});

/** `vercel project inspect` as CLI 50.22.1 prints it, the colour codes kept and the ids replaced. */
const PROJECT_INSPECT = [
  'Vercel CLI 50.22.1',
  '> Found Project example-team/day0 [312ms]',
  '',
  '\u001b[1m  General\n\u001b[22m',
  '    \u001b[36mID\u001b[39m\t\t\t\tprj_Example123',
  '    \u001b[36mName\u001b[39m\t\t\tday0',
  '    \u001b[36mNode.js Version\u001b[39m\t\t22.x',
  '',
  '\u001b[1m  Framework Settings\n\u001b[22m',
  '    \u001b[36mFramework Preset\u001b[39m\t\tNext.js',
  '    \u001b[36mBuild Command\u001b[39m\t\t\u001b[2m`npm run build` or `next build`\u001b[22m',
].join('\n');

describe('parseFrameworkPreset', (): void => {
  it("reads the linked project's framework preset by its name", (): void => {
    expect(parseFrameworkPreset(PROJECT_INSPECT)).toBe('Next.js');
    expect(parseFrameworkPreset(PROJECT_INSPECT.replace('Next.js', 'Other'))).toBe('Other');
  });

  it('reads no preset from an error or a preset the CLI could not name', (): void => {
    expect(parseFrameworkPreset('Error: Project not found')).toBeUndefined();
    expect(parseFrameworkPreset(PROJECT_INSPECT.replace('Next.js', 'undefined'))).toBeUndefined();
  });
});

describe('vercelEnvNames', (): void => {
  it('reads the names an environment holds and when each was written, never a value', (): void => {
    const listing = JSON.stringify({
      envs: [
        { key: 'NEXT_PUBLIC_CONVEX_URL', type: 'encrypted', target: ['production'], updatedAt: 5 },
        {
          key: 'CLERK_SECRET_KEY',
          type: 'encrypted',
          target: ['production', 'preview'],
          createdAt: 3,
        },
        { key: 'ONLY_PREVIEW', type: 'plain', value: 'x', target: ['preview'], updatedAt: 9 },
      ],
    });
    expect(vercelEnvNames(`Retrieving project…\n${listing}`, 'production')).toEqual(
      new Map([
        ['NEXT_PUBLIC_CONVEX_URL', 5],
        ['CLERK_SECRET_KEY', 3],
      ]),
    );
  });

  it('is undefined for output that is not the listing', (): void => {
    expect(vercelEnvNames('Error: not linked', 'production')).toBeUndefined();
    expect(vercelEnvNames('{"error":{}}', 'production')).toBeUndefined();
  });
});

describe('deployedAppUrl', (): void => {
  it('reads the production URL, or the last deployment URL printed', (): void => {
    expect(
      deployedAppUrl(
        '🔍  Inspect: https://vercel.com/x\n✅  Production: https://day0-abc.vercel.app [2m]',
      ),
    ).toBe('https://day0-abc.vercel.app');
    expect(deployedAppUrl('https://day0-def.vercel.app\n')).toBe('https://day0-def.vercel.app');
    expect(deployedAppUrl('Error: build failed')).toBeUndefined();
  });
});

describe('the public read-backs', (): void => {
  it('find the stamped release on /setup and only that release', (): void => {
    const html =
      '<p class="x">The deployment behind this page has been at v0.10.1 since 30 September 2026, Singapore time.</p>';
    expect(pageNamesRelease(html, '0.10.1')).toBe(true);
    expect(pageNamesRelease(html, '0.10.0')).toBe(false);
  });

  it("list a page's client chunks once each", (): void => {
    const html =
      '<script src="/_next/static/chunks/a1.js" async=""></script><link rel="preload" href="/_next/static/chunks/b2.js"/><script src="/_next/static/chunks/a1.js"></script>';
    expect(clientChunkPaths(html)).toEqual([
      '/_next/static/chunks/a1.js',
      '/_next/static/chunks/b2.js',
    ]);
  });
});

describe('the export counts', (): void => {
  it('read the tables and the stored files from the member listing', (): void => {
    const layout = exportLayout(
      [
        'README.md',
        '_tables/documents.jsonl',
        '_storage/documents.jsonl',
        'migrations/documents.jsonl',
        'migrations/generated_schema.jsonl',
        'agents/documents.jsonl',
        '',
      ].join('\n'),
    );
    expect(layout).toEqual({ tables: ['agents', 'migrations'], storage: true });
  });

  it("count one row per non-empty line and print the handovers' form", (): void => {
    expect(rowCount('{"_id":"a"}\n{"_id":"b"}\n\n')).toBe(2);
    expect(
      countsText({
        tables: [
          ['agents', 0],
          ['migrations', 19],
        ],
        storedFiles: 0,
      }),
    ).toBe('agents 0\nmigrations 19\nTOTAL 19 tables 2 stored_files 0\n');
  });
});
