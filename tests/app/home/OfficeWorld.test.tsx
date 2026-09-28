import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfficeWorld } from '../../../app/home/OfficeWorld';
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

describe('OfficeWorld', (): void => {
  it('renders every room lit, with no light-up state, before the script runs', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira]} />);
    expect(html).not.toContain('data-seen');
    const rooms = [...html.matchAll(/class="day0-pixel-room day0-pixel-room-\w+ absolute"[^>]*>/g)];
    expect(rooms).toHaveLength(6);
  });

  it('numbers the rooms, desks, chairs and decor for the light-up stagger, each with a wash', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} />);
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
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} />);
    expect(html).toContain('office ready');
    expect(html).toContain('0 total');
  });

  it('titles a figure with the employee and what it is doing, nothing else (N6)', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira, idle]} />);
    expect(html).toContain('title="Mira, working at a desk"');
    expect(html).toContain('title="Aiko, roaming the office"');
    expect(html).not.toMatch(/title="[^"]* - /);
  });

  it('sets the name plate, the reads pill, the plate and the count at the 12 px floor', (): void => {
    const empty = renderToStaticMarkup(<OfficeWorld agents={[]} />);
    const staffed = renderToStaticMarkup(<OfficeWorld agents={[mira]} />);
    expect(`${empty}${staffed}`).not.toMatch(/text-\[(9|10|11)px\]/);
    expect(staffed).toContain('reads 2 locations');
    expect(staffed).toContain(mira.roleLine);
  });

  it('keeps a figure and its name plate inside the office at a phone width', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira]} />);
    expect(html).toContain('left:clamp(4.5rem, 14%, calc(100% - 4.5rem))');
  });

  it('seats working employees far apart first, so two name plates never overlap', (): void => {
    const second = { ...mira, agentId: 'synthetic-second', name: 'Aiko' } as RosterRow;
    const html = renderToStaticMarkup(<OfficeWorld agents={[mira, second]} />);
    const seats = [...html.matchAll(/left:clamp\(4\.5rem, (\d+)%[^;]*;top:(\d+)%/g)].map(
      (match) => [Number(match[1]), Number(match[2])],
    );
    expect(seats).toEqual([
      [14, 25],
      [67, 25],
    ]);
  });

  it('draws four desks on a phone, the ones the first four employees take (UX 12, option c)', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} />);
    const desks = [...html.matchAll(/class="day0-pixel-desk ([^"]*)"/g)].map((match) => match[1]);
    const chairs = [...html.matchAll(/class="day0-pixel-chair ([^"]*)"/g)].map((match) => match[1]);
    expect(desks).toHaveLength(8);
    const hidden = (classes: string[]): number[] =>
      classes.flatMap((names, index) => (names.includes('max-sm:hidden') ? [index] : []));
    expect(hidden(desks)).toEqual([1, 4, 5, 7]);
    expect(hidden(chairs)).toEqual([1, 4, 5, 7]);
    const staffed = renderToStaticMarkup(
      <OfficeWorld
        agents={Array.from(
          { length: 6 },
          (_, index) => ({ ...idle, agentId: `a${index}` }) as RosterRow,
        )}
      />,
    );
    expect(
      hidden([...staffed.matchAll(/class="day0-pixel-desk ([^"]*)"/g)].map((match) => match[1])),
    ).toEqual([4, 5]);
  });

  it('keeps every desk inside the office at a phone’s width', (): void => {
    const html = renderToStaticMarkup(<OfficeWorld agents={[]} />);
    expect(html).toContain('left:clamp(3rem, 86%, calc(100% - 3rem))');
  });
});
