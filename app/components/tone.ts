/**
 * The tones a component can take, each one of the theme's hues (`app/globals.css`): the accent
 * for what is in progress, warn for what waits on the manager, ok for what landed or was
 * approved, danger for what was refused, muted for what waits on nobody.
 */
export const TONES = ['accent', 'warn', 'ok', 'danger', 'muted'] as const;

/** One of the theme's hues, as a component names it. */
export type Tone = (typeof TONES)[number];

/** Text in the tone's hue on a 15 percent fill of it: a chip, a pill, a count. */
export const TONE_FILL: Readonly<Record<Tone, string>> = {
  accent: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
  warn: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
  ok: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]',
  danger: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]',
  muted: 'bg-[var(--color-muted)]/15 text-[var(--color-fg-2)]',
};

/** A border in the tone's line colour: the tone mixed into the border at 40 percent. */
export const TONE_LINE: Readonly<Record<Tone, string>> = {
  accent: 'border-[var(--color-accent-line)]',
  warn: 'border-[var(--color-warn-line)]',
  ok: 'border-[var(--color-ok-line)]',
  danger: 'border-[var(--color-danger-line)]',
  muted: 'border-[var(--color-border-2)]',
};
