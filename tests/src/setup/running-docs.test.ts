import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { egressHosts } from '../../../scripts/check-setup';
import { PROFILES } from '../../../scripts/compose';
import { REAL_MODE_PROFILES } from '../../../scripts/setup';

/**
 * `docs/running/components.md` is what an operator reads to decide which
 * components to start and which ports they will publish. The compose file and
 * the real-mode setup are what actually start them, so the page is pinned to
 * both: a profile added to one, a port moved in the other, or a knob the
 * backend is now started with has to reach the page before the gate is green.
 */

const COMPONENTS = readFileSync(
  new URL('../../../docs/running/components.md', import.meta.url),
  'utf8',
);
const INTERFACES = readFileSync(
  new URL('../../../docs/running/interfaces.md', import.meta.url),
  'utf8',
);
const COMPOSE = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');

/** The host-port variables the compose file publishes, with their defaults. */
function publishedPorts(): Record<string, string> {
  const published: Record<string, string> = {};
  for (const [, name, fallback] of COMPOSE.matchAll(
    /\$\{(CONVEX_PORT|CONVEX_SITE_PROXY_PORT|CONVEX_DASHBOARD_PORT|MODEL_PORT|FAKE_SLACK_HOST_PORT):-(\d+)\}:/g,
  )) {
    published[name!] = fallback!;
  }
  return published;
}

/** A backend environment value the compose file sets, by name. */
function backendKnob(name: string): string {
  const found = new RegExp(`- ${name}=(\\S+)`).exec(COMPOSE);
  expect(found).not.toBeNull();
  return found![1]!;
}

describe('the components page', (): void => {
  it('names every profile the compose file defines, and no other', (): void => {
    for (const profile of Object.keys(PROFILES)) {
      expect(COMPONENTS).toContain(`\`${profile}\``);
    }
    for (const [, named] of COMPONENTS.matchAll(/--profile ([a-z-]+)/g)) {
      expect(Object.keys(PROFILES)).toContain(named!);
    }
  });

  it('says which profiles a real-mode setup starts for you', (): void => {
    for (const profile of REAL_MODE_PROFILES) {
      expect(COMPONENTS).toContain(`\`${profile}\``);
    }
    expect(COMPONENTS).toContain('./setup.sh');
  });

  it('lists every host port the compose file publishes, with its default', (): void => {
    const ports = publishedPorts();
    expect(Object.keys(ports).sort()).toEqual([
      'CONVEX_DASHBOARD_PORT',
      'CONVEX_PORT',
      'CONVEX_SITE_PROXY_PORT',
      'FAKE_SLACK_HOST_PORT',
      'MODEL_PORT',
    ]);
    for (const [name, fallback] of Object.entries(ports)) {
      expect(COMPONENTS).toContain(`\`${name}\``);
      expect(COMPONENTS).toContain(fallback);
    }
  });

  it('gives the scheduler knobs the backend is started with', (): void => {
    expect(COMPONENTS).toContain(
      `SCHEDULED_JOB_EXECUTION_PARALLELISM=${backendKnob('SCHEDULED_JOB_EXECUTION_PARALLELISM')}`,
    );
    expect(COMPONENTS).toContain(
      `APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=${backendKnob('APPLICATION_MAX_CONCURRENT_NODE_ACTIONS')}`,
    );
  });

  it('says how the redactor is warmed rather than downloaded', (): void => {
    expect(COMPONENTS).toContain('--warm-from');
  });
});

/** The `module:function` names in the interfaces page's entry-point table. */
function entryPoints(): Array<readonly [string, string]> {
  const from = INTERFACES.indexOf('The entry points a reader is most likely to want:');
  expect(from).toBeGreaterThan(0);
  const rows = INTERFACES.slice(from, INTERFACES.indexOf('\n## ', from))
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .join('\n');
  return [...rows.matchAll(/`([a-zA-Z]+):([a-zA-Z]+)`/g)].map(
    ([, module, name]) => [module!, name!] as const,
  );
}

