'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
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
import { presentBrowserComponent } from '@/surfaces/browser';
import { pageLinkFromQuote } from '@/surfaces/evidence';
import { extractDocumentedSystemOrder, orderSurfaceWaterfall } from '@/surfaces/waterfall';
import { awaitsManagerProposal, charterNamesWorkSystems } from '@/surfaces/charter-cards';
import {
  presentIntakeScope,
  presentScopeDrift,
  restatedScope,
  scopeFieldsFor,
  type IntakeScope,
  type ScopePage,
  type ScopeValue,
} from '@/surfaces/intake-scope';
import type { SurfaceDiscoveryEvidence } from '@/docs/system-discovery';
import { clockTime, useAgentZone, useNow } from '../time';
import { LiveStatus, refusalText, useChange, type ChangeOutcome } from '../live-status';

interface SurfaceEvidence {
  sourceId?: string;
  ref?: string;
  quote?: string;
  url?: string;
}

/** The one control that approves a proposed card (Q10); the rehearsal driver clicks it by name. */
export const APPROVE_CARD = 'Approve';

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

/** The Slack provisioning row's inputs: the token handler, its error and the presentation. */
export interface ProvisioningRowProps {
  error?: string;
  onProvision: (configurationToken: string) => void;
  presentation: ProvisioningPresentation;
  provisioning: boolean;
  surfaceSlug: string;
}

/** Where orientation found a system: the pages it cites, by source. */
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

/**
 * Show a handbook line or a note with its code spans set as code.
 *
 * The stored text keeps the page's backticks, because a changed page is found
 * by comparing the line as written; only the card sets them as code. A
 * backtick with no partner is shown as it is.
 *
 * Args:
 *   props: The line as stored.
 *
 * Returns:
 *   The line, each backticked span in a code element.
 */
export function PageLine({ text }: { text: string }): React.ReactNode {
  return text.split(/(`[^`]+`)/).map(
    (part: string, index: number): React.ReactNode =>
      /^`[^`]+`$/.test(part) ? (
        <code key={index} className="rounded bg-[var(--color-border)] px-1 font-mono">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
  );
}

/** The intake scope row's inputs: the scope, its drift and the re-orientation handler. */
export interface IntakeScopeRowProps {
  drift: readonly ScopeValue[];
  scope: IntakeScope;
  sourceLabels: ReadonlyMap<string, string>;
  surfaceClass: string;
  system: string;
}

/**
 * Show the queues a work-bearing card reads, each with the handbook line
 * that states it, so the manager approves exactly what intake reads.
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
  const queues =
    props.surfaceClass === 'kanban'
      ? [props.scope.project, ...(props.scope.projects ?? [])]
          .filter((value): value is ScopeValue => value !== undefined)
          .map((value): string => `Project ${value.value}`)
      : (props.scope.channels ?? []).map((value): string => `#${value.value}`);
  // The reads line already names a single queue; the list is for telling several apart.
  const listed = queues.length > 1 ? queues : [];
  return (
    <div className="mt-3 rounded border border-[var(--color-border)] p-2 text-xs">
      <p className={presentation.empty ? 'font-medium text-[var(--color-warn)]' : 'font-medium'}>
        {presentation.line}
      </p>
      {listed.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {listed.map((queue) => (
            <li key={queue}>{queue}</li>
          ))}
        </ul>
      ) : null}
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
            <PageLine text={value.quote} />
          </blockquote>
        );
      })}
      {changed ? <p className="mt-2 text-[var(--color-warn)]">{changed}</p> : null}
      {presentation.notes.map(
        (note: string, index: number): React.ReactNode => (
          <p key={`note-${index}`} className="mt-1 text-[10px] text-[var(--color-muted)]">
            <PageLine text={note} />
          </p>
        ),
      )}
    </div>
  );
}

/** A discovered system the charter did not name, awaiting a proposal. */
export interface UnnamedSystem {
  _id: string;
  slug: string;
  displayName: string;
  class: string;
  discoveryEvidence?: SurfaceDiscoveryEvidence[];
}

/** The unnamed-systems row's inputs: the systems, the propose handler and its error. */
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
      <summary className="min-h-11 py-3 cursor-pointer text-[var(--color-muted)]">
        {`Documented in the company, not named in this role's charter (${props.systems.length})`}
      </summary>
      <p className="mt-2 text-[var(--color-muted)]">
        Cards are proposed for the systems the charter names. Propose one of these to file its card;
        you still approve it, and a charter amendment names it for good.
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
                  <p role="alert" className="mt-1 text-[var(--color-danger)]">
                    {props.error.message}
                  </p>
                ) : null}
              </div>
              <button
                onClick={(): void => props.onPropose(system._id)}
                disabled={proposing}
                className="min-h-11 rounded border px-3 text-xs disabled:opacity-50"
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

