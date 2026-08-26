'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import {
  presentSurfaceCredential,
  type CredentialOwnerSummary,
  type CredentialPresentation,
  type SurfaceCredentialFinding,
} from '@/surfaces/credential-presentation';
import { pageLinkFromQuote } from '@/surfaces/evidence';
import { extractDocumentedSystemOrder, orderSurfaceWaterfall } from '@/surfaces/waterfall';

type SurfaceEvidence = {
  sourceId?: string;
  ref?: string;
  quote?: string;
  url?: string;
};

type ConnectRequestBody = {
  target?: { reasoning?: string; fallbackPath?: string; confidence?: number };
  evidence?: SurfaceEvidence[];
  scopeRequested?: string[];
  credential?: SurfaceCredentialFinding;
  registrySuggestion?: { endpoint?: string; note?: string };
  blastRadius?: string;
  costBand?: string;
  expiresInDays?: number;
  rollback?: string;
  openQuestions?: string[];
};

type Operation = {
  error?: string;
  kind: 'landing' | 'probe';
  surfaceId: string;
};

const credentialSummariesQuery = makeFunctionReference<
  'query',
  Record<string, never>,
  CredentialOwnerSummary[]
>('credentials:summaryForOwner');

export interface CredentialRowProps {
  credentialLabel: string;
  error?: string;
  landing: boolean;
  onLand: (plaintext: string) => void;
  presentation: CredentialPresentation;
}

/**
 * Render safe credential metadata and an uncontrolled write-only landing form.
 *
 * Args:
 *   props: Presentation copy, operation state and landing callback.
 *
 * Returns:
 *   Credential metadata that never places plaintext in React state.
 */
export function CredentialRow(props: CredentialRowProps): React.ReactNode {
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('credential');
    form.reset();
    if (typeof value === 'string' && value.trim()) props.onLand(value);
  }

  return (
    <div className="mt-3 rounded border border-[var(--color-border)] p-2 text-xs">
      <p>
        <span className="text-[var(--color-muted)]">Credential: </span>
        {props.presentation.label ? `${props.presentation.label} - ` : ''}
        {props.presentation.text}
      </p>
      {props.presentation.kind === 'oauth' ? (
        <p className="mt-1 text-[var(--color-muted)]">
          OAuth approval procedure
          {props.presentation.detail ? `: ${props.presentation.detail}` : ''}
        </p>
      ) : null}
      {props.presentation.governanceFinding ? (
        <p className="mt-1 text-[var(--color-warn)]">{props.presentation.governanceFinding}</p>
      ) : null}
      {props.presentation.canLand && props.presentation.landingNote ? (
        <p className="mt-1 text-[var(--color-muted)]">{props.presentation.landingNote}</p>
      ) : null}
      {props.presentation.canLand ? (
        <form onSubmit={onSubmit} className="mt-2 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor={`credential-${props.credentialLabel}`}>
            Credential value for {props.credentialLabel}
          </label>
          <input
            id={`credential-${props.credentialLabel}`}
            name="credential"
            type="password"
            autoComplete="new-password"
            required
            placeholder="Enter credential"
            className="min-w-48 flex-1 rounded border bg-transparent px-2 py-1"
          />
          <button
            type="submit"
            disabled={props.landing}
            className="rounded border px-2 py-1 disabled:opacity-50"
          >
            {props.landing ? 'Landing...' : (props.presentation.landingLabel ?? 'Land credential')}
          </button>
        </form>
      ) : null}
      {props.error ? <p className="mt-1 text-[var(--color-danger)]">{props.error}</p> : null}
    </div>
  );
}

/** Render evidence-backed connection requests and absence verdicts. */
/**
 * One evidence quote: an index tag becomes the page title linked to the page,
 * anything else is shown as stored.
 */
export function EvidenceQuote({ quote }: { quote?: string }): React.ReactNode {
  const link = pageLinkFromQuote(quote);
  if (!link) return <>{quote}</>;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--color-fg)] underline decoration-[var(--color-border)]"
    >
      {link.title}
    </a>
  );
}

