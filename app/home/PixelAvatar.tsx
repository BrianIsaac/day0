import type { AgentAvatarPet } from '@/agent/avatar-pets';
import type { OneToOnePhase } from '@/agent/one-to-one-phase';
import { employeeStateWords, type EmployeeState, type StateTone } from '@/work/state-labels';

/** What the face is drawn from. */
export interface AgentPixelAvatarProps {
  readonly avatar: AgentAvatarPet;
  /** The state the page shows (`shownEmployeeState`). */
  readonly state: EmployeeState;
  /** Where the one-to-one stands (`oneToOnePhase`), when the surface has read it. */
  readonly phase?: OneToOnePhase['kind'];
  /** The employee's name. */
  readonly label: string;
  readonly size?: 'sm' | 'md' | 'lg';
  /** Whether the face sits among others, ringed in the page colour. */
  readonly compact?: boolean;
}

/**
 * An employee's face in its state-toned frame, with the state dot.
 *
 * The hover title names the employee and its state, in the words its page's
 * pill uses (`employeeStateWords`, with the one-to-one's phase where the
 * surface has it), and the frame is toned in those words' hue, and nothing
 * else: the face is known by its number only (N6). The frame is hidden from
 * assistive technology because every place that draws it prints the name
 * beside it.
 */
export function AgentPixelAvatar({
  avatar,
  state,
  phase,
  label,
  size = 'md',
  compact = false,
}: AgentPixelAvatarProps) {
  const sizeClass = { sm: 'h-7 w-7', md: 'h-14 w-14', lg: 'h-24 w-24' }[size];
  const words = employeeStateWords(state, phase);
  const tone = toneClasses(words.tone);

  return (
    <div
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-sm border p-1 ${tone.border} ${tone.bg} ${
        compact ? 'shadow-[0_0_0_2px_var(--color-bg)]' : ''
      }`}
      title={`${label}, ${words.text.toLowerCase()}`}
      aria-hidden="true"
    >
      <div className={`${sizeClass} overflow-hidden rounded-sm bg-[var(--color-bg)]`}>
        <PixelAvatarSprite avatar={avatar} className="h-full w-full" />
      </div>
      <span
        className={`absolute bottom-1 right-1 h-2.5 w-2.5 rounded-[1px] border border-[var(--color-card)] ${tone.dot}`}
      />
    </div>
  );
}

/** What one face from the gallery is drawn from. */
export interface PixelAvatarSpriteProps {
  readonly avatar: AgentAvatarPet;
  readonly className: string;
}

/** One face from the gallery, drawn with its pixels kept square. */
export function PixelAvatarSprite({ avatar, className }: PixelAvatarSpriteProps) {
  return (
    <span
      aria-hidden="true"
      className={`block bg-center bg-no-repeat [image-rendering:pixelated] ${className}`}
      style={{
        backgroundImage: `url("${avatar.src}")`,
        backgroundSize: 'contain',
      }}
    />
  );
}

/** The Tailwind classes that tone an employee's frame, fill, dot and text. */
export interface ToneClasses {
  readonly bg: string;
  readonly border: string;
  readonly dot: string;
  readonly text: string;
}

/**
 * The classes for each hue a state's words are drawn in (`employeeStateWords`), so the frame and
 * the roster's chip take their hue from the words and never disagree with them.
 */
const TONE_CLASSES: Readonly<Record<StateTone, ToneClasses>> = {
  ok: {
    bg: 'bg-[var(--color-ok)]/10',
    border: 'border-[var(--color-ok)]/35',
    dot: 'bg-[var(--color-ok)]',
    text: 'text-[var(--color-ok)]',
  },
  accent: {
    bg: 'bg-[var(--color-accent)]/10',
    border: 'border-[var(--color-accent)]/35',
    dot: 'bg-[var(--color-accent)]',
    text: 'text-[var(--color-accent)]',
  },
  warn: {
    bg: 'bg-[var(--color-warn)]/10',
    border: 'border-[var(--color-warn)]/35',
    dot: 'bg-[var(--color-warn)]',
    text: 'text-[var(--color-warn)]',
  },
  muted: {
    bg: 'bg-[var(--color-muted)]/10',
    border: 'border-[var(--color-muted)]/35',
    dot: 'bg-[var(--color-muted)]',
    text: 'text-[var(--color-muted)]',
  },
};

/**
 * The classes that draw a state's words in their hue.
 *
 * @param tone - The words' hue (`employeeStateWords(...).tone`).
 */
export function toneClasses(tone: StateTone): ToneClasses {
  return TONE_CLASSES[tone];
}
