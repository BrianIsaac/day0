import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_USAGE,
  parseCloudArguments,
  runCloudBackup,
  runCloudCommand,
  runCloudPause,
  runCloudSetup,
  runCloudUpgrade,
} from '../../scripts/setup-cloud';
import {
  APP_URL,
  cleanupClouds,
  cloud,
  COMMIT,
  DEPLOYMENT,
  DEV_DEPLOYMENT,
  ran,
  SECRET,
  verb,
  writes,
  type Cloud,
} from './cloud/harness';

afterEach(cleanupClouds);

/** The state of a production deployment nothing was ever pushed to, and an app still on dev: fresh for each test, since the fake mutates it. */
function empty(): Partial<Cloud['state']> {
  return {
    tables: [],
    env: new Map<string, string>(),
    stamp: undefined,
    pendingMigrations: ['agents-owner', 'surfaces-access-clock'],
    served: { id: 'dpl_OnDev', talksTo: DEV_DEPLOYMENT, release: '0.3.0' },
  };
}

/**
 * A private settings file beside the target, mode 600.
 *
 * @param c - The fake cloud.
 * @param text - Its contents.
 */
function settingsFile(c: Cloud, text: string, mode = 0o600): string {
  const file = join(c.privateDir, 'prod.env');
  writeFileSync(file, text, 'utf8');
  chmodSync(file, mode);
  return file;
}

const SETTINGS = [
  'CLERK_JWT_ISSUER_DOMAIN=https://example.clerk.accounts.dev',
  `OPENAI_API_KEY=${SECRET}`,
  'OPENAI_MODEL=gpt-5.6-terra',
  '',
].join('\n');

/** Every line printed, joined, for the no-secret assertions. */
function printed(c: Cloud): string {
  return c.output.join('\n');
}

describe('CLOUD_USAGE', (): void => {
  it('says pause is for a real-mode deployment, and that a mock one takes it too', (): void => {
    expect(CLOUD_USAGE).toContain(
      "pause     hold the deployment's scheduled jobs, pushing the stamped\n" +
        '            release again so every module reads it; it is for a\n' +
        '            real-mode deployment, whose jobs reach the connected systems,\n' +
        '            and a mock one takes it too (its jobs reach nothing outside)',
    );
  });
});

describe('parseCloudArguments', (): void => {
  it('reads a verb and its flags, the app host defaulting to Vercel', (): void => {
    expect(
      parseCloudArguments(['upgrade', '--target', '/p/t.env', '--dry-run', '--scope', 'team']),
    ).toEqual({
      verb: 'upgrade',
      target: '/p/t.env',
      scope: 'team',
      app: 'vercel',
      dryRun: true,
      assumeYes: false,
      help: false,
    });
    expect(parseCloudArguments(['setup', '--app', 'none']).app).toBe('none');
  });

  it('refuses an unknown flag, a missing value, two verbs and an unknown host', (): void => {
    expect(() => parseCloudArguments(['setup', '--prod'])).toThrow('Unknown option "--prod"');
    expect(() => parseCloudArguments(['backup', '--to'])).toThrow('--to needs a value.');
    expect(() => parseCloudArguments(['setup', 'upgrade'])).toThrow('two verbs');
    expect(() => parseCloudArguments(['setup', '--app', 'netlify'])).toThrow('vercel, none');
    expect(() => parseCloudArguments(['setup', 'constructor', 'x'])).toThrow(
      'Unknown option "constructor"',
    );
  });
});