/** What the approval row of a proposed card shows and does. */
export interface ApprovalRowProps {
  /** The decision in flight, if any. */
  readonly pending?: 'approve' | 'reject';
  /** The card cannot be approved on this deployment yet (its browser component is absent). */
  readonly blocked: boolean;
  /** Why the last decision was refused, in the backend's words. */
  readonly error?: string;
  /** Approve the card. */
  readonly onApprove: () => void;
  /** Reject the card, returning it to declared. */
  readonly onReject: () => void;
}

/**
 * What a manual probe came to, in the manager's words; a probe that did not
 * run says why rather than passing for a check (P6-7).
 *
 * @param system - The surface's display name.
 * @param outcome - The probe's answer.
 * @returns One sentence for the tab's live region.
 */
export function probeOutcomeText(
  system: string,
  outcome: { verdict: string; reason?: string },
): string {
  if (outcome.verdict === 'skipped') {
    return `The probe of ${system} did not run${outcome.reason ? `: ${outcome.reason.replace(/\.$/, '')}` : ''}.`;
  }
  return `Probed ${system}: ${outcome.verdict}${outcome.reason ? `, ${outcome.reason.replace(/\.$/, '')}` : ''}.`;
}

/**
 * The proposed card's one approval (Q10): Approve, Reject, the refusal of the
 * last decision, and the line that says the probe follows.
 *
 * Args:
 *   props: The decision's state and the two controls' handlers.
 *
 * Returns:
 *   The row.
 */
export function ApprovalRow(props: ApprovalRowProps): React.ReactNode {
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={props.blocked || props.pending !== undefined}
          onClick={props.onApprove}
          className="min-h-11 rounded border px-3 text-xs disabled:opacity-50"
        >
          {props.pending === 'approve' ? 'Approving...' : APPROVE_CARD}
        </button>
        <button
          type="button"
          disabled={props.pending !== undefined}
          onClick={props.onReject}
          className="min-h-11 px-3 text-xs text-[var(--color-danger)] disabled:opacity-50"
        >
          Reject
        </button>
        {props.error ? (
          <span role="alert" className="text-xs text-[var(--color-danger)]">
            {props.error}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[10px] text-[var(--color-muted)]">
        Probe runs automatically once you approve.
      </p>
    </>
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
            className="min-h-11 min-w-48 flex-1 rounded border bg-transparent px-2"
          />
          <button
            type="submit"
            disabled={props.provisioning}
            className="min-h-11 rounded border px-3 disabled:opacity-50"
          >
            {props.provisioning ? 'Registering the app...' : PROVISION_LABEL}
          </button>
        </form>
      ) : null}
      {props.error ? (
        <p role="alert" className="mt-1 text-[var(--color-danger)]">
          {props.error}
        </p>
      ) : null}
    </div>
  );
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

