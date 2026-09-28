import type { Doc } from '@convex/_generated/dataModel';
import type { AgentAvatarPet } from '@/agent/avatar-pets';

/** An employee's face in its state-toned frame, with the state dot. */
export function AgentPixelAvatar({
  avatar,
  state,
  label,
  size = 'md',
  compact = false,
}: {
  avatar: AgentAvatarPet;
  state: Doc<'agents'>['state'];
  label: string;
  size?: 'md' | 'lg';
  compact?: boolean;
}) {
  const sizeClass = size === 'lg' ? 'h-24 w-24' : 'h-14 w-14';
  const tone = agentStateTone(state);

  return (
    <div
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-sm border p-1 ${tone.border} ${tone.bg} ${
        compact ? 'shadow-[0_0_0_2px_var(--color-bg)]' : ''
      }`}
      title={label}
    >
      <div className={`${sizeClass} overflow-hidden rounded-sm bg-[var(--color-bg)]`}>
        <PixelAvatarSprite avatar={avatar} className="h-full w-full" />
      </div>
      <span
        className={`absolute bottom-1 right-1 h-2.5 w-2.5 rounded-[1px] border border-[var(--color-card)] ${tone.dot}`}
        aria-label={state}
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

function agentStateTone(state: Doc<'agents'>['state']) {
  if (state === 'active') {
    return {
      bg: 'bg-[var(--color-ok)]/10',
      border: 'border-[var(--color-ok)]/35',
      dot: 'bg-[var(--color-ok)]',
    };
  }
  if (state === 'day-one-in-progress') {
    return {
      bg: 'bg-[var(--color-accent)]/10',
      border: 'border-[var(--color-accent)]/35',
      dot: 'bg-[var(--color-accent)]',
    };
  }
  return {
    bg: 'bg-[var(--color-warn)]/10',
    border: 'border-[var(--color-warn)]/35',
    dot: 'bg-[var(--color-warn)]',
  };
}