describe('cloud setup, the first push', (): void => {
  it('sets the env through stdin before the push, then migrates, stamps and deploys the app onto it', async (): Promise<void> => {
    const c = cloud(empty(), { targetText: `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\n` });
    const envFile = settingsFile(c, SETTINGS);
    expect(await runCloudSetup(verb(c, { verb: 'setup', envFile }), c.io)).toBe(0);

    const order = writes(c);
    expect(order[0]).toBe(`npx convex env set --deployment ${DEPLOYMENT}`);
    expect(order[1]).toMatch(
      /^npx convex deploy --typecheck enable --env-file .*prod-target\.env --message v0\.4\.0 0123456789ab cloud setup$/,
    );
    expect(order.filter((line) => line.includes('migrations:runPending'))).toHaveLength(2);
    expect(order).toContain(
      `npx convex run migrations:recordRelease {"release":"0.4.0","commit":"${COMMIT}"} --deployment ${DEPLOYMENT}`,
    );
    expect(order.slice(-4)).toEqual([
      'vercel env update NEXT_PUBLIC_CONVEX_URL production --yes',
      'vercel env update NEXT_PUBLIC_CONVEX_SITE_URL production --yes',
      'vercel env update CONVEX_DEPLOYMENT production --yes',
      'vercel --prod --yes',
    ]);

    expect(Object.fromEntries(c.state.env)).toEqual({
      CLERK_JWT_ISSUER_DOMAIN: 'https://example.clerk.accounts.dev',
      OPENAI_API_KEY: SECRET,
      OPENAI_MODEL: 'gpt-5.6-terra',
      DAY0_SURFACE_MODE: 'mock',
    });
    expect(c.state.pushedWithEnv[0]?.get('CLERK_JWT_ISSUER_DOMAIN')).toBeDefined();
    // The target is proved before the env, the push itself once the env gives it an identity.
    const lines = ran(c);
    const set = lines.indexOf(`npx convex env set --deployment ${DEPLOYMENT}`);
    const dryRuns = lines.flatMap((line, at) => (line.includes('deploy --dry-run') ? [at] : []));
    expect(dryRuns).toHaveLength(2);
    expect(dryRuns[0]).toBeLessThan(set);
    expect(dryRuns[1]).toBeGreaterThan(set);
    expect(dryRuns[1]).toBeLessThan(
      lines.findIndex((line) => line.startsWith('npx convex deploy --typecheck')),
    );
    expect(c.state.stamp).toEqual({ release: '0.4.0', commit: COMMIT });
    expect(Object.fromEntries(c.state.vercelValues)).toEqual({
      NEXT_PUBLIC_CONVEX_URL: `https://${DEPLOYMENT}.convex.cloud`,
      NEXT_PUBLIC_CONVEX_SITE_URL: `https://${DEPLOYMENT}.convex.site`,
      CONVEX_DEPLOYMENT: `prod:${DEPLOYMENT}`,
    });
    expect(c.state.served).toMatchObject({ talksTo: DEPLOYMENT, release: '0.4.0' });
    expect(printed(c)).toContain(
      `Read back: ${APP_URL} is dpl_After1, its client talks to ${DEPLOYMENT}, and /setup says v0.4.0.`,
    );
    expect(readFileSync(c.target, 'utf8')).toContain(`DAY0_APP_URL=${APP_URL}`);
  });

  it('never puts a secret on a command line or on the screen', async (): Promise<void> => {
    const c = cloud(empty());
    const envFile = settingsFile(c, SETTINGS);
    expect(await runCloudSetup(verb(c, { verb: 'setup', envFile }), c.io)).toBe(0);
    expect(ran(c).join('\n')).not.toContain(SECRET);
    expect(printed(c)).not.toContain(SECRET);
    expect(c.calls.find((call) => call.input?.includes(SECRET))?.args).toEqual([
      'convex',
      'env',
      'set',
      '--deployment',
      DEPLOYMENT,
    ]);
  });

  it('puts back the generated code the push rewrote before it builds the app', async (): Promise<void> => {
    const c = cloud(empty());
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(0);
    const lines = ran(c);
    const push = lines.findIndex((line) => line.startsWith('npx convex deploy --typecheck'));
    expect(lines[push + 1]).toBe('git checkout -- convex/_generated');
    expect(lines.indexOf('vercel --prod --yes')).toBeGreaterThan(push);
  });

  it('asks for the settings, the keys hidden, when no file is named', async (): Promise<void> => {
    const c = cloud({
      ...empty(),
      answers: ['https://example.clerk.accounts.dev', SECRET, '', '', ''],
    });
    const asked: { question: string; hidden: boolean }[] = [];
    const io = {
      ...c.io,
      ask: async (question: string, options?: { hidden?: boolean }): Promise<string> => {
        asked.push({ question, hidden: options?.hidden === true });
        return c.state.answers.shift() ?? '';
      },
    };
    expect(await runCloudSetup(verb(c, { verb: 'setup' }), io)).toBe(0);
    expect(asked.map((entry) => [entry.question.split(' ')[0], entry.hidden])).toEqual([
      ['CLERK_JWT_ISSUER_DOMAIN', false],
      ['OPENAI_API_KEY', true],
      ['OPENAI_BASE_URL', false],
      ['OPENAI_MODEL', false],
      ['DAYTONA_API_KEY', true],
    ]);
    expect([...c.state.env.keys()].sort()).toEqual([
      'CLERK_JWT_ISSUER_DOMAIN',
      'DAY0_SURFACE_MODE',
      'OPENAI_API_KEY',
    ]);
  });

  it('keeps what the deployment already holds and sets only what it lacks', async (): Promise<void> => {
    const c = cloud({ ...empty(), env: new Map([['OPENAI_MODEL', 'already-chosen']]) });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(0);
    expect(c.state.env.get('OPENAI_MODEL')).toBe('already-chosen');
    expect(printed(c)).toContain('kept as it holds them: OPENAI_MODEL');
  });

  it('adds the three values Vercel does not hold yet, rather than updating them', async (): Promise<void> => {
    const c = cloud({
      ...empty(),
      vercelEnv: new Map([
        ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 1],
        ['CLERK_SECRET_KEY', 1],
      ]),
    });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(0);
    expect(writes(c).filter((line) => line.startsWith('vercel env'))).toEqual([
      'vercel env add NEXT_PUBLIC_CONVEX_URL production --yes',
      'vercel env add NEXT_PUBLIC_CONVEX_SITE_URL production --yes',
      'vercel env add CONVEX_DEPLOYMENT production --yes',
    ]);
  });

  it.each<
    [
      string,
      Partial<Cloud['state']>,
      { targetText?: string | null; linked?: boolean },
      string,
      Record<string, string>?,
    ]
  >([
    ['a dirty tree', { dirty: true }, {}, 'changes git has not committed'],
    ['a checkout that is not the tag', { tag: undefined }, {}, 'is not the v0.4.0 tag'],
    [
      'a development deployment',
      {},
      { targetText: `CONVEX_DEPLOYMENT=dev:${DEV_DEPLOYMENT}\n` },
      'names a development deployment',
    ],
    [
      'a target that is not the default production deployment',
      { defaultProd: 'other-prod-789' },
      {},
      'did not name brisk-heron-417',
    ],
    [
      'a missing target file',
      {},
      { targetText: null },
      "printf 'CONVEX_DEPLOYMENT=prod:<name>\\n'",
    ],
    [
      'a secret in the target file',
      {},
      { targetText: `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\nOPENAI_API_KEY=x\n` },
      'holds only CONVEX_DEPLOYMENT',
    ],
    ['an unlinked checkout', {}, { linked: false }, 'not linked to a Vercel project'],
    [
      'a deployment selected in the shell',
      {},
      {},
      'CONVEX_DEPLOY_KEY is set in this shell',
      { CONVEX_DEPLOY_KEY: 'prod:x|y' },
    ],
  ])(
    'refuses %s before anything is written',
    async (_label, state, options, words, environment): Promise<void> => {
      const c = cloud({ ...empty(), ...state }, options);
      const io = environment === undefined ? c.io : { ...c.io, environment };
      expect(
        await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), io),
      ).toBe(1);
      expect(printed(c)).toContain('error: nothing was set, pushed or deployed, because');
      expect(printed(c)).toContain(words);
      expect(writes(c)).toEqual([]);
    },
  );

  it('refuses a .env.local in the checkout, which the CLI would read beside the target', async (): Promise<void> => {
    const c = cloud(empty());
    writeFileSync(join(c.checkout, '.env.local'), 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\n');
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain('this checkout has a .env.local');
    expect(printed(c)).toContain('`vercel link` writes one when it is let pull the env');
    expect(writes(c)).toEqual([]);
  });

  it('refuses a target file inside the checkout', async (): Promise<void> => {
    const c = cloud(empty());
    const inside = join(c.checkout, 'prod-target.env');
    writeFileSync(inside, `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\n`);
    expect(await runCloudSetup({ ...verb(c, { verb: 'setup' }), target: inside }, c.io)).toBe(1);
    expect(printed(c)).toContain('is inside this checkout');
    expect(writes(c)).toEqual([]);
  });

  it('refuses a deployment that already holds tables and names the upgrade', async (): Promise<void> => {
    const c = cloud({ served: empty().served });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain(
      'already holds tables at v0.3.0, so this is not its first push: `./setup.sh cloud upgrade',
    );
    expect(writes(c)).toEqual([]);
  });

  it('finishes a first setup that stopped after its push, and one that stopped after its stamp', async (): Promise<void> => {
    const pushed = cloud({
      ...empty(),
      tables: ['agents', 'migrations'],
      env: new Map([['CLERK_JWT_ISSUER_DOMAIN', 'https://example.clerk.accounts.dev']]),
    });
    expect(
      await runCloudSetup(
        verb(pushed, { verb: 'setup', envFile: settingsFile(pushed, SETTINGS) }),
        pushed.io,
      ),
    ).toBe(0);
    expect(printed(pushed)).toContain('finishing a first setup that stopped after its push.');
    expect(pushed.state.stamp).toEqual({ release: '0.4.0', commit: COMMIT });

    const stamped = cloud({
      ...empty(),
      tables: ['agents', 'deploymentVersions', 'migrations'],
      stamp: { release: '0.4.0', commit: COMMIT },
      env: new Map([['CLERK_JWT_ISSUER_DOMAIN', 'https://example.clerk.accounts.dev']]),
    });
    expect(
      await runCloudSetup(
        verb(stamped, { verb: 'setup', envFile: settingsFile(stamped, SETTINGS) }),
        stamped.io,
      ),
    ).toBe(0);
    expect(printed(stamped)).toContain('finishing a first setup that stopped after its stamp.');
    expect(stamped.state.served).toMatchObject({ talksTo: DEPLOYMENT, release: '0.4.0' });
  });

  it('refuses a deployment stamped at this release that the app already talks to, and names the upgrade', async (): Promise<void> => {
    const finished = (): Partial<Cloud['state']> => ({
      stamp: { release: '0.4.0', commit: COMMIT },
      served: { id: 'dpl_Live1', talksTo: DEPLOYMENT, release: '0.4.0' },
    });
    const refusal = `brisk-heron-417 is set up at v0.4.0 and ${APP_URL} serves it: this is the upgrade's, which exports first:`;
    for (const dryRun of [false, true]) {
      const c = cloud(finished());
      expect(
        await runCloudSetup(
          verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS), dryRun }),
          c.io,
        ),
      ).toBe(1);
      expect(printed(c)).toContain(refusal);
      expect(printed(c)).not.toContain('finishing a first setup');
      expect(writes(c)).toEqual([]);
    }
    const asked = cloud(finished());
    expect(await runCloudSetup(verb(asked, { verb: 'setup' }), asked.io)).toBe(1);
    expect(printed(asked)).toContain(refusal);
    // Refused before the prompts, so nobody types a key into a setup that will not run.
    expect(printed(asked)).not.toContain('CLERK_JWT_ISSUER_DOMAIN (');
  });

  it('refuses to finish a stamped setup while no app address says whether the app is on it yet', async (): Promise<void> => {
    const c = cloud(
      {
        ...empty(),
        stamp: { release: '0.4.0', commit: COMMIT },
        tables: ['agents', 'deploymentVersions', 'migrations'],
      },
      { targetText: `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\n` },
    );
    expect(
      await runCloudSetup(
        verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS), dryRun: true }),
        c.io,
      ),
    ).toBe(1);
    expect(printed(c)).toContain(
      'brisk-heron-417 is stamped v0.4.0 already, and no app address is named, so a first setup that stopped part way cannot be told from one that finished:',
    );
    expect(writes(c)).toEqual([]);
  });

  it('finishes a stamped setup whose address answers no page yet, as a stopped first build leaves it', async (): Promise<void> => {
    const c = cloud({
      ...empty(),
      tables: ['agents', 'deploymentVersions', 'migrations'],
      stamp: { release: '0.4.0', commit: COMMIT },
      env: new Map([['CLERK_JWT_ISSUER_DOMAIN', 'https://example.clerk.accounts.dev']]),
      served: { id: 'dpl_Stopped1', talksTo: DEPLOYMENT, release: '0.4.0' },
      failing: [{ match: `%{http_code} ${APP_URL}/`, status: 0, stderr: '', stdout: '\n404' }],
    });
    expect(
      await runCloudSetup(
        verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS), dryRun: true }),
        c.io,
      ),
    ).toBe(0);
    expect(printed(c)).toContain('finishing a first setup that stopped after its stamp.');
    expect(writes(c)).toEqual([]);
  });

  it('leaves unstamped rows from before the migrations table to the upgrade', async (): Promise<void> => {
    const c = cloud({ ...empty(), tables: ['agents'] });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain('already holds tables, so this is not its first push');
    expect(writes(c)).toEqual([]);
  });

  it('judges what the deployment already holds with the file: a no-auth key there is refused', async (): Promise<void> => {
    const c = cloud({ ...empty(), env: new Map([['NEXT_PUBLIC_DEV_NO_AUTH', 'true']]) });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain(
      'NEXT_PUBLIC_DEV_NO_AUTH is refused (the deployment holds it; remove it on the dashboard)',
    );
    expect(writes(c)).toEqual([]);
  });

  it('reads back the values it set, not only their names', async (): Promise<void> => {
    const c = cloud({ ...empty(), envSetMangles: true });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain("the deployment's env does not hold");
    expect(printed(c)).not.toContain(SECRET);
    expect(writes(c).some((line) => line.startsWith('npx convex deploy'))).toBe(false);
  });

  it('refuses dependencies installed from another lockfile, which a push would bundle with', async (): Promise<void> => {
    const c = cloud(empty(), { staleDependencies: true });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain('run pnpm install --frozen-lockfile first.');
    expect(writes(c)).toEqual([]);
  });

  it('refuses a settings file others can read, and an app key in it, by name only', async (): Promise<void> => {
    const open = cloud(empty());
    expect(
      await runCloudSetup(
        verb(open, { verb: 'setup', envFile: settingsFile(open, SETTINGS, 0o644) }),
        open.io,
      ),
    ).toBe(1);
    expect(printed(open)).toContain('is readable by others; chmod 600');

    const appKey = cloud(empty());
    const envFile = settingsFile(appKey, `${SETTINGS}CLERK_SECRET_KEY=sk_test_synthetic\n`);
    expect(await runCloudSetup(verb(appKey, { verb: 'setup', envFile }), appKey.io)).toBe(1);
    expect(printed(appKey)).toContain('CLERK_SECRET_KEY is not a deployment setting');
    expect(printed(appKey)).not.toContain('sk_test_synthetic');
    expect(writes(appKey)).toEqual([]);
  });

  it('refuses a Vercel project whose framework preset is not Next.js, naming the setting, before any write', async (): Promise<void> => {
    for (const dryRun of [false, true]) {
      const c = cloud({ ...empty(), framework: 'Other' });
      expect(
        await runCloudSetup(
          verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS), dryRun }),
          c.io,
        ),
      ).toBe(1);
      expect(printed(c)).toContain(
        "the Vercel project day0 has the framework preset Other, so Vercel would build the app and serve none of its pages: set the project's Framework Preset to Next.js",
      );
      expect(writes(c)).toEqual([]);
      expect(ran(c)).toContain('vercel project inspect day0');
    }
  });

  it('reads the preset of the project the checkout is linked to, in its team', async (): Promise<void> => {
    const c = cloud(empty());
    expect(
      await runCloudSetup(
        verb(c, {
          verb: 'setup',
          envFile: settingsFile(c, SETTINGS),
          dryRun: true,
          scope: 'example-team',
        }),
        c.io,
      ),
    ).toBe(0);
    expect(ran(c)).toContain('vercel project inspect day0 --scope example-team');
  });

  it('refuses while Vercel holds no Clerk keys, since the app could not sign anyone in', async (): Promise<void> => {
    const c = cloud({ ...empty(), vercelEnv: new Map() });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain('vercel env add CLERK_SECRET_KEY production --sensitive');
    expect(writes(c)).toEqual([]);
  });

  it('on a dry run reads everything and changes nothing', async (): Promise<void> => {
    const c = cloud(empty());
    expect(
      await runCloudSetup(
        verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS), dryRun: true }),
        c.io,
      ),
    ).toBe(0);
    expect(writes(c)).toEqual([]);
    expect(ran(c)).toContain(`npx convex data --deployment ${DEPLOYMENT}`);
    expect(ran(c)).toContain(`vercel inspect ${APP_URL}`);
    expect(printed(c)).toContain(
      'Dry run: every read above ran; nothing was set, pushed or deployed.',
    );
  });

  it('asks before the first write and changes nothing when declined', async (): Promise<void> => {
    const c = cloud({ ...empty(), answers: ['n'] });
    const code = await runCloudSetup(
      verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS), assumeYes: false }),
      c.io,
    );
    expect(code).toBe(130);
    expect(c.output).toContain('Push v0.4.0 to brisk-heron-417 and deploy the app? [y/N] ');
    expect(writes(c)).toEqual([]);
  });

  it('with --app none pushes the functions and prints the three values for another host', async (): Promise<void> => {
    const c = cloud(empty());
    const code = await runCloudSetup(
      verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS), app: 'none' }),
      c.io,
    );
    expect(code).toBe(0);
    expect(ran(c).some((line) => line.startsWith('vercel'))).toBe(false);
    expect(c.output).toContain(`  NEXT_PUBLIC_CONVEX_URL=https://${DEPLOYMENT}.convex.cloud`);
    expect(c.state.stamp?.release).toBe('0.4.0');
  });

  it('stops with the rollback when the deployed app does not read back', async (): Promise<void> => {
    const c = cloud({
      ...empty(),
      failing: [
        {
          match: `curl -sS -L --max-time 30 -A`,
          status: 0,
          stderr: '',
          stdout: '<html></html>\n200',
        },
      ],
    });
    expect(
      await runCloudSetup(verb(c, { verb: 'setup', envFile: settingsFile(c, SETTINGS) }), c.io),
    ).toBe(1);
    expect(printed(c)).toContain('the app was deployed and did not read back');
    expect(printed(c)).toContain(
      'vercel promote dpl_OnDev, the build that served production before this run.',
    );
    expect(printed(c)).toContain('put back what they held');
  });
});

