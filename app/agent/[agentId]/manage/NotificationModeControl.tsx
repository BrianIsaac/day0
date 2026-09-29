'use client';

import { type ManagerNotificationMode, NOTIFICATION_MODE_LABELS } from '@/work/manager-notes';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';

/**
 * How the manager hears about run outcomes over the chat surface: as each run finishes, or in
 * one hourly digest. Decision requests are sent at once in either mode, so the choice only
 * quietens what is for information. A labelled select with what it does beneath it; what the
 * change came to is said in a live region and focus stays on the select.
 *
 * @param mode - The current mode.
 * @param onChange - Persist the manager's choice.
 */
export function NotificationModeControl({
  mode,
  onChange,
}: {
  mode: ManagerNotificationMode;
  onChange: (mode: ManagerNotificationMode) => Promise<unknown>;
}) {
  const change = useChange();
  return (
    <div className="grid gap-2">
      <Field label="Manager DMs" hint={NOTIFICATION_MODE_HINT}>
        {(control) => (
          <select
            {...control}
            value={mode}
            disabled={change.busy}
            onChange={(event) => {
              const next = event.target.value as ManagerNotificationMode;
              change.run(() => onChange(next), {
                done: `Manager DMs: ${NOTIFICATION_MODE_LABELS[next]}.`,
                refused: 'The manager DM setting was not changed.',
              });
            }}
            className={`${INPUT_CLASS} w-full disabled:cursor-wait`}
          >
            {(Object.keys(NOTIFICATION_MODE_LABELS) as ManagerNotificationMode[]).map((option) => (
              <option key={option} value={option}>
                {NOTIFICATION_MODE_LABELS[option]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <StatusRegion outcome={change.outcome} />
    </div>
  );
}

/** What the manager DM setting does, beneath the control. */
const NOTIFICATION_MODE_HINT =
  'Decision requests go to your manager channel at once whenever one is connected. This sets how you hear that work landed or a run stopped.';
