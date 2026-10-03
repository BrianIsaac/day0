'use client';

import Link from 'next/link';
import type { Doc } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import { verdictFor } from '@/surfaces/verdict';
import { runProgress, type WorkGate } from '@/work/item-display';
import { attemptsSpent } from '@/work/needs-manager';
import { needsSkillReason } from '@/work/skill-rationale';
import { Help, ItemSection, Lead, Note } from './ItemParts';
import { cancelledReason, colleagueHolding } from './work-item';

/** A reason as the row keeps it, ending in a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A verdict as the card reads it off the row. */
export interface ItemVerdict {
  decision: string;
  reason?: string;
  suggestedSkillName?: string;
  missingSurface?: string;
  missingPermissions?: string[];
}

/**
 * A skill an item waits on whose draft failed Day0's authoring check: the waiting card says so
 * and links to its Retry on the Skills tab, since nothing tries it again on its own (decision D3
 * (b), a product call, flagged).
 */
export interface RefusedSkill {
  readonly skillId: string;
  readonly name: string;
  /** Whether Retry is still offered: false once every attempt is spent and Give up is left. */
  readonly retryable: boolean;
}

/**
 * The employee's failed skills by id, as the waiting cards read them.
 *
 * @param skills - The employee's skills in the `failed` state.
 */
export function refusedSkillsOf(
  skills: ReadonlyArray<
    Pick<Doc<'skills'>, 'name' | 'state' | 'authoringAttempts' | 'offeredVersionId'> & {
      readonly _id: string;
    }
  >,
): ReadonlyMap<string, RefusedSkill> {
  return new Map(
    skills
      // An adoption's failed check is drawn by the adoption card, whose row has no Retry here.
      .filter((skill) => skill.offeredVersionId === undefined)
      .map((skill): [string, RefusedSkill] => [
        skill._id,
        { skillId: skill._id, name: skill.name, retryable: !attemptsSpent(skill) },
      ]),
  );
}

/** Where a failed skill's row is on the Skills tab, which lands on it (`useSkillAnchor`). */
export function skillAnchorHref(agentId: string, skillId: string): string {
  return `/agent/${agentId}/skills#skill-${skillId}`;
}

/**
 * Why an item that is not moving is where it is, from its verdict: parked until a system is
 * connected, a scope is granted or the charter is approved; waiting on a skill; held by a
 * colleague; cancelled, and why. A skip is its own section (`SkippedSection`); an item moving
 * on its own says nothing here.
 *
 * @param item - The row.
 * @param verdict - Its verdict.
 * @param surfaces - The employee's surfaces, for the connection a deferral waits on.
 * @param now - The page's clock, for that connection's state.
 */
