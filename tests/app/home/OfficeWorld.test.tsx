import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfficeWorld } from '../../../app/home/OfficeWorld';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearance, PHONE_FIGURE_SPAN } from '../../../app/home/office-places';
import type { RosterRow } from '../../../app/home/types';

const mira = {
  agentId: 'synthetic-mira',
  name: 'Mira',
  avatarId: 'face-05',
  state: 'active',
  autonomous: false,
  roleLine: 'Owns triage for tier-2 asks in #revops-asks',
  openCount: 1,
  parkedCount: 0,
  stoppedCount: 0,
  needsYou: 3,
  docSourceCount: 2,
} as unknown as RosterRow;

const idle = { ...mira, agentId: 'synthetic-idle', name: 'Aiko', openCount: 0 } as RosterRow;

/** Where each figure stands in the markup, at a desktop width and on a phone. */
function figuresOf(
  html: string,
): { desktop: { x: number; y: number }; phone: { x: number; y: number } }[] {
  return [
    ...html.matchAll(
      /class="day0-office-agent [^"]*" style="--x:([\d.]+);--y:([\d.]+);--px:([\d.]+);--py:([\d.]+)/g,
    ),
  ].map((match) => ({
    desktop: { x: Number(match[1]), y: Number(match[2]) },
    phone: { x: Number(match[3]), y: Number(match[4]) },
  }));
}

/** The hosted walk's roster when Ada's figure covered Cleo's: two idle, one waiting, two at desks. */
const WALK = [
  ['j5713xes6by9nefbwn731b00f58fdy75', 'Ada', 'active'],
  ['j571jf4d2j098ha81d0mqwc4z18fdg78', 'Ben', 'active'],
  ['j579sb6eh5qv6ks03bwzsfk69s8fdnpx', 'Cleo', 'deployed'],
  ['j57bbxk2n8t35dq65tqydezd3h8fcse2', 'Dara', 'day-one-in-progress'],
  ['j5792jaxjmh7xmc9mf2whktdvs8fc5fn', 'Eli', 'day-one-in-progress'],
].map(([agentId, name, state]) => ({ ...mira, agentId, name, state, openCount: 0 }) as RosterRow);

// By path: `fs` does not take jsdom's `URL`.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../app/globals.css'),
  'utf8',
);

