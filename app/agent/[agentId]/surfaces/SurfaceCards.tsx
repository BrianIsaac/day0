'use client';

import {
  type SurfaceCredentialFinding,
  type CredentialOwnerSummary,
  type SurfaceProvisioning,
  presentSurfaceCredential,
  presentProvisioning,
  presentChannelsNotJoined,
} from '@/surfaces/credential-presentation';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '@convex/_generated/dataModel';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useMemo, useState, useRef } from 'react';
import { extractDocumentedSystemOrder, orderSurfaceWaterfall } from '@/surfaces/waterfall';
import { type ScopePage, scopeFieldsFor, restatedScope } from '@/surfaces/intake-scope';
import { charterNamesWorkSystems, awaitsManagerProposal } from '@/surfaces/charter-cards';
import { useNow } from '../time';
import { useChange, refusalText } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import type { SurfaceDiscoveryEvidence } from '@/docs/system-discovery';
import { presentBrowserComponent } from '@/surfaces/browser';
import {
  SurfaceLadder,
  DiscoveryProvenance,
  IntakeScopeRow,
  ProvisioningRow,
  CredentialRow,
  EvidenceQuote,
  ApprovalRow,
  probeOutcomeText,
  UnnamedSystemsRow,
} from './SurfaceRows';
import { AccessRow, ToolsRow } from './SurfaceControls';

interface SurfaceEvidence {
  sourceId?: string;
  ref?: string;
  quote?: string;
  url?: string;
}

/** What the tab says while the surfaces are loading. */
export const LOADING_SURFACES = 'Loading discovered systems, connection status and evidence…';

/** What the tab says before orientation has discovered anything. */
export const EMPTY_SURFACES =
  'No systems have been discovered yet. After charter approval, orientation maps systems from the linked documentation and shows their connection status here.';

interface ConnectRequestBody {
  target?: {
    reasoning?: string;
    fallbackPath?: string;
    confidence?: number;
    ladder?: Array<{ path: string; endpoint: string }>;
  };
  evidence?: SurfaceEvidence[];
  scopeRequested?: string[];
  credential?: SurfaceCredentialFinding;
  registrySuggestion?: { endpoint?: string; note?: string };
  blastRadius?: string;
  costBand?: string;
  rollback?: string;
  openQuestions?: string[];
}

interface Operation {
  error?: string;
  kind: 'approve' | 'landing' | 'probe' | 'propose' | 'provision' | 'reject';
  surfaceId: string;
}

/** A stored credential as `credentials.summaryForOwner` lists it, with what the store says of it. */
interface CredentialStatus extends CredentialOwnerSummary {
  readonly revokedAt?: number;
  readonly status?: 'suspect' | 'superseded';
  readonly statusReason?: string;
}

const credentialSummariesQuery = makeFunctionReference<
  'query',
  Record<string, never>,
  CredentialStatus[]
>('credentials:summaryForOwner');

/**
 * What the credential store says about a stored credential: revoked, or a
 * status the sync or a rotation set, with its reason (U19 D5). Nothing for a
 * credential that is simply live.
 */
export function credentialStatusLine(
  summary: Pick<CredentialStatus, 'revokedAt' | 'status' | 'statusReason'> | undefined,
): string | undefined {
  if (!summary) return undefined;
  const reason = summary.statusReason?.trim();
  const tail = reason ? `: ${reason.replace(/\.$/, '')}.` : '.';
  if (summary.revokedAt !== undefined) return `Revoked${tail}`;
  if (summary.status === 'suspect') return `Suspect${tail}`;
  if (summary.status === 'superseded') return `Superseded${tail}`;
  return undefined;
}