export function VerdictSection({
  item,
  verdict,
  surfaces,
  now,
  refusedSkill,
}: {
  item: Doc<'workItems'>;
  verdict: ItemVerdict | undefined;
  surfaces: readonly SurfaceRecord[];
  now: number;
  /** The skill the item waits on, when its draft failed Day0's check (D3). */
  refusedSkill?: RefusedSkill;
}) {
  if (item.state === 'cancelled') {
    return (
      <ItemSection>
        <Note>
          <Lead>Cancelled.</Lead>{' '}
          {cancelledReason({ skipReason: item.skipReason, verdict, plan: item.plan })}
        </Note>
      </ItemSection>
    );
  }
  const holder = colleagueHolding(item);
  if (holder) {
    return (
      <ItemSection>
        <Note>
          <Lead>Skipped.</Lead> Another employee holds this:{' '}
          <Link
            href={`/agent/${holder.agentId}`}
            className="text-[var(--color-accent)] underline underline-offset-4"
          >
            {holder.name}
          </Link>
          .
        </Note>
        <Help>
          To give it to this employee instead, cancel it on {holder.name}&apos;s card; it comes back
          here by itself once they let it go.
        </Help>
      </ItemSection>
    );
  }
  if (item.state === 'needs-skill' && verdict && refusedSkill) {
    const href = skillAnchorHref(item.agentId, refusedSkill.skillId);
    return (
      <ItemSection>
        <Note>
          <Lead>Waiting on a skill</Lead>: {refusedSkill.name}.{' '}
          {refusedSkill.retryable ? (
            <>
              Its draft failed Day0&apos;s check, and nothing tries it again on its own:{' '}
              <Link href={href} className="text-[var(--color-accent)] underline underline-offset-4">
                Retry it on the Skills tab
              </Link>
              .
            </>
          ) : (
            <>
              Its draft failed Day0&apos;s check on every attempt:{' '}
              <Link href={href} className="text-[var(--color-accent)] underline underline-offset-4">
                The Skills tab
              </Link>{' '}
              offers Give up.
            </>
          )}
        </Note>
      </ItemSection>
    );
  }
  if (item.state === 'needs-skill' && verdict) {
    return (
      <ItemSection>
        <Note>
          <Lead>Waiting on a skill</Lead>
          {verdict.suggestedSkillName ? `: ${verdict.suggestedSkillName}` : ''}.{' '}
          {verdict.reason && needsSkillReason(verdict.reason)
            ? `${needsSkillReason(verdict.reason)} `
            : ''}
          <Link
            href={`/agent/${item.agentId}/skills`}
            className="text-[var(--color-accent)] underline underline-offset-4"
          >
            The Skills tab
          </Link>{' '}
          holds the proposal.
        </Note>
      </ItemSection>
    );
  }
  if (item.state === 'discovered' && verdict?.decision === 'queue') {
    return (
      <ItemSection>
        <Note>
          <Lead>Queued.</Lead> Waiting for a free slot
          {verdict.reason ? `: ${sentence(verdict.reason)}` : '.'}
        </Note>
      </ItemSection>
    );
  }
  if (item.state !== 'deferred' || !verdict || verdict.decision !== 'defer') return null;
  if (verdict.reason === 'awaiting-connection') {
    const surface = surfaces.find((candidate) => candidate.slug === verdict.missingSurface);
    return (
      <ItemSection>
        <Note tone="warn">
          <Lead>Parked</Lead> until {surface?.displayName ?? verdict.missingSurface ?? 'its system'}{' '}
          is connected
          {surface ? ` (${verdictFor(surface, now)} now)` : ' (not listed among the surfaces)'}. It
          is evaluated again once it is. Connect it on the{' '}
          <a href="#surfaces" className="text-[var(--color-accent)] underline underline-offset-4">
            Surfaces tab
          </a>
          .
        </Note>
      </ItemSection>
    );
  }
  if (verdict.reason === 'awaiting-charter') {
    return (
      <ItemSection>
        <Note tone="warn">
          <Lead>Parked:</Lead> waiting for you to approve the charter; it is evaluated once you do.
        </Note>
      </ItemSection>
    );
  }
  if (verdict.reason === 'awaiting-permission' && verdict.missingPermissions?.length) {
    return (
      <ItemSection>
        <Note tone="warn">
          <Lead>Parked:</Lead> needs {verdict.missingPermissions.join(', ')}, a grant you give. It
          is evaluated again once you do.
        </Note>
      </ItemSection>
    );
  }
  // A reason the card has no words for is still said, as the row keeps it.
  return (
    <ItemSection>
      <Note tone="warn">
        <Lead>Parked:</Lead> {sentence(verdict.reason ?? 'no reason recorded')}
      </Note>
    </ItemSection>
  );
}

/**
 * How far a working item has got (`runProgress`): the part under way, the parts in order, and
 * what reaches a surface meanwhile. A run records its steps' outcomes only when it finishes, so
 * the progress is by part.
 *
 * @param item - A row in `claimed`, `plan-approved` or `executing`.
 * @param autonomous - Whether autonomous actions are on.
 * @param gate - The deployment's gate.
 */
export function ProgressSection({
  item,
  autonomous,
  gate = 'real',
}: {
  item: Doc<'workItems'>;
  autonomous: boolean;
  gate?: WorkGate;
}) {
  const progress = runProgress(item, autonomous, gate);
  if (!progress) return null;
  return (
    <ItemSection title={progress.title}>
      <ol aria-label="Progress" className="flex flex-wrap gap-2">
        {progress.parts.map((part) => (
          <li
            key={part.name}
            aria-current={part.status === 'now' ? 'step' : undefined}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[13px] ${
              part.status === 'now'
                ? 'border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : part.status === 'done'
                  ? 'border-[var(--color-ok-line)] text-[var(--color-ok)]'
                  : 'border-[var(--color-border)] text-[var(--color-muted)]'
            }`}
          >
            {part.name}
            <span className="sr-only">
              {part.status === 'now' ? ', under way' : part.status === 'done' ? ', done' : ', next'}
            </span>
          </li>
        ))}
      </ol>
      <Help>{progress.detail}</Help>
    </ItemSection>
  );
}
