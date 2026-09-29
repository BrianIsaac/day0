'use client';

import { type ManagerNotificationMode, NOTIFICATION_MODE_LABELS } from '@/work/manager-notes';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import { useId } from 'react';

/**
 * How the manager hears about run outcomes over the chat surface: as each
 * run finishes, or in one hourly digest. Decision requests are sent at once
 * in either mode, so the choice only quietens what is for information.
 */
export function NotificationModeControl({
  mode,
  onChange,
}: {
  mode: ManagerNotificationMode;
  onChange: (mode: ManagerNotificationMode) => Promise<unknown>;
}) {
  const change = useChange();
  const id = useId();
  return (
    <div>
      <div
        className="flex items-center gap-1.5 pl-3 pr-1 rounded-full border border-[var(--color-border)] text-[10px] text-[var(--color-muted)]"
        title={NOTIFICATION_MODE_HINT}
      >
        <label htmlFor={`${id}-mode`}>Manager DMs</label>
        <select
          id={`${id}-mode`}
          aria-describedby={`${id}-hint`}
          value={mode}
          disabled={change.busy}
          onChange={(event) => {
            const next = event.target.value as ManagerNotificationMode;
            change.run(() => onChange(next), {
              done: `Manager DMs: ${NOTIFICATION_MODE_LABELS[next]}.`,
              refused: 'The manager DM setting was not changed.',
            });
          }}
          className="min-h-11 bg-transparent text-xs text-[var(--color-fg)] disabled:cursor-wait"
        >
          {(Object.keys(NOTIFICATION_MODE_LABELS) as ManagerNotificationMode[]).map((option) => (
            <option key={option} value={option}>
              {NOTIFICATION_MODE_LABELS[option]}
            </option>
          ))}
        </select>
        <span id={`${id}-hint`} className="sr-only">
          {NOTIFICATION_MODE_HINT}
        </span>
      </div>
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}

/** What the manager DM setting does, beside the control and for its hover. */
const NOTIFICATION_MODE_HINT =
  'Decision requests go to your manager channel at once whenever one is connected. This sets how you hear that work landed or a run stopped.';
