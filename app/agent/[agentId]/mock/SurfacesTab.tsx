'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import {
  presentChannelsNotJoined,
  presentProvisioning,
  presentSurfaceCredential,
  PROVISION_LABEL,
  type CredentialOwnerSummary,
  type CredentialPresentation,
  type ProvisioningPresentation,
  type SurfaceCredentialFinding,
  type SurfaceProvisioning,
} from '@/surfaces/credential-presentation';
import { plainErrorMessage } from '@/lib/plain-error';
import { presentBrowserComponent } from '@/surfaces/browser';
import { pageLinkFromQuote } from '@/surfaces/evidence';
import { extractDocumentedSystemOrder, orderSurfaceWaterfall } from '@/surfaces/waterfall';
import { awaitsManagerProposal, charterNamesWorkSystems } from '@/surfaces/charter-cards';
import {
  presentIntakeScope,
  presentScopeDrift,
  scopeDrift,
  scopeFieldsFor,
  type IntakeScope,
  type ScopePage,
  type ScopeValue,
} from '@/surfaces/intake-scope';
import type { SurfaceDiscoveryEvidence } from '@/docs/system-discovery';

type SurfaceEvidence = {
  sourceId?: string;
  ref?: string;
  quote?: string;
  url?: string;
};

export const LOADING_SURFACES = 'Loading discovered systems, connection status and evidence…';
export const EMPTY_SURFACES =
  'No systems have been discovered yet. After charter approval, orientation maps systems from the linked documentation and shows their connection status here.';

type ConnectRequestBody = {
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
  expiresInDays?: number;
  rollback?: string;
  openQuestions?: string[];
};

type Operation = {
  error?: string;
  kind: 'landing' | 'probe' | 'propose' | 'provision';
  surfaceId: string;
};

export interface ProvisioningRowProps {
  error?: string;
  onProvision: (configurationToken: string) => void;
  presentation: ProvisioningPresentation;
  provisioning: boolean;
  surfaceSlug: string;
}

export function DiscoveryProvenance({
  evidence,
  sourceLabels,
}: {
  evidence: readonly SurfaceDiscoveryEvidence[];
  sourceLabels: ReadonlyMap<string, string>;
}): React.ReactNode {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-3 rounded border border-[var(--color-border)] p-2 text-xs">
      <p className="font-medium">System discovered from</p>
      {evidence.map((item, index): React.ReactNode => {
        const source =
          item.kind === 'charter'
            ? 'manager 1:1'
            : (item.sourceId && sourceLabels.get(item.sourceId)) || 'documentation';
        const label = [source, item.ref === source ? undefined : item.ref]
          .filter(Boolean)
          .join(' / ');
        return (
          <blockquote
            key={`${item.kind}-${item.sourceId ?? 'manager'}-${index}`}
            className="mt-2 border-l border-[var(--color-border)] pl-2"
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
            {!item.current ? (
              <span className="text-[var(--color-muted)]">
                {' '}
                · no longer named in the current page
              </span>
            ) : null}
            <br />
            <EvidenceQuote quote={item.quote} />
          </blockquote>
        );
      })}
    </div>
  );
}

export interface IntakeScopeRowProps {
  drift: readonly ScopeValue[];
  scope: IntakeScope;
  sourceLabels: ReadonlyMap<string, string>;
  surfaceClass: string;
  system: string;
}

/**
 * Show the queues a work-bearing card reads, each with the handbook line
 * that states it, so the manager and IT approve exactly what intake reads.
 *
 * Args:
 *   props: The card's scope, what has changed on its pages, and source labels.
 *
 * Returns:
 *   The reads line, its quotes, any change since the proposal and the notes.
 */
export function IntakeScopeRow(props: IntakeScopeRowProps): React.ReactNode {
  const presentation = presentIntakeScope(props.system, props.surfaceClass, props.scope);
  const changed = presentScopeDrift(props.scope, props.drift);
  return (
    <div className="mt-3 rounded border border-[var(--color-border)] p-2 text-xs">
      <p className={presentation.empty ? 'font-medium text-[var(--color-warn)]' : 'font-medium'}>
        {presentation.line}
      </p>
      {presentation.quotes.map((value: ScopeValue, index: number): React.ReactNode => {
        const source =
          (value.sourceId && props.sourceLabels.get(value.sourceId)) || 'documentation';
        return (
          <blockquote
            key={`${value.ref}-${value.value}-${index}`}
            className="mt-2 border-l border-[var(--color-border)] pl-2"
          >
            <span className="text-[var(--color-muted)]">{`${source} / ${value.ref}`}</span>
            <br />
            {value.quote}
          </blockquote>
        );
      })}
      {changed ? <p className="mt-2 text-[var(--color-warn)]">{changed}</p> : null}
      {presentation.notes.map(
        (note: string, index: number): React.ReactNode => (
          <p key={`note-${index}`} className="mt-1 text-[10px] text-[var(--color-muted)]">
            {note}
          </p>
        ),
      )}
    </div>
  );
}

export interface UnnamedSystem {
  _id: string;
  slug: string;
  displayName: string;
  class: string;
  discoveryEvidence?: SurfaceDiscoveryEvidence[];
}