/** The real-mode Surfaces tab's cards: every discovered system with its connection state, evidence and controls. */
export function SurfaceCards({ agentId }: { agentId: Id<'agents'> }): React.ReactNode {
  const surfaces = useQuery(api.surfaces.listForAgent, { agentId });
  const pages = useQuery(api.docSources.pagesForAgent, { agentId });
  const charter = useQuery(api.charters.latest, { agentId });
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
    const discoverySourceIds = (surfaces ?? []).flatMap((surface) =>
      (surface.discoveryEvidence ?? []).flatMap((item): string[] =>
        item.sourceId ? [item.sourceId] : [],
      ),
    );
    const scopeSourceIds = (surfaces ?? []).flatMap((surface) => {
      const scope = surface.intakeScope;
      return [
        scope?.team,
        scope?.project,
        ...(scope?.projects ?? []),
        ...(scope?.channels ?? []),
      ].flatMap((value): string[] => (value?.sourceId ? [value.sourceId] : []));
    });
    return [
      ...new Set([
        ...evidenceSourceIds,
        ...discoverySourceIds,
        ...scopeSourceIds,
        ...credentialSourceIds,
      ]),
    ] as Id<'docSources'>[];
  }, [credentialSummaries, surfaces]);
  const sources = useQuery(api.docSources.byIds, { sourceIds });
  const sourceLabels = useMemo(
    (): Map<string, string> =>
      new Map((sources ?? []).map((source): [string, string] => [source._id, source.label])),
    [sources],
  );
  const credentialById = useMemo(
    (): Map<string, CredentialStatus> =>
      new Map(
        (credentialSummaries ?? []).map((summary: CredentialStatus): [string, CredentialStatus] => [
          String(summary._id),
          summary,
        ]),
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
  const scopePages = useMemo(
    (): ScopePage[] =>
      (pages ?? []).map(
        (page): ScopePage => ({
          sourceId: String(page.sourceId),
          ref: page.ref,
          markdown: page.markdown,
        }),
      ),
    [pages],
  );
  // The server orients only what the approved charter names; the card list
  // follows the same rule, so what waits for the manager's Propose is listed
  // under the cards rather than shown as a card that will never be filed.
  const charterNamesSystems =
    charter?.approved === true &&
    charterNamesWorkSystems(
      (charter.body as { namedSystems?: Array<{ class: string }> } | null)?.namedSystems,
    );
  const awaitingProposal = orderedSurfaces.filter((surface): boolean =>
    awaitsManagerProposal(surface, charterNamesSystems),
  );
  const cardSurfaces = orderedSurfaces.filter(
    (surface): boolean => !awaitsManagerProposal(surface, charterNamesSystems),
  );
  const approve = useMutation(api.surfaces.approve);
  const reject = useMutation(api.surfaces.reject);
  const setAccessDays = useMutation(api.surfaces.setAccessDays);
  const approveTools = useMutation(api.surfaces.approveTools);
  const now = useNow();
  const reorient = useAction(api.surfaces.reorient);
  const requestProposal = useMutation(api.surfaces.requestProposal);
  const probe = useAction(api.surfaceActions.probe);
  const landCredential = useAction(api.surfaceActions.landCredential);
  const provisionApp = useAction(api.slackProvisionActions.provisionApp);
  const installRedirectConfigured = useQuery(api.surfaces.installRedirectConfigured, {});
  const componentStatus = useQuery(api.config.components, {});
  // One change per card at a time, and each card's own: a card's refusal or
  // pending state outlives a change made on another card meanwhile.
  const [operations, setOperations] = useState<Readonly<Record<string, Operation>>>({});
  // Where focus goes when the control that made a change leaves with it (the
  // Approve buttons become the card's verdict): the card, set per change.
  const cardFocus = useRef<HTMLElement | null>(null);
  const change = useChange(cardFocus);
  const [reorienting, setReorienting] = useState(false);
  const [reorientError, setReorientError] = useState<string | null>(null);

  /** Set one card's operation, or clear it with `undefined`. */
  function putOperation(surfaceId: string, next: Operation | undefined): void {
    setOperations((current) => {
      const rest = Object.fromEntries(
        Object.entries(current).filter(([id]): boolean => id !== surfaceId),
      );
      return next ? { ...rest, [surfaceId]: next } : rest;
    });
  }

  /**
   * One change to one card: the card shows it in flight and keeps its refusal
   * beside the control, and the tab's live region says what it came to.
   */
  function operate<Result>(
    kind: Operation['kind'],
    surface: { readonly _id: Id<'surfaces'>; readonly slug: string },
    call: () => Promise<Result>,
    words: { done: string | ((result: Result) => string); refused: string },
  ): void {
    putOperation(surface._id, { kind, surfaceId: surface._id });
    // An unnamed system has no card yet: its disclosure stands in for it.
    cardFocus.current =
      document.getElementById(`surface-${surface.slug}`) ??
      document.activeElement?.closest('details')?.querySelector<HTMLElement>('summary') ??
      null;
    change.run(
      async (): Promise<Result> => {
        try {
          return await call();
        } catch (failure) {
          putOperation(surface._id, {
            kind,
            surfaceId: surface._id,
            error: refusalText(failure, words.refused),
          });
          throw failure;
        }
      },
      { ...words, after: () => putOperation(surface._id, undefined) },
    );
  }

  function onReorient(): void {
    setReorientError(null);
    setReorienting(true);
    change.run(
      async (): Promise<void> => {
        try {
          await reorient({ agentId });
        } catch (failure) {
          setReorientError(refusalText(failure, 'Orientation did not run again.'));
          throw failure;
        } finally {
          setReorienting(false);
        }
      },
      {
        done: 'Orientation is running again for the declared systems; their cards update here.',
        refused: 'Orientation did not run again.',
      },
    );
  }

  if (!surfaces || !pages || !credentialRows || charter === undefined)
    return <p className="text-xs text-[var(--color-muted)]">{LOADING_SURFACES}</p>;
  if (surfaces.length === 0)
    return <p className="text-xs text-[var(--color-muted)]">{EMPTY_SURFACES}</p>;
  const declared = cardSurfaces.filter((surface): boolean => surface.verdict === 'declared');
  const proposeOperation = Object.values(operations).find(
    (entry): boolean => entry.kind === 'propose',
  );

  return (
    <div className="space-y-3">
      {/* A refusal is said once, by the alert beside the control that met it;
          what a change that landed came to is said here, once for the tab. */}
      <div className="sr-only">
        <StatusRegion outcome={change.outcome?.tone === 'done' ? change.outcome : null} />
      </div>
      {declared.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[var(--color-muted)]">
            {declared.length} declared {declared.length === 1 ? 'system has' : 'systems have'} no
            proposal yet.
          </span>
          <button
            type="button"
            onClick={onReorient}
            disabled={reorienting}
            className="min-h-11 rounded border px-3 text-xs disabled:opacity-50"
          >
            {reorienting ? 'Re-running orientation...' : 'Re-run orientation'}
          </button>
          {reorientError ? (
            <span role="alert" className="text-[var(--color-danger)]">
              {reorientError}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {cardSurfaces.map((surface, index): React.ReactNode => {
          const request = surface.request as ConnectRequestBody | undefined;
          const ladder = request?.target?.ladder ?? surface.pathCandidates;
          const evidence = request?.evidence ?? (surface.whereFound as SurfaceEvidence[]);
          const discoveryEvidence = (surface.discoveryEvidence ?? []) as SurfaceDiscoveryEvidence[];
          const summary = surface.credentialId
            ? credentialById.get(String(surface.credentialId))
            : undefined;
          const summarySourceLabel =
            summary && typeof summary.source === 'object'
              ? sourceLabels.get(summary.source.sourceId)
              : undefined;
          const provisioning = surface.provisioning as SurfaceProvisioning | undefined;
          const presentation = presentSurfaceCredential({
            verdict: surface.verdict,
            credential: request?.credential,
            credentialId: surface.credentialId ? String(surface.credentialId) : undefined,
            credentialLocation: surface.credentialLocation,
            provisioning,
            sourceLabel: summarySourceLabel,
            summary,
            reason: surface.reason,
          });
          const provisioningPresentation = presentProvisioning({
            credential: request?.credential,
            hasPublicUrl: installRedirectConfigured === true,
            provisioning,
          });
          const channelsNotJoined = presentChannelsNotJoined(
            surface.channelsNotJoined,
            provisioning?.appName,
          );
          const currentOperation = operations[surface._id];
          const decision =
            currentOperation?.kind === 'approve' || currentOperation?.kind === 'reject'
              ? { kind: currentOperation.kind, error: currentOperation.error }
              : undefined;
          const canProbe = ['approved', 'connected', 'ungranted', 'listed-dead'].includes(
            surface.verdict,
          );
          const derivedSkipReason = ['absent', 'ungranted', 'listed-dead'].includes(surface.verdict)
            ? (surface.reason ?? `Surface is ${surface.verdict}.`)
            : undefined;
          const skipReason = surface.intakeSkipReason ?? derivedSkipReason;
          // Orientation proposes the path from the evidence whether or not this
          // deployment runs the component that drives it. The card is where the
          // two meet: the path stands, and approving it waits.
          const browserFloor = presentBrowserComponent({
            componentPresent: componentStatus?.browser === true,
            path: surface.path,
            reason: surface.reason,
          });
          return (
            <article
              id={`surface-${surface.slug}`}
              key={surface._id}
              tabIndex={-1}
              aria-labelledby={`surface-${surface.slug}-name`}
              data-verdict={surface.verdict}
              className="rounded-lg border border-[var(--color-border)] p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 id={`surface-${surface.slug}-name`} className="font-medium">
                  {surface.displayName}
                </h3>
                <span className="text-[10px] uppercase text-[var(--color-accent)]">
                  {surface.verdict}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Waterfall {surface.waterfallPosition ?? index + 1} - {surface.class} -{' '}
                {surface.path || 'no approved path'}
              </p>
              <SurfaceLadder candidates={ladder} attempts={surface.probeAttempts} />
              <DiscoveryProvenance evidence={discoveryEvidence} sourceLabels={sourceLabels} />
              {skipReason ? (
                <p className="mt-1 text-xs text-[var(--color-warn)]">Skipped: {skipReason}</p>
              ) : null}
              {surface.lastDecisionError ? (
                <p className="mt-1 text-xs text-[var(--color-warn)]">
                  Manager decisions: {surface.lastDecisionError}
                </p>
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
                  {surface.verdict === 'connected' ? null : (
                    <>
                      <dt className="text-[var(--color-muted)]">Scopes requested</dt>
                      <dd>{request.scopeRequested?.join(', ') || 'none requested'}</dd>
                    </>
                  )}
                  {request.registrySuggestion?.endpoint ? (
                    <>
                      <dt className="text-[var(--color-muted)]">Registry suggestion</dt>
                      <dd className="break-all">
                        <span className="font-mono">{request.registrySuggestion.endpoint}</span>
                        <span className="block text-[var(--color-warn)]">
                          {request.registrySuggestion.note ||
                            'Not linked evidence; confirm the endpoint before you approve.'}
                        </span>
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-[var(--color-muted)]">Blast radius</dt>
                  <dd>{request.blastRadius || 'not stated'}</dd>
                  <dt className="text-[var(--color-muted)]">Cost</dt>
                  <dd>{request.costBand || 'not stated'}</dd>
                  {surface.verdict === 'proposed' ? (
                    <>
                      <dt className="text-[var(--color-muted)]">Access</dt>
                      <dd>
                        starts when you approve; the end date shows on this card, where you change
                        or renew it
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-[var(--color-muted)]">Rollback</dt>
                  <dd>{request.rollback || 'not stated'}</dd>
                </dl>
              ) : null}
              <AccessRow
                surface={surface}
                now={now}
                onSetDays={(days) => setAccessDays({ surfaceId: surface._id, days })}
              />
              <ToolsRow
                surface={surface}
                onApprove={(tools) => approveTools({ surfaceId: surface._id, tools })}
              />
              {surface.intakeScope && scopeFieldsFor(surface.class).length > 0 ? (
                <IntakeScopeRow
                  drift={restatedScope(surface.intakeScope, scopePages).drift}
                  scope={surface.intakeScope}
                  sourceLabels={sourceLabels}
                  surfaceClass={surface.class}
                  system={surface.displayName}
                />
              ) : null}
              {surface.verdict !== 'declared' && surface.verdict !== 'absent' ? (
                <ProvisioningRow
                  error={
                    currentOperation?.kind === 'provision' ? currentOperation.error : undefined
                  }
                  onProvision={(configurationToken: string): void =>
                    operate(
                      'provision',
                      surface,
                      () => provisionApp({ surfaceId: surface._id, configurationToken }),
                      {
                        done: `The app for ${surface.displayName} is registered; install it from the link on the card.`,
                        refused: 'The app was not registered.',
                      },
                    )
                  }
                  presentation={provisioningPresentation}
                  provisioning={currentOperation?.kind === 'provision' && !currentOperation.error}
                  surfaceSlug={surface.slug}
                />
              ) : null}
              {request || surface.credentialId || surface.credentialLocation ? (
                <CredentialRow
                  credentialLabel={presentation.label ?? `${surface.displayName} credential`}
                  error={currentOperation?.kind === 'landing' ? currentOperation.error : undefined}
                  landing={currentOperation?.kind === 'landing' && !currentOperation.error}
                  onLand={(plaintext: string): void =>
                    operate(
                      'landing',
                      surface,
                      () =>
                        landCredential({
                          surfaceId: surface._id,
                          label: presentation.label ?? `${surface.displayName} credential`,
                          plaintext,
                        }),
                      {
                        done: `The credential for ${surface.displayName} is stored; Day0 checks the connection now.`,
                        refused: 'The credential was not stored.',
                      },
                    )
                  }
                  presentation={presentation}
                  status={credentialStatusLine(summary)}
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
              {channelsNotJoined ? (
                <p className="mt-3 text-xs text-[var(--color-warn)]">{channelsNotJoined}</p>
              ) : null}
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
              {browserFloor.absent ? (
                <p className="mt-3 text-xs text-[var(--color-warn)]">{browserFloor.message}</p>
              ) : null}
              {surface.verdict === 'proposed' ? (
                <ApprovalRow
                  pending={decision && !decision.error ? decision.kind : undefined}
                  blocked={browserFloor.absent}
                  error={decision?.error}
                  onApprove={(): void =>
                    operate('approve', surface, () => approve({ surfaceId: surface._id }), {
                      done: `Approved ${surface.displayName}: the probe runs now.`,
                      refused: 'The card was not approved.',
                    })
                  }
                  onReject={(): void =>
                    operate(
                      'reject',
                      surface,
                      () => reject({ surfaceId: surface._id, reason: 'Rejected by the operator.' }),
                      {
                        done: `Rejected ${surface.displayName}: it goes back to declared.`,
                        refused: 'The card was not rejected.',
                      },
                    )
                  }
                />
              ) : null}
              {canProbe ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={(): void =>
                      operate('probe', surface, () => probe({ surfaceId: surface._id }), {
                        done: (outcome) => probeOutcomeText(surface.displayName, outcome),
                        refused: 'The probe did not run.',
                      })
                    }
                    disabled={currentOperation?.kind === 'probe' && !currentOperation.error}
                    className="min-h-11 rounded border px-3 text-xs disabled:opacity-50"
                  >
                    {currentOperation?.kind === 'probe' && !currentOperation.error
                      ? 'Probing...'
                      : 'Probe'}
                  </button>
                  {currentOperation?.kind === 'probe' && currentOperation.error ? (
                    <span role="alert" className="text-xs text-[var(--color-danger)]">
                      {currentOperation.error}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <UnnamedSystemsRow
        error={
          proposeOperation?.error
            ? { surfaceId: proposeOperation.surfaceId, message: proposeOperation.error }
            : undefined
        }
        onPropose={(surfaceId: string): void => {
          const system = awaitingProposal.find((row) => row._id === surfaceId);
          operate(
            'propose',
            { _id: surfaceId as Id<'surfaces'>, slug: system?.slug ?? surfaceId },
            () => requestProposal({ surfaceId: surfaceId as Id<'surfaces'> }),
            {
              done: `Proposal requested for ${system?.displayName ?? 'the system'}; its card appears once it is drafted.`,
              refused: 'The proposal was not requested.',
            },
          );
        }}
        proposing={
          proposeOperation && !proposeOperation.error ? proposeOperation.surfaceId : undefined
        }
        sourceLabels={sourceLabels}
        systems={awaitingProposal}
      />
    </div>
  );
}
