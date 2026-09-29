import type { AgentAvatarPet } from '@/agent/avatar-pets';
import { EMPLOYEE_STATE_LABEL, type EmployeeState } from './employee-state';

/**
 * An employee's face in its state-toned frame, with the state dot.
 *
 * The hover title names the employee and its state and nothing else: the
 * face is known by its number only (N6). The frame is hidden from assistive
 * technology because every place that draws it prints the name beside it.
 */
export function AgentPixelAvatar({
  avatar,
  state,
  label,
  size = 'md',
  compact = false,
}: {
  avatar: AgentAvatarPet;
  state: EmployeeState;
  label: string;
  size?: 'sm' | 'md' | 'lg';
  compact?: boolean;
}) {
  const sizeClass = { sm: 'h-7 w-7', md: 'h-14 w-14', lg: 'h-24 w-24' }[size];
  const tone = agentStateTone(state);

  return (
    <div
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-sm border p-1 ${tone.border} ${tone.bg} ${
        compact ? 'shadow-[0_0_0_2px_var(--color-bg)]' : ''
      }`}
      title={`${label}, ${EMPLOYEE_STATE_LABEL[state].toLowerCase()}`}
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

/** One face from the gallery, drawn with its pixels kept square. */
export function PixelAvatarSprite({
  avatar,
  className,
}: {
  avatar: AgentAvatarPet;
  className: string;
}) {
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
export interface StateTone {
  readonly bg: string;
  readonly border: string;
  readonly dot: string;
  readonly text: string;
}

const OK_TONE: StateTone = {
  bg: 'bg-[var(--color-ok)]/10',
  border: 'border-[var(--color-ok)]/35',
  dot: 'bg-[var(--color-ok)]',
  text: 'text-[var(--color-ok)]',
};

const ACCENT_TONE: StateTone = {
  bg: 'bg-[var(--color-accent)]/10',
  border: 'border-[var(--color-accent)]/35',
  dot: 'bg-[var(--color-accent)]',
  text: 'text-[var(--color-accent)]',
};

const WARN_TONE: StateTone = {
  bg: 'bg-[var(--color-warn)]/10',
  border: 'border-[var(--color-warn)]/35',
  dot: 'bg-[var(--color-warn)]',
  text: 'text-[var(--color-warn)]',
};

/** Each state's tone: active is well, the one-to-one is under way, the rest wait on the manager. */
const STATE_TONES: Readonly<Record<EmployeeState, StateTone>> = {
  active: OK_TONE,
  'day-one-in-progress': ACCENT_TONE,
  deployed: WARN_TONE,
  'charter-pending': WARN_TONE,
};

/** The tone for an employee's state. */
export function agentStateTone(state: EmployeeState): StateTone {
  return STATE_TONES[state];
}
