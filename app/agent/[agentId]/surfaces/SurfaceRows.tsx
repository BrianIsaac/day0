'use client';

import { type ProvisioningPresentation, PROVISION_LABEL } from '@/surfaces/credential-presentation';
import type { SurfaceDiscoveryEvidence } from '@/docs/system-discovery';
import { type ScopeValue, type IntakeScope, presentIntakeScope } from '@/surfaces/intake-scope';
import { useId, type FormEvent } from 'react';
import { pageLinkFromQuote } from '@/surfaces/evidence';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { INPUT_CLASS } from '../../../components/Field';

/** The one control that approves a proposed card (Q10); the rehearsal driver clicks it by name. */
export const APPROVE_CARD = 'Approve';

/** Q10's line under the one approval: real mode has one subject, so no second approver is named. */
export const ONE_APPROVER = 'You approve; there is no second approver.';

/** A quoted page line on a card: the source and page it came from above the words it says. */
const QUOTE = 'border-l-2 border-[var(--color-border-2)] pl-3';

/** One inset block of a card: what orientation found, what intake reads, how a rung was tried. */
const INSET = 'rounded-lg bg-[var(--color-inset)] p-3 text-sm';

/** The Slack provisioning row's inputs: the token handler, its error and the presentation. */
export interface ProvisioningRowProps {
  readonly error?: string;
  readonly onProvision: (configurationToken: string) => void;
  readonly presentation: ProvisioningPresentation;
  readonly provisioning: boolean;
  readonly surfaceSlug: string;
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
    <div className={INSET}>
      <p className="font-medium text-[var(--color-fg)]">System discovered from</p>
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
            className={`mt-2 ${QUOTE}`}
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

/** The intake scope row's inputs: the scope, what changed on its pages, and source labels. */
export interface IntakeScopeRowProps {
  /** What the server found changed on the scope's pages since the proposal (`scopeChange`, D D4). */
  readonly changed?: string;
  readonly scope: IntakeScope;
  readonly sourceLabels: ReadonlyMap<string, string>;
  readonly surfaceClass: string;
  readonly system: string;
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
  const queues =
    props.surfaceClass === 'kanban'
      ? [props.scope.project, ...(props.scope.projects ?? [])]
          .filter((value): value is ScopeValue => value !== undefined)
          .map((value): string => `Project ${value.value}`)
      : (props.scope.channels ?? []).map((value): string => `#${value.value}`);
  // The reads line already names a single queue; the list is for telling several apart.
  const listed = queues.length > 1 ? queues : [];
  return (
    <div className={INSET}>
      <p
        className={
          presentation.empty
            ? 'font-medium text-[var(--color-warn)]'
            : 'font-medium text-[var(--color-fg)]'
        }
      >
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
          <blockquote key={`${value.ref}-${value.value}-${index}`} className={`mt-2 ${QUOTE}`}>
            <span className="text-[var(--color-muted)]">{`${source} / ${value.ref}`}</span>
            <br />
            <PageLine text={value.quote} />
          </blockquote>
        );
      })}
      {props.changed ? <p className="mt-2 text-[var(--color-warn)]">{props.changed}</p> : null}
      {presentation.notes.map(
        (note: string, index: number): React.ReactNode => (
          <p key={`note-${index}`} className="mt-1 text-[13px] text-[var(--color-muted)]">
            <PageLine text={note} />
          </p>
        ),
      )}
    </div>
  );
}

/** A discovered system the charter did not name, awaiting a proposal. */
export interface UnnamedSystem {
  readonly _id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly class: string;
  readonly discoveryEvidence?: SurfaceDiscoveryEvidence[];
}

/** The unnamed-systems row's inputs: the systems, the propose handler and its error. */
export interface UnnamedSystemsRowProps {
  readonly error?: { surfaceId: string; message: string };
  readonly onPropose: (surfaceId: string) => void;
  readonly proposing?: string;
  readonly sourceLabels: ReadonlyMap<string, string>;
  readonly systems: readonly UnnamedSystem[];
}

/**
 * The documented systems this role's charter does not name, as a card beside the others, each
 * one click from a card of its own (a proposal the manager still approves).
 *
 * @returns The card, or nothing when every documented system is named.
 */