/** The credential row's inputs: the label, the landing handler, its state and error. */
export interface CredentialRowProps {
  credentialLabel: string;
  error?: string;
  landing: boolean;
  onLand: (plaintext: string) => void;
  presentation: CredentialPresentation;
  /** What the store says of the stored credential, when it is not simply live. */
  status?: string;
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
      {props.status ? (
        <p className="mt-1 text-[var(--color-warn)]">Status: {props.status}</p>
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
            className="min-h-11 min-w-48 flex-1 rounded border bg-transparent px-2"
          />
          <button
            type="submit"
            disabled={props.landing}
            className="min-h-11 rounded border px-3 disabled:opacity-50"
          >
            {props.landing ? 'Landing...' : (props.presentation.landingLabel ?? 'Land credential')}
          </button>
        </form>
      ) : null}
      {props.error ? (
        <p role="alert" className="mt-1 text-[var(--color-danger)]">
          {props.error}
        </p>
      ) : null}
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

interface SurfaceProbeAttempt {
  path: string;
  endpoint?: string;
  outcome: 'demoted' | 'ungranted' | 'listed-dead' | 'retried';
  reason: string;
  attemptedAt: number;
  retryAfterMs?: number;
}

/** The connection ladder's inputs: the candidate paths, the attempts and the verdict. */
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
          {attempts.map(
            (attempt, index): React.ReactNode => (
              <li key={`${attempt.attemptedAt}-${attempt.path}-${index}`}>
                <span className="font-medium">
                  {attempt.outcome === 'retried'
                    ? `${attempt.path} first probe failed: `
                    : `${attempt.path} attempt failed: `}
                </span>
                {attempt.reason}{' '}
                <span className="text-[var(--color-muted)]">
                  {attempt.outcome === 'retried'
                    ? `Retried after ${Math.round((attempt.retryAfterMs ?? 0) / 1_000)} s.`
                    : attempt.outcome === 'demoted'
                      ? 'Fell to the next approved rung.'
                      : attempt.outcome === 'ungranted'
                        ? 'Waiting on Day0 or approved access.'
                        : 'No approved fallback connected.'}
                </span>
              </li>
            ),
          )}
        </ol>
      ) : null}
    </div>
  );
}

/** Q5's access length, in days: what a renewal offers until the manager types another. */
export const DEFAULT_ACCESS_DAYS = 90;

/** How long before the end date the card warns, as the server's notice does (Q5). */
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** The verdicts of an approved card, whose access runs on a clock. */
const ACCESS_VERDICTS: ReadonlySet<string> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** Who set the end date, in the manager's words. */
const ACCESS_SET_BY_WORDS: Readonly<Record<NonNullable<Doc<'surfaces'>['accessSetBy']>, string>> = {
  approval: 'set when you approved the card',
  manager: 'set by you',
  upgrade: 'set by the upgrade',
};

/** A surface as the access row reads it. */
export type AccessSurface = Pick<
  Doc<'surfaces'>,
  '_id' | 'displayName' | 'verdict' | 'expiresAt' | 'accessSetBy' | 'reason'
>;

/**
 * The card's access line (Q5): when access ends, in the employee's zone, who
 * set the date, and the control that sets it again, which is also the
 * explicit renewal of an access that has ended (`surfaces.setAccessDays`).
 *
 * A probe never moves the date and nothing renews on its own, so the line is
 * the one place the manager keeps a connection alive. The outcome is announced
 * in the row's live region and focus returns to the control.
 *
 * Args:
 *   props: The surface, the instant to judge the warning against, and the setter.
 *
 * Returns:
 *   The row, or nothing for a card whose access has not started.
 */