describe('cloud upgrade', (): void => {
  it('exports first, then pushes, migrates, stamps and deploys, and reads both halves back', async (): Promise<void> => {
    const c = cloud({ pendingMigrations: ['agents-owner'] });
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(0);
    const order = writes(c);
    expect(order[0]).toMatch(
      new RegExp(
        `^npx convex export --include-file-storage --path .*before-v0\\.4\\.0-20261001T020304Z\\.zip --deployment ${DEPLOYMENT}$`,
      ),
    );
    expect(order[1]).toMatch(/^npx convex deploy --typecheck enable --env-file /);
    expect(order.at(-1)).toBe('vercel --prod --yes');
    expect(c.state.stamp).toEqual({ release: '0.4.0', commit: COMMIT });
    expect(printed(c)).toContain('Release check: 0.3.0 to 0.4.0.');
    expect(printed(c)).toContain('  migrated agents-owner: 3 row(s) changed');
    expect(printed(c)).toContain(`Done: ${DEPLOYMENT} moved from v0.3.0 to v0.4.0.`);
    expect(printed(c)).toContain('vercel promote dpl_Before1');
    expect(printed(c)).toMatch(
      /npx convex import --replace-all --deployment brisk-heron-417 .*before-v0\.4\.0/,
    );
    expect(ran(c).some((line) => line.includes(`env set DAY0_CRONS_PAUSED`))).toBe(false);
    expect(writes(c).some((line) => line.startsWith('vercel env'))).toBe(false);
  });

  it('writes the export owner-readable only, with its checksum and row counts beside it', async (): Promise<void> => {
    const c = cloud();
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(0);
    const zip = join(c.privateDir, 'before-v0.4.0-20261001T020304Z.zip');
    expect(statSync(zip).mode & 0o777).toBe(0o600);
    // Exported inside a directory only its owner enters, then moved beside the others.
    expect(c.calls.find((call) => call.args[1] === 'export')?.args[4]).toMatch(
      /\/\.export-[^/]+\/before-v0\.4\.0-/,
    );
    expect(readdirSync(c.privateDir).filter((name) => name.startsWith('.export-'))).toEqual([]);
    expect(readFileSync(`${zip}.sha256`, 'utf8')).toMatch(
      /^[0-9a-f]{64} {2}before-v0\.4\.0-20261001T020304Z\.zip\n$/,
    );
    expect(
      readFileSync(join(c.privateDir, 'before-v0.4.0-20261001T020304Z.counts.txt'), 'utf8'),
    ).toBe('agents 2\ndeploymentVersions 1\nmigrations 19\nTOTAL 22 tables 3 stored_files 0\n');
    expect(statSync(`${zip}.sha256`).mode & 0o777).toBe(0o600);
  });

  it('after an attempt that stopped part way, rolls back to the export taken when it first ran', async (): Promise<void> => {
    const c = cloud({ stamp: { release: '0.4.0', commit: COMMIT } });
    const first = join(c.privateDir, 'before-v0.4.0-20261001T010000Z.zip');
    writeFileSync(first, 'the rows from before the upgrade');
    writeFileSync(`${first}.sha256`, `${'e'.repeat(64)}  before-v0.4.0-20261001T010000Z.zip\n`);
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(0);
    expect(printed(c)).toContain(
      `${first} (sha256 ${'e'.repeat(64)}) holds the rows from before the upgrade to v0.4.0, taken when that upgrade first ran.`,
    );
    expect(printed(c)).toContain(`Done: ${DEPLOYMENT} is at v0.4.0, pushed again.`);
  });

  it('says where an export it could not count was written, and pushes nothing', async (): Promise<void> => {
    const c = cloud({
      failing: [
        { match: 'unzip -Z1', status: 9, stderr: 'End-of-central-directory signature not found' },
      ],
    });
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(1);
    expect(printed(c)).toMatch(
      /error: nothing was pushed or deployed, because the export did not finish: .*before-v0\.4\.0-20261001T020304Z\.zip was written \(sha256 [0-9a-f]{64}\) and its rows could not be counted/,
    );
    expect(writes(c).filter((line) => !line.startsWith('npx convex export'))).toEqual([]);
  });

  it("pauses a real-mode deployment's jobs before the push and lifts them, pushing again, once read back", async (): Promise<void> => {
    const c = cloud({
      env: new Map([
        ['DAY0_OIDC_ISSUER', 'https://id.example.com'],
        ['DAY0_SURFACE_MODE', 'real'],
      ]),
    });
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(0);
    const order = writes(c);
    const paused = order.indexOf(
      `npx convex env set DAY0_CRONS_PAUSED upgrade to 0.4.0 at 2026-10-01T02:03:04Z --deployment ${DEPLOYMENT}`,
    );
    const firstPush = order.findIndex((line) => line.startsWith('npx convex deploy'));
    expect(paused).toBeGreaterThan(0);
    expect(paused).toBeLessThan(firstPush);
    expect(c.state.pushedWithEnv[0]?.get('DAY0_CRONS_PAUSED')).toBe(
      'upgrade to 0.4.0 at 2026-10-01T02:03:04Z',
    );
    expect(
      order.indexOf(`npx convex env remove DAY0_CRONS_PAUSED --deployment ${DEPLOYMENT}`),
    ).toBeGreaterThan(order.indexOf('vercel --prod --yes'));
    expect(c.state.pushedWithEnv).toHaveLength(2);
    expect(c.state.pushedWithEnv[1]?.has('DAY0_CRONS_PAUSED')).toBe(false);
    expect(c.state.env.has('DAY0_CRONS_PAUSED')).toBe(false);
  });

  it('leaves a pause set by hand, and lifts one an unfinished upgrade left', async (): Promise<void> => {
    const hand = cloud({
      env: new Map([
        ['CLERK_JWT_ISSUER_DOMAIN', 'https://e.clerk.accounts.dev'],
        ['DAY0_SURFACE_MODE', 'real'],
        ['DAY0_CRONS_PAUSED', 'paused by hand at 2026-09-30T00:00:00Z'],
      ]),
    });
    expect(await runCloudUpgrade(verb(hand, { verb: 'upgrade' }), hand.io)).toBe(0);
    expect(hand.state.env.get('DAY0_CRONS_PAUSED')).toBe('paused by hand at 2026-09-30T00:00:00Z');
    expect(writes(hand).some((line) => line.includes('DAY0_CRONS_PAUSED'))).toBe(false);

    const unfinished = cloud({
      env: new Map([
        ['CLERK_JWT_ISSUER_DOMAIN', 'https://e.clerk.accounts.dev'],
        ['DAY0_CRONS_PAUSED', 'upgrade to 0.3.0 at 2026-09-29T00:00:00Z'],
      ]),
    });
    expect(await runCloudUpgrade(verb(unfinished, { verb: 'upgrade' }), unfinished.io)).toBe(0);
    expect(unfinished.state.env.has('DAY0_CRONS_PAUSED')).toBe(false);
  });

  it('keeps its pause when it stops after its push, and sends the reader back to the upgrade', async (): Promise<void> => {
    const c = cloud({
      env: new Map([
        ['CLERK_JWT_ISSUER_DOMAIN', 'https://e.clerk.accounts.dev'],
        ['DAY0_SURFACE_MODE', 'real'],
      ]),
      failing: [{ match: 'migrations:runPending', status: 1, stderr: 'Server error' }],
    });
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(1);
    expect(c.state.env.get('DAY0_CRONS_PAUSED')).toMatch(/^upgrade to 0\.4\.0/);
    expect(printed(c)).toContain(
      `Run \`./setup.sh cloud upgrade --target ${c.target}\` again from this checkout: it resumes the migrations and lifts the pause when it completes.`,
    );
    expect(printed(c)).not.toContain('cloud unpause');
    expect(printed(c)).toContain('Rollback (nothing here is run for you):');
    expect(writes(c).some((line) => line.startsWith('vercel --prod'))).toBe(false);
  });

  it('takes its own pause off again when its push fails, since nothing changed', async (): Promise<void> => {
    const c = cloud({
      env: new Map([
        ['CLERK_JWT_ISSUER_DOMAIN', 'https://e.clerk.accounts.dev'],
        ['DAY0_SURFACE_MODE', 'real'],
      ]),
      failing: [
        {
          match: 'deploy --typecheck enable --env-file',
          status: 1,
          stderr: 'Schema validation failed',
        },
      ],
    });
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(1);
    expect(c.state.env.has('DAY0_CRONS_PAUSED')).toBe(false);
    expect(printed(c)).toContain(
      'Nothing was pushed, so the pause this run set on the scheduled jobs is lifted again',
    );
    expect(printed(c)).not.toContain('The scheduled jobs stay paused');
  });

  it.each<[string, Partial<Cloud['state']>, string]>([
    ['a release jump', { stamp: { release: '0.2.0', commit: 'x' } }, 'skips 0.3.0'],
    [
      'older functions over newer rows',
      { stamp: { release: '0.5.0', commit: 'x' } },
      'a release this checkout',
    ],
    [
      'a deployment nothing was pushed to',
      { tables: [], stamp: undefined },
      'its first push is `./setup.sh cloud setup',
    ],
    [
      'an app that talks to another deployment',
      { served: { id: 'dpl_OnDev', talksTo: DEV_DEPLOYMENT, release: '0.3.0' } },
      'so this is a move, not an upgrade',
    ],
    ['no unzip to count the export with', { missing: ['unzip'] }, '`unzip` does not answer'],
    [
      'a checkout linked to another Vercel project',
      { servedProject: 'day0-staging' },
      'is served by the Vercel project day0-staging',
    ],
  ])('refuses %s before anything is written', async (_label, state, words): Promise<void> => {
    const c = cloud(state);
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(1);
    expect(printed(c)).toContain('error: nothing was backed up, pushed or deployed, because');
    expect(printed(c)).toContain(words);
    expect(writes(c)).toEqual([]);
  });

  it("refuses without the app's address, which the read-back needs", async (): Promise<void> => {
    const c = cloud({}, { targetText: `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\n` });
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(1);
    expect(printed(c)).toContain("the app's production address is not named");
    expect(writes(c)).toEqual([]);
  });

  it('on a dry run reads the stamp, the env and the app, and exports nothing', async (): Promise<void> => {
    const c = cloud();
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade', dryRun: true }), c.io)).toBe(0);
    expect(writes(c)).toEqual([]);
    expect(ran(c)).toContain(
      `npx convex data deploymentVersions --limit 1 --format jsonl --deployment ${DEPLOYMENT}`,
    );
    expect(ran(c)).toContain(
      `curl -sS -L --max-time 30 -A Mozilla/5.0 (compatible; day0-setup-cloud read-back) -w \n%{http_code} ${APP_URL}/`,
    );
    expect(existsSync(join(c.privateDir, 'before-v0.4.0-20261001T020304Z.zip'))).toBe(false);
  });

  it('stops with the rollback when the new build is not what serves the address', async (): Promise<void> => {
    const c = cloud({
      failing: [
        { match: 'vercel --prod', status: 0, stderr: '', stdout: 'https://day0-x.vercel.app\n' },
      ],
    });
    expect(await runCloudUpgrade(verb(c, { verb: 'upgrade' }), c.io)).toBe(1);
    expect(printed(c)).toContain(
      'is served by dpl_Before1 (production, ready), not a new production build',
    );
    expect(printed(c)).toContain('vercel promote dpl_Before1');
  });
});

