import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SetupPage from '../../../app/setup/page';
import {
  DETAILED_SECTIONS,
  FIRST_SUCCESS,
  MEASURED_TIMINGS,
  MODEL_ROUTES,
  PREREQUISITES,
  QUICKSTART_COMMANDS,
  TRAPS,
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

  it('states the prerequisites before the commands', (): void => {
    for (const item of PREREQUISITES) expect(text).toContain(item.name);
    expect(text.indexOf(PREREQUISITES[0].name)).toBeLessThan(text.indexOf('git clone'));
  });

  it('names the ports the installation publishes', (): void => {
    for (const port of ['3210', '3211', '6791', '3000', '11434']) expect(text).toContain(port);
  });

  it('offers the key route and the account-free route, with their flags', (): void => {
    for (const route of MODEL_ROUTES) {
      expect(text).toContain(route.title);
      expect(text).toContain(route.flag);
    }
  });

  it('prints the five commands in order', (): void => {
    let at = -1;
    for (const command of QUICKSTART_COMMANDS) {
      const next = text.indexOf(command, at + 1);
      expect(next, command).toBeGreaterThan(at);
      at = next;
    }
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
    expect(text).toContain('pnpm sandbox:down && pnpm convex:down');
    expect(text).toContain('_convex_data');
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
