import { ROOM_HEIGHT } from './room-frame';

/** The frame the one-to-one's rooms occupy, as their own markup sizes them. */
export const ROOM_FRAME = `${ROOM_HEIGHT} rounded-xl border border-[var(--color-border)]`;

/** The frame the work environment occupies, as its own markup sizes it. */
export const ENVIRONMENT_FRAME = 'min-h-[30rem] rounded-xl border border-[var(--color-border)]';

/**
 * What a panel shows while its chunk is on the way: the panel's own frame, so the page does not
 * jump by a card when the chunk lands.
 *
 * @param label - What is loading, after "Loading".
 * @param frame - The classes of the frame the panel will fill.
 */
export function PanelLoading({ label, frame }: { label: string; frame: string }) {
  return (
    <p
      className={`${frame} flex items-center justify-center text-xs text-[var(--color-muted)]`}
      role="status"
    >
      Loading {label}
    </p>
  );
}
