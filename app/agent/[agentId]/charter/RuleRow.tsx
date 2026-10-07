'use client';

import { useState, type ReactNode } from 'react';
import type { ListClauseField } from '@/agent/charter-amendment';
import {
  listedRules,
  type CharterConstraint,
  type KeptClause,
  type RulePlacement,
  type StrikePreview,
} from '@/agent/charter-constraints';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { defaultRuleClause } from './AmendCharterPanel';
import { READER_ACTED, type CharterActors } from './charter-actors';

const CONSTRAINT_KIND_LABEL: Record<CharterConstraint['kind'], string> = {
  'candidate-property': 'what work qualifies',
  'system-boundary': 'where I may act',
  'reporting-line': 'who I report to',
};

/** Where a rule stands, as its chip says it. */
export type RuleStanding =
  | 'confirmed'
  | 'struck'
  | 'kept'
  | 'unverified'
  | 'check'
  | 'in-no-clause';

/** Where a rule drafted before binds is: by its words alone. */
const BY_WORDING: RulePlacement = { kind: 'by-wording' };

/**
 * A rule's standing: struck by the manager, kept because the charter cannot do without it (a
 * strike the effective charter refuses), or else by where it is placed. A rule bound to its clauses
 * is confirmed when one of them carries its words, and to be checked when none does; a rule in no
 * clause says so. A rule drafted before binds is confirmed, or not in the clauses because no clause
 * carries its words (none were verified, or none are left, so a strike would change nothing).
 */