describe('the interfaces page', (): void => {
  it('names only entry points the backend still exports', (): void => {
    const named = entryPoints();
    expect(named.length).toBeGreaterThan(10);
    const missing = named.filter(([module, name]) => {
      const path = new URL(`../../../convex/${module}.ts`, import.meta.url);
      if (!existsSync(path)) return true;
      return !new RegExp(`export const ${name}\\b`).test(readFileSync(path, 'utf8'));
    });
    expect(missing.map((entry) => entry.join(':'))).toEqual([]);
  });

  it('names in its prose only functions the backend still exports', (): void => {
    const referenced = [...INTERFACES.matchAll(/`([a-zA-Z]+):([a-zA-Z]+)`/g)]
      .map(([, module, name]) => [module!, name!] as const)
      // A scope such as `docs:read` has the same shape; only a Convex module's names are checked.
      .filter(([module]) => existsSync(new URL(`../../../convex/${module}.ts`, import.meta.url)));
    expect(referenced.length).toBeGreaterThan(10);
    const missing = referenced.filter(([module, name]) => {
      const source = readFileSync(new URL(`../../../convex/${module}.ts`, import.meta.url), 'utf8');
      return !new RegExp(`export const ${name}\\b`).test(source);
    });
    expect(missing.map((entry) => entry.join(':'))).toEqual([]);
  });

  it("says a card takes the manager's one approval and the export returns its trace a page at a time", (): void => {
    // Q10: the IT approval and `surfaces.approve`'s role argument are gone.
    expect(INTERFACES).not.toMatch(/two approvals|by `role`/);
    expect(INTERFACES).toContain("`surfaces:approve` | mutation | The manager's one approval");
    // m24: the action returns the head; the whole trace is `pnpm export:trace`.
    expect(INTERFACES).toContain('pnpm export:trace');
    expect(INTERFACES).not.toMatch(/exportForAgent` returns the agent, its events/);
    const scripts = (
      JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['export:trace']).toBe('tsx scripts/export-trace.ts');
  });

  it('names the owner export where a newcomer and a contributor read, in both languages of the README', (): void => {
    // 16-F's `--owner` was in the interfaces page only: the README's recompute step and the
    // contributing guide's commands named the one-employee export alone.
    const read = (name: string): string =>
      readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
    const command = 'pnpm export:trace --owner --out';
    expect(read('README.md').split(command).length - 1).toBe(2);
    expect(read('CONTRIBUTING.md')).toContain(`\`${command} <file>\``);
    expect(INTERFACES).toContain('`pnpm export:trace --owner`');
  });
});

/**
 * The three pages wave 17 added for a customer's IT (17-P): the reverse proxy, the way out and the
 * upgrade with its way back. The checks and the setup send a reader to them by name and by
 * section, so a page renamed, a heading reworded or a host added to the list has to reach the
 * page before the gate is green.
 */
