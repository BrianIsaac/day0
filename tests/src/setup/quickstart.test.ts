import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DETAILED_SECTIONS,
  FIRST_SUCCESS,
  MEASURED_TIMINGS,
  MOCK_FIRST_SUCCESS,
  MOCK_OFFICE_NOTE,
  MODEL_ROUTES,
  PREREQUISITES,
  PUBLISHED_PORTS,
  QUICKSTART_BLOCK,
  QUICKSTART_COMMANDS,
  REAL_MODE_NOTE,
  REAL_MODE_VERBS,
  REPOSITORY_URL,
  RUN_WAYS,
  SETUP_PAGE_URL,
  SETUP_SCRIPT,
  TIMING_CAVEAT,
  TRAPS,
  WAY_NAMES,
  wayOfSetup,
} from '../../../src/setup/quickstart';
import { firstSuccessLines, parseSetupArguments } from '../../../scripts/setup';

/**
 * The commands a newcomer types exist once, here, because they are printed in
 * three places that cannot see each other: the `/setup` page, the English
 * README and the Chinese one. A command that drifts in one of them sends a
 * reader somewhere the other two do not go, and nothing about a markdown file
 * would notice. These tests are what notices.
 */

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

/** The scripts `pnpm <name>` can run, by name. */
const PACKAGE_SCRIPTS: Record<string, string> = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The repository root, where `./setup.sh` has to be. */
const ROOT = new URL('../../../', import.meta.url);

/** Where the Chinese half of the README starts. */
const CHINESE_HEADING = '\n## 中文说明\n';

