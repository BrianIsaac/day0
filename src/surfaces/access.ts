/**
 * Q5's access length, in days: what an approval gives a surface, the length an upgrade restarts
 * the clock with, and the period the card's renewal offers first. The backend and the card read
 * this one value, so the card never offers a default the approval does not give.
 */
export const SURFACE_ACCESS_DEFAULT_DAYS = 90;

/** The longest access the manager can set, in days; the card offers no period past it. */
export const SURFACE_ACCESS_MAX_DAYS = 365;