export interface UnnamedSystemsRowProps {
  error?: { surfaceId: string; message: string };
  onPropose: (surfaceId: string) => void;
  proposing?: string;
  sourceLabels: ReadonlyMap<string, string>;
  systems: readonly UnnamedSystem[];
}

/**
 * List the documented systems this role's charter does not name, collapsed
 * under the cards, each one click from a card of its own.
 *
 * Args:
 *   props: The systems, their source labels and the propose callback.
 *
 * Returns:
 *   The collapsed row, or nothing when every documented system is named.
 */
export function UnnamedSystemsRow(props: UnnamedSystemsRowProps): React.ReactNode {
  if (props.systems.length === 0) return null;
  return (
    <details className="rounded-lg border border-[var(--color-border)] p-3 text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)]">
        {`Documented in the company, not named in this role's charter (${props.systems.length})`}
      </summary>
      <p className="mt-2 text-[var(--color-muted)]">
        Cards are proposed for the systems the charter names. Propose one of these to file its card;
        the manager and IT still approve it, and a charter amendment names it for good.
      </p>
      <ul className="mt-2 space-y-2">
        {props.systems.map((system: UnnamedSystem): React.ReactNode => {
          const documented = (system.discoveryEvidence ?? []).find(
            (item: SurfaceDiscoveryEvidence): boolean =>
              item.kind === 'documentation' && item.current,
          );
          const source = documented?.sourceId
            ? (props.sourceLabels.get(documented.sourceId) ?? 'documentation')
            : 'documentation';
          const proposing = props.proposing === system._id;
          return (
            <li
              key={system._id}
              className="flex flex-wrap items-start justify-between gap-2 border-t border-[var(--color-border)] pt-2"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {system.displayName}{' '}
                  <span className="text-[10px] font-normal text-[var(--color-muted)]">
                    {system.class}
                  </span>
                </p>
                {documented ? (
                  <p className="mt-1 text-[var(--color-muted)]">
                    {`${source} / ${documented.ref}`}: <EvidenceQuote quote={documented.quote} />
                  </p>
                ) : null}
                {props.error?.surfaceId === system._id ? (
                  <p className="mt-1 text-[var(--color-danger)]">{props.error.message}</p>
                ) : null}
              </div>
              <button
                onClick={(): void => props.onPropose(system._id)}
                disabled={proposing}
                className="rounded border px-2 py-1 text-xs disabled:opacity-50"
              >
                {proposing ? 'Proposing...' : 'Propose'}
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * Render the documented self-provisioning procedure and whichever step is next.
 *
 * The configuration-token field is uncontrolled for the same reason the
 * credential field is: the value goes straight from the form to the action and
 * never lands in React state, where a devtools snapshot or an error boundary
 * could keep it.
 *
 * Args:
 *   props: Stage copy, operation state and the provisioning callback.
 *
 * Returns:
 *   The procedure's current step, or nothing when the docs describe none.
 */
export function ProvisioningRow(props: ProvisioningRowProps): React.ReactNode {
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('configurationToken');
    form.reset();
    if (typeof value === 'string' && value.trim()) props.onProvision(value);
  }

  // A system whose documentation describes no install procedure has no step to
  // show, and an empty box beside every Linear card would only be noise.
  if (props.presentation.stage === 'not-applicable') return null;

  return (
    <div className="mt-3 rounded border border-[var(--color-border)] p-2 text-xs">
      <p className="font-medium">{props.presentation.title}</p>
      <p className="mt-1 text-[var(--color-muted)]">{props.presentation.note}</p>
      {props.presentation.installUrl ? (
        <p className="mt-2 break-all">
          <a
            href={props.presentation.installUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-accent)] underline"
          >
            Install link for the administrator
          </a>
        </p>
      ) : null}
      {props.presentation.offerProvisioning ? (
        <form onSubmit={onSubmit} className="mt-2 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor={`configuration-token-${props.surfaceSlug}`}>
            App configuration token for {props.surfaceSlug}
          </label>
          <input
            id={`configuration-token-${props.surfaceSlug}`}
            name="configurationToken"
            type="password"
            autoComplete="new-password"
            required
            placeholder="Paste the app configuration token"
            className="min-w-48 flex-1 rounded border bg-transparent px-2 py-1"
          />
          <button
            type="submit"
            disabled={props.provisioning}
            className="rounded border px-2 py-1 disabled:opacity-50"
          >
            {props.provisioning ? 'Registering the app...' : PROVISION_LABEL}
          </button>
        </form>
      ) : null}
      {props.error ? <p className="mt-1 text-[var(--color-danger)]">{props.error}</p> : null}
    </div>
  );
}

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

type SurfaceProbeAttempt = {
  path: string;
  endpoint?: string;
  outcome: 'demoted' | 'ungranted' | 'listed-dead';
  reason: string;
  attemptedAt: number;
};

export interface SurfaceLadderProps {
  candidates?: Array<{ path: string; endpoint: string }>;
  attempts?: SurfaceProbeAttempt[];
}

/** Show exactly which routes were approved and what each failed probe established. */
export function SurfaceLadder({ candidates, attempts }: SurfaceLadderProps): React.ReactNode {
  if (!candidates?.length && !attempts?.length) return null;
  return (
    <div className="mt-2 rounded border border-[var(--color-border)] p-2 text-[10px]">
      {candidates?.length ? (
        <p>
          <span className="text-[var(--color-muted)]">Approved ladder: </span>
          {candidates.map((candidate): string => candidate.path).join(' → ')}
        </p>
      ) : null}
      {attempts?.length ? (
        <ol className="mt-1 space-y-1">
          {attempts.map((attempt, index): React.ReactNode => (
            <li key={`${attempt.attemptedAt}-${attempt.path}-${index}`}>
              <span className="font-medium">{attempt.path} attempt failed: </span>
              {attempt.reason}{' '}
              <span className="text-[var(--color-muted)]">
                {attempt.outcome === 'demoted'
                  ? 'Fell to the next approved rung.'
                  : attempt.outcome === 'ungranted'
                    ? 'Waiting on Day0 or approved access.'
                    : 'No approved fallback connected.'}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function SurfacesTab({ agentId }: { agentId: Id<'agents'> }): React.ReactNode {
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
      return [scope?.team, scope?.project, ...(scope?.channels ?? [])].flatMap((value): string[] =>
        value?.sourceId ? [value.sourceId] : [],
      );
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
  const reorient = useAction(api.surfaces.reorient);
  const requestProposal = useMutation(api.surfaces.requestProposal);
  const probe = useAction(api.surfaceActions.probe);
  const landCredential = useAction(api.surfaceActions.landCredential);
  const provisionApp = useAction(api.slackProvisionActions.provisionApp);
  const installRedirectConfigured = useQuery(api.surfaces.installRedirectConfigured, {});
  const componentStatus = useQuery(api.config.components, {});
  const [reorienting, setReorienting] = useState(false);
  const [reorientError, setReorientError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);

  async function onReorient(): Promise<void> {
    setReorienting(true);
    setReorientError(null);
    try {
      await reorient({ agentId });
    } catch (failure) {
      setReorientError(plainErrorMessage((failure as Error).message));
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
      setOperation({
        kind: 'probe',
        surfaceId,
        error: plainErrorMessage((failure as Error).message),
      });
    }
  }

  async function onPropose(surfaceId: Id<'surfaces'>): Promise<void> {
    setOperation({ kind: 'propose', surfaceId });
    try {
      await requestProposal({ surfaceId });
      setOperation(null);
    } catch (failure) {
      setOperation({
        kind: 'propose',
        surfaceId,
        error: plainErrorMessage((failure as Error).message),
      });
    }
  }

  async function onProvision(surfaceId: Id<'surfaces'>, configurationToken: string): Promise<void> {
    setOperation({ kind: 'provision', surfaceId });
    try {
      await provisionApp({ surfaceId, configurationToken });
      setOperation(null);
    } catch (failure) {
      setOperation({
        kind: 'provision',
        surfaceId,
        error: plainErrorMessage((failure as Error).message),
      });
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
      setOperation({
        kind: 'landing',
        surfaceId,
        error: plainErrorMessage((failure as Error).message),
      });
    }
  }

  if (!surfaces || !pages || !credentialRows || charter === undefined)
    return <p className="text-xs text-[var(--color-muted)]">{LOADING_SURFACES}</p>;
  if (surfaces.length === 0)
    return <p className="text-xs text-[var(--color-muted)]">{EMPTY_SURFACES}</p>;
  const declared = cardSurfaces.filter((surface): boolean => surface.verdict === 'declared');
  const proposeOperation = operation?.kind === 'propose' ? operation : undefined;

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
          const currentOperation = operation?.surfaceId === surface._id ? operation : undefined;
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
              {surface.intakeScope && scopeFieldsFor(surface.class).length > 0 ? (
                <IntakeScopeRow
                  drift={scopeDrift(surface.intakeScope, scopePages)}
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
                  onProvision={(configurationToken: string): void => {
                    void onProvision(surface._id, configurationToken);
                  }}
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
                <div className="mt-4 flex flex-wrap gap-2">
                  {surface.managerApprovedAt ? (
                    <span className="rounded border px-2 py-1 text-xs">Manager approved</span>
                  ) : (
                    <button
                      disabled={browserFloor.absent}
                      onClick={(): void =>
                        void approve({ surfaceId: surface._id, role: 'manager' })
                      }
                      className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                    >
                      Approve as manager
                    </button>
                  )}
                  {surface.itApprovedAt ? (
                    <span className="rounded border px-2 py-1 text-xs">IT approved</span>
                  ) : (
                    <button
                      disabled={browserFloor.absent}
                      onClick={(): void => void approve({ surfaceId: surface._id, role: 'it' })}
                      className="rounded border px-2 py-1 text-xs disabled:opacity-50"
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
      <UnnamedSystemsRow
        error={
          proposeOperation?.error
            ? { surfaceId: proposeOperation.surfaceId, message: proposeOperation.error }
            : undefined
        }
        onPropose={(surfaceId: string): void => {
          void onPropose(surfaceId as Id<'surfaces'>);
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