export function UnnamedSystemsRow(props: UnnamedSystemsRowProps): React.ReactNode {
  if (props.systems.length === 0) return null;
  return (
    <Card title="Documented, not named in the charter" meta={props.systems.length}>
      <p className="text-sm text-[var(--color-fg-2)]">
        Cards are proposed for the systems the charter names. Propose one of these to file its card;
        you still approve it, and a charter amendment names it for good.
      </p>
      <ul className="mt-3 grid gap-3">
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
              className="grid gap-2 border-t border-[var(--color-border)] pt-3 text-sm"
            >
              <p className="font-medium text-[var(--color-fg)]">
                {system.displayName}{' '}
                <span className="text-[13px] font-normal text-[var(--color-muted)]">
                  {system.class}
                </span>
              </p>
              {documented ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  {`${source} / ${documented.ref}`}: <EvidenceQuote quote={documented.quote} />
                </p>
              ) : null}
              <div>
                <Button
                  size="small"
                  aria-label={`Propose ${system.displayName}`}
                  onClick={(): void => props.onPropose(system._id)}
                  disabled={proposing}
                >
                  {proposing ? 'Proposing…' : 'Propose'}
                </Button>
              </div>
              {props.error?.surfaceId === system._id ? (
                <p role="alert" className="text-[var(--color-danger)]">
                  {props.error.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** What the approval row of a proposed card shows and does. */
export interface ApprovalRowProps {
  /** The decision in flight, if any. */
  readonly pending?: 'approve' | 'reject';
  /** The card cannot be approved yet: its reason is `refusal`, or the component status is loading. */
  readonly blocked: boolean;
  /** Why Approve is disabled, said beside it (the server's `approvalRefusal`, E-63). */
  readonly refusal?: string;
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
    return `The check of ${system} did not run${outcome.reason ? `: ${outcome.reason.replace(/\.$/, '')}` : ''}.`;
  }
  return `Checked ${system}: ${outcome.verdict}${outcome.reason ? `, ${outcome.reason.replace(/\.$/, '')}` : ''}.`;
}

/**
 * The proposed card's one approval (Q10): Approve and Reject, why Approve is disabled when it
 * is, the refusal of the last decision, and the line that says the manager is the one approver
 * and the probe follows.
 */
export function ApprovalRow(props: ApprovalRowProps): React.ReactNode {
  const reasonId = useId();
  const refused = props.blocked || props.refusal !== undefined;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="approve"
          size="small"
          disabled={refused || props.pending !== undefined}
          aria-describedby={props.refusal !== undefined ? reasonId : undefined}
          onClick={props.onApprove}
        >
          {props.pending === 'approve' ? 'Approving…' : APPROVE_CARD}
        </Button>
        <Button
          variant="quiet"
          size="small"
          disabled={props.pending !== undefined}
          onClick={props.onReject}
        >
          Reject
        </Button>
        {props.error ? (
          <span role="alert" className="text-sm text-[var(--color-danger)]">
            {props.error}
          </span>
        ) : null}
      </div>
      {props.refusal !== undefined ? (
        <p id={reasonId} className="text-sm text-[var(--color-warn)]">
          {props.refusal}
        </p>
      ) : null}
      <p className="text-[13px] text-[var(--color-muted)]">
        {ONE_APPROVER} Day0 checks the connection as soon as you approve.
      </p>
    </div>
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
    <div className={INSET}>
      <p className="font-medium text-[var(--color-fg)]">{props.presentation.title}</p>
      <p className="mt-1 text-[var(--color-fg-2)]">{props.presentation.note}</p>
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
        <form onSubmit={onSubmit} className="mt-3 grid gap-1.5">
          <label
            htmlFor={`configuration-token-${props.surfaceSlug}`}
            className="text-[13px] font-medium text-[var(--color-fg-2)]"
          >
            App configuration token
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`configuration-token-${props.surfaceSlug}`}
              name="configurationToken"
              type="password"
              autoComplete="new-password"
              required
              className={`${INPUT_CLASS} min-w-48 flex-1`}
            />
            <Button type="submit" size="small" disabled={props.provisioning}>
              {props.provisioning ? 'Registering the app…' : PROVISION_LABEL}
            </Button>
          </div>
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
  readonly path: string;
  readonly endpoint?: string;
  readonly outcome: 'demoted' | 'ungranted' | 'listed-dead' | 'retried';
  readonly reason: string;
  readonly attemptedAt: number;
  readonly retryAfterMs?: number;
}

/** The connection ladder's inputs: the candidate paths, the attempts and the verdict. */
export interface SurfaceLadderProps {
  readonly candidates?: Array<{ path: string; endpoint: string }>;
  readonly attempts?: SurfaceProbeAttempt[];
}

/** Show exactly which routes were approved and what each failed probe established. */
export function SurfaceLadder({ candidates, attempts }: SurfaceLadderProps): React.ReactNode {
  if (!candidates?.length && !attempts?.length) return null;
  return (
    <div className={INSET}>
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
