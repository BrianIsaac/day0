import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SetupPage from '../../../app/setup/page';
import {
  DETAILED_SECTIONS,
  FIRST_SUCCESS,
  MEASURED_TIMINGS,
  MOCK_OFFICE_NOTE,
  MODEL_ROUTES,
  PREREQUISITES,
  QUICKSTART_COMMANDS,
  REAL_MODE_NOTE,
  REAL_MODE_VERBS,
  RUN_WAYS,
  RUN_WAY_VERBS_NOTE,
  TRAPS,
  WAY_NAMES,
} from '../../../src/setup/quickstart';

/**
 * `/setup` is the page a signed-out visitor lands on from the landing page's
 * second button, and it is the only instruction a newcomer may ever read. It
 * therefore has to be complete on its own, it has to say what was measured
 * rather than what would sound good, and it must collect nothing: no key, no
 * address, no form of any kind reaches this route.
 */
const html = renderToStaticMarkup(<SetupPage />);

/** The rendered text, with markup and entities out of the way. */
const text = html
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x27;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&rsquo;/g, '’')
  .replace(/&ndash;/g, '–')
  .replace(/\s+/g, ' ');

describe('the /setup guide', (): void => {
  it('starts by saying what runs, and that it runs here', (): void => {
    expect(text).toContain('your own machine');
    expect(text).toMatch(/mock office/i);
  });

  it('states the prerequisites, and the command that gets each one, before the commands', (): void => {
    for (const item of PREREQUISITES) {
      expect(text).toContain(item.name);
      if (item.fix) expect(text).toContain(item.fix);
    }
    expect(text.indexOf(PREREQUISITES[0].name)).toBeLessThan(text.indexOf('git clone'));
  });

  it('names the ports the installation publishes', (): void => {
    for (const port of ['3210', '3211', '6791', '3000', '11434']) expect(text).toContain(port);
  });

  it('names the three ways to run it, in order, each with its commands', (): void => {
    const titles = RUN_WAYS.map((way) => way.title);
    expect(titles).toEqual([WAY_NAMES.hosted, WAY_NAMES.cloud, WAY_NAMES.local]);
    expect(titles).toEqual(['Hosted demo', 'Local, cloud model', 'Local, local model']);
    const offsets = titles.map((title) => text.indexOf(title));
    expect(offsets.every((offset) => offset > 0)).toBe(true);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    // The section comes before the routes and the commands it names the flags of.
    expect(offsets[0]).toBeLessThan(text.indexOf(MODEL_ROUTES[0].title));

    const [hosted, cloud, local] = RUN_WAYS;
    for (const link of hosted.links ?? []) {
      expect(html).toContain(`href="${link.href}"`);
      expect(text).toContain(link.label);
    }
    expect(hosted.links?.map((link) => link.href)).toEqual(['/sign-in', '/demo']);
    expect(cloud.commands).toContain('./setup.sh --route featherless');
    expect(cloud.body).toContain('--route key');
    expect(cloud.body).toContain('--route endpoint');
    expect(local.commands).toContain('./setup.sh --route local');
    for (const way of [cloud, local]) {
      // Every command line, in its own block and in the order the file gives.
      const block = /<span[^>]*>(.*?)<\/span>/gs;
      const rendered = [...html.matchAll(block)].map((match) => match[1]);
      for (const command of way.commands ?? []) expect(rendered).toContain(command);
      expect(text).toContain(way.body);
      if (way.after) expect(text).toContain(way.after);
    }
    // Neither local way is sent to the mock entry.
    for (const way of [cloud, local]) {
      expect(`${way.body} ${way.after ?? ''} ${way.commands?.join(' ')}`).not.toContain('pnpm setup:local');
    }
  });

  it('says once, under the two local ways, that both are real mode, with the three verbs', (): void => {
    expect(text).toContain(REAL_MODE_NOTE);
    expect(REAL_MODE_NOTE).toContain('Both local ways are real mode');
    expect(REAL_MODE_NOTE).toContain('local only');
    expect(text.indexOf(REAL_MODE_NOTE)).toBeGreaterThan(text.indexOf(WAY_NAMES.local));
    for (const verb of REAL_MODE_VERBS) {
      expect(text).toContain(verb.command);
      expect(text).toContain(verb.what);
    }
    expect(REAL_MODE_VERBS.map((verb) => verb.command)).toEqual([
      './setup.sh stop',
      './setup.sh resume',
      './setup.sh clear',
    ]);
    expect(text).toContain(RUN_WAY_VERBS_NOTE);
    expect(text.indexOf('./setup.sh stop')).toBeLessThan(text.indexOf('./setup.sh resume'));
    expect(text.indexOf('./setup.sh resume')).toBeLessThan(text.indexOf('./setup.sh clear'));
  });

  it('keeps the mock office as a note under an evaluation heading, not a card', (): void => {
    expect(text).toContain(MOCK_OFFICE_NOTE.title);
    expect(text).toContain(MOCK_OFFICE_NOTE.body);
    expect(MOCK_OFFICE_NOTE.title).toBe('Evaluation and the mock office');
    expect(MOCK_OFFICE_NOTE.body).toContain('pnpm setup:local');
    expect(MOCK_OFFICE_NOTE.body).toContain('not as a way to run Day0');
    // A heading and a paragraph, after the verbs and before the model section.
    expect(html).toMatch(/<h3[^>]*id="mock-office"[^>]*>Evaluation and the mock office<\/h3>/);
    expect(text.indexOf(MOCK_OFFICE_NOTE.title)).toBeGreaterThan(text.indexOf(RUN_WAY_VERBS_NOTE));
    expect(text.indexOf(MOCK_OFFICE_NOTE.title)).toBeLessThan(text.indexOf(MODEL_ROUTES[0].title));
    // Nothing on the page names the old fourth way or the mock entry as a way to run it.
    expect(text).not.toContain('Four ways');
    expect(text).not.toMatch(/no account, and the model runs here/i);
  });

  it('offers the cloud model and the local model, with their flags', (): void => {
    for (const route of MODEL_ROUTES) {
      expect(text).toContain(route.title);
      expect(text).toContain(route.flag);
    }
  });

  it('prints the five commands in order', (): void => {
    const block = /<pre[^>]*><code[^>]*>(.*?)<\/code><\/pre>/s.exec(html)?.[1];
    expect(block).toBeDefined();
    const commands = [...block!.matchAll(/<span[^>]*>(.*?)<\/span>/gs)].map((match) => match[1]);
    expect(commands).toEqual(QUICKSTART_COMMANDS);
  });

  it('says what a first success looks like, step by step', (): void => {
    for (const step of FIRST_SUCCESS) {
      expect(text).toContain(step.action);
      expect(text).toContain(step.detail);
    }
  });

  it('shows one screenshot, from an asset this repository already publishes', (): void => {
    const image = /<img[^>]*>/.exec(html)?.[0] ?? '';
    expect(image).toContain('src="/setup/');
    expect(image).toMatch(/alt="[^"]{40,}"/);
    expect(image).toMatch(/width="\d+"/);
    expect(image).toMatch(/height="\d+"/);
  });

  it('hands the reader the checker when something is wrong', (): void => {
    expect(text).toContain('pnpm check:setup');
  });

  it('carries both traps the rehearsals found', (): void => {
    for (const trap of TRAPS) {
      expect(text).toContain(trap.title);
      expect(text).toContain(trap.body);
    }
  });

  it('says how to stop it, and where the data stays', (): void => {
    expect(text).toContain('./setup.sh stop');
    expect(text).toContain('./setup.sh clear');
    expect(text).toContain('pnpm sandbox:down && pnpm convex:down');
    expect(text).toContain('_convex_data');
    expect(text).toContain('_redactor_models');
  });

  it('quotes measured figures and labels what they exclude', (): void => {
    for (const timing of MEASURED_TIMINGS) {
      expect(text).toContain(timing.phase);
      expect(text).toContain(timing.measured);
      expect(text).toContain(timing.excludes);
    }
  });

  it('calls ten minutes a target rather than a promise', (): void => {
    expect(text).toMatch(/target/);
    expect(text).not.toMatch(/in (about )?ten minutes\b/i);
    expect(text).not.toMatch(/ten minutes or less/i);
  });

  it('links the detailed README sections, the demo and the source', (): void => {
    for (const section of DETAILED_SECTIONS) expect(html).toContain(`href="${section.href}"`);
    expect(html).toContain('href="/demo"');
    expect(html).toContain('>Source<');
  });

  it('collects nothing: no form, no field, no control at all', (): void => {
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<textarea');
  });

  it('never asks for a key on the page, and says where the key is asked for', (): void => {
    expect(text).not.toMatch(/paste (your|the) key (in|into) (this|the) (page|form|field)/i);
    expect(text).toMatch(/hidden prompt/i);
  });

  it('names no model a provider sells, as the landing page does not', (): void => {
    for (const name of ['GPT-5', 'gpt-5', 'Terra', 'GLM', 'Gemini', 'qwen']) {
      expect(text).not.toContain(name);
    }
  });

  it('is static prose: no client component, no session, no fetch', (): void => {
    const source = readFileSync(new URL('../../../app/setup/page.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('use client');
    expect(source).not.toContain('convex/react');
    expect(source).not.toContain('@clerk/nextjs');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('useEffect');
  });
});
