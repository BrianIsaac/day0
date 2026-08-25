'use client';

import { useMemo, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

type SurfaceEvidence = {
  sourceId?: string;
  ref?: string;
  quote?: string;
  url?: string;
};

type ConnectRequestBody = {
  target?: {
    reasoning?: string;
    fallbackPath?: string;
    confidence?: number;
  };
  evidence?: SurfaceEvidence[];
  scopeRequested?: string[];
  credential?: { owner?: string; method?: string; envName?: string };
  registrySuggestion?: { endpoint?: string; note?: string };
  blastRadius?: string;
  costBand?: string;
  expiresInDays?: number;
  rollback?: string;
  openQuestions?: string[];
};

/** Render evidence-backed connection requests and absence verdicts. */
export function SurfacesTab({ agentId }: { agentId: Id<'agents'> }): React.ReactNode {
  const surfaces = useQuery(api.surfaces.listForAgent, { agentId });
  const sourceIds = useMemo(
    (): Id<'docSources'>[] =>
      [
        ...new Set(
          (surfaces ?? []).flatMap((surface) =>
            (surface.whereFound as SurfaceEvidence[]).flatMap((item) =>
              item.sourceId ? [item.sourceId] : [],
            ),
          ),
        ),
      ] as Id<'docSources'>[],
    [surfaces],
  );
  const sources = useQuery(api.docSources.byIds, { sourceIds });
  const sourceLabels = useMemo(
    (): Map<string, string> =>
      new Map((sources ?? []).map((source): [string, string] => [source._id, source.label])),
    [sources],
  );
  const approve = useMutation(api.surfaces.approve);
  const reject = useMutation(api.surfaces.reject);
  const reorient = useAction(api.surfaces.reorient);
  const [reorienting, setReorienting] = useState(false);
  const [reorientError, setReorientError] = useState<string | null>(null);
  if (!surfaces) return <p className="text-xs text-[var(--color-muted)]">loading surfaces...</p>;
  if (surfaces.length === 0)
    return (
      <p className="text-xs text-[var(--color-muted)]">Surfaces appear after charter approval.</p>
    );
  const declared = surfaces.filter((surface) => surface.verdict === 'declared');

  async function onReorient(): Promise<void> {
    setReorienting(true);
    setReorientError(null);
    try {
      await reorient({ agentId });
    } catch (failure) {
      setReorientError((failure as Error).message);
    } finally {
      setReorienting(false);
    }
  }

  return (
    <div className="space-y-3">
      {declared.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[var(--color-muted)]">
            {declared.length} declared {declared.length === 1 ? 'system has' : 'systems have'} no
            proposal yet.
          </span>
          <button
            onClick={() => void onReorient()}
            disabled={reorienting}
            className="rounded border px-2 py-1 text-xs disabled:opacity-50"
          >
            {reorienting ? 'Re-running orientation...' : 'Re-run orientation'}
          </button>
          {reorientError ? (
            <span className="text-[var(--color-danger)]">{reorientError}</span>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {surfaces.map((surface) => {
          const request = surface.request as ConnectRequestBody | undefined;
          const evidence = request?.evidence ?? (surface.whereFound as SurfaceEvidence[]);
          return (
            <article
              key={surface._id}
              className="rounded-lg border border-[var(--color-border)] p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium">{surface.displayName}</h3>
                <span className="text-[10px] uppercase text-[var(--color-accent)]">
                  {surface.verdict}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                {surface.class} - {surface.path || 'no approved path'}
              </p>
              {surface.endpoint ? (
                <p className="mt-1 break-all font-mono text-[10px] text-[var(--color-muted)]">
                  {surface.endpoint}
                </p>
              ) : null}
              {surface.reason ? <p className="mt-3 text-xs">{surface.reason}</p> : null}
              {request?.target?.reasoning ? (
                <p className="mt-3 text-xs">{request.target.reasoning}</p>
              ) : null}
              {request ? (
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]">
                  <dt className="text-[var(--color-muted)]">Fallback</dt>
                  <dd>{request.target?.fallbackPath || surface.fallbackPath || 'escalate'}</dd>
                  <dt className="text-[var(--color-muted)]">Confidence</dt>
                  <dd>
                    {request.target?.confidence === undefined
                      ? 'not stated'
                      : `${Math.round(request.target.confidence * 100)}%`}
                  </dd>
                  <dt className="text-[var(--color-muted)]">Scopes</dt>
                  <dd>{request.scopeRequested?.join(', ') || 'none requested'}</dd>
                  <dt className="text-[var(--color-muted)]">Credential</dt>
                  <dd>
                    {[request.credential?.method, request.credential?.envName]
                      .filter(Boolean)
                      .join(' - ') || 'not documented'}
                  </dd>
                  <dt className="text-[var(--color-muted)]">Owner</dt>
                  <dd>{request.credential?.owner || 'not documented'}</dd>
                  {request.registrySuggestion?.endpoint ? (
                    <>
                      <dt className="text-[var(--color-muted)]">Registry suggestion</dt>
                      <dd className="break-all">
                        <span className="font-mono">{request.registrySuggestion.endpoint}</span>
                        <span className="block text-[var(--color-warn)]">
                          {request.registrySuggestion.note ||
                            'Not linked evidence; IT confirms and enters the endpoint.'}
                        </span>
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-[var(--color-muted)]">Blast radius</dt>
                  <dd>{request.blastRadius || 'not stated'}</dd>
                  <dt className="text-[var(--color-muted)]">Cost / expiry</dt>
                  <dd>
                    {request.costBand || 'not stated'} /{' '}
                    {request.expiresInDays ? `${request.expiresInDays} days` : 'not stated'}
                  </dd>
                  <dt className="text-[var(--color-muted)]">Rollback</dt>
                  <dd>{request.rollback || 'not stated'}</dd>
                </dl>
              ) : null}
              {evidence.map((item: SurfaceEvidence, index: number) => {
                const source = item.sourceId ? sourceLabels.get(item.sourceId) : undefined;
                const label = [source || 'manager 1:1', item.ref].filter(Boolean).join(' / ');
                return (
                  <blockquote
                    key={`${item.ref}-${index}`}
                    className="mt-2 border-l border-[var(--color-border)] pl-2 text-xs"
                  >
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--color-accent)] underline"
                      >
                        {label}
                      </a>
                    ) : (
                      <span className="text-[var(--color-muted)]">{label}</span>
                    )}
                    <br />
                    {item.quote}
                  </blockquote>
                );
              })}
              {request?.openQuestions?.length ? (
                <p className="mt-3 text-[10px] text-[var(--color-muted)]">
                  Open: {request.openQuestions.join(' ')}
                </p>
              ) : null}
              {surface.verdict === 'absent' ? (
                <p className="mt-3 text-xs text-[var(--color-warn)]">
                  Ask the manager for an approved access path.
                </p>
              ) : null}
              {surface.verdict === 'proposed' ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {surface.managerApprovedAt ? (
                    <span className="rounded border px-2 py-1 text-xs">Manager approved</span>
                  ) : (
                    <button
                      onClick={() => void approve({ surfaceId: surface._id, role: 'manager' })}
                      className="rounded border px-2 py-1 text-xs"
                    >
                      Approve as manager
                    </button>
                  )}
                  {surface.itApprovedAt ? (
                    <span className="rounded border px-2 py-1 text-xs">IT approved</span>
                  ) : (
                    <button
                      onClick={() => void approve({ surfaceId: surface._id, role: 'it' })}
                      className="rounded border px-2 py-1 text-xs"
                    >
                      Approve as IT
                    </button>
                  )}
                  <button
                    onClick={() =>
                      void reject({ surfaceId: surface._id, reason: 'Rejected by the operator.' })
                    }
                    className="text-xs text-[var(--color-danger)]"
                  >
                    Reject
                  </button>
                </div>
              ) : null}
              <p className="mt-3 text-[10px] text-[var(--color-muted)]">
                In this local single-user run, manager and IT are the same operator.
              </p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