export function AccessRow({
  surface,
  now,
  onSetDays,
}: {
  surface: AccessSurface;
  now: number;
  onSetDays: (days: number) => Promise<{ expiresAt: number }>;
}): React.ReactNode {
  const zone = useAgentZone();
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(String(DEFAULT_ACCESS_DAYS));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  if (!ACCESS_VERDICTS.has(surface.verdict) || surface.expiresAt === undefined) return null;
  // The hourly sweep marks an ended card `expired`; until it runs, and on a
  // card whose reason a later failure replaced, the passed date says it.
  const ended = surface.reason === 'expired' || surface.expiresAt <= now;
  const endingSoon = !ended && surface.expiresAt - now <= EXPIRY_WARNING_MS;
  const fieldId = `access-days-${surface._id}`;
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const save = (): void => {
    setBusy(true);
    setOutcome(null);
    // The chain ends in its own catch, which says the refusal in the live region.
    void onSetDays(Number(days))
      .then((result) => {
        setOutcome({
          tone: 'done',
          text: `${ended ? 'Access renewed' : 'Access length set'}: ${surface.displayName} access now ends ${clockTime(result.expiresAt, zone)}.`,
        });
        close();
      })
      .catch((err: unknown) =>
        setOutcome({ tone: 'refused', text: refusalText(err, 'The access length was not set.') }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div
      className={`mt-3 rounded border p-2 text-xs ${
        ended || endingSoon ? 'border-[var(--color-warn)]/40' : 'border-[var(--color-border)]'
      }`}
    >
      <p className={ended || endingSoon ? 'text-[var(--color-warn)]' : undefined}>
        {ended ? 'Access ended ' : 'Access ends '}
        <time dateTime={new Date(surface.expiresAt).toISOString()}>
          {clockTime(surface.expiresAt, zone)}
        </time>
        {surface.accessSetBy ? ` · ${ACCESS_SET_BY_WORDS[surface.accessSetBy]}` : ''}
        {ended
          ? '. Nothing is read or sent through this card until you renew it.'
          : endingSoon
            ? '. That is within a week; renew it to keep the connection.'
            : '.'}
      </p>
      <button
        ref={toggle}
        type="button"
        aria-expanded={editing}
        aria-controls={`${fieldId}-form`}
        onClick={() => {
          setOutcome(null);
          setEditing(!editing);
        }}
        className="mt-2 min-h-11 rounded border px-3 text-xs"
      >
        {ended ? 'Renew access' : 'Change the end date'}
      </button>
      {editing ? (
        <form
          id={`${fieldId}-form`}
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label htmlFor={fieldId}>Days from now</label>
          <input
            id={fieldId}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            required
            autoFocus
            value={days}
            disabled={busy}
            onChange={(event) => setDays(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
            className="min-h-11 w-24 rounded border bg-transparent px-2"
          />
          <button
            type="submit"
            disabled={busy || days.trim() === ''}
            className="min-h-11 rounded border px-3 disabled:opacity-50"
          >
            {busy ? 'Saving…' : ended ? 'Renew' : 'Set'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="min-h-11 rounded border px-3 disabled:opacity-50"
          >
            Cancel
          </button>
        </form>
      ) : null}
      <LiveStatus outcome={outcome} />
    </div>
  );
}

/** A surface as the tools row reads it. */
export type ToolsSurface = Pick<
  Doc<'surfaces'>,
  '_id' | 'displayName' | 'verdict' | 'toolAllowlist' | 'approvedToolAllowlist' | 'withheldTools'
>;

/**
 * The tools a connected card calls, and the manager's control to change the
 * tools it may call (U10 D2 (b), the re-approval of a narrowed card).
 *
 * The first connection after an approval freezes the approved list; a later
 * probe that finds more tools keeps them back (the row's `withheldTools`)
 * until the manager approves them here, and nothing else widens the list
 * (`surfaces.approveTools`). Taking a tool off stops it at once; one added is
 * called once the next probe finds the provider offers it.
 *
 * Args:
 *   props: The surface and the approval callback.
 *
 * Returns:
 *   The row, or nothing for a card that is not connected.
 */
export function ToolsRow({
  surface,
  onApprove,
}: {
  surface: ToolsSurface;
  onApprove: (tools: string[]) => Promise<unknown>;
}): React.ReactNode {
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<readonly string[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  if (surface.verdict !== 'connected') return null;
  const calls = surface.toolAllowlist ?? [];
  const approved = surface.approvedToolAllowlist ?? calls;
  const notOffered = approved.filter((tool) => !calls.includes(tool));
  const keptBack = (surface.withheldTools ?? []).filter((tool) => !approved.includes(tool));
  const options = [...new Set([...approved, ...keptBack, ...added])];
  const formId = `tools-${surface._id}`;
  const open = (): void => {
    setChosen(new Set(approved));
    setAdded([]);
    setTyped('');
    setOutcome(null);
    setEditing(true);
  };
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const addTyped = (): void => {
    const tool = typed.trim();
    if (tool === '') return;
    if (!options.includes(tool)) setAdded([...added, tool]);
    setChosen(new Set([...chosen, tool]));
    setTyped('');
  };
  const save = (): void => {
    const tools = options.filter((tool) => chosen.has(tool));
    setBusy(true);
    setOutcome(null);
    // The chain ends in its own catch, which says the refusal in the live region.
    void onApprove(tools)
      .then(() => {
        const gained = tools.filter((tool) => !approved.includes(tool));
        const dropped = approved.filter((tool) => !tools.includes(tool));
        const changes = [
          gained.length > 0 ? `added ${gained.join(', ')}` : '',
          dropped.length > 0 ? `removed ${dropped.join(', ')}` : '',
        ].filter(Boolean);
        setOutcome({
          tone: 'done',
          text: `Approved tools saved${changes.length > 0 ? `: ${changes.join('; ')}` : ''}. Day0 checks the connection now; an added tool is called once the provider offers it.`,
        });
        close();
      })
      .catch((err: unknown) =>
        setOutcome({
          tone: 'refused',
          text: refusalText(err, 'The approved tools were not saved.'),
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-3 rounded border border-[var(--color-border)] p-2 text-xs">
      <p>
        <span className="text-[var(--color-muted)]">Scopes: </span>
        {calls.length > 0 ? calls.join(', ') : 'no tool the provider offers is approved'}
      </p>
      {notOffered.length > 0 ? (
        <p className="mt-1 text-[var(--color-muted)]">
          Approved, not offered by the provider at the last check: {notOffered.join(', ')}
        </p>
      ) : null}
      {keptBack.length > 0 ? (
        <p className="mt-1 text-[var(--color-warn)]">
          Withheld, outside your approval: {keptBack.join(', ')}. Approve them here to let the
          employee call them.
        </p>
      ) : null}
      <button
        ref={toggle}
        type="button"
        aria-expanded={editing}
        aria-controls={formId}
        onClick={() => (editing ? close() : open())}
        className="mt-2 min-h-11 rounded border px-3 text-xs"
      >
        Change approved tools
      </button>
      {editing ? (
        <form
          id={formId}
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <fieldset>
            <legend className="text-[var(--color-muted)]">
              Tools {surface.displayName} may call
            </legend>
            <ul className="mt-1 space-y-1">
              {options.map((tool) => (
                <li key={tool}>
                  <label className="inline-flex min-h-11 items-center gap-2 font-mono">
                    <input
                      type="checkbox"
                      checked={chosen.has(tool)}
                      disabled={busy}
                      onChange={(event) => {
                        const next = new Set(chosen);
                        if (event.target.checked) next.add(tool);
                        else next.delete(tool);
                        setChosen(next);
                      }}
                    />
                    {tool}
                    {keptBack.includes(tool) ? (
                      <span className="font-sans text-[var(--color-warn)]">withheld</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${formId}-add`}>Another tool, by its name</label>
            <input
              id={`${formId}-add`}
              value={typed}
              disabled={busy}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTyped();
                }
              }}
              className="min-h-11 min-w-0 flex-1 rounded border bg-transparent px-2 font-mono"
            />
            <button
              type="button"
              disabled={busy || typed.trim() === ''}
              onClick={addTyped}
              className="min-h-11 rounded border px-3 disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy || chosen.size === 0}
              className="min-h-11 rounded border px-3 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save approved tools'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className="min-h-11 rounded border px-3 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <LiveStatus outcome={outcome} />
    </div>
  );
}

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

/** The Surfaces tab: every discovered system with its connection state, evidence and controls. */
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
        <LiveStatus outcome={change.outcome?.tone === 'done' ? change.outcome : null} />
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