describe('OfficeWorld', (): void => {
  it('renders every room lit, with no light-up state, before the script runs', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira]} settled />);
    expect(html).not.toContain('data-seen');
    const rooms = [...html.matchAll(/class="day0-pixel-room day0-pixel-room-\w+ absolute"[^>]*>/g)];
    expect(rooms).toHaveLength(6);
  });

  it('numbers the rooms, desks, chairs and decor for the light-up stagger, each with a wash', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} settled />);
    for (let index = 0; index < 6; index += 1) {
      expect(html).toMatch(
        new RegExp(
          `class="day0-pixel-room [^"]*"[^>]*style="[^"]*--i:${index}"[^>]*><span class="day0-pixel-room-light" aria-hidden="true"></span>`,
        ),
      );
    }
    expect(html.match(/class="day0-pixel-desk [^"]*"[^>]*style="[^"]*--i:\d+/g)).toHaveLength(8);
    expect(html.match(/class="day0-pixel-chair [^"]*"[^>]*style="[^"]*--i:\d+/g)).toHaveLength(8);
    expect(html.match(/class="day0-pixel-decor [^"]*"[^>]*style="[^"]*--i:\d+/g)).toHaveLength(9);
  });

  it('shows the ready plate and the eight-desk minimum in an empty office', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} settled />);
    expect(html).toContain('office ready');
    expect(html).toContain('0 total');
  });

  it("leaves each figure's link the base layer's focus ring, which no utility of its own removes (C1)", (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira, idle]} settled />);
    const figures = [...html.matchAll(/<a [^>]*class="day0-office-agent [^"]*"/g)];
    expect(figures).toHaveLength(2);
    for (const [figure] of figures) expect(figure).not.toMatch(/outline-(none|hidden)/);
  });

  it('titles a figure with the employee and what it is doing, nothing else (N6)', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira, idle]} settled />);
    expect(html).toContain('title="Mira, working at a desk"');
    expect(html).toContain('title="Aiko, roaming the office"');
    expect(html).not.toMatch(/title="[^"]* - /);
  });

  it('draws a paused employee with open work away from its desk, its face marked paused as the roster is (12-P)', (): void => {
    const paused = { ...mira, paused: true } as RosterRow;
    const html = renderToStaticMarkup(<OfficeWorld agents={[paused]} settled />);
    expect(html).toContain('title="Mira, paused"');
    expect(html).not.toContain('working at a desk');
    expect(html).not.toContain('day0-office-agent-seated');
    expect(html).toMatch(/<div [^>]*title="Mira, paused"[^>]*aria-hidden="true"/);
  });

  it('sets the name plate, the reads pill, the plate and the count at the 12 px floor', (): void => {
    const empty = renderToStaticMarkup(<OfficeWorld agents={[]} settled />);
    const staffed = renderToStaticMarkup(<OfficeWorld agents={[mira]} settled />);
    expect(`${empty}${staffed}`).not.toMatch(/text-\[(9|10|11)px\]/);
    expect(staffed).toContain('<span class="max-sm:sr-only">reads </span>2 locations');
    expect(staffed).toContain(mira.roleLine);
  });

  it('hands both places to the stylesheet, which keeps a figure and a desk inside the office (re-pinned: the phone office)', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira]} settled />);
    expect(html).toMatch(/class="day0-office-agent day0-office-at [^"]*" style="--x:14;--y:25;/);
    // The insets and the phone plan are the stylesheet's, since an inline style cannot follow a breakpoint.
    expect(CSS).toContain(
      'left: clamp(var(--inset), calc(var(--x) * 1%), calc(100% - var(--inset)));',
    );
    expect(CSS).toMatch(/\.day0-office-agent\.day0-office-at \{\s*--inset: 4\.5rem;/);
    expect(CSS).toMatch(/\.day0-office-at \{\s*--inset: 3\.5rem;/);
  });

  it('seats working employees far apart first, so two name plates never overlap (re-pinned: the seats re-ranked, review A-M1)', (): void => {
    const second = { ...mira, agentId: 'synthetic-second', name: 'Aiko' } as RosterRow;
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira, second]} settled />);
    expect(figuresOf(html).map(({ desktop }) => [desktop.x, desktop.y])).toEqual([
      [14, 25],
      [86, 25],
    ]);
  });

  it('stands no idle employee on another, nor on one at a desk, as the walk’s five were (walk m18)', (): void => {
    const figures = figuresOf(renderToStaticMarkup(<OfficeWorld agents={WALK} settled />)).map(
      ({ desktop }) => desktop,
    );
    expect(figures).toHaveLength(5);
    for (const [index, figure] of figures.entries()) {
      expect(clearance(figure, figures.slice(index + 1)), `figure ${index}`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('stands the walk’s five clear of each other on a phone, the first three side by side along the top (the phone office)', (): void => {
    for (const roster of [
      WALK,
      WALK.map((agent) => ({ ...agent, state: 'active' }) as RosterRow),
      WALK.map((agent) => ({ ...agent, openCount: 1 }) as RosterRow),
    ]) {
      const phone = figuresOf(renderToStaticMarkup(<OfficeWorld agents={roster} settled />)).map(
        (figure) => figure.phone,
      );
      expect(phone).toHaveLength(5);
      for (const [index, figure] of phone.entries()) {
        expect(
          clearance(figure, phone.slice(index + 1), PHONE_FIGURE_SPAN),
          `figure ${index}`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
    const seated = figuresOf(
      renderToStaticMarkup(
        <OfficeWorld
          agents={WALK.map((agent) => ({ ...agent, openCount: 1 }) as RosterRow)}
          settled
        />,
      ),
    );
    // Re-pinned: a phone row stands in px from the top (90), so rows can be added (pre-tag minor 10).
    expect(seated.slice(0, 3).map(({ phone }) => phone.y)).toEqual([90, 90, 90]);
  });

  it('draws a phone figure at most a third of the office inside its frame, at the 110 px the ruling names', (): void => {
    expect(CSS).toMatch(
      /@media \(width < 40rem\) \{\s*\.day0-office-at \{\s*left: calc\(8px \+ \(100% - 16px\) \* var\(--px\) \/ 100\);\s*top: calc\(var\(--py\) \* 1px\);\s*\}\s*\.day0-office-agent\.day0-office-at \{\s*width: min\(110px, calc\(\(100% - 16px\) \/ 3 - 6px\)\);/,
    );
  });

  it('draws no desk on a phone, where a figure covers the desk it sits at (re-pinned: the phone office supersedes UX 12, option c)', (): void => {
    for (const agents of [
      [],
      Array.from({ length: 6 }, (_, index) => ({ ...idle, agentId: `a${index}` }) as RosterRow),
    ]) {
      const html = renderToStaticMarkup(<OfficeWorld agents={agents} settled />);
      const desks = [...html.matchAll(/class="day0-pixel-desk ([^"]*)"/g)].map((match) => match[1]);
      const chairs = [...html.matchAll(/class="day0-pixel-chair ([^"]*)"/g)].map(
        (match) => match[1],
      );
      expect(desks).toHaveLength(8);
      expect(desks.every((names) => names.includes('max-sm:hidden'))).toBe(true);
      expect(chairs.every((names) => names.includes('max-sm:hidden'))).toBe(true);
    }
  });

  it('stands ten idle employees clear of each other at a desktop width (second review x9)', (): void => {
    const ten = Array.from(
      { length: 10 },
      (_, index) => ({ ...idle, agentId: `idle-${index}`, name: `Idle ${index}` }) as RosterRow,
    );
    const figures = figuresOf(renderToStaticMarkup(<OfficeWorld agents={ten} settled />)).map(
      ({ desktop }) => desktop,
    );
    expect(figures).toHaveLength(10);
    for (const [index, figure] of figures.entries()) {
      expect(clearance(figure, figures.slice(index + 1)), `figure ${index}`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('stands eight idle employees clear of each other and of two at desks, as the bed’s roster did (second review x9)', (): void => {
    const ten = Array.from(
      { length: 10 },
      (_, index) =>
        ({
          ...idle,
          agentId: `bed-${index}`,
          name: `Bed ${index}`,
          // The bed's Ben and Lan: in the one-to-one, and with work open.
          openCount: index === 5 || index === 9 ? 1 : 0,
        }) as RosterRow,
    );
    const figures = figuresOf(renderToStaticMarkup(<OfficeWorld agents={ten} settled />)).map(
      ({ desktop }) => desktop,
    );
    expect(figures).toHaveLength(10);
    for (const [index, figure] of figures.entries()) {
      expect(clearance(figure, figures.slice(index + 1)), `figure ${index}`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('seats ten working employees every two clear of each other at a desktop width (review A-M1)', (): void => {
    const ten = Array.from(
      { length: 10 },
      (_, index) =>
        ({ ...mira, agentId: `working-${index}`, name: `Working ${index}` }) as RosterRow,
    );
    const figures = figuresOf(renderToStaticMarkup(<OfficeWorld agents={ten} settled />)).map(
      ({ desktop }) => desktop,
    );
    expect(figures).toHaveLength(10);
    for (const [index, figure] of figures.entries()) {
      expect(clearance(figure, figures.slice(index + 1)), `figure ${index}`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('seats every employee of twenty inside the office, a 140 px figure clear of the 8 px frame of a 560 px office', (): void => {
    const twenty = Array.from(
      { length: 20 },
      (_, index) =>
        ({ ...mira, agentId: `working-${index}`, name: `Working ${index}` }) as RosterRow,
    );
    const figures = figuresOf(renderToStaticMarkup(<OfficeWorld agents={twenty} settled />));
    expect(figures).toHaveLength(20);
    for (const [index, { desktop }] of figures.entries()) {
      const centre = (desktop.y / 100) * 560;
      expect(centre + 70, `figure ${index}`).toBeLessThanOrEqual(560 - 8);
      expect(centre - 70 - 2, `figure ${index}`).toBeGreaterThanOrEqual(8);
    }
  });

  it('draws no desk of the first ten over the lounge table, in an 886 by 560 px office (review A-M1 follow-up)', (): void => {
    const size: Record<string, { width: number; height: number }> = {
      wide: { width: 88, height: 54 },
      compact: { width: 66, height: 50 },
      console: { width: 56, height: 60 },
    };
    const ten = Array.from(
      { length: 10 },
      (_, index) => ({ ...idle, agentId: `idle-${index}`, name: `Idle ${index}` }) as RosterRow,
    );
    const html = renderToStaticMarkup(<OfficeWorld agents={ten} settled />);
    const table =
      /class="day0-pixel-decor day0-pixel-table [^"]*" style="left:([\d.]+)%;top:([\d.]+)%/g;
    const tables = [...html.matchAll(table)].map((match) => ({
      x: (Number(match[1]) / 100) * 886,
      y: (Number(match[2]) / 100) * 560,
    }));
    const lounge = tables.find((spot) => spot.y > 0.8 * 560);
    expect(lounge).toBeDefined();
    const desks = [
      ...html.matchAll(
        /class="day0-pixel-desk day0-pixel-desk-(\w+) [^"]*" style="--x:([\d.]+);--y:([\d.]+);/g,
      ),
    ];
    expect(desks).toHaveLength(10);
    for (const [, variant, x, y] of desks) {
      const box = size[variant ?? ''];
      expect(box).toBeDefined();
      const dx = Math.abs((Number(x) / 100) * 886 - lounge!.x);
      const dy = Math.abs((Number(y) / 100) * 560 - lounge!.y);
      const apart = dx >= (box!.width + 62) / 2 || dy >= (box!.height + 42) / 2;
      expect(apart, `desk at ${x},${y}`).toBe(true);
    }
  });

  it('stands ten employees clear of each other whichever six of them are in their one-to-ones (review A-M1)', (): void => {
    const sixOfTen = (mask: number): boolean =>
      mask
        .toString(2)
        .split('')
        .filter((bit) => bit === '1').length === 6;
    const masks = Array.from({ length: 1 << 10 }, (_, mask) => mask).filter(sixOfTen);
    expect(masks).toHaveLength(210);
    const crowded = masks.filter((mask) => {
      const ten = Array.from(
        { length: 10 },
        (_, index) =>
          ({
            ...idle,
            agentId: `bed-${index}`,
            name: `Bed ${index}`,
            state: mask & (1 << index) ? 'day-one-in-progress' : 'active',
          }) as RosterRow,
      );
      const figures = figuresOf(renderToStaticMarkup(<OfficeWorld agents={ten} settled />)).map(
        ({ desktop }) => desktop,
      );
      return figures.some((figure, index) => clearance(figure, figures.slice(index + 1)) < 1);
    });
    expect(crowded.map((mask) => mask.toString(2).padStart(10, '0'))).toEqual([]);
  });

  it('gives a tenth employee a phone seat of its own, in an office a row taller (pre-tag minor 10)', (): void => {
    const ten = Array.from(
      { length: 10 },
      (_, index) =>
        ({ ...mira, agentId: `working-${index}`, name: `Working ${index}` }) as RosterRow,
    );
    const html = renderToStaticMarkup(<OfficeWorld agents={ten} settled />);
    const phone = figuresOf(html).map((figure) => `${figure.phone.x},${figure.phone.y}`);
    expect(new Set(phone).size).toBe(10);
    expect(html).toContain('style="--phone-height:750px"');
    expect(html).toMatch(/class="day0-pixel-office [^"]*max-sm:min-h-\(--phone-height\)/);
    expect(renderToStaticMarkup(<OfficeWorld agents={[mira]} settled />)).toContain(
      'style="--phone-height:560px"',
    );
  });

  it('leaves a phone plate’s role line to the roster and lets the count wrap rather than cut it (pre-tag minor 10)', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira]} settled />);
    const role = new RegExp(`<div class="([^"]*)" title="${mira.roleLine}">`).exec(html)?.[1];
    expect(role?.split(' ')).toContain('max-sm:hidden');
    const pill = /<div class="([^"]*)"><span class="max-sm:sr-only">reads <\/span>/.exec(html)?.[1];
    expect(pill?.split(' ')).toEqual(expect.arrayContaining(['max-sm:whitespace-normal']));
  });

  it('walks a figure when its place changes, never when the page crosses sm (pre-tag minor 10)', (): void => {
    for (const name of ['--x', '--y', '--px', '--py']) {
      expect(CSS).toMatch(new RegExp(`@property ${name} \\{\\s*syntax: '<number>';`));
    }
    const walk = /\.day0-office-agent \{\s*transition:([^;]*);/.exec(CSS)?.[1] ?? '';
    expect(walk).toMatch(/--x var\(--walk-duration/);
    expect(walk).toMatch(/--py var\(--walk-duration/);
    // Left and top change with the breakpoint, so neither is transitioned.
    expect(walk).not.toMatch(/\b(left|top)\b/);
  });

  it('keeps every desk where the desktop plan stands it, inside the office by its inset (re-pinned: the seats re-ranked, review A-M1)', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} settled />);
    const deskTwo = [...html.matchAll(/class="day0-pixel-desk [^"]*" style="([^"]*)"/g)][2]?.[1];
    expect(deskTwo).toBe('--x:68;--y:31;--i:2');
  });
});
