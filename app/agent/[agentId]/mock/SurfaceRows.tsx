'use client';

import {
  type ProvisioningPresentation,
  PROVISION_LABEL,
  type CredentialPresentation,
} from '@/surfaces/credential-presentation';
import type { SurfaceDiscoveryEvidence } from '@/docs/system-discovery';
import {
  type ScopeValue,
  type IntakeScope,
  presentIntakeScope,
  presentScopeDrift,
} from '@/surfaces/intake-scope';
import type { FormEvent } from 'react';
import { pageLinkFromQuote } from '@/surfaces/evidence';

/** The one control that approves a proposed card (Q10); the rehearsal driver clicks it by name. */
export const APPROVE_CARD = 'Approve';

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
