'use client';

import { useState } from 'react';
import type { CharterConstraint, StrikePreview } from '@/agent/charter-constraints';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';

const CONSTRAINT_KIND_LABEL: Record<CharterConstraint['kind'], string> = {
  'candidate-property': 'what work qualifies',
  'system-boundary': 'where I may act',
  'reporting-line': 'who I report to',
};

/** Where a rule stands, as its chip says it. */
export type RuleStanding = 'confirmed' | 'struck' | 'kept';

/**
 * A rule's standing: struck by the manager, kept because the charter cannot do without it (a
 * strike the effective charter refuses), or confirmed.
 */
export function ruleStanding(
  constraint: Pick<CharterConstraint, 'struck'>,
  preview: StrikePreview | undefined,
): RuleStanding {
  if (constraint.struck) return 'struck';
  return preview?.refusal !== undefined ? 'kept' : 'confirmed';
}

/**
 * The chip for each standing. Struck is drawn muted, its line through the quote in danger: danger
 * is never drawn on its own fill, which reads under AA (wave 6 A decision 4 (b)).
 */
const STANDING_CHIP: Readonly<
  Record<RuleStanding, { label: string; tone: 'ok' | 'muted' | 'you' }>
> = {
  confirmed: { label: 'Confirmed', tone: 'ok' },
  struck: { label: 'Struck', tone: 'muted' },
  kept: { label: 'Kept', tone: 'you' },
};

/** The clauses a strike removes, quoted for the row. */
function quotedClauses(clauses: readonly string[]): string {
  return clauses.map((clause: string): string => `“${clause}”`).join('; ');
}

/**
 * One rule the charter enforces (round two section 3.5): the manager's sentence, what it became
 * in the charter, what striking it would do, its standing, and Strike or Restore.
 *
 * `justStruck` marks a rule struck since the list first rendered, whose line draws (v3 section
 * 5.2); a rule struck before the page opened is drawn struck at once.
 */
