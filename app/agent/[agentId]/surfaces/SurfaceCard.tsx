'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import {
  type CredentialOwnerSummary,
  type SurfaceCredentialFinding,
  type SurfaceProvisioning,
  presentChannelsNotJoined,
  presentProvisioning,
  presentSurfaceCredential,
} from '@/surfaces/credential-presentation';
import {
  BROWSER_COMPONENT_CARD_MESSAGE,
  BROWSER_DRIVER_ABSENT,
  presentBrowserComponent,
} from '@/surfaces/browser';
import type { SurfaceDiscoveryEvidence } from '@/docs/system-discovery';
import { scopeFieldsFor } from '@/surfaces/intake-scope';
import { organisationSystemOf } from '@/surfaces/access-request';
import { deploymentZone } from '@/lib/zone';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import { Disclosure } from '../../../components/Disclosure';
import type { Tone } from '../../../components/tone';
import { clockTime, useAgentZone } from '../../../components/time';
import {
  accessStanding,
  actsAsWords,
  cardIdentity,
  connectedForOrganisationWords,
  disconnectLines,
  expectedCredential,
  moveOfferWords,
  slackChannelsGoWords,
  identityChip,
  reachedWords,
  stateChip,
  type OrganisationSystem,
} from './card-words';
import { CredentialField } from './CredentialField';
import { DisconnectDialog } from './DisconnectDialog';
import { ExpiryBlock, type MoveOffer, type Renewed } from './ExpiryBlock';
import { ToolsRow } from './SurfaceControls';
import {
  AccessRequestRow,
  ApprovalRow,
  ConnectRow,
  DiscoveryProvenance,
  EvidenceQuote,
  IntakeScopeRow,
  ONE_APPROVER,
  ProvisioningRow,
  SurfaceLadder,
} from './SurfaceRows';

/** One surface as `surfaces.listForAgent` lists it for its card. */
export type ListedSurface = FunctionReturnType<typeof api.surfaces.listForAgent>[number];

/** A card's access request as `accessRequests.forCard` answers it, when the card makes one. */
export type AccessRequestView = NonNullable<FunctionReturnType<typeof api.accessRequests.forCard>>;

/** One evidence line a proposal cites. */
interface SurfaceEvidence {
  sourceId?: string;
  ref?: string;
  quote?: string;
  url?: string;
}

/** The connection request orientation drafted, as the card reads it. */
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

/** A change in flight on one card, and its refusal once refused. */
export interface Operation {
  readonly error?: string;
  readonly kind: 'approve' | 'connect' | 'landing' | 'probe' | 'propose' | 'provision' | 'reject';
  readonly surfaceId: string;
}

/** A stored credential as `credentials.summaryForOwner` lists it, with what the store says of it. */
export interface CredentialStatus extends CredentialOwnerSummary {
  readonly revokedAt?: number;
  readonly status?: 'suspect' | 'superseded';
  readonly statusReason?: string;
}

/**
 * What the credential store says about a stored credential: revoked, or a status the sync or a
 * rotation set, with its reason (U19 D5). Nothing for a credential that is simply live.
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

/** What every card on the tab reads alike: the clock, the labels and this deployment's parts. */
export interface SurfaceCardContext {
  readonly now: number;
  readonly sourceLabels: ReadonlyMap<string, string>;
  readonly credentials: ReadonlyMap<string, CredentialStatus>;
  /** Whether this deployment has a public address for a dedicated app's install to return to. */
  readonly installRedirectConfigured: boolean;
  /** Whether this deployment runs the browser component; undefined while that is loading. */
  readonly browserPresent: boolean | undefined;
  /** The employee's name, which the identity's words say. */
  readonly employeeName: string;
  /** The systems IT connected for the organisation, by system (`summaryForManager`). */
  readonly organisation: ReadonlyMap<string, OrganisationSystem>;
}

