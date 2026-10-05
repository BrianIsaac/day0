'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import Link from 'next/link';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DEFAULT_AGENT_AVATAR, avatarById } from '@/agent/avatar-pets';
import { UNVERIFIED_FOR_DEPLOY } from '@/agent/manager-address';
import { EMPLOYEE_NAME_MAX_CHARS } from '@/agent/employee-name';
import { deploymentZone } from '@/lib/zone';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { AvatarPicker } from './AvatarPicker';
import { AgentPixelAvatar } from './PixelAvatar';

/** Where a new employee works, by the deployment's surface mode. */
const WORKS_IN = {
  mock: 'the mock office: a Slack, the Q4 Revenue Tracker, a wiki, a ticket queue and one social mention',
  real: 'the systems it finds in your documentation, each connected only once you approve it',
} as const;

/**
 * How much a new employee does on its own, by the deployment's surface mode: every deploy starts
 * supervised. The hosted office holds every action, a message to the manager included, so the
 * copy follows the gate there (the hosted walk's m4).
 */
const AUTONOMY = {
  mock: 'Supervised. In the hosted office every action waits for you, a message to you included, and applies once you approve its exact payload.',
  real: 'Supervised. Reads and messages to you apply on their own; every other action waits for your approval of the exact payload.',
} as const;

/**
 * What a failed deploy says: a refusal the backend wrote for the manager (a `ConvexError`'s
 * words), else the failure's own message.
 */
function deployFailure(err: unknown): string {
  return err instanceof ConvexError && typeof err.data === 'string' ? err.data : errorMessage(err);
}

/**
 * Who the new employee reports to, as the facts line reads: the server's verified address for
 * this caller once it has loaded.
 */
function reportsTo(address: string | null | undefined): string {
  if (address === undefined) return 'loading';
  if (address === null) return 'no verified address';
  return `${address} (you)`;
}

/** One documentation source the form offers to leave out. */
interface DocSourceChoice {
  readonly _id: Id<'docSources'>;
  readonly label: string;
}

/**
 * The deploy form: the face (behind a disclosure, above the name as the
 * product has it), the name, the documentation the employee reads, and the
 * three facts the manager is agreeing to (who it reports to, where it works,
 * how much it does alone). Deploying opens the new employee's page.
 *
 * The address shown and stored is the one the caller's own sign-in proves, read from the server
 * (`agents.myManagerAddress`); the browser's copy of it is neither shown nor sent.
 *
 * @param docSources - The owner's documentation sources, undefined while they load.
 * @param surfaceMode - Whether the deployment runs the mock office or real systems.
 * @param pickerOpen - Whether the faces show at first: for the first employee they do.
 * @param onCancel - Closes the form, where the page offers it as "Deploy another".
 * @param focusOnMount - Puts the caret in the name field when the form opens on request.
 */