export function RuleRow({
  constraint,
  index,
  preview,
  justStruck,
  busy,
  record = false,
  onStrike,
  onRestore,
}: {
  constraint: CharterConstraint;
  index: number;
  preview: StrikePreview | undefined;
  justStruck: boolean;
  busy: boolean;
  /** The row is the approved charter's record, drawn without the review's warn line. */
  record?: boolean;
  onStrike?: (index: number) => void;
  onRestore?: (index: number) => void;
}) {
  const standing = ruleStanding(constraint, preview);
  const chip = STANDING_CHIP[standing];
  return (
    <li
      data-just={justStruck ? '' : undefined}
      data-standing={standing}
      className={`grid gap-x-4 gap-y-3 rounded-[10px] border p-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-4 ${
        standing === 'struck'
          ? 'border-[var(--color-border)] bg-[var(--color-card)]'
          : standing === 'kept' || record
            ? 'border-[var(--color-border)] bg-[var(--color-bg)]'
            : 'border-[var(--color-warn-line)] bg-[var(--color-bg)]'
      }`}
    >
      <div className="min-w-0">
        <p
          data-strike=""
          className={`text-base italic ${
            constraint.struck
              ? 'text-[var(--color-muted)] line-through decoration-[var(--color-danger)] decoration-2'
              : 'text-[var(--color-fg)]'
          }`}
        >
          {/* A derived rule's quote is the clause itself, not a sentence
            the manager said, so it is not printed as a quotation. */}
          {constraint.origin === 'derived' ? (
            constraint.quote
          ) : (
            <>&ldquo;{constraint.quote}&rdquo;</>
          )}
        </p>
        <p className="mt-1.5 text-sm text-[var(--color-fg-2)]">
          {CONSTRAINT_KIND_LABEL[constraint.kind]}
          {constraint.wording.length > 0 ? (
            <>
              {' · in the charter as '}
              {constraint.wording.map((phrase, i) => (
                <span key={i}>
                  {i > 0 ? '; ' : ''}
                  <b className="font-semibold text-[var(--color-fg)]">
                    {i < constraint.wording.length - 1 ? phrase.replace(/\.$/, '') : phrase}
                  </b>
                </span>
              ))}
            </>
          ) : (
            ' · not verified: no clause carries these words, so striking it changes nothing'
          )}
          {constraint.origin === 'derived'
            ? " · found by checking the clauses (the charter's wording, not a sentence of yours)"
            : ''}
          {constraint.origin === 'manager' ? ' · added by you' : ''}
          {constraint.struck ? (
            <>
              {' '}
              <span data-struck-mark="">· struck</span>
            </>
          ) : null}
        </p>
        {preview?.refusal ? (
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            cannot be struck: {preview.refusal}
          </p>
        ) : preview && preview.removedClauses.length > 0 ? (
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            {preview.removedClauses.length === 1 ? 'strikes the clause: ' : 'strikes the clauses: '}
            {quotedClauses(preview.removedClauses)}
          </p>
        ) : null}
        {preview && !preview.refusal
          ? preview.rewrittenClauses.map((pair, i) => (
              <p key={i} className="mt-1 text-[13px] text-[var(--color-muted)]">
                {'rewrites the clause: '}
                {quotedClauses([pair.from])}
                {' to '}
                {quotedClauses([pair.to])}
              </p>
            ))
          : null}
        {constraint.struck && onRestore ? (
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            Its clauses leave the charter on approval; Restore puts them back.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:grid sm:content-start sm:justify-items-end">
        <Chip tone={chip.tone}>{chip.label}</Chip>
        {!constraint.struck && onStrike ? (
          <Button
            size="small"
            onClick={() => onStrike(index)}
            disabled={busy || preview?.refusal !== undefined}
            title={preview?.refusal}
            aria-label={`Strike: ${constraint.quote}`}
          >
            Strike
          </Button>
        ) : constraint.struck && onRestore ? (
          <Button
            size="small"
            onClick={() => onRestore(index)}
            disabled={busy}
            aria-label={`Restore: ${constraint.quote}`}
          >
            Restore
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The confirm-or-strike list: every rule the draft will enforce, in the
 * manager's own words, beside the clause phrases that encode it.
 *
 * Before approval each row can be struck or restored; the clauses in the
 * document are drawn as approval will leave them. After approval the list is
 * the record of what was confirmed and what was struck. With `previewStrike`
 * each row says what its strike would remove, and a strike the effective
 * charter refuses is disabled with the reason and the rule kept, so nothing
 * the card offers can fail at approval.
 */
export function ConstraintList({
  constraints,
  approved,
  onStrike,
  onRestore,
  previewStrike,
  busy = false,
}: {
  constraints: CharterConstraint[];
  approved: boolean;
  /** A change to the charter is in flight; the controls wait for it. */
  busy?: boolean;
  /** Strike a confirmed rule; before approval a draft flag, after it an amendment. */
  onStrike?: (index: number) => void;
  /** Restore a struck rule; only a draft can, because a strike after approval has already left the clauses. */
  onRestore?: (index: number) => void;
  /** What striking a rule would do, computed as approval computes it. */
  previewStrike?: (index: number) => StrikePreview;
}) {
  // A rule struck since the list first rendered is this visit's decision, and its line draws.
  const [struckOnArrival] = useState(
    (): ReadonlySet<number> =>
      new Set(constraints.flatMap((constraint, index) => (constraint.struck ? [index] : []))),
  );
  if (constraints.length === 0) return null;
  return (
    <div className="grid gap-3">
      <div>
        <h3 className="text-[15px] font-semibold text-[var(--color-fg)]">
          {approved
            ? 'Rules this charter enforces'
            : 'These words will limit the work. Confirm or strike each one.'}
        </h3>
        {approved ? null : (
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">
            Each rule is a sentence you said, and what it became. Strike removes the clauses it
            produced; nothing else changes.
          </p>
        )}
      </div>
      <ul className="grid gap-2.5">
        {constraints.map((constraint, index) => (
          <RuleRow
            key={index}
            constraint={constraint}
            index={index}
            preview={
              !constraint.struck && onStrike && previewStrike ? previewStrike(index) : undefined
            }
            justStruck={constraint.struck === true && !struckOnArrival.has(index)}
            busy={busy}
            record={approved}
            onStrike={onStrike}
            onRestore={onRestore}
          />
        ))}
      </ul>
    </div>
  );
}