/** What a card's controls do, each bound to the card's own change. */
export interface SurfaceCardActions {
  readonly approve: () => void;
  readonly reject: () => void;
  readonly probe: () => void;
  /** Store a credential under its name, as the card names it. */
  readonly land: (label: string, plaintext: string) => void;
  /** Register or install the employee's own Slack app: with a pasted token, or through IT's. */
  readonly provision: (configurationToken?: string) => void;
  readonly setDays: (days: number) => Promise<Renewed>;
  readonly approveTools: (tools: string[]) => Promise<unknown>;
  /** Connect through the organisation's connection, where the card's system has an issuer. */
  readonly connect?: () => void;
  /** End the card's access (`surfaces.disconnect`), once the dialog confirmed it. */
  readonly disconnect: () => Promise<unknown>;
  /** Draft the card's access request (`accessRequests.draft`). */
  readonly draftAccessRequest: () => Promise<unknown>;
  /** Record the request copied or opened in an email (`accessRequests.recordSent`). */
  readonly recordAccessRequestSent: (via: 'copied' | 'emailed') => Promise<unknown>;
}

/** The verdicts of a card the manager approved, whose access can be connected and ended. */
const ACCESS_VERDICTS: ReadonlySet<string> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** The verdicts of a card that names no system to act in yet. */
const NO_IDENTITY: ReadonlySet<string> = new Set(['declared', 'absent']);

/** The verdicts a manual probe can check. */
const PROBEABLE: ReadonlySet<string> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** The verdicts whose own reason says why intake skips the card. */
const SKIPPED: ReadonlySet<string> = new Set(['absent', 'ungranted', 'listed-dead']);

/** The card's border, from its chip: a connected card in the ok tone, one to act on in warn. */
function cardTone(tone: Tone): 'ok' | 'warn' | undefined {
  return tone === 'ok' || tone === 'warn' ? tone : undefined;
}

/** One labelled line of a card's facts: the label in a narrow column beside what it says. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[13px] text-[var(--color-muted)]">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-[var(--color-fg-2)]">{children}</dd>
    </div>
  );
}

/**
 * One system's card on the Surfaces tab (round two section 3.9, `agent-surfaces.html`): its name
 * and state, how it is reached, the credential and whose it is, the one approval (Q10), the
 * access end date and its renewal (Q5), what intake reads, and, one step away, where Day0 found
 * it and how each rung was tried. The card carries the id, the verdict and the name the
 * rehearsal driver and the Surfaces tab's focus return read.
 */