/** Every index in `text` at which `needle` appears. */
function offsetsOf(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

describe('the quick-start commands', (): void => {
  it('are the five the setup guide promises, in order', (): void => {
    expect([...QUICKSTART_COMMANDS]).toEqual([
      'git clone https://github.com/BrianIsaac/day0.git',
      'cd day0',
      'pnpm install --frozen-lockfile',
      './setup.sh',
      'pnpm dev',
    ]);
  });

  it('clone the repository this page links as its source', (): void => {
    expect(QUICKSTART_COMMANDS[0]).toContain(REPOSITORY_URL);
    expect(SETUP_PAGE_URL.endsWith('/setup')).toBe(true);
  });

  it('render as one fenced bash block, which is what a README carries', (): void => {
    expect(QUICKSTART_BLOCK).toBe(['```bash', ...QUICKSTART_COMMANDS, '```'].join('\n'));
  });

  it('install with the frozen lockfile, so a stranger gets the tested tree', (): void => {
    expect(QUICKSTART_COMMANDS).toContain('pnpm install --frozen-lockfile');
  });
});

describe('the README quick starts', (): void => {
  const chineseAt = README.indexOf(CHINESE_HEADING);
  const blockOffsets = offsetsOf(README, QUICKSTART_BLOCK);

  it('has a Chinese half to be checked against', (): void => {
    expect(chineseAt).toBeGreaterThan(0);
  });

  it('carries the shared block exactly twice, once per language', (): void => {
    expect(blockOffsets).toHaveLength(2);
    expect(blockOffsets[0]).toBeLessThan(chineseAt);
    expect(blockOffsets[1]).toBeGreaterThan(chineseAt);
  });

  it('puts both quick starts near the top of their own language', (): void => {
    const english = README.indexOf('\n## What is unusual about it\n');
    const chinese = README.indexOf('\n### 它的特别之处\n');
    expect(blockOffsets[0]).toBeLessThan(english);
    expect(blockOffsets[1]).toBeLessThan(chinese);
    expect(README.indexOf('\n## Quick start\n')).toBeLessThan(english);
    expect(README.indexOf('\n### 快速开始\n')).toBeGreaterThan(chineseAt);
    expect(README.indexOf('\n### 快速开始\n')).toBeLessThan(chinese);
  });

  it('is reachable from both tables of contents', (): void => {
    expect(README).toContain('[Quick start](#quick-start)');
    expect(README).toContain('[快速开始](#快速开始)');
  });

  it('states the tool prerequisites beside the commands, in both languages', (): void => {
    const english = README.slice(README.indexOf('\n## Quick start\n'), blockOffsets[0]);
    const chinese = README.slice(README.indexOf('\n### 快速开始\n'), blockOffsets[1]);
    for (const tool of ['Node 22+', 'pnpm 9+', 'Compose v2']) {
      expect(english).toContain(tool);
      expect(chinese).toContain(tool);
    }
  });

  it('sends a reader on to the page and to the hand-run sections', (): void => {
    expect(README).toContain(SETUP_PAGE_URL);
    const quickStart = README.slice(README.indexOf('\n## Quick start\n'), blockOffsets[0] + 2000);
    expect(quickStart).toContain('#local-dev');
  });
});

describe('the three ways to run it', (): void => {
  it('are hosted, then local with a cloud model, then local with a local model, by the deck\'s names', (): void => {
    expect(RUN_WAYS.map((way) => way.id)).toEqual(['hosted', 'cloud', 'local']);
    expect(RUN_WAYS.map((way) => way.title)).toEqual([
      'Hosted demo',
      'Local, cloud model',
      'Local, local model',
    ]);
    expect(Object.values(WAY_NAMES)).toEqual(RUN_WAYS.map((way) => way.title));
  });

  it('go to pages this app serves, or type commands this repository ships', (): void => {
    const [hosted, ...local] = RUN_WAYS;
    expect(hosted.commands).toBeUndefined();
    expect(hosted.links?.map((link) => link.href)).toEqual(['/sign-in', '/demo']);
    for (const way of local) {
      expect(way.links).toBeUndefined();
      expect(way.commands?.slice(0, 3)).toEqual(QUICKSTART_COMMANDS.slice(0, 3));
      expect(way.commands?.at(-1)).toBe('pnpm dev');
    }
  });

  it('name only commands that exist: a package script by name, or a file at the root', (): void => {
    const commands = [
      ...RUN_WAYS.flatMap((way) => way.commands ?? []),
      ...REAL_MODE_VERBS.map((verb) => verb.command),
      ...QUICKSTART_COMMANDS,
    ];
    expect(commands.length).toBeGreaterThan(10);
    for (const command of commands) {
      const [program, ...rest] = command.split(' ');
      if (program === 'git' || program === 'cd') continue;
      if (program === 'pnpm') {
        // `pnpm install` is pnpm's own; everything else is a script by name.
        const script = rest[0] === 'run' ? rest[1] : rest[0];
        if (script !== 'install') expect(Object.keys(PACKAGE_SCRIPTS), command).toContain(script);
        continue;
      }
      expect(program, command).toBe(SETUP_SCRIPT);
      const stat = statSync(new URL(program, ROOT));
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o111, `${program} is executable`).not.toBe(0);
    }
  });

  it('are real mode on both local ways, through the one entry, and never the mock one', (): void => {
    const [, cloud, local] = RUN_WAYS;
    // `./setup.sh <args>` is `pnpm setup:local --mode real <args>`.
    for (const way of [cloud, local]) {
      const args = way.commands!.find((c) => c.startsWith(SETUP_SCRIPT))!.split(' ').slice(1);
      expect(parseSetupArguments(['--mode', 'real', ...args]).mode).toBe('real');
      expect(JSON.stringify(way)).not.toContain('pnpm setup:local');
    }
    expect(parseSetupArguments(['--mode', 'real', '--route', 'featherless']).route).toBe('featherless');
    expect(parseSetupArguments(['--mode', 'real', '--route', 'local']).route).toBe('local');
    for (const verb of REAL_MODE_VERBS) {
      const word = verb.command.split(' ')[1];
      expect(parseSetupArguments(['--mode', 'real', word]).command).toBe(word);
    }
    for (const flag of ['--route key', '--route endpoint', 'FEATHERLESS_API_KEY']) {
      expect(cloud.body).toContain(flag);
    }
    for (const flag of ['--model <id>', '--yes', '--model-port']) {
      expect(`${local.body} ${local.after}`).toContain(flag);
    }
    expect(REAL_MODE_NOTE).toContain('--warm-from <project>');
    for (const flag of ['--purge-env', '--yes']) {
      expect(REAL_MODE_VERBS.map((verb) => verb.what).join(' ')).toContain(flag);
    }
    expect(parseSetupArguments(['--mode', 'real', 'clear', '--purge-env', '--yes'])).toMatchObject({
      command: 'clear',
      purgeEnv: true,
      assumeYes: true,
    });
  });

  it('are the commands the README gives for the same ways, in both halves', (): void => {
    const [, cloud, local] = RUN_WAYS;
    const chineseAt = README.indexOf(CHINESE_HEADING);
    for (const command of [cloud.commands![3], local.commands![3], ...REAL_MODE_VERBS.map((v) => v.command)]) {
      const offsets = offsetsOf(README, command);
      expect(offsets.length, command).toBeGreaterThanOrEqual(2);
      expect(offsets[0]).toBeLessThan(chineseAt);
      expect(offsets.at(-1)).toBeGreaterThan(chineseAt);
    }
    for (const name of Object.values(WAY_NAMES)) {
      expect(README, name).toContain(`## ${name}`);
    }
    expect(README).toContain('\n### 托管演示\n');
    expect(README).toContain('\n### 本地运行，云端模型\n');
    expect(README).toContain('\n### 本地运行，本地模型\n');
  });

  it('keep the mock office as what the harness and the hosted demo run on, with its own README section', (): void => {
    expect(MOCK_OFFICE_NOTE.body).toContain('pnpm setup:local');
    expect(MOCK_OFFICE_NOTE.body).toContain('evaluation harness');
    expect(README).toContain('\n## Evaluation and the mock office\n');
    expect(README).toContain('\n### 评测与 mock office\n');
    const chineseAt = README.indexOf(CHINESE_HEADING);
    // The mock command appears with the evaluation material, never in a run section.
    const mockCommand = offsetsOf(README, 'pnpm setup:local --route local');
    expect(mockCommand.length).toBeGreaterThanOrEqual(2);
    expect(mockCommand[0]).toBeGreaterThan(README.indexOf('\n## Evaluation quick start\n'));
    expect(mockCommand.at(-1)).toBeGreaterThan(README.indexOf('\n### 评测快速开始\n'));
    expect(mockCommand.at(-1)).toBeGreaterThan(chineseAt);
  });

  it('name the way the checker reports for a mode and a route', (): void => {
    expect(wayOfSetup('real', 'featherless')).toBe(WAY_NAMES.cloud);
    expect(wayOfSetup('real', 'key')).toBe(WAY_NAMES.cloud);
    expect(wayOfSetup('real', 'endpoint')).toBe(WAY_NAMES.cloud);
    expect(wayOfSetup('real', 'local')).toBe(WAY_NAMES.local);
    expect(wayOfSetup('real', 'none')).toBeUndefined();
    expect(wayOfSetup('mock', 'local')).toContain('evaluation harness');
    expect(wayOfSetup('nonsense', 'local')).toBeUndefined();
  });

  it('never name the model a provider sells, as the routes do not', (): void => {
    const prose = JSON.stringify([RUN_WAYS, REAL_MODE_NOTE, MOCK_OFFICE_NOTE]);
    for (const name of ['GPT-5', 'gpt-5', 'Terra', 'GLM', 'Gemini', 'qwen']) {
      expect(prose).not.toContain(name);
    }
  });
});

