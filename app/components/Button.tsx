import Link from 'next/link';
import type { ComponentProps } from 'react';

/** What a button does, as its look says: the page's one next step, a decision, or the rest. */
export const BUTTON_VARIANTS = [
  'primary',
  'secondary',
  'approve',
  'retry',
  'danger',
  'quiet',
  'text',
] as const;

/** One of the button looks. */
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

/**
 * How much room a button takes. Every size keeps the 44 px target (N14); a decision is set
 * larger, a row control smaller, by its padding and type alone.
 */
export type ButtonSize = 'small' | 'medium' | 'large';

const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90',
  secondary:
    'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-fg)] hover:border-[var(--color-accent)]',
  approve:
    'border-transparent bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30',
  retry:
    'border-transparent bg-[var(--color-warn)]/20 text-[var(--color-warn)] hover:bg-[var(--color-warn)]/25',
  danger:
    'border-[var(--color-danger-line)] bg-transparent text-[var(--color-danger)] hover:border-[var(--color-danger)]',
  quiet: 'border-transparent bg-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]',
  text: 'border-transparent bg-transparent text-[var(--color-fg-2)] underline decoration-[var(--color-link-line)] underline-offset-4 hover:decoration-[var(--color-accent)]',
};

const SIZE: Readonly<Record<ButtonSize, string>> = {
  small: 'px-3 text-[13px]',
  medium: 'px-4 text-sm',
  large: 'px-5 text-[15px]',
};

/** The type sizes of the `text` look, which takes no padding. */
const TEXT_SIZE: Readonly<Record<ButtonSize, string>> = {
  small: 'text-[13px]',
  medium: 'text-sm',
  large: 'text-[15px]',
};

/**
 * The classes of a button of this look and size, for a control that cannot be the `Button`
 * element itself. The `text` look sits in a line of prose, so it takes no side padding: its
 * target is the 44 px line it sits on. Pressing scales it to 0.97 in 120 ms where motion is welcome; hover changes
 * colour and border only; a disabled one is dimmed and says so to the pointer.
 *
 * @param variant - The look.
 * @param size - The room it takes.
 */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'medium') {
  const room = variant === 'text' ? TEXT_SIZE[size] : SIZE[size];
  const underline = variant === 'text' ? '' : ' no-underline';
  return `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border font-medium whitespace-nowrap${underline} transition-[transform,border-color,background-color,opacity,text-decoration-color] duration-[120ms,180ms,180ms,180ms,180ms] ease-out motion-safe:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${VARIANT[variant]} ${room}`;
}

/**
 * A button in one of the product's looks: `primary` for the page's one next step, `approve` and
 * `retry` for the manager's decisions, `danger` for what cannot be undone, `secondary` and
 * `quiet` for the rest, `text` for a control inside a line of prose. It is a `button` of type
 * `button` unless told otherwise, so it never submits a form by accident.
 */
export function Button({
  variant = 'secondary',
  size = 'medium',
  type = 'button',
  className,
  ...rest
}: ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={`${buttonClass(variant, size)}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  );
}

/**
 * A link drawn as a button, for a control whose action is to go to the page that performs it:
 * an inbox entry's one control, the day-zero Chat.
 */
export function ButtonLink({
  variant = 'secondary',
  size = 'medium',
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <Link
      className={`${buttonClass(variant, size)}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  );
}