export function ruleStanding(
  constraint: Pick<CharterConstraint, 'struck' | 'wording'>,
  preview: StrikePreview | undefined,
  placement: RulePlacement = BY_WORDING,
): RuleStanding {
  if (constraint.struck) return 'struck';
  if (preview?.refusal !== undefined) return 'kept';
  switch (placement.kind) {
    case 'in-no-clause':
      return 'in-no-clause';
    case 'bound':
      return placement.carriesWords ? 'confirmed' : 'check';
    case 'by-wording':
      return constraint.wording.length > 0 && preview?.changes !== false
        ? 'confirmed'
        : 'unverified';
    default: {
      const unknown: never = placement;
      throw new Error(`unknown rule placement ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Whether the row offers Strike: a strike the charter refuses is offered disabled with why, a
 * strike that would change nothing is not offered at all (the production walk's 6c), and a row
 * with no preview to ask is offered it as before.
 */
export function offersStrike(preview: StrikePreview | undefined): boolean {
  return preview === undefined || preview.refusal !== undefined || preview.changes;
}

/**
 * The chip for each standing. Struck is drawn muted, its line through the quote in danger: danger
 * is never drawn on its own fill, which reads under AA (wave 6 A decision 4 (b)).
 */
const STANDING_CHIP: Readonly<
  Record<RuleStanding, { label: string; tone: 'ok' | 'muted' | 'warn' | 'you' }>
> = {
  confirmed: { label: 'Confirmed', tone: 'ok' },
  struck: { label: 'Struck', tone: 'muted' },
  kept: { label: 'Kept', tone: 'you' },
  unverified: { label: 'Not in the clauses', tone: 'muted' },
  check: { label: 'Check the clause', tone: 'warn' },
  'in-no-clause': { label: 'In no clause', tone: 'warn' },
};

/** The clause lists by the words the row says them in. */
const CLAUSE_LIST_WORDS: Readonly<Record<ListClauseField, string>> = {
  willDo: 'will do',
  willNotDo: 'will not do',
  escalationTriggers: 'escalation triggers',
};

/** The clauses a strike removes, quoted for the row. */
function quotedClauses(clauses: readonly string[]): string {
  return clauses.map((clause: string): string => `“${clause}”`).join('; ');
}

/**
 * Whether a clause opens on a name written in lower case, which capitalising would misspell: a
 * word with no vowel (`dbt`, `npm`, `sql`), with a capital after its first letter (`iPhone`), with
 * a digit (`s3`), or with a dot or underscore between its letters (`stripe.com`, `pg_dump`). A
 * hyphenated word (`follow-up`) and a word ending a sentence (`sync.`) are words, not names.
 */
function opensOnLowerCaseName(phrase: string): boolean {
  const first = /^\S+/.exec(phrase)?.[0].replace(/[,;:.!?]+$/, '') ?? '';
  return (
    /^[a-z]/.test(first) &&
    (!/[aeiouy]/i.test(first) ||
      /^.+[A-Z]/.test(first) ||
      /[0-9]/.test(first) ||
      /[a-z0-9][._][a-z0-9]/i.test(first))
  );
}

/**
 * The clauses' words the rule's "in the charter as" list shows, one per clause. Several are
 * capitalised alike, so clauses the model wrote in mixed case read as one list (the hosted walk's
 * m22: "answer routine asks ...; Post in any Slack channel ..."), capitalised rather than lowered
 * since a clause may open on a name; a clause that opens on a name written in lower case keeps it
 * (`dbt models ...`, the second review's x10), and one clause is left as written. Only the last
 * keeps its full stop.
 *
 * @param wording - The clauses' words as the charter holds them.
 */
export function listedWording(wording: readonly string[]): string[] {
  if (wording.length <= 1) return [...wording];
  return wording.map((phrase, index) => {
    const words = index === wording.length - 1 ? phrase : phrase.replace(/\.$/, '');
    return opensOnLowerCaseName(words)
      ? words
      : `${words.charAt(0).toLocaleUpperCase('en-GB')}${words.slice(1)}`;
  });
}

/** The bold clause words a rule drafted before binds lists, joined as one list. */
function ClauseWords({ clauses }: { clauses: readonly string[] }) {
  return (
    <>
      {listedWording(clauses).map((phrase, i) => (
        <span key={i}>
          {i > 0 ? '; ' : ''}
          <b className="font-semibold text-[var(--color-fg)]">{phrase}</b>
        </span>
      ))}
    </>
  );
}

/**
 * The clauses a bound rule produced, joined as one list in the page's text colour at the row's own
 * weight: whole sentences, so the rule's quote above them stays the row's headline.
 */
function BoundClauses({ clauses }: { clauses: readonly string[] }) {
  return (
    <>
      {listedWording(clauses).map((clause, i) => (
        <span key={i}>
          {i > 0 ? '; ' : ''}
          <span data-clause="" className="text-[var(--color-fg)]">
            {clause}
          </span>
        </span>
      ))}
    </>
  );
}

/**
 * What the rule became in the charter, after its kind: the clauses it binds, or for a rule drafted
 * before binds the words the clauses carry ("not verified" when none do); a rule in no clause says
 * so. A struck rule whose clauses have left the charter says nothing more here.
 */
function PlacementWords({
  constraint,
  placement,
}: {
  constraint: CharterConstraint;
  placement: RulePlacement;
}) {
  switch (placement.kind) {
    case 'by-wording':
      return constraint.wording.length > 0 ? (
        <>
          {' · in the charter as '}
          <ClauseWords clauses={constraint.wording} />
        </>
      ) : (
        <>{' · not verified: no clause carries these words'}</>
      );
    case 'bound':
      // A confirmed rule is shown as the clauses that carry it; the others are said beneath it
      // (W13-R6). A rule none carries shows every clause it binds, for the manager to check.
      return (
        <>
          {' · in the charter as '}
          <BoundClauses
            clauses={
              placement.carriesWords
                ? placement.clauses.filter((clause) => !placement.notCarrying.includes(clause))
                : placement.clauses
            }
          />
        </>
      );
    case 'in-no-clause':
      return constraint.struck ? null : <>{' · in no clause'}</>;
    default: {
      const unknown: never = placement;
      throw new Error(`unknown rule placement ${JSON.stringify(unknown)}`);
    }
  }
}

/** Why a strike keeps a clause its rule binds (W13-R6, W13-R7), in the row's muted line. */
function keptClauseWords(kept: KeptClause): string {
  const clause = quotedClauses([kept.clause]);
  switch (kept.because) {
    case 'another-rule':
      return `keeps the clause ${clause} because another rule still needs it: ${quotedClauses([kept.rule ?? 'another rule'])}`;
    case 'not-this-rule':
      return `keeps the clause ${clause}: it does not carry your words`;
    case 'no-words':
      return `keeps the clause ${clause}: your words are not in it to take out`;
    default: {
      const unknown: never = kept.because;
      throw new Error(`unknown kept clause ${String(unknown)}`);
    }
  }
}

/**
 * The muted lines under a row that say what its strike would do, or why it does nothing: the
 * clauses it takes, then each bound clause it keeps and why. On a row to be checked it says the
 * clauses a strike takes may not be this rule.
 */
function StrikeLine({
  constraint,
  placement,
  preview,
  check,
}: {
  constraint: CharterConstraint;
  placement: RulePlacement;
  preview: StrikePreview | undefined;
  check: boolean;
}) {
  if (preview?.refusal) return <RowNote>cannot be struck: {preview.refusal}</RowNote>;
  const kept = (preview?.keptClauses ?? []).map((clause, i) => (
    <RowNote key={i}>{keptClauseWords(clause)}</RowNote>
  ));
  return (
    <>
      <TakenLine constraint={constraint} placement={placement} preview={preview} check={check} />
      {kept}
    </>
  );
}

/** The line that says which clauses a strike takes, or why it takes none. */
function TakenLine({
  constraint,
  placement,
  preview,
  check,
}: {
  constraint: CharterConstraint;
  placement: RulePlacement;
  preview: StrikePreview | undefined;
  check: boolean;
}) {
  if (preview && preview.removedClauses.length > 0) {
    const one = preview.removedClauses.length === 1;
    const lead = check
      ? one
        ? 'strikes the clause, though it may not be this rule: '
        : 'strikes the clauses, though they may not be this rule: '
      : one
        ? 'strikes the clause: '
        : 'strikes the clauses: ';
    return (
      <RowNote>
        {lead}
        {quotedClauses(preview.removedClauses)}
      </RowNote>
    );
  }
  if (!preview || preview.changes) return null;
  if (placement.kind === 'bound') {
    return <RowNote>nothing to strike: striking it would change no clause</RowNote>;
  }
  if (placement.kind === 'by-wording' && constraint.wording.length > 0) {
    return <RowNote>nothing to strike: no clause carries these words any more</RowNote>;
  }
  return null;
}

/** A line under a row: muted, or in the text colour for what the manager reads before approving. */
function RowNote({ children, emphasis = false }: { children: ReactNode; emphasis?: boolean }) {
  return (
    <p
      className={
        emphasis
          ? 'mt-1.5 text-sm text-[var(--color-fg)]'
          : 'mt-1 text-[13px] text-[var(--color-muted)]'
      }
    >
      {children}
    </p>
  );
}

/**
 * One rule the charter enforces (round two section 3.5): the manager's sentence, what it became
 * in the charter, what striking it would do, its standing, and Strike or Restore.
 *
 * `justStruck` marks a rule struck since the list first rendered, whose line draws (v3 section
 * 5.2); a rule struck before the page opened is drawn struck at once. A rule the manager added
 * names who added it: "you", or the earlier manager a handover took the employee from.
 *
 * A rule bound to clauses that do not carry its words asks the manager to check them; a rule in
 * no clause says the charter does not enforce it and, with `onKeep`, offers the way to: on a
 * draft, a request for changes; on the approved record, the rule added to its list by amendment
 * (13-R, a product call).
 */
export function RuleRow({
  constraint,
  index,
  preview,
  placement = BY_WORDING,
  justStruck,
  busy,
  record = false,
  name = 'Your employee',
  actors = READER_ACTED,
  onStrike,
  onRestore,
  onKeep,
}: {
  constraint: CharterConstraint;
  index: number;
  preview: StrikePreview | undefined;
  /** Where the rule is in the charter (`rulePlacement`); by its words alone when not given. */
  placement?: RulePlacement;
  justStruck: boolean;
  busy: boolean;
  /** The row is the approved charter's record, drawn without the review's warn line. */
  record?: boolean;
  /** The employee's name, for the way to keep a rule in no clause. */
  name?: string;
  /** Who added a rule the manager added; the reader, by default. */
  actors?: CharterActors;
  onStrike?: (index: number) => void;
  onRestore?: (index: number) => void;
  /** Keep a rule in no clause: ask for changes on a draft, add it as a clause once approved. */
  onKeep?: (index: number) => void;
}) {
  const standing = ruleStanding(constraint, preview, placement);
  // The bound clauses a confirmed rule does not carry, said once: a kept line already names its own.
  const unnamed =
    standing === 'confirmed' && placement.kind === 'bound'
      ? placement.notCarrying.filter(
          (clause) => !(preview?.keptClauses ?? []).some((kept) => kept.clause === clause),
        )
      : [];
  const chip = STANDING_CHIP[standing];
  const keepUnder = CLAUSE_LIST_WORDS[defaultRuleClause(constraint.quote)];
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
          <PlacementWords constraint={constraint} placement={placement} />
          {constraint.origin === 'derived'
            ? " · found by checking the clauses (the charter's wording, not a sentence of yours)"
            : ''}
          {constraint.origin === 'manager' ? ` · added by ${actors.added(constraint)}` : ''}
          {constraint.struck ? (
            <>
              {' '}
              <span data-struck-mark="">· struck</span>
            </>
          ) : null}
        </p>
        {standing === 'check' && placement.kind === 'bound' ? (
          <RowNote emphasis>
            {placement.clauses.length === 1
              ? 'This clause does not carry your words.'
              : 'These clauses do not carry your words.'}
          </RowNote>
        ) : null}
        {standing === 'in-no-clause' ? (
          <RowNote emphasis>
            {record
              ? `The charter does not enforce it. Add it to ${keepUnder} to enforce it.`
              : `The charter does not enforce it. Ask ${name} for changes to add it, or approve without it.`}
          </RowNote>
        ) : null}
        <StrikeLine
          constraint={constraint}
          placement={placement}
          preview={preview}
          check={standing === 'check'}
        />
        {preview && !preview.refusal
          ? preview.rewrittenClauses.map((pair, i) => (
              <RowNote key={i}>
                {'rewrites the clause: '}
                {quotedClauses([pair.from])}
                {' to '}
                {quotedClauses([pair.to])}
              </RowNote>
            ))
          : null}
        {/* After what Strike does, and only for a clause no kept line already names (the design pass). */}
        {unnamed.length > 0 ? (
          <RowNote>
            {unnamed.length === 1
              ? 'Also linked to this rule, but it does not carry your words: '
              : 'Also linked to this rule, but they do not carry your words: '}
            {quotedClauses(unnamed)}
          </RowNote>
        ) : null}
        {constraint.struck && onRestore ? (
          <RowNote>Its clauses leave the charter on approval; Restore puts them back.</RowNote>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:grid sm:content-start sm:justify-items-end">
        <Chip tone={chip.tone}>{chip.label}</Chip>
        {!constraint.struck && onStrike && offersStrike(preview) ? (
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
        ) : standing === 'in-no-clause' && onKeep ? (
          <Button
            size="small"
            onClick={() => onKeep(index)}
            disabled={busy}
            aria-label={
              record
                ? `Add to ${keepUnder}: ${constraint.quote}`
                : `Ask for changes to add: ${constraint.quote}`
            }
          >
            {record ? `Add to ${keepUnder}` : 'Ask for changes'}
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
  name,
  actors,
  onStrike,
  onRestore,
  onKeep,
  previewStrike,
  placementOf,
  busy = false,
}: {
  constraints: CharterConstraint[];
  approved: boolean;
  /** The employee's name, for the way to keep a rule in no clause. */
  name?: string;
  /** Who added the rules the manager added; the reader, by default. */
  actors?: CharterActors;
  /** A change to the charter is in flight; the controls wait for it. */
  busy?: boolean;
  /** Strike a confirmed rule; before approval a draft flag, after it an amendment. */
  onStrike?: (index: number) => void;
  /** Restore a struck rule; only a draft can, because a strike after approval has already left the clauses. */
  onRestore?: (index: number) => void;
  /** Keep a rule in no clause: ask for changes on a draft, add it as a clause once approved. */
  onKeep?: (index: number) => void;
  /** What striking a rule would do, computed as approval computes it. */
  previewStrike?: (index: number) => StrikePreview;
  /** Where each rule is in the charter (`rulePlacement`); by its words alone when not given. */
  placementOf?: (constraint: CharterConstraint) => RulePlacement;
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
            Each rule is a sentence you said, and what it became. Strike removes the clauses that
            carry it; each row says what it takes and what it keeps.
          </p>
        )}
      </div>
      <ul className="grid gap-2.5">
        {listedRules(constraints).map(({ constraint, index }) => (
          <RuleRow
            key={index}
            constraint={constraint}
            index={index}
            preview={
              !constraint.struck && onStrike && previewStrike ? previewStrike(index) : undefined
            }
            placement={placementOf?.(constraint)}
            justStruck={constraint.struck === true && !struckOnArrival.has(index)}
            busy={busy}
            record={approved}
            name={name}
            actors={actors}
            onStrike={onStrike}
            onRestore={onRestore}
            onKeep={onKeep}
          />
        ))}
      </ul>
    </div>
  );
}