describe('the prerequisites the page states', (): void => {
  it('name the two runtimes and the container tooling', (): void => {
    const names = PREREQUISITES.map((item) => item.name);
    expect(names).toEqual(['Node 22 or newer', 'pnpm 9 or newer', 'Docker, with Compose v2']);
  });

  it('each say what the helper does about them', (): void => {
    for (const item of PREREQUISITES) expect(item.detail.length).toBeGreaterThan(20);
  });

  it('offer a command where one line gets the tool', (): void => {
    const fixes = PREREQUISITES.map((item) => item.fix).filter(Boolean);
    expect(fixes.length).toBeGreaterThanOrEqual(2);
    for (const fix of fixes) expect(fix).toMatch(/^(nvm|corepack|docker) /);
  });

  it('list the host ports the installation publishes', (): void => {
    expect(PUBLISHED_PORTS.map((port) => port.port)).toEqual([3210, 3211, 6791, 3000, 11434]);
    for (const port of PUBLISHED_PORTS) expect(port.what.length).toBeGreaterThan(10);
  });
});

describe('the two places a model runs', (): void => {
  it('offer the cloud model first and the local model second, through the real-mode entry', (): void => {
    expect(MODEL_ROUTES.map((route) => route.id)).toEqual(['cloud', 'local']);
    expect(MODEL_ROUTES.map((route) => route.flag)).toEqual([
      './setup.sh --route featherless',
      './setup.sh --route local',
    ]);
  });

  it('say what each costs the reader', (): void => {
    for (const route of MODEL_ROUTES) {
      expect(route.needs.length).toBeGreaterThan(10);
      expect(route.gives.length).toBeGreaterThan(10);
      expect(route.flag).toMatch(/^\.\/setup\.sh --route (featherless|local)$/);
    }
  });

  it('never names the model a provider sells, which is not this product', (): void => {
    const prose = JSON.stringify(MODEL_ROUTES);
    for (const name of ['GPT-5', 'gpt-5', 'Terra', 'GLM', 'Gemini', 'qwen']) {
      expect(prose).not.toContain(name);
    }
  });
});