export function SurfacesTab({ agentId }: { agentId: Id<'agents'> }): React.ReactNode {
  const surfaces = useQuery(api.surfaces.listForAgent, { agentId });
  const pages = useQuery(api.docSources.pagesForAgent, { agentId });
  const credentialRows = useQuery(credentialSummariesQuery, {});
  const credentialSummaries = credentialRows;
  const sourceIds = useMemo((): Id<'docSources'>[] => {
    const evidenceSourceIds = (surfaces ?? []).flatMap((surface) =>
      (surface.whereFound as SurfaceEvidence[]).flatMap((item: SurfaceEvidence): string[] =>
        item.sourceId ? [item.sourceId] : [],
      ),
    );
    const credentialSourceIds = (credentialSummaries ?? []).flatMap(
      (summary: CredentialOwnerSummary): string[] =>
        typeof summary.source === 'object' ? [summary.source.sourceId] : [],
    );
    return [...new Set([...evidenceSourceIds, ...credentialSourceIds])] as Id<'docSources'>[];
  }, [credentialSummaries, surfaces]);
  const sources = useQuery(api.docSources.byIds, { sourceIds });
  const sourceLabels = useMemo(
    (): Map<string, string> =>
      new Map((sources ?? []).map((source): [string, string] => [source._id, source.label])),
    [sources],
  );
  const credentialById = useMemo(
    (): Map<string, CredentialOwnerSummary> =>
      new Map(
        (credentialSummaries ?? []).map(
          (summary: CredentialOwnerSummary): [string, CredentialOwnerSummary] => [
            String(summary._id),
            summary,
          ],
        ),
      ),
    [credentialSummaries],
  );
  const documentedNames = useMemo(
    (): string[] =>
      extractDocumentedSystemOrder(
        (pages ?? []).map((page): { content: string; title: string } => ({
          title: page.title,
          content: page.markdown,
        })),
      ),
    [pages],
  );
  const orderedSurfaces = useMemo(
    () => orderSurfaceWaterfall(surfaces ?? [], documentedNames),
    [documentedNames, surfaces],
  );
  const approve = useMutation(api.surfaces.approve);
  const reject = useMutation(api.surfaces.reject);
  const reorient = useAction(api.surfaces.reorient);
  const probe = useAction(api.surfaceActions.probe);
  const landCredential = useAction(api.surfaceActions.landCredential);
  const [reorienting, setReorienting] = useState(false);
  const [reorientError, setReorientError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);

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

  async function onProbe(surfaceId: Id<'surfaces'>): Promise<void> {
    setOperation({ kind: 'probe', surfaceId });
    try {
      await probe({ surfaceId });
      setOperation(null);
    } catch (failure) {
      setOperation({ kind: 'probe', surfaceId, error: (failure as Error).message });
    }
  }

  async function onLand(
    surfaceId: Id<'surfaces'>,
    label: string,
    plaintext: string,
  ): Promise<void> {
    setOperation({ kind: 'landing', surfaceId });
    try {
      await landCredential({ surfaceId, label, plaintext });
      setOperation(null);
    } catch (failure) {
      setOperation({ kind: 'landing', surfaceId, error: (failure as Error).message });
    }
  }

  if (!surfaces || !pages || !credentialRows)
    return <p className="text-xs text-[var(--color-muted)]">loading surfaces...</p>;
  if (surfaces.length === 0)
    return (
      <p className="text-xs text-[var(--color-muted)]">Surfaces appear after charter approval.</p>
    );
  const declared = surfaces.filter((surface): boolean => surface.verdict === 'declared');

  return (
    <div className="space-y-3">
      {declared.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[var(--color-muted)]">
            {declared.length} declared {declared.length === 1 ? 'system has' : 'systems have'} no
            proposal yet.
          </span>
          <button
            onClick={(): void => void onReorient()}
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
        {orderedSurfaces.map((surface, index): React.ReactNode => {
          const request = surface.request as ConnectRequestBody | undefined;
          const evidence = request?.evidence ?? (surface.whereFound as SurfaceEvidence[]);
          const summary = surface.credentialId
            ? credentialById.get(String(surface.credentialId))
            : undefined;
          const summarySourceLabel =
            summary && typeof summary.source === 'object'
              ? sourceLabels.get(summary.source.sourceId)
              : undefined;
          const presentation = presentSurfaceCredential({
            credential: request?.credential,
            credentialId: surface.credentialId ? String(surface.credentialId) : undefined,
            credentialLocation: surface.credentialLocation,
            sourceLabel: summarySourceLabel,
            summary,
          });
          const currentOperation = operation?.surfaceId === surface._id ? operation : undefined;
          const canProbe = ['approved', 'connected', 'ungranted', 'listed-dead'].includes(
            surface.verdict,
          );
          const derivedSkipReason = ['absent', 'ungranted', 'listed-dead'].includes(surface.verdict)
            ? (surface.reason ?? `Surface is ${surface.verdict}.`)
            : undefined;
          const skipReason = surface.intakeSkipReason ?? derivedSkipReason;
          return (
            <article
              id={`surface-${surface.slug}`}
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
                Waterfall {surface.waterfallPosition ?? index + 1} - {surface.class} -{' '}
                {surface.path || 'no approved path'}
              </p>
              {skipReason ? (
                <p className="mt-1 text-xs text-[var(--color-warn)]">Skipped: {skipReason}</p>
              ) : null}
              {surface.endpoint ? (
                <p className="mt-1 break-all font-mono text-[10px] text-[var(--color-muted)]">
                  {surface.endpoint}
                </p>
              ) : null}
              {surface.reason && !skipReason ? (
                <p className="mt-3 text-xs">{surface.reason}</p>
              ) : null}
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
                    {request.expiresInDays
                      ? `${request.expiresInDays} ${request.expiresInDays === 1 ? 'day' : 'days'}`
                      : 'not stated'}
                  </dd>
                  <dt className="text-[var(--color-muted)]">Rollback</dt>
                  <dd>{request.rollback || 'not stated'}</dd>
                </dl>
              ) : null}
              {request || surface.credentialId || surface.credentialLocation ? (
                <CredentialRow
                  credentialLabel={presentation.label ?? `${surface.displayName} credential`}
                  error={currentOperation?.kind === 'landing' ? currentOperation.error : undefined}
                  landing={currentOperation?.kind === 'landing' && !currentOperation.error}
                  onLand={(plaintext: string): void => {
                    void onLand(
                      surface._id,
                      presentation.label ?? `${surface.displayName} credential`,
                      plaintext,
                    );
                  }}
                  presentation={presentation}
                />
              ) : null}
              {evidence.map((item: SurfaceEvidence, evidenceIndex: number): React.ReactNode => {
                const source = item.sourceId ? sourceLabels.get(item.sourceId) : undefined;
                const label = [source || 'manager 1:1', item.ref].filter(Boolean).join(' / ');
                return (
                  <blockquote
                    key={`${item.ref}-${evidenceIndex}`}
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
                    <EvidenceQuote quote={item.quote} />
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
                      onClick={(): void =>
                        void approve({ surfaceId: surface._id, role: 'manager' })
                      }
                      className="rounded border px-2 py-1 text-xs"
                    >
                      Approve as manager
                    </button>
                  )}
                  {surface.itApprovedAt ? (
                    <span className="rounded border px-2 py-1 text-xs">IT approved</span>
                  ) : (
                    <button
                      onClick={(): void => void approve({ surfaceId: surface._id, role: 'it' })}
                      className="rounded border px-2 py-1 text-xs"
                    >
                      Approve as IT
                    </button>
                  )}
                  <button
                    onClick={(): void =>
                      void reject({
                        surfaceId: surface._id,
                        reason: 'Rejected by the operator.',
                      })
                    }
                    className="text-xs text-[var(--color-danger)]"
                  >
                    Reject
                  </button>
                </div>
              ) : null}
              {surface.verdict === 'proposed' ? (
                <p className="mt-2 text-[10px] text-[var(--color-muted)]">
                  Probe runs automatically after both approvals.
                </p>
              ) : null}
              {canProbe ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={(): void => void onProbe(surface._id)}
                    disabled={currentOperation?.kind === 'probe' && !currentOperation.error}
                    className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                  >
                    {currentOperation?.kind === 'probe' && !currentOperation.error
                      ? 'Probing...'
                      : 'Probe'}
                  </button>
                  {currentOperation?.kind === 'probe' && currentOperation.error ? (
                    <span className="text-xs text-[var(--color-danger)]">
                      {currentOperation.error}
                    </span>
                  ) : null}
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
