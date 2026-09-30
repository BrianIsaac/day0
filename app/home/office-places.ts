/** A place in the office, as a share of its width and height. */
export interface OfficePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The spots an employee not at a desk stands at, in the corridors and the rooms' open floor: ten,
 * every two clear of each other by a figure's span (`FIGURE_SPAN`), none over one of the eight
 * desks always drawn, their chairs or the décor, and every figure inside the office's frame, so
 * ten idle employees stand apart at a desktop width (the second review's x9: at most five of the
 * earlier ten were clear of each other).
 */
export const OFFICE_IDLE_SPOTS: readonly OfficePoint[] = [
  { x: 41, y: 16 },
  { x: 20, y: 36 },
  { x: 60, y: 43 },
  { x: 39, y: 43 },
  { x: 88, y: 53 },
  { x: 10, y: 73 },
  { x: 48, y: 72 },
  { x: 29, y: 81 },
  { x: 67, y: 81 },
  { x: 90, y: 81 },
];

/**
 * How far apart two figures' centres stand before they overlap, as a share of the office at a
 * desktop width: a figure is 144 by 140 px in an office about 880 px wide and 560 px tall.
 */
export const FIGURE_SPAN: OfficePoint = { x: 17, y: 26 };

/** The phone plan's columns, as shares of the office's inner width (inside its 8 px frame). */
const PHONE_COLUMNS = [16.5, 50, 83.5] as const;

/** Where the phone plan's first row stands, in px from the office's top: a figure's top at 20. */
const PHONE_FIRST_ROW = 90;

/** How far apart the phone plan's rows stand, in px: a figure and a 50 px gap. */
const PHONE_ROW_PITCH = 190;

/**
 * How many rows a phone office has for this many employees: three at least, as the plan was
 * ruled (30 September), and one more for each three past nine, so every employee has a seat of
 * its own (the pre-tag pass's minor 10: a tenth shared the first).
 *
 * @param employees - How many the office draws.
 */
export function phoneRows(employees: number): number {
  return Math.max(3, Math.ceil(employees / PHONE_COLUMNS.length));
}

/**
 * How tall a phone office is for this many rows, in px: the first row's room above, a pitch per
 * row after it and the same room below, so three rows keep the 560 px office.
 *
 * @param rows - The office's rows (`phoneRows`).
 */
export function phoneOfficeHeight(rows: number): number {
  return 2 * PHONE_FIRST_ROW + (rows - 1) * PHONE_ROW_PITCH;
}

/**
 * Where a phone stands its employees (below `sm`, the operator's ruling of 30 September): three
 * across, as shares of the office's inner width, and row after row down, in px from its top. A
 * phone figure is at most a third of the inner width wide (`app/globals.css`), so three stand side
 * by side at any phone width, and a row's pitch keeps each clear of the next. Row by row, so the
 * first three employees stand side by side along the top.
 *
 * @param rows - The office's rows (`phoneRows`).
 */
export function phoneSpots(rows: number): OfficePoint[] {
  return Array.from({ length: rows }, (_, row) => PHONE_FIRST_ROW + row * PHONE_ROW_PITCH).flatMap(
    (y) => PHONE_COLUMNS.map((x) => ({ x, y })),
  );
}

/**
 * How far apart two phone figures' centres stand before they overlap, in the phone plan's units:
 * a figure is a third of the inner width less 6 px, under 33 percent at any phone width, and at
 * most 140 px tall, taken with 10 px to spare.
 */
export const PHONE_FIGURE_SPAN: OfficePoint = { x: 33, y: 150 };

/** Where an office stands its idle employees, and how far apart two must be not to overlap. */
export interface OfficePlan {
  readonly spots: readonly OfficePoint[];
  /**
   * Where an idle employee stands when none of `spots` is clear of the others, tier by tier: the
   * floor off the desks, then the floor over an empty desk. A figure over an empty desk reads
   * better than two figures on each other.
   */
  readonly fallbacks?: readonly (readonly OfficePoint[])[];
  readonly span: OfficePoint;
}

/**
 * The desktop office's floor as a lattice, for when the seats in use and the other idle
 * employees leave none of `OFFICE_IDLE_SPOTS` clear (the bed: two employees at desks left five
 * clear spots for eight standing). Every point keeps a figure inside the frame.
 */
const DESKTOP_FLOOR: readonly OfficePoint[] = Array.from(
  { length: 21 },
  (_, column) => 10 + 4 * column,
).flatMap((x) => Array.from({ length: 15 }, (_, row) => ({ x, y: 15 + 5 * row })));

/** Whether a figure standing at `spot` would stand over one of the desks or chairs drawn. */
function overDesk(spot: OfficePoint, drawn: readonly OfficePoint[]): boolean {
  return drawn.some(
    (desk) =>
      Math.abs(desk.x - spot.x) < FIGURE_SPAN.x / 2 &&
      Math.abs(desk.y - spot.y) < FIGURE_SPAN.y / 2,
  );
}

/**
 * The office at a desktop width for the desks it draws: the corridors' and rooms' open floor
 * clear of them, then the rest of the floor off them, then over an empty one (the second pass: a
 * spot stood over the tenth desk once ten were drawn).
 *
 * @param drawn - The centres of the desks and chairs drawn, as shares of the office.
 */
export function desktopPlan(drawn: readonly OfficePoint[]): OfficePlan {
  const off = (spot: OfficePoint): boolean => !overDesk(spot, drawn);
  return {
    spots: OFFICE_IDLE_SPOTS.filter(off),
    fallbacks: [DESKTOP_FLOOR.filter(off), DESKTOP_FLOOR.filter((spot) => !off(spot))],
    span: FIGURE_SPAN,
  };
}