describe('what first success looks like', (): void => {
  it('is real mode\'s four steps: unlock, link the documentation, the charter, the connection cards', (): void => {
    expect(FIRST_SUCCESS).toHaveLength(4);
    expect(FIRST_SUCCESS[1].action).toContain('Link your documentation first');
    expect(FIRST_SUCCESS[2].action).toContain('approve the charter');
    expect(FIRST_SUCCESS[2].detail).toContain('work queue');
    expect(FIRST_SUCCESS[3].action).toContain('connection cards');
  });

  it('is what the terminal prints in real mode, so the page and the command agree', (): void => {
    const url = 'http://localhost:3000/?day0_key=example';
    // The terminal wraps to its own width; collapsing puts the sentences back
    // together, which is the thing that has to match rather than the layout.
    const printed = firstSuccessLines(url, 'real').join(' ').replace(/\s+/g, ' ');
    expect(printed).toContain(url);
    FIRST_SUCCESS.forEach((step, index): void => {
      if (index > 0) expect(printed).toContain(step.action);
      expect(printed).toContain(step.detail);
    });
  });

  it('keeps the mock office\'s own four for the mock entry, seeded and synthetic', (): void => {
    expect(MOCK_FIRST_SUCCESS).toHaveLength(4);
    expect(MOCK_FIRST_SUCCESS[0]).toBe(FIRST_SUCCESS[0]);
    expect(MOCK_FIRST_SUCCESS[1].detail).toContain('seeded and synthetic');
    expect(MOCK_FIRST_SUCCESS[3].detail).toContain('work queue');
    const printed = firstSuccessLines(undefined).join(' ').replace(/\s+/g, ' ');
    for (const step of MOCK_FIRST_SUCCESS) expect(printed).toContain(step.detail);
    expect(printed).not.toContain(FIRST_SUCCESS[1].action);
  });

  it('warns that the bare address is refused, which is the boundary working', (): void => {
    expect(JSON.stringify(FIRST_SUCCESS)).toContain('403');
  });
});

describe('the traps', (): void => {
  it('cover the rewritten public URLs and the generated admin key', (): void => {
    const prose = TRAPS.map((trap) => `${trap.title} ${trap.body}`).join('\n');
    expect(prose).toContain('NEXT_PUBLIC_CONVEX_URL');
    expect(prose).toContain('container');
    expect(prose).toContain('CONVEX_SELF_HOSTED_ADMIN_KEY');
  });

  it('each hand the reader something to do about it, through the real-mode entry', (): void => {
    for (const trap of TRAPS) expect(trap.body).toMatch(/pnpm |\.\/setup\.sh/);
    expect(TRAPS.map((trap) => trap.body).join(' ')).not.toContain('pnpm setup:local');
  });
});

describe('the measured figures', (): void => {
  it('each say what they exclude, because none of them includes a download', (): void => {
    expect(MEASURED_TIMINGS.length).toBeGreaterThanOrEqual(4);
    for (const timing of MEASURED_TIMINGS) {
      expect(timing.measured).toMatch(/\d/);
      expect(timing.excludes.length).toBeGreaterThan(20);
    }
  });

  it('call ten minutes a target rather than a promise', (): void => {
    expect(TIMING_CAVEAT).toContain('target');
    expect(TIMING_CAVEAT).not.toMatch(/in (about )?ten minutes\b/i);
    expect(TIMING_CAVEAT).toContain('MB');
  });
});

describe('the detailed sections', (): void => {
  it('are README anchors, not invented pages', (): void => {
    expect(DETAILED_SECTIONS.length).toBeGreaterThanOrEqual(4);
    for (const section of DETAILED_SECTIONS) {
      expect(section.href.startsWith(`${REPOSITORY_URL}#`)).toBe(true);
      const anchor = section.href.slice(section.href.indexOf('#'));
      expect(README).toContain(`](${anchor})`);
    }
  });
});
