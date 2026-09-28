import { useId } from 'react';
import { SINGAPORE_AI_BUILDER_AVATARS } from '@/agent/avatar-pets';
import { PixelAvatarSprite } from './PixelAvatar';

/**
 * The 29-face grid a new employee's face is chosen from, labelled with the
 * gallery's own name as the README credits it. Each face is `Face n` and
 * nothing more: no title, no handle, no person (N6).
 */
export function AvatarPicker({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (avatarId: string) => void;
}) {
  const labelId = useId();
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span
          id={labelId}
          className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-muted)]"
        >
          Choose avatar
        </span>
        <span className="text-xs text-[var(--color-muted)]">
          Singapore Codex Pets · {SINGAPORE_AI_BUILDER_AVATARS.length}
        </span>
      </div>
      <div
        role="group"
        aria-labelledby={labelId}
        className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto pr-1 sm:grid-cols-10"
      >
        {SINGAPORE_AI_BUILDER_AVATARS.map((avatar) => {
          const selected = avatar.id === selectedId;
          return (
            <button
              key={avatar.id}
              type="button"
              onClick={() => onSelect(avatar.id)}
              aria-label={avatar.label}
              aria-pressed={selected}
              className={`grid h-12 w-full place-items-center rounded-md border bg-[var(--color-bg)] transition ${
                selected
                  ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
              }`}
            >
              <PixelAvatarSprite avatar={avatar} className="h-10 w-10" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