describe('the pages the checks send a reader to', (): void => {
  const ROOT = new URL('../../../', import.meta.url);
  const read = (file: string): string => readFileSync(new URL(file, ROOT), 'utf8');
  /** Everything that prints a page's name to a person. */
  const SOURCES = [
    ...readdirSync(new URL('scripts/', ROOT))
      .filter((name) => /\.(ts|sh)$/.test(name))
      .map((name) => `scripts/${name}`),
    ...readdirSync(new URL('scripts/lib/', ROOT)).map((name) => `scripts/lib/${name}`),
    'docker-compose.yml',
    'docker/proxy.bed.yml',
    '.env.example',
    'next.config.mjs',
  ];
  const TEXT = SOURCES.map(read).join('\n');

  it('exist, each one a source names', (): void => {
    const named = [
      ...new Set([...TEXT.matchAll(/docs\/running\/([a-z-]+\.md)/g)].map(([, n]) => n!)),
    ];
    expect(named).toEqual(
      expect.arrayContaining(['proxy.md', 'egress.md', 'upgrade-and-rollback.md']),
    );
    expect(named.filter((name) => !existsSync(new URL(`docs/running/${name}`, ROOT)))).toEqual([]);
  });

  it('carry every section of the proxy page a check names', (): void => {
    const sections = [
      ...new Set(
        [
          ...TEXT.replace(/'\s*\+\s*'/g, '').matchAll(
            /docs\/running\/proxy\.md, \\?["']([^"'\\]+)/g,
          ),
        ].map(([, section]) => section!),
      ),
    ];
    expect(sections.sort()).toEqual(['The app', 'The backend', 'The certificate']);
    const page = read('docs/running/proxy.md');
    for (const section of sections) expect(page).toContain(`\n## ${section}\n`);
  });

  it('list on the egress page every host the check can print', (): void => {
    const page = read('docs/running/egress.md');
    const everything = {
      DAY0_SURFACE_MODE: 'real',
      OPENAI_API_KEY: 'k',
      ELEVENLABS_API_KEY: 'k',
      DAYTONA_API_KEY: 'k',
    };
    const bundled = {
      DAY0_SURFACE_MODE: 'real',
      CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
    };
    const hosts = new Set(
      [
        ...egressHosts(everything, [], 'x64'),
        ...egressHosts(everything, [], 'arm64'),
        ...egressHosts(bundled, [], 'x64'),
      ].map((row) => row.host),
    );
    expect(hosts.size).toBeGreaterThan(30);
    expect([...hosts].filter((host) => !page.includes(`\`${host}\``))).toEqual([]);
    // What is not given the proxy is said beside its host, so a reader of the table alone knows.
    // Re-taken (wave 18, 17-P's F6): the Notion component and the model service take it now; a
    // listed git host still dials directly.
    const row = (host: string): string =>
      page.split('\n').find((line) => line.startsWith(`| \`${host}\``)) ?? '';
    for (const host of ['api.notion.com', 'registry.npmjs.org', 'registry.ollama.ai']) {
      expect(row(host), host).not.toBe('');
      expect(row(host), host).not.toContain('directly');
    }
    expect(row('github.com')).toContain('a listed host directly');
  });

  it('give on the upgrade page the way back as the upgrade prints it', (): void => {
    const page = read('docs/running/upgrade-and-rollback.md');
    expect(read('scripts/setup.ts')).toContain("'Never start the old image over this volume.'");
    expect(page).toContain('Never start the old image over this volume.');
    expect(page).toMatch(
      /\.\/setup\.sh restore \S+ from a checkout of v\d+\.\d+\.\d+ \(commit [0-9a-f]{12}\)\./,
    );
  });
});

describe('the runbook and the components page, on the two proxies (wave 17, 17-P)', (): void => {
  const RUNBOOK = readFileSync(
    new URL('../../../docs/running/install.md', import.meta.url),
    'utf8',
  );

  it('asks IT about both before the day, and links the three pages', (): void => {
    const before = RUNBOOK.slice(
      RUNBOOK.indexOf('## Before the day'),
      RUNBOOK.indexOf('## On the day'),
    );
    expect(before).toContain('](proxy.md)');
    expect(before).toContain('**The way out.**');
    expect(before).toContain('](egress.md)');
    expect(RUNBOOK).toContain('](upgrade-and-rollback.md)');
  });

  it('gives the install’s proxy check as a step of its own, by the words of its two gaps', (): void => {
    expect(RUNBOOK).toContain('**The reverse proxy**');
    expect(RUNBOOK).toContain('"answered, and not as Day0"');
    expect(RUNBOOK).toContain('"did not complete the WebSocket upgrade"');
  });

  it('says which components the compose file hands the proxy, and which reach out without it', (): void => {
    const services = (
      parse(COMPOSE) as { services: Record<string, { environment?: readonly string[] }> }
    ).services;
    const handed = Object.entries(services)
      .filter(([, service]) =>
        (service.environment ?? []).some((entry) => entry.startsWith('HTTPS_PROXY=')),
      )
      .map(([name]) => name);
    // Re-taken (wave 18, 17-P's F6): the Notion component, the browser and the bundled model
    // service's pulls, which reached out without it until 0.22.0, are handed it too.
    expect(handed.sort()).toEqual([
      'backend',
      'docs-notion-mcp',
      'model',
      'nango-server',
      'playwright-mcp',
      'redactor',
      'slack-socket',
    ]);
    const from = COMPONENTS.indexOf('## Which components reach out');
    expect(from).toBeGreaterThan(0);
    const section = COMPONENTS.slice(from, COMPONENTS.indexOf('\n---', from));
    for (const name of handed) expect(section).toContain(`\`${name}\``);
    expect(section).toContain('hands it\nto all seven');
    expect(section).not.toContain('not handed it');
    expect(section).toContain('](egress.md)');
  });
});

// W17-R25 and W17-R26 (reader 5; the review's bed 3): a proxy exported in a corporate shell
// profile and absent from `.env.local` reaches the backend while `pnpm sync:env` clears the
// deployment's NO_PROXY, and `pnpm convex:restart` after a changed NO_PROXY keeps the containers'
// own list, since a compose restart keeps the environment a container was created with.
describe('the way out’s page and the runbook, on where the proxy is named (W17-R25, W17-R26)', (): void => {
  // The pages' prose wraps at any space, so each is read with its runs of white space as one.
  const EGRESS = readFileSync(
    new URL('../../../docs/running/egress.md', import.meta.url),
    'utf8',
  ).replace(/\s+/g, ' ');
  const RUNBOOK = readFileSync(
    new URL('../../../docs/running/install.md', import.meta.url),
    'utf8',
  ).replace(/\s+/g, ' ');

  it('names ./setup.sh resume after a changed NO_PROXY, and never pnpm convex:restart', (): void => {
    expect(EGRESS).not.toContain('convex:restart');
    expect(EGRESS).toContain('After you change `NO_PROXY` in `.env.local`: `./setup.sh resume`');
  });

  // Re-taken (wave 18, D-9 (a)): the shell's proxy is no longer read by Day0, so the page says what
  // Day0 does with one and keeps the unset for pnpm itself, Node's switch among the names.
  it('says the proxy is named in .env.local and nowhere else, that the shell’s is not read, and to name it once the containers reach it', (): void => {
    expect(EGRESS).toContain('Name the proxy in `.env.local` and nowhere else');
    expect(EGRESS).toContain('since 0.22.0 Day0 reads it from there alone');
    expect(EGRESS).toContain('reaches no process Day0 starts, no container and not the deployment');
    expect(EGRESS).toContain(
      '`unset HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_USE_ENV_PROXY https_proxy http_proxy no_proxy`',
    );
    expect(EGRESS).toContain('The backend container has no route to');
  });

  // W17-R27 and 17-P's F6 on the 18-P bed: NO_PROXY as Node reads it, and nothing left saying the
  // Notion component, the browser or a GitHub source dials past the proxy.
  it('reads NO_PROXY as Node does, and names what the beds found takes the proxy and what does not', (): void => {
    expect(EGRESS).toContain('list both (`acme.com,.acme.com`)');
    expect(EGRESS).toContain('an address range (`10.0.0.0/8`) is not read at all');
    expect(EGRESS).not.toContain('not established');
    expect(EGRESS).not.toContain('Neither is handed the proxy');
    expect(EGRESS).toContain('**Nango’s token requests.**'.replace('’', "'"));
    expect(EGRESS).toContain('`http://user:password@proxy.acme.com:3128`');
  });

  it('asks IT before the day for the proxy’s address in the form the file takes', (): void => {
    const before = RUNBOOK.slice(
      RUNBOOK.indexOf('## Before the day'),
      RUNBOOK.indexOf('## On the day'),
    );
    expect(before).toContain('`http://<host>:<port>`');
    expect(before).toContain('reachable from the machine’s containers');
  });
});

// W17-R14 (reader 3): a page with no block is never kept by its listed revision
// (`docPages.ts`'s `firstBlockStatus === undefined`), so its text is asked for at every sync, where
// the three guides said an unchanged read asks for no page's text. W17-R23 with D-5 (b): the
// agreements' check stops past fifty employees, and the README says so.
describe('the readers’ guides on a page with no text, and the README on fifty employees (W17-R14, W17-R23)', (): void => {
  const flat = (path: string): string =>
    readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

  it.each([
    [
      'docs/running/reader-confluence.md',
      'a parent page that holds only a children or include macro',
    ],
    ['docs/running/reader-sharepoint.md', 'a site page of image web parts alone'],
    ['docs/running/reader-drive.md', 'a document that holds a title and images alone'],
  ])(
    '%s says a page with no text under its title is asked for at every read',
    (path, example): void => {
      const page = flat(path);
      expect(page).toContain('Another: a page with no text under its title');
      expect(page).toContain(example);
      expect(page).toContain('is asked for at every read');
    },
  );

  it('says in the README that a company-wide agreement is checked only while the owner has fifty employees or fewer', (): void => {
    const readme = flat('README.md');
    expect(readme).toContain('### Fifty employees or fewer');
    expect(readme).toContain(
      "a company-wide working agreement is checked against each employee's charter only while you have fifty employees or fewer",
    );
    expect(readme).toContain('五十名或更少');
  });
});
