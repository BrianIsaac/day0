'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { errorMessage } from '@/lib/errors';

/**
 * The demo reset: wipes every employee and what it made, and optionally
 * unlinks the owner's documentation. Disabled while there is nothing to wipe.
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
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onReset(): Promise<void> {
    const documentationNote = alsoUnlinkDocumentation
      ? ' and unlink every documentation source'
      : '';
    if (!confirm(`Delete every employee and its data${documentationNote}? This cannot be undone.`))
      return;
    setResetting(true);
    setError(null);
    try {
      await reset({ alsoUnlinkDocumentation });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResetting(false);
    }
  }

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
        <button
          type="button"
          // The handler reports its own failure on the card; nothing is left to reject.
          onClick={() => void onReset()}
          disabled={resetting || (!hasEmployees && (!alsoUnlinkDocumentation || !hasDocumentation))}
          className="inline-flex min-h-11 shrink-0 items-center self-start whitespace-nowrap rounded-lg border border-[var(--color-danger)]/40 px-4 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 disabled:opacity-50 sm:self-center"
        >
          {resetting ? 'Resetting…' : 'Reset everything'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