/** The office at a desktop width with no desk drawn over its spots. */
export const DESKTOP_PLAN: OfficePlan = desktopPlan([]);

/**
 * The office on a phone: three across, as many rows as its employees need.
 *
 * @param rows - The office's rows (`phoneRows`).
 */
export function phonePlan(rows: number): OfficePlan {
  return { spots: phoneSpots(rows), span: PHONE_FIGURE_SPAN };
}

/** Where the employee at this place on the roster sits at its desk on a phone: a seat of its own. */
export function phoneSeat(index: number): OfficePoint {
  const column = PHONE_COLUMNS[index % PHONE_COLUMNS.length] ?? PHONE_COLUMNS[0];
  return {
    x: column,
    y: PHONE_FIRST_ROW + Math.floor(index / PHONE_COLUMNS.length) * PHONE_ROW_PITCH,
  };
}

/** How far a roaming employee moves at least, so a step reads as a walk. */
const LEAST_STEP = 18;

/**
 * How clear a point is of the figures already placed: the nearest one's distance, in figures,
 * along whichever axis separates them most. At 1 or more the two do not overlap.
 *
 * @param point - Where a figure would stand.
 * @param placed - Where the others stand.
 * @param span - How far apart two figures stand before they overlap, in the plan's shares.
 */
export function clearance(
  point: OfficePoint,
  placed: readonly OfficePoint[],
  span: OfficePoint = FIGURE_SPAN,
): number {
  return placed.reduce(
    (nearest, other) =>
      Math.min(
        nearest,
        Math.max(Math.abs(other.x - point.x) / span.x, Math.abs(other.y - point.y) / span.y),
      ),
    Number.POSITIVE_INFINITY,
  );
}

/** An employee standing somewhere other than a desk, and where it stood before, if anywhere. */
export interface IdleFigure {
  readonly agentId: string;
  /** A number of its own, so its first spot is its own and stays put between renders. */
  readonly seed: number;
  readonly previous?: OfficePoint;
}

/**
 * Where each idle employee stands: one at a time, each on a spot clear of the figures already
 * placed (the seated ones first), and of those the one that leaves the most clear spots to the
 * employees still to place, so two figures overlap only once the office has no clear spot left
 * (the hosted walk's m18: Ada's figure stood on Cleo's). When the plan's spots have none clear
 * left, the plan's floor (`OfficePlan.fallbacks`) is asked the same way, so two figures overlap
 * only once the whole floor is full. Between equally good spots the first placement follows each
 * employee's own seed; a roaming step takes `pick`'s choice, away from where the employee stood.
 *
 * @param idle - The idle employees, in roster order.
 * @param seated - Where the employees at desks sit.
 * @param pick - Chooses among equally good spots; the first by default, so a render is stable.
 * @param plan - The office's spots and figure span: the desktop's by default, or the phone's.
 * @returns Each idle employee's spot, by id.
 */
export function idlePlaces(
  idle: readonly IdleFigure[],
  seated: readonly OfficePoint[],
  pick: (spots: readonly OfficePoint[]) => OfficePoint = (spots) => spots[0],
  plan: OfficePlan = DESKTOP_PLAN,
): Record<string, OfficePoint> {
  const placed: OfficePoint[] = [...seated];
  const places: Record<string, OfficePoint> = {};
  const tiers = [plan.spots, ...(plan.fallbacks ?? [])].filter((tier) => tier.length > 0);
  for (const figure of idle) {
    // Each tier is asked only when the ones before it have no clear spot left; the clearest
    // spot any tier offered stands when none has one.
    let chosen: OfficePoint | undefined;
    for (const tier of tiers) {
      const spot = bestSpot(figure, placed, tier, plan.span, pick);
      if (
        chosen === undefined ||
        clearance(spot, placed, plan.span) > clearance(chosen, placed, plan.span)
      ) {
        chosen = spot;
      }
      if (clearance(chosen, placed, plan.span) >= 1) break;
    }
    if (chosen === undefined) continue;
    places[figure.agentId] = chosen;
    placed.push(chosen);
  }
  return places;
}

/**
 * The spot of `spots` an idle employee takes: one clear of the figures already placed, and of
 * those the one that leaves the most clear spots to the employees still to place; away from where
 * it stood when it roams; the least crowded when none is clear.
 */
function bestSpot(
  figure: IdleFigure,
  placed: readonly OfficePoint[],
  spots: readonly OfficePoint[],
  span: OfficePoint,
  pick: (spots: readonly OfficePoint[]) => OfficePoint,
): OfficePoint {
  const { previous } = figure;
  const away =
    previous === undefined
      ? []
      : spots.filter(
          (spot) => Math.abs(spot.x - previous.x) + Math.abs(spot.y - previous.y) > LEAST_STEP,
        );
  const reachable = away.length > 0 ? away : rotated(spots, figure.seed);
  // The spots still clear of everyone placed: a spot that takes fewer of them from the
  // employees still to place is the better of two clear ones.
  const open = spots.filter((spot) => clearance(spot, placed, span) >= 1);
  const scored = reachable.map((spot) => ({
    spot,
    clear: Math.min(1, clearance(spot, placed, span)),
    blocks: open.filter((other) => other !== spot && clearance(other, [spot], span) < 1).length,
  }));
  const best = Math.max(...scored.map(({ clear }) => clear));
  const clearest = scored.filter(({ clear }) => clear === best);
  const fewest = Math.min(...clearest.map(({ blocks }) => blocks));
  return pick(clearest.filter(({ blocks }) => blocks === fewest).map(({ spot: each }) => each));
}

/** The spots in order from the one a seed names, so employees prefer spots of their own. */
function rotated(spots: readonly OfficePoint[], seed: number): OfficePoint[] {
  const start = seed % spots.length;
  return [...spots.slice(start), ...spots.slice(0, start)];
}