describe('cloud backup', (): void => {
  it('exports beside the target file, named by the deployment and the time', async (): Promise<void> => {
    const c = cloud();
    expect(await runCloudBackup(verb(c, { verb: 'backup' }), c.io)).toBe(0);
    expect(ran(c).findIndex((line) => line.includes('deploy --dry-run'))).toBeLessThan(
      ran(c).findIndex((line) => line.startsWith('npx convex export')),
    );
    const zip = join(c.privateDir, `${DEPLOYMENT}-20261001T020304Z.zip`);
    expect(statSync(zip).mode & 0o777).toBe(0o600);
    expect(existsSync(`${zip}.sha256`)).toBe(true);
    expect(printed(c)).toContain('22 rows in 3 tables, 0 stored files; mode 600');
  });

  it('takes a name and a directory, and writes over nothing', async (): Promise<void> => {
    const c = cloud();
    const to = join(c.privateDir, 'audits');
    expect(
      await runCloudBackup(
        verb(c, { verb: 'backup', backupTo: to, name: 'after-prod-v0.4.0' }),
        c.io,
      ),
    ).toBe(0);
    expect(statSync(to).mode & 0o777).toBe(0o700);
    expect(existsSync(join(to, 'after-prod-v0.4.0.zip'))).toBe(true);
    expect(
      await runCloudBackup(
        verb(c, { verb: 'backup', backupTo: to, name: 'after-prod-v0.4.0' }),
        c.io,
      ),
    ).toBe(1);
    expect(printed(c)).toContain('exists already; nothing is written over a backup.');
  });

  it('refuses a target the dry run does not name, before it exports anything', async (): Promise<void> => {
    const c = cloud({ defaultProd: 'other-prod-789' });
    expect(await runCloudBackup(verb(c, { verb: 'backup' }), c.io)).toBe(1);
    expect(printed(c)).toContain(
      'error: nothing was exported, because the dry run of the push did not name',
    );
    expect(writes(c)).toEqual([]);
  });

  it('refuses a directory inside the checkout', async (): Promise<void> => {
    const c = cloud();
    mkdirSync(join(c.checkout, 'exports'));
    expect(
      await runCloudBackup(
        verb(c, { verb: 'backup', backupTo: join(c.checkout, 'exports') }),
        c.io,
      ),
    ).toBe(1);
    expect(printed(c)).toContain('is inside this checkout');
    expect(writes(c)).toEqual([]);
  });
});

