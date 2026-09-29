'use client';

import { useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { StatusRegion } from '../components/StatusRegion';
import { useChange } from '../components/use-change';

/**
 * What the reset does, said in its confirmation.
 *
 * @param alsoUnlinkDocumentation - Whether the owner's documentation goes too.
 */
export function resetWarning(alsoUnlinkDocumentation: boolean): string {
  return alsoUnlinkDocumentation
    ? 'This deletes every employee and its data, and unlinks every documentation source. It cannot be undone.'
    : 'This deletes every employee and its data. Your documentation stays linked. It cannot be undone.';
}

/**
 * The demo reset: wipes every employee and what it made, and optionally unlinks the owner's
 * documentation. Disabled while there is nothing to wipe. Pressing it opens the shared
 * confirmation dialog, Keep everything focused first; what the reset came to is said beside the
 * button and focus comes back to it.
 *
 * @param hasEmployees - Whether the owner has any agent row, evaluation agents included.
 * @param hasDocumentation - Whether the owner has linked documentation.
 */
export function ResetCard({
  hasEmployees,
  hasDocumentation,
}: {
  hasEmployees: boolean;
  hasDocumentation: boolean;
}) {
  const reset = useMutation(api.reset.deleteMyData);
  const [alsoUnlinkDocumentation, setAlsoUnlinkDocumentation] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const change = useChange(opener);

  const close = (): void => {
    change.clear();
    setConfirming(false);
  };

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="mb-1 text-sm font-semibold">Reset demo</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Wipe every employee and its workspace, charter, work items, skills and mock environment
            rows you’ve created. Useful between demos.
          </p>
          <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={alsoUnlinkDocumentation}
              onChange={(event) => setAlsoUnlinkDocumentation(event.target.checked)}
            />
            Also unlink owner-level documentation locations
          </label>
        </div>
        <Button
          ref={opener}
          variant="danger"
          aria-haspopup="dialog"
          onClick={() => {
            change.clear();
            setConfirming(true);
          }}
          disabled={
            change.busy || (!hasEmployees && (!alsoUnlinkDocumentation || !hasDocumentation))
          }
          className="shrink-0 self-start sm:self-center"
        >
          {change.busy ? 'Resetting…' : 'Reset everything'}
        </Button>
      </div>
      <StatusRegion outcome={confirming ? null : change.outcome} />
      {confirming ? (
        <Dialog
          role="alertdialog"
          title="Reset everything?"
          description={resetWarning(alsoUnlinkDocumentation)}
          onClose={close}
          initialFocus={keep}
          busy={change.busy}
        >
          <StatusRegion outcome={change.outcome} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={keep} size="large" disabled={change.busy} onClick={close}>
              Keep everything
            </Button>
            <Button
              variant="danger"
              size="large"
              disabled={change.busy}
              onClick={() =>
                change.run(() => reset({ alsoUnlinkDocumentation }), {
                  done: (result) =>
                    `Reset: ${result.deleted} ${result.deleted === 1 ? 'employee' : 'employees'} wiped${
                      result.unlinkedSources > 0
                        ? `, ${result.unlinkedSources} documentation ${result.unlinkedSources === 1 ? 'source' : 'sources'} unlinked`
                        : ''
                    }.`,
                  refused: 'Nothing was reset.',
                  after: () => setConfirming(false),
                })
              }
            >
              Reset everything
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