export function DeployForm({
  docSources,
  surfaceMode,
  pickerOpen,
  onCancel,
  focusOnMount = false,
}: {
  docSources: readonly DocSourceChoice[] | undefined;
  surfaceMode: 'mock' | 'real' | undefined;
  pickerOpen: boolean;
  onCancel?: () => void;
  focusOnMount?: boolean;
}) {
  const router = useRouter();
  const deploy = useMutation(api.agents.deploy);
  const managerAddress = useQuery(api.agents.myManagerAddress);
  // Empty, as the page asks for a name: a prefilled one read as the field's example (13-FD).
  const [name, setName] = useState('');
  const [avatarId, setAvatarId] = useState(DEFAULT_AGENT_AVATAR.id);
  const [excludedSourceIds, setExcludedSourceIds] = useState<Id<'docSources'>[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const nameId = useId();
  const nameHelpId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const avatar = avatarById(avatarId);
  const trimmed = name.trim();

  useEffect(() => {
    if (focusOnMount) nameInput.current?.focus();
  }, [focusOnMount]);

  async function onDeploy(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // The button is held in both cases; Enter in the name field still submits.
    if (!trimmed || !managerAddress) return;
    setSubmitting(true);
    setError(null);
    try {
      const agentId = await deploy({
        name: trimmed,
        avatarId: avatar.id,
        // Only the unticked sources travel. Sending the ticked ones as an
        // explicit list would freeze inheritance at deploy time, so a location
        // linked later would never reach this employee.
        excludedDocSourceIds: excludedSourceIds.length > 0 ? excludedSourceIds : undefined,
        // The manager's own zone is the employee's day (N12): every stamp on
        // its dashboard and every day boundary the server draws follow it.
        zone: deploymentZone(),
      });
      // The seed is fire-and-forget by design (P9-10): the page navigates
      // away on the next line, so a failed post is logged here and otherwise
      // shows where it is felt, as an empty mock office on the dashboard.
      void fetch('/api/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      }).then(
        (response): void => {
          if (!response.ok) log.warn('mock seed refused', { agentId, status: response.status });
        },
        (err: unknown): void =>
          log.warn('mock seed not sent', { agentId, reason: errorMessage(err) }),
      );
      router.push(`/agent/${agentId}`);
    } catch (err) {
      setError(deployFailure(err));
      setSubmitting(false);
    }
  }

  return (
    <form
      id="deploy-form"
      aria-labelledby={headingId}
      // The handler reports its own failures in the form; nothing is left to reject.
      onSubmit={(event) => void onDeploy(event)}
      className="flex flex-col gap-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5"
    >
      <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
        <AgentPixelAvatar
          avatar={avatar}
          state="deployed"
          label={trimmed || 'Your new employee'}
          size="lg"
        />
        <div className="min-w-0">
          <h2 id={headingId} className="mb-3 text-base font-semibold">
            Deploy a new Day0 employee
          </h2>
          <AvatarPicker selectedId={avatarId} onSelect={setAvatarId} defaultOpen={pickerOpen} />
          <label htmlFor={nameId} className="mb-1.5 block text-sm">
            Name
          </label>
          <input
            ref={nameInput}
            id={nameId}
            type="text"
            required
            maxLength={EMPLOYEE_NAME_MAX_CHARS}
            disabled={submitting}
            // The bed rehearsal's driver finds the field by this placeholder (scripts/bed/rehearsal/driver.ts).
            placeholder="worker 1"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-describedby={nameHelpId}
            className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2.5 text-sm focus:border-[var(--color-accent)]"
          />
          <p id={nameHelpId} className="mt-1.5 text-xs text-[var(--color-muted)]">
            The name the team will see. It cannot be changed after deploy.
          </p>
          {docSources && docSources.length > 0 ? (
            <fieldset className="mt-4">
              <legend className="mb-1.5 text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Documentation this employee reads
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {docSources.map((source) => (
                  <label key={source._id} className="flex min-h-11 items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={!excludedSourceIds.includes(source._id)}
                      onChange={(event) =>
                        setExcludedSourceIds((current) =>
                          event.target.checked
                            ? current.filter((id) => id !== source._id)
                            : [...current, source._id],
                        )
                      }
                    />
                    {source.label}
                  </label>
                ))}
                <Link
                  href="/documentation"
                  className="inline-flex min-h-11 items-center text-sm text-[var(--color-accent)]"
                >
                  Manage
                </Link>
              </div>
            </fieldset>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-[var(--color-muted)]">Reports to</dt>
        <dd aria-live="polite">{reportsTo(managerAddress)}</dd>
        <dt className="text-[var(--color-muted)]">Works in</dt>
        <dd>{surfaceMode ? WORKS_IN[surfaceMode] : 'loading'}</dd>
        <dt className="text-[var(--color-muted)]">Autonomy</dt>
        <dd>{surfaceMode ? AUTONOMY[surfaceMode] : 'loading'}</dd>
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={submitting || !managerAddress}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-50"
        >
          {/* Exactly "Deploy": the bed rehearsal's driver presses the button by that name. */}
          {submitting ? 'Deploying…' : 'Deploy'}
        </button>
        <span className="text-xs text-[var(--color-muted)]">
          {`Takes a few seconds, then ${trimmed || 'your new employee'} asks you for a Day-1 one-to-one.`}
        </span>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="ml-auto min-h-11 rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {managerAddress === null ? (
        <p role="status" className="text-sm text-[var(--color-danger)]">
          {UNVERIFIED_FOR_DEPLOY}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-[var(--color-muted)]">
        Avatar art from the product’s own set, the Singapore Codex Pets gallery. No person is named
        here.
      </p>
    </form>
  );
}