describe('cloud pause and unpause', (): void => {
  const stamped = { stamp: { release: '0.4.0', commit: COMMIT } };

  it('pause sets the value by hand and pushes the stamped release again so every module reads it', async (): Promise<void> => {
    const c = cloud(stamped);
    expect(await runCloudPause(verb(c, { verb: 'pause' }), c.io, 'pause')).toBe(0);
    expect(c.state.env.get('DAY0_CRONS_PAUSED')).toBe('paused by hand at 2026-10-01T02:03:04Z');
    expect(c.state.pushedWithEnv.at(-1)?.get('DAY0_CRONS_PAUSED')).toBe(
      'paused by hand at 2026-10-01T02:03:04Z',
    );
  });

  it('unpause removes it and pushes again; with nothing paused it changes nothing', async (): Promise<void> => {
    const c = cloud({
      ...stamped,
      env: new Map([
        ['CLERK_JWT_ISSUER_DOMAIN', 'https://e.clerk.accounts.dev'],
        ['DAY0_CRONS_PAUSED', 'x'],
      ]),
    });
    expect(await runCloudPause(verb(c, { verb: 'unpause' }), c.io, 'unpause')).toBe(0);
    expect(c.state.env.has('DAY0_CRONS_PAUSED')).toBe(false);
    expect(c.state.pushedWithEnv).toHaveLength(1);

    const idle = cloud(stamped);
    expect(await runCloudPause(verb(idle, { verb: 'unpause' }), idle.io, 'unpause')).toBe(0);
    expect(idle.output).toContain(
      `${DEPLOYMENT}'s scheduled jobs are not paused; nothing was changed.`,
    );
    expect(writes(idle)).toEqual([]);
  });

  it("refuses to lift another release's unfinished upgrade by pushing this one", async (): Promise<void> => {
    const c = cloud({
      stamp: { release: '0.4.0', commit: COMMIT },
      env: new Map([
        ['CLERK_JWT_ISSUER_DOMAIN', 'https://e.clerk.accounts.dev'],
        ['DAY0_CRONS_PAUSED', 'upgrade to 0.5.0 at 2026-10-01T00:00:00Z'],
      ]),
    });
    expect(await runCloudPause(verb(c, { verb: 'unpause' }), c.io, 'unpause')).toBe(1);
    expect(printed(c)).toContain('an upgrade to v0.5.0 did not finish');
    expect(writes(c)).toEqual([]);
  });

  it('refuses when the checkout is not the release the deployment is stamped at', async (): Promise<void> => {
    const c = cloud();
    expect(await runCloudPause(verb(c, { verb: 'pause' }), c.io, 'pause')).toBe(1);
    expect(printed(c)).toContain('is at v0.3.0 and this checkout is v0.4.0');
    expect(writes(c)).toEqual([]);
  });
});

describe('runCloudCommand', (): void => {
  it('asks for a verb when none is named', async (): Promise<void> => {
    const c = cloud();
    expect(await runCloudCommand(verb(c, {}), c.io)).toBe(2);
    expect(c.output).toContain(
      'error: name a verb: ./setup.sh cloud <setup|upgrade|backup|pause|unpause>.',
    );
  });
});
