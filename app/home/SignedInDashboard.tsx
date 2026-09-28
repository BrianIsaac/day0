'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DEFAULT_AGENT_AVATAR, avatarById, type AgentAvatarPet } from '@/agent/avatar-pets';
import { deploymentZone } from '@/lib/zone';
import { errorMessage } from '@/lib/errors';
import { CompanySupervision } from '../CompanySupervision';
import { AvatarPicker } from './AvatarPicker';
import { EmployeeList } from './EmployeeList';
import { OfficeWorld } from './OfficeWorld';
import { AgentPixelAvatar } from './PixelAvatar';
import type { Boss, RosterRow } from './types';

/** The signed-in home: deploy, the employees, the company's figures and the office. */
export function SignedInDashboard({ boss }: { boss: Boss }) {
  const router = useRouter();
  // The roster is the company the page shows; the raw list still decides
  // whether Reset has anything to wipe, evaluation agents included.
  const agents = useQuery(api.agents.listForUser);
  const roster = useQuery(api.agents.rosterForUser);
  const docSources = useQuery(api.docSources.listMine);
  const deploy = useMutation(api.agents.deploy);
  const reset = useMutation(api.reset.deleteMyData);
  const [workerName, setWorkerName] = useState('worker 1');
  const [selectedAvatarId, setSelectedAvatarId] = useState(DEFAULT_AGENT_AVATAR.id);
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excludedSourceIds, setExcludedSourceIds] = useState<Id<'docSources'>[]>([]);
  const [alsoUnlinkDocumentation, setAlsoUnlinkDocumentation] = useState(false);
  const selectedAvatar = avatarById(selectedAvatarId);

  async function onDeploy(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!workerName.trim()) return;
    const bossEmail = boss.email;
    if (!bossEmail) {
      setError('Could not read your email address - try signing out and back in.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const agentId = await deploy({
        bossEmail,
        name: workerName.trim(),
        avatarId: selectedAvatar.id,
        // Only the unticked sources travel. Sending the ticked ones as an
        // explicit list would freeze inheritance at deploy time, so a location
        // linked later would never reach this agent.
        excludedDocSourceIds: excludedSourceIds.length > 0 ? excludedSourceIds : undefined,
        // The manager's own zone is the employee's day (N12): every stamp on
        // its dashboard and every day boundary the server draws follow it.
        zone: deploymentZone(),
      });
      // The seed is fire-and-forget by design (P9-10): the page navigates
      // away on the next line, so a failed post can only show where it is
      // felt, as an empty mock office on the dashboard.
      fetch('/api/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      }).catch((): void => undefined);
      router.push(`/agent/${agentId}`);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  async function onReset() {
    const documentationNote = alsoUnlinkDocumentation
      ? ' and unlink every documentation source'
      : '';
    if (!confirm(`Delete all your agents + their data${documentationNote}? This cannot be undone.`))
      return;
    setResetting(true);
    try {
      await reset({ alsoUnlinkDocumentation });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="flex-1 px-6 py-10 max-w-4xl mx-auto w-full">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight mb-2">
            Welcome{boss.firstName ? `, ${boss.firstName}` : ''}.
          </h1>
          <p className="text-sm text-[var(--color-muted)]">
            Each agent runs the new-hire loop independently. Deploy as many as you like; reset wipes
            the slate clean.
          </p>
        </div>
        <AgentAvatarRail
          employees={roster ?? []}
          previewAvatar={selectedAvatar}
          previewLabel={workerName}
        />
      </div>

      <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5 mb-6">
        <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
          <AgentPixelAvatar avatar={selectedAvatar} state="deployed" label={workerName} size="lg" />
          <div>
            <h2 className="text-sm font-semibold mb-3">Deploy a new Day0 agent</h2>
            <AvatarPicker selectedId={selectedAvatarId} onSelect={setSelectedAvatarId} />
            {(docSources?.length ?? 0) > 0 ? (
              <fieldset className="mb-3">
                <legend className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-1">
                  Documentation this agent reads
                </legend>
                <div className="flex flex-wrap gap-3">
                  {docSources?.map((source) => (
                    <label key={source._id} className="text-xs flex items-center gap-1.5">
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
                  <Link href="/documentation" className="text-xs text-[var(--color-accent)]">
                    manage
                  </Link>
                </div>
              </fieldset>
            ) : null}
            <form onSubmit={onDeploy} className="flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                required
                disabled={submitting}
                placeholder="worker 1"
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
                className="flex-1 px-4 py-2.5 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] text-sm"
              />
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50 text-sm"
              >
                {submitting ? 'Deploying…' : 'Deploy'}
              </button>
            </form>
          </div>
        </div>
        {error ? <p className="text-xs text-[var(--color-danger)] mt-2">{error}</p> : null}
      </section>

      <EmployeeList employees={roster} />

      <CompanySupervision />

      <OfficeWorld agents={roster} />

      <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold mb-1">Reset demo</h2>
            <p className="text-xs text-[var(--color-muted)]">
              Wipe every agent + workspace, charter, work item, skill, and mock environment row
              you&apos;ve created. Useful between demos.
            </p>
            <label className="mt-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={alsoUnlinkDocumentation}
                onChange={(event) => setAlsoUnlinkDocumentation(event.target.checked)}
              />
              Also unlink owner-level documentation locations
            </label>
          </div>
          <button
            onClick={onReset}
            disabled={
              resetting ||
              ((agents?.length ?? 0) === 0 &&
                (!alsoUnlinkDocumentation || (docSources?.length ?? 0) === 0))
            }
            className="shrink-0 whitespace-nowrap px-4 py-2 rounded-lg border border-[var(--color-danger)]/40 text-[var(--color-danger)] text-xs hover:bg-[var(--color-danger)]/10 disabled:opacity-50"
          >
            {resetting ? 'Resetting…' : 'Reset everything'}
          </button>
        </div>
      </section>
    </div>
  );
}

function AgentAvatarRail({
  employees,
  previewAvatar,
  previewLabel,
}: {
  employees: RosterRow[];
  previewAvatar: AgentAvatarPet;
  previewLabel: string;
}) {
  const shown = employees.slice(0, 5);

  return (
    <div className="flex min-h-14 items-center justify-start -space-x-2 sm:justify-end">
      {shown.length > 0 ? (
        shown.map((employee) => (
          <AgentPixelAvatar
            key={employee.agentId}
            avatar={avatarById(employee.avatarId)}
            state={employee.state}
            label={employee.name}
            compact
          />
        ))
      ) : (
        <AgentPixelAvatar avatar={previewAvatar} state="deployed" label={previewLabel} compact />
      )}
    </div>
  );
}
