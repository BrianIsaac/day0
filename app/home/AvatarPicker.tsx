import { useId } from 'react';
import { SINGAPORE_AI_BUILDER_AVATARS } from '@/agent/avatar-pets';
import { PixelAvatarSprite } from './PixelAvatar';

/**
 * The 29-face grid a new employee's face is chosen from, behind a
 * disclosure headed with the gallery's own name as the README credits it.
 * Each face is `Face n` and nothing more: no title, no handle, no person
 * (N6). A native `details`, so it opens and closes without the script.
 *
 * @param selectedId - The chosen face.
 * @param onSelect - Called with a pressed face's id.
 * @param defaultOpen - Whether the faces show when the form first renders.
 */
export function AvatarPicker({
  selectedId,
  onSelect,
  defaultOpen = false,
}: {
  selectedId: string;
  onSelect: (avatarId: string) => void;
  defaultOpen?: boolean;
}) {
  const labelId = useId();
  const creditId = useId();
  return (
    <details open={defaultOpen} className="group mb-4">
      <summary className="mb-2 flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md [&::-webkit-details-marker]:hidden">
        <span
          id={labelId}
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-muted)]"
        >
          <span
            aria-hidden="true"
            className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none"
          >
            ›
          </span>
          Choose avatar
        </span>
        <span id={creditId} className="text-xs text-[var(--color-muted)]">
          Singapore Codex Pets · {SINGAPORE_AI_BUILDER_AVATARS.length}
        </span>
      </summary>
      <div
        role="group"
        aria-labelledby={`${labelId} ${creditId}`}
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
    </details>
  );
}
