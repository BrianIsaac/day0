import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DETAILED_SECTIONS,
  FIRST_SUCCESS,
  MEASURED_TIMINGS,
  MODEL_ROUTES,
  PREREQUISITES,
  PUBLISHED_PORTS,
  QUICKSTART_BLOCK,
  QUICKSTART_COMMANDS,
  REPOSITORY_URL,
  SETUP_PAGE_URL,
  TIMING_CAVEAT,
  TRAPS,
} from '../../../src/setup/quickstart';
import { firstSuccessLines } from '../../../scripts/setup';

/**
 * The commands a newcomer types exist once, here, because they are printed in
 * three places that cannot see each other: the `/setup` page, the English
 * README and the Chinese one. A command that drifts in one of them sends a
 * reader somewhere the other two do not go, and nothing about a markdown file
 * would notice. These tests are what notices.
 */

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

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
      'pnpm setup:local',
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

describe('the two routes to a model', (): void => {
  it('offer the key route first and the account-free route second', (): void => {
    expect(MODEL_ROUTES.map((route) => route.id)).toEqual(['key', 'local']);
  });

  it('say what each costs the reader', (): void => {
    for (const route of MODEL_ROUTES) {
      expect(route.needs.length).toBeGreaterThan(10);
      expect(route.gives.length).toBeGreaterThan(10);
      expect(route.flag).toMatch(/^pnpm setup:local --route (key|local)$/);
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
  it('is the four steps, ending at the approval that fills the queue', (): void => {
    expect(FIRST_SUCCESS).toHaveLength(4);
    expect(FIRST_SUCCESS[3].detail).toContain('work queue');
  });

  it('is what the terminal prints too, so the page and the command agree', (): void => {
    const url = 'http://localhost:3000/?day0_key=example';
    // The terminal wraps to its own width; collapsing puts the sentences back
    // together, which is the thing that has to match rather than the layout.
    const printed = firstSuccessLines(url).join(' ').replace(/\s+/g, ' ');
    expect(printed).toContain(url);
    FIRST_SUCCESS.forEach((step, index): void => {
      if (index > 0) expect(printed).toContain(step.action);
      expect(printed).toContain(step.detail);
    });
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

  it('each hand the reader something to do about it', (): void => {
    for (const trap of TRAPS) expect(trap.body).toContain('pnpm ');
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