export function SurfaceCard({
  surface,
  context,
  operation,
  actions,
  accessRequest,
}: {
  surface: ListedSurface;
  context: SurfaceCardContext;
  operation: Operation | undefined;
  actions: SurfaceCardActions;
  /** The card's access request, when it makes one; undefined while it is read. */
  accessRequest?: AccessRequestView | null;
}) {
  const zone = useAgentZone();
  const [disconnecting, setDisconnecting] = useState(false);
  // A disconnect that lands takes its button with it: the card takes focus once the dialog closed.
  const focusCardOnClose = useRef(false);
  useEffect(() => {
    if (disconnecting || !focusCardOnClose.current) return;
    focusCardOnClose.current = false;
    document.getElementById(`surface-${surface.slug}`)?.focus();
  }, [disconnecting, surface.slug]);
  const request = surface.request as ConnectRequestBody | undefined;
  const ladder = request?.target?.ladder ?? surface.pathCandidates;
  const evidence = request?.evidence ?? (surface.whereFound as SurfaceEvidence[]);
  const discoveryEvidence = (surface.discoveryEvidence ?? []) as SurfaceDiscoveryEvidence[];
  const summary = surface.credentialId
    ? context.credentials.get(String(surface.credentialId))
    : undefined;
  const provisioning = surface.provisioning as SurfaceProvisioning | undefined;
  const presentation = presentSurfaceCredential({
    verdict: surface.verdict,
    credential: request?.credential,
    credentialId: surface.credentialId ? String(surface.credentialId) : undefined,
    credentialLocation: surface.credentialLocation,
    provisioning,
    sourceLabel:
      summary && typeof summary.source === 'object'
        ? context.sourceLabels.get(summary.source.sourceId)
        : undefined,
    summary,
    reason: surface.reason,
  });
  const credentialLabel = presentation.label ?? `${surface.displayName} credential`;
  const pending = operation && !operation.error ? operation.kind : undefined;
  const failed = (kind: Operation['kind']): string | undefined =>
    operation?.kind === kind ? operation.error : undefined;
  const skipReason =
    surface.intakeSkipReason ??
    (SKIPPED.has(surface.verdict)
      ? (surface.reason ?? `Surface is ${surface.verdict}.`)
      : undefined);
  // Orientation proposes the path from the evidence whether or not this deployment runs the
  // component that drives it: the path stands, and approving it waits.
  const browserFloor = presentBrowserComponent({
    componentPresent: context.browserPresent === true,
    path: surface.path,
    reason: surface.reason,
  });
  // Why Approve is disabled, said beside it: the absent component in words (the server's refusal
  // names it by its code), else the server's own refusal (E-63).
  const refusal = browserFloor.absent
    ? browserFloor.message
    : surface.approvalRefusal?.includes(BROWSER_DRIVER_ABSENT)
      ? BROWSER_COMPONENT_CARD_MESSAGE
      : surface.approvalRefusal;
  const channelsNotJoined = presentChannelsNotJoined(
    surface.channelsNotJoined,
    provisioning?.appName,
  );
  const reached = reachedWords(surface.path);
  const approvedAt = surface.verdict === 'proposed' ? undefined : surface.managerApprovedAt;
  const proposal = request ? <ProposalFacts request={request} surface={surface} /> : null;
  const system = organisationSystemOf(surface);
  const connection = system === undefined ? undefined : context.organisation.get(system);
  // Only an active connection covers the card: `landCredential` refuses a paste while one is.
  const covering = connection?.status === 'active' ? connection : undefined;
  const slack = system === 'slack';
  const provisioningPresentation = presentProvisioning({
    credential: request?.credential,
    hasPublicUrl: context.installRedirectConfigured,
    provisioning,
    organisationConnected: slack && covering !== undefined,
    credentialHeld: surface.credentialId !== undefined,
  });
  const identity = cardIdentity(surface, connection, {
    selfProvisions:
      slack &&
      provisioningPresentation.stage !== 'not-applicable' &&
      provisioningPresentation.stage !== 'unavailable',
  });
  const identityNames = { employee: context.employeeName, system: surface.displayName };
  const showsIdentity = !NO_IDENTITY.has(surface.verdict);
  const chipForIdentity = identityChip(identity.kind);
  const approvedAccess =
    ACCESS_VERDICTS.has(surface.verdict) && surface.managerApprovedAt !== undefined;
  const ended = accessStanding(surface, context.now, zone).kind === 'ended';
  // A27: a card still on a pasted key whose system IT has since connected is offered the move,
  // through the connection's own issuer: Slack's app, else the card's Connect.
  const onMove = slack ? (): void => actions.provision() : actions.connect;
  const move: MoveOffer | undefined =
    covering !== undefined &&
    identity.kind === 'shared-key' &&
    !identity.planned &&
    surface.credentialId !== undefined &&
    onMove !== undefined
      ? {
          words: moveOfferWords(
            cardIdentity({ endpoint: surface.endpoint, path: surface.path }, covering, {
              selfProvisions: false,
            }),
            identityNames,
          ),
          onMove,
        }
      : undefined;
  const connectable =
    actions.connect !== undefined &&
    covering !== undefined &&
    !slack &&
    approvedAccess &&
    !ended &&
    surface.credentialId === undefined &&
    !accessRequest;
  const slackConnectable =
    slack &&
    covering !== undefined &&
    approvedAccess &&
    !ended &&
    surface.credentialId === undefined &&
    provisioningPresentation.offerProvisioning;
  const chip = stateChip(surface, context.now, zone, {
    waitsOn: accessRequest ? 'it' : connectable || slackConnectable ? 'connect' : undefined,
  });
  return (
    <Card
      id={`surface-${surface.slug}`}
      data-verdict={surface.verdict}
      title={surface.displayName}
      meta={<Chip tone={chip.tone}>{chip.text}</Chip>}
      tone={cardTone(chip.tone)}
    >
      <div className="grid gap-4">
        {skipReason ? (
          <p className="text-sm text-[var(--color-warn)]">Skipped: {skipReason}</p>
        ) : null}
        {surface.lastDecisionError ? (
          <p className="text-sm text-[var(--color-warn)]">
            Manager decisions: {surface.lastDecisionError}
          </p>
        ) : null}
        {channelsNotJoined ? (
          <p className="text-sm text-[var(--color-warn)]">{channelsNotJoined}</p>
        ) : null}
        {/* A proposed card says it beside its disabled Approve instead. */}
        {browserFloor.absent && surface.verdict !== 'proposed' ? (
          <p className="text-sm text-[var(--color-warn)]">{browserFloor.message}</p>
        ) : null}
        {surface.reason && !skipReason && surface.reason !== 'expired' ? (
          <p className="text-sm text-[var(--color-fg-2)]">{surface.reason}</p>
        ) : null}
        {request?.target?.reasoning ? (
          <p className="text-sm text-[var(--color-fg-2)]">{request.target.reasoning}</p>
        ) : null}
        {showsIdentity ||
        reached ||
        approvedAt !== undefined ||
        (surface.verdict === 'proposed' && proposal) ? (
          <dl className="grid gap-2.5">
            {showsIdentity ? (
              <Fact label="Acts as">
                {actsAsWords(identity, identityNames)}
                {chipForIdentity !== undefined ? (
                  <>
                    {' '}
                    <Chip tone="warn">{chipForIdentity}</Chip>
                  </>
                ) : null}
              </Fact>
            ) : null}
            {reached ? (
              <Fact label="Reached">
                {reached}
                {surface.endpoint ? (
                  <>
                    {' '}
                    <span className="font-mono text-[13px] break-all text-[var(--color-muted)]">
                      {surface.endpoint}
                    </span>
                  </>
                ) : null}
              </Fact>
            ) : null}
            {covering !== undefined && showsIdentity ? (
              <Fact label="Connection">
                {connectedForOrganisationWords(covering, zone ?? deploymentZone())}
              </Fact>
            ) : null}
            {approvedAt !== undefined ? (
              <Fact label="Approved">
                by you,{' '}
                <time dateTime={new Date(approvedAt).toISOString()}>
                  {clockTime(approvedAt, zone)}
                </time>
                . {ONE_APPROVER}
              </Fact>
            ) : null}
            {surface.verdict === 'proposed' ? proposal : null}
          </dl>
        ) : null}
        {surface.intakeScope && scopeFieldsFor(surface.class).length > 0 ? (
          <IntakeScopeRow
            changed={surface.scopeChange}
            scope={surface.intakeScope}
            sourceLabels={context.sourceLabels}
            surfaceClass={surface.class}
            system={surface.displayName}
          />
        ) : null}
        <ToolsRow surface={surface} onApprove={actions.approveTools} />
        <ExpiryBlock
          surface={surface}
          now={context.now}
          onSetDays={actions.setDays}
          endedNote={
            slack && identity.kind === 'own-app'
              ? slackChannelsGoWords(context.employeeName, 'Renewing')
              : undefined
          }
          move={move}
        />
        {/* The employee's own app is Slack's alone (`provisionApp`), and is registered only for an
            approved card, as the action refuses one before. */}
        {slack && surface.managerApprovedAt !== undefined ? (
          <ProvisioningRow
            error={failed('provision')}
            onProvision={actions.provision}
            presentation={provisioningPresentation}
            provisioning={pending === 'provision'}
            surfaceSlug={surface.slug}
          />
        ) : null}
        {connectable && actions.connect !== undefined ? (
          <ConnectRow
            system={surface.displayName}
            employee={context.employeeName}
            startedAt={surface.pendingAuthorisation?.startedAt}
            zone={zone}
            connecting={pending === 'connect'}
            error={failed('connect')}
            onConnect={actions.connect}
          />
        ) : null}
        {accessRequest ? (
          <AccessRequestRow
            request={accessRequest}
            system={surface.displayName}
            employee={context.employeeName}
            zone={zone ?? deploymentZone()}
            onDraft={actions.draftAccessRequest}
            onSent={actions.recordAccessRequestSent}
          />
        ) : null}
        {/* Where IT's connection covers the card, the Acts as row names its identity: the field's
            lines are drawn only for a key of the manager's own still stored on it. */}
        {(
          covering === undefined
            ? request || surface.credentialId || surface.credentialLocation
            : summary !== undefined
        ) ? (
          <CredentialField
            expected={expectedCredential(surface, presentation.label)}
            approved={surface.managerApprovedAt !== undefined}
            covered={covering !== undefined}
            error={failed('landing')}
            landing={pending === 'landing'}
            onLand={(plaintext) => actions.land(credentialLabel, plaintext)}
            presentation={presentation}
            status={credentialStatusLine(summary)}
          />
        ) : null}
        {surface.verdict === 'proposed' ? (
          <ApprovalRow
            pending={pending === 'approve' || pending === 'reject' ? pending : undefined}
            blocked={browserFloor.absent}
            refusal={refusal}
            error={failed('approve') ?? failed('reject')}
            onApprove={actions.approve}
            onReject={actions.reject}
          />
        ) : null}
        {PROBEABLE.has(surface.verdict) ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="small" onClick={actions.probe} disabled={pending === 'probe'}>
              {pending === 'probe' ? 'Checking…' : 'Check the connection'}
            </Button>
            {surface.credentialId !== undefined ? (
              <Button size="small" variant="quiet" onClick={(): void => setDisconnecting(true)}>
                Disconnect
              </Button>
            ) : null}
            {failed('probe') ? (
              <span role="alert" className="text-sm text-[var(--color-danger)]">
                {failed('probe')}
              </span>
            ) : null}
          </div>
        ) : null}
        <Disclosure summary="Where Day0 found it, and how it was reached">
          <div className="grid gap-3 text-sm">
            <p className="text-[13px] text-[var(--color-muted)]">
              Intake order {surface.waterfallPosition ?? 'not polled yet'} · {surface.class} ·{' '}
              {surface.path || 'no approved path'}
            </p>
            {surface.verdict === 'proposed' || !proposal ? null : (
              <dl className="grid gap-2.5">{proposal}</dl>
            )}
            <SurfaceLadder candidates={ladder} attempts={surface.probeAttempts} />
            <DiscoveryProvenance evidence={discoveryEvidence} sourceLabels={context.sourceLabels} />
            {evidence.map((item: SurfaceEvidence, index: number) => {
              const source = item.sourceId ? context.sourceLabels.get(item.sourceId) : undefined;
              const label = [source || 'manager 1:1', item.ref].filter(Boolean).join(' / ');
              return (
                <blockquote
                  key={`${item.ref}-${index}`}
                  className="border-l-2 border-[var(--color-border-2)] pl-3"
                >
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer">
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
              <p className="text-[var(--color-muted)]">Open: {request.openQuestions.join(' ')}</p>
            ) : null}
          </div>
        </Disclosure>
      </div>
      {disconnecting ? (
        <DisconnectDialog
          system={surface.displayName}
          employee={context.employeeName}
          lines={disconnectLines(identity, identityNames, { slack })}
          onConfirm={async (): Promise<void> => {
            await actions.disconnect();
            focusCardOnClose.current = true;
          }}
          onClose={(): void => setDisconnecting(false)}
        />
      ) : null}
    </Card>
  );
}

/**
 * What a proposal asks for, as facts: the scopes, the fallback, how sure orientation was, a
 * registry suggestion to confirm, the blast radius, the cost, when access starts, the rollback.
 */
function ProposalFacts({
  request,
  surface,
}: {
  request: ConnectRequestBody;
  surface: ListedSurface;
}) {
  return (
    <>
      {surface.verdict === 'connected' ? null : (
        <Fact label="Scopes requested">
          {request.scopeRequested?.join(', ') || 'none requested'}
        </Fact>
      )}
      <Fact label="Blast radius">{request.blastRadius || 'not stated'}</Fact>
      <Fact label="Fallback">
        {request.target?.fallbackPath || surface.fallbackPath || 'escalate'}
      </Fact>
      <Fact label="Confidence">
        {request.target?.confidence === undefined
          ? 'not stated'
          : `${Math.round(request.target.confidence * 100)}%`}
      </Fact>
      {request.registrySuggestion?.endpoint ? (
        <Fact label="Registry suggestion">
          <span className="font-mono break-all">{request.registrySuggestion.endpoint}</span>
          <span className="block text-[var(--color-warn)]">
            {request.registrySuggestion.note ||
              'Not linked evidence; confirm the endpoint before you approve.'}
          </span>
        </Fact>
      ) : null}
      <Fact label="Cost">{request.costBand || 'not stated'}</Fact>
      {surface.verdict === 'proposed' ? (
        <Fact label="Access">
          starts when you approve; the end date shows on this card, where you renew it
        </Fact>
      ) : null}
      <Fact label="Rollback">{request.rollback || 'not stated'}</Fact>
    </>
  );
}
