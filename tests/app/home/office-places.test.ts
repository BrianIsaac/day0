import { describe, expect, it } from 'vitest';
import {
  clearance,
  FIGURE_SPAN,
  idlePlaces,
  OFFICE_IDLE_SPOTS,
  PHONE_FIGURE_SPAN,
  phoneOfficeHeight,
  phonePlan,
  phoneRows,
  phoneSeat,
  phoneSpots,
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

  it('has ten spots every two of which stand clear, so a sixth idle employee overlaps nobody (second review x9)', () => {
    expect(OFFICE_IDLE_SPOTS).toHaveLength(10);
    for (const [index, spot] of OFFICE_IDLE_SPOTS.entries()) {
      expect(
        clearance(spot, OFFICE_IDLE_SPOTS.slice(index + 1)),
        `spot ${index}`,
      ).toBeGreaterThanOrEqual(1);
    }
    const places = Object.values(
      idlePlaces(
        Array.from({ length: 10 }, (_, index) => ({ agentId: `a${index}`, seed: index * 3 })),
        [],
      ),
    );
    for (const [index, place] of places.entries()) {
      expect(clearance(place, places.slice(index + 1)), `figure ${index}`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('keeps every idle figure inside the desktop office, 560 px tall with an 8 px frame', () => {
    // A figure is 140 px tall and drawn centred on its spot, and walks a 2 px step up.
    for (const spot of OFFICE_IDLE_SPOTS) {
      const centre = (spot.y / 100) * 560;
      expect(centre - 70 - 2).toBeGreaterThanOrEqual(8);
      expect(centre + 70).toBeLessThanOrEqual(560 - 8);
    }
  });
});

describe('the phone office (the operator’s ruling of 30 September)', () => {
  /** The office's frame, and a phone figure's height at most, in px. */
  const FRAME = 8;
  const FIGURE_HEIGHT = 140;

  it('stands three across and three down up to nine, every spot clear of every other', () => {
    expect(phoneRows(1)).toBe(3);
    expect(phoneRows(9)).toBe(3);
    const spots = phoneSpots(3);
    expect(spots).toHaveLength(9);
    expect(phoneOfficeHeight(3)).toBe(560);
    for (const [index, spot] of spots.entries()) {
      expect(
        clearance(spot, spots.slice(index + 1), PHONE_FIGURE_SPAN),
        `spot ${index}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('adds a row for every three past nine, so a tenth employee has a seat of its own (pre-tag minor 10)', () => {
    expect(phoneRows(10)).toBe(4);
    expect(phoneRows(20)).toBe(7);
    const seats = Array.from({ length: 20 }, (_, index) => phoneSeat(index));
    for (const [index, seat] of seats.entries()) {
      expect(
        clearance(seat, seats.slice(index + 1), PHONE_FIGURE_SPAN),
        `seat ${index}`,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(phoneSeat(9)).not.toEqual(phoneSeat(0));
    // Each seat is one of its office's spots, so an idle figure is placed among the same.
    expect(phoneSpots(phoneRows(20)).slice(0, 20)).toEqual(seats);
  });

  it('keeps every figure inside the frame at any row count, its top edge included, the walk’s 2 px step too', () => {
    for (const rows of [3, 4, 7]) {
      const height = phoneOfficeHeight(rows);
      for (const spot of phoneSpots(rows)) {
        expect(spot.y - FIGURE_HEIGHT / 2 - 2).toBeGreaterThanOrEqual(FRAME);
        expect(spot.y + FIGURE_HEIGHT / 2).toBeLessThanOrEqual(height - FRAME);
      }
    }
    // Across, a figure a third of the inner width wide at most stays inside it at either end.
    const third = 100 / 3;
    const spots = phoneSpots(3);
    expect(Math.min(...spots.map((spot) => spot.x)) - third / 2).toBeGreaterThan(-0.5);
    expect(Math.max(...spots.map((spot) => spot.x)) + third / 2).toBeLessThan(100.5);
  });

  it('stands up to nine employees clear of each other and of the seated, seats by roster place', () => {
    const seated = [phoneSeat(0), phoneSeat(3)];
    const places = idlePlaces(
      Array.from({ length: 7 }, (_, index) => ({ agentId: `a${index}`, seed: index * 5 })),
      seated,
      undefined,
      phonePlan(3),
    );
    const all = [...seated, ...Object.values(places)];
    for (const [index, place] of all.entries()) {
      expect(
        clearance(place, all.slice(index + 1), PHONE_FIGURE_SPAN),
        `figure ${index}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});
