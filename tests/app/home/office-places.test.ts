import { describe, expect, it } from 'vitest';
import {
  clearance,
  FIGURE_SPAN,
  idlePlaces,
  OFFICE_IDLE_SPOTS,
  PHONE_FIGURE_SPAN,
  PHONE_PLAN,
  PHONE_SPOTS,
  phoneSeat,
} from '../../../app/home/office-places';

describe('where the office stands its idle employees (walk m18)', () => {
  it('measures clearance in figures, along the axis that separates two most', () => {
    expect(clearance({ x: 50, y: 50 }, [])).toBe(Number.POSITIVE_INFINITY);
    expect(clearance({ x: 50, y: 50 }, [{ x: 50 + FIGURE_SPAN.x, y: 50 }])).toBe(1);
    expect(clearance({ x: 50, y: 50 }, [{ x: 50, y: 50 + FIGURE_SPAN.y / 2 }])).toBe(0.5);
  });

  it('gives two employees who prefer the same spot two spots clear of each other', () => {
    const places = idlePlaces(
      [
        { agentId: 'a', seed: 0 },
        { agentId: 'b', seed: OFFICE_IDLE_SPOTS.length },
      ],
      [],
    );
    expect(clearance(places.b!, [places.a!])).toBeGreaterThanOrEqual(1);
  });

  it('keeps an idle employee off the one sitting at a desk in its way', () => {
    const desk = { x: 49, y: 20 };
    const places = idlePlaces([{ agentId: 'a', seed: 0 }], [desk]);
    expect(clearance(places.a!, [desk])).toBeGreaterThanOrEqual(1);
  });

  it('opens each employee on the same spot every render', () => {
    const idle = [
      { agentId: 'a', seed: 3 },
      { agentId: 'b', seed: 7 },
    ];
    expect(idlePlaces(idle, [])).toEqual(idlePlaces(idle, []));
  });

  it('walks each employee away from where it stood, to a spot clear of the others', () => {
    const start = idlePlaces(
      [
        { agentId: 'a', seed: 0 },
        { agentId: 'b', seed: 1 },
        { agentId: 'c', seed: 2 },
      ],
      [],
    );
    for (let step = 0; step < 20; step += 1) {
      const next = idlePlaces(
        Object.entries(start).map(([agentId, previous], seed) => ({ agentId, seed, previous })),
        [],
        (spots) => spots[Math.floor(Math.random() * spots.length)] ?? spots[0]!,
      );
      for (const [agentId, place] of Object.entries(next)) {
        const previous = start[agentId]!;
        expect(Math.abs(place.x - previous.x) + Math.abs(place.y - previous.y)).toBeGreaterThan(18);
      }
      const [a, b, c] = Object.values(next);
      expect(clearance(a!, [b!, c!])).toBeGreaterThanOrEqual(1);
      expect(clearance(b!, [c!])).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the phone office (the operator’s ruling of 30 September)', () => {
  /** The office's height and frame, and a phone figure's height at most, in px. */
  const HEIGHT = 560;
  const FRAME = 8;
  const FIGURE_HEIGHT = 140;

  it('stands three across and three down, every spot clear of every other', () => {
    expect(PHONE_SPOTS).toHaveLength(9);
    expect(PHONE_SPOTS.slice(0, 3).map((spot) => spot.y)).toEqual([16, 16, 16]);
    for (const [index, spot] of PHONE_SPOTS.entries()) {
      expect(
        clearance(spot, PHONE_SPOTS.slice(index + 1), PHONE_FIGURE_SPAN),
        `spot ${index}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps every figure inside the frame, its top edge included, the walk’s 2 px step too', () => {
    for (const spot of PHONE_SPOTS) {
      const centre = (spot.y / 100) * HEIGHT;
      expect(centre - FIGURE_HEIGHT / 2 - 2).toBeGreaterThanOrEqual(FRAME);
      expect(centre + FIGURE_HEIGHT / 2).toBeLessThanOrEqual(HEIGHT - FRAME);
    }
    // Across, a figure a third of the inner width wide at most stays inside it at either end.
    const third = 100 / 3;
    expect(Math.min(...PHONE_SPOTS.map((spot) => spot.x)) - third / 2).toBeGreaterThan(-0.5);
    expect(Math.max(...PHONE_SPOTS.map((spot) => spot.x)) + third / 2).toBeLessThan(100.5);
  });

  it('stands up to nine employees clear of each other and of the seated, seats by roster place', () => {
    const seated = [phoneSeat(0), phoneSeat(3)];
    const places = idlePlaces(
      Array.from({ length: 7 }, (_, index) => ({ agentId: `a${index}`, seed: index * 5 })),
      seated,
      undefined,
      PHONE_PLAN,
    );
    const all = [...seated, ...Object.values(places)];
    for (const [index, place] of all.entries()) {
      expect(
        clearance(place, all.slice(index + 1), PHONE_FIGURE_SPAN),
        `figure ${index}`,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(phoneSeat(9)).toEqual(phoneSeat(0));
  });
});
