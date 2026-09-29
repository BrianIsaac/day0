'use client';

import {
  type ListClauseField,
  type CharterChange,
  nextCharterVersion,
  LIST_CLAUSE_FIELDS,
} from '@/agent/charter-amendment';
import { useState, useId, useRef } from 'react';
import type { Doc } from '@convex/_generated/dataModel';
import type { CharterCardBody } from './CharterCard';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useNow, useAgentZone, clockTimeWithSeconds, relativeTime } from '../time';
import type { CharterConstraint } from '@/agent/charter-constraints';
import { type SystemClass, SYSTEM_CLASSES } from '@/agent/system-classes';
import { managerOpenQuestions } from '@/agent/manager-questions';
import { SUMMARY } from '../../../components/Disclosure';

const CLAUSE_LIST_LABEL: Record<ListClauseField, string> = {
  willDo: 'Will do',
  willNotDo: 'Will NOT do',
  escalationTriggers: 'Escalation triggers',
};

const AMEND_INPUT =
  'min-h-11 flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 text-xs text-[var(--color-fg)]';

const AMEND_BUTTON =
  'shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50';

/**
 * One line of text the manager can rewrite or remove; Save sends the
 * amendment. Callers key it by the text, so a new version remounts it with
 * the new text rather than syncing state from props.
 */
function EditableLine({
  text,
  label,
  busy,
  onSave,
  onRemove,
}: {
  text: string;
  /** What the line is, as the field's visible label. */
  label: string;
  busy: boolean;
  onSave: (text: string) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const id = useId();
  const changed = draft.trim() !== text.trim();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        className={AMEND_INPUT}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className={AMEND_BUTTON}
        disabled={busy || !changed || !draft.trim()}
        aria-label={`Save: ${label}`}
        onClick={() => onSave(draft)}
      >
        Save
      </button>
      {onRemove ? (
        <button
          type="button"
          className={AMEND_BUTTON}
          disabled={busy}
          aria-label={`Remove: ${label}`}
          onClick={onRemove}
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}

/** A labelled input with a button, cleared when the change it sends lands. */
function AddLine({
  label,
  button,
  busy,
  onAdd,
}: {
  /** The field's visible label. */
  label: string;
  /** The button's text. */
  button: string;
  busy: boolean;
  /**
   * Send the text; `clear` empties the field once the change lands, and the
   * field, where the next entry goes, takes focus from the emptied button.
   */
  onAdd: (text: string, clear: () => void, field: () => HTMLElement | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <label htmlFor={id} className="basis-full text-[10px] text-[var(--color-muted)]">
        {label}
      </label>
      <input
        ref={field}
        id={id}
        className={AMEND_INPUT}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className={AMEND_BUTTON}
        disabled={busy || !draft.trim()}
        onClick={() =>
          onAdd(
            draft,
            () => setDraft(''),
            () => field.current,
          )
        }
      >
        {button}
      </button>
    </div>
  );
}

/** A sentence that forbids: the manager's "never", "don't", "no …" and the like. */
const PROHIBITION =
  /^\s*no\b|\b(?:never|not|don['\u2019]t|doesn['\u2019]t|won['\u2019]t|mustn['\u2019]t|avoid|stop|without|forbidden|off-limits)\b/i;

/**
 * The clause list a new rule goes under until the manager picks one.
 *
 * A rule is more often a limit than a licence, and a prohibition filed under
 * "will do" admits work through the overlap gate, so a prohibition, and a
 * rule not typed yet, default to "will not do" (P8-9).
 */
export function defaultRuleClause(quote: string): ListClauseField {
  return quote.trim() === '' || PROHIBITION.test(quote) ? 'willNotDo' : 'willDo';
}

/**
 * Amend an approved charter from the card: each Save, Answer, Add or Remove
 * is one typed change and one new version. The list of versions below the
 * editors is the charter's history; nothing here edits a row in place.
 */
export function AmendCharterPanel({
  charter,
  body,
  busy,
  onAmend,
}: {
  charter: Doc<'charters'>;
  body: CharterCardBody;
  /** An amendment is in flight; the editors wait for it. */
  busy: boolean;
  /** Send one typed change; `after` runs and `focus` takes focus once it lands. Its outcome is said on the card. */
  onAmend: (change: CharterChange, after?: () => void, focus?: () => HTMLElement | null) => void;
}) {
  const ruleId = useId();
  const versions = useQuery(api.charters.listForAgent, { agentId: charter.agentId });
  const now = useNow();
  const zone = useAgentZone();
  const [rule, setRule] = useState<{
    quote: string;
    kind: CharterConstraint['kind'];
    /** The list the manager picked; until then the rule follows `defaultRuleClause`. */
    clause?: ListClauseField;
  }>({ quote: '', kind: 'candidate-property' });
  const ruleClause = rule.clause ?? defaultRuleClause(rule.quote);
  const [system, setSystem] = useState<{
    name: string;
    class: SystemClass;
    whereMentioned: string;
  }>({
    name: '',
    class: 'other',
    whereMentioned: '',
  });
  const answered = body.answeredQuestions ?? [];
  const openQuestions = managerOpenQuestions(body);
  return (
    <details className="text-xs">
      <summary className={SUMMARY}>
        Amend this charter · next version v{nextCharterVersion(charter.version)}
      </summary>
      <div className="mt-2 space-y-3 pl-3 border-l border-[var(--color-border)]">
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Proposed function
          </div>
          <EditableLine
            key={body.proposedFunction}
            text={body.proposedFunction}
            label="Proposed function"
            busy={busy}
            onSave={(text) => onAmend({ kind: 'edit-function', text })}
          />
        </div>
        {LIST_CLAUSE_FIELDS.map((field) => (
          <div key={field}>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
              {CLAUSE_LIST_LABEL[field]}
            </div>
            <div className="space-y-1">
              {body.proposedBoundaries[field].map((item, index) => (
                <EditableLine
                  key={`${index}:${item}`}
                  text={item}
                  label={`${CLAUSE_LIST_LABEL[field]}, clause ${index + 1}`}
                  busy={busy}
                  onSave={(text) => onAmend({ kind: 'edit-clause', field, index, text })}
                  onRemove={() => onAmend({ kind: 'edit-clause', field, index, text: '' })}
                />
              ))}
              <AddLine
                label={`Add to ${CLAUSE_LIST_LABEL[field].toLowerCase()}`}
                button="Add"
                busy={busy}
                onAdd={(text, clear, input) =>
                  onAmend(
                    {
                      kind: 'edit-clause',
                      field,
                      index: body.proposedBoundaries[field].length,
                      text,
                    },
                    clear,
                    input,
                  )
                }
              />
            </div>
          </div>
        ))}
        {openQuestions.length > 0 || answered.length > 0 ? (
          <div>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
              Open questions
            </div>
            <div className="space-y-1.5">
              {openQuestions.map((question) => (
                <div key={question}>
                  <AddLine
                    label={question}
                    button="Answer"
                    busy={busy}
                    onAdd={(answer, clear, input) =>
                      onAmend({ kind: 'answer-question', question, answer }, clear, input)
                    }
                  />
                </div>
              ))}
              {answered.map((entry) => (
                <p key={entry.question} className="text-[var(--color-muted)]">
                  {entry.question} <span className="text-[var(--color-fg)]">- {entry.answer}</span>
                </p>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Add a rule
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <label
              htmlFor={`${ruleId}-quote`}
              className="basis-full text-[10px] text-[var(--color-muted)]"
            >
              The rule, in your own words
            </label>
            <input
              id={`${ruleId}-quote`}
              className={AMEND_INPUT}
              value={rule.quote}
              disabled={busy}
              onChange={(e) => setRule({ ...rule, quote: e.target.value })}
            />
            <label htmlFor={`${ruleId}-kind`} className="sr-only">
              What the rule limits
            </label>
            <select
              id={`${ruleId}-kind`}
              className={AMEND_INPUT}
              disabled={busy}
              value={rule.kind}
              onChange={(e) =>
                setRule({ ...rule, kind: e.target.value as CharterConstraint['kind'] })
              }
            >
              <option value="candidate-property">what work qualifies</option>
              <option value="system-boundary">where I may act</option>
              <option value="reporting-line">who I report to</option>
            </select>
            <label htmlFor={`${ruleId}-clause`} className="sr-only">
              The clause list it goes under
            </label>
            <select
              id={`${ruleId}-clause`}
              className={AMEND_INPUT}
              disabled={busy}
              value={ruleClause}
              onChange={(e) => setRule({ ...rule, clause: e.target.value as ListClauseField })}
            >
              {LIST_CLAUSE_FIELDS.map((field) => (
                <option key={field} value={field}>
                  under {CLAUSE_LIST_LABEL[field].toLowerCase()}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={AMEND_BUTTON}
              disabled={busy || !rule.quote.trim()}
              onClick={() =>
                onAmend(
                  {
                    kind: 'add-constraint',
                    constraint: { kind: rule.kind, quote: rule.quote, clause: ruleClause },
                  },
                  () => setRule({ quote: '', kind: rule.kind }),
                )
              }
            >
              Add rule
            </button>
          </div>
        </div>
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Adjacent roles (work in their lane is out of scope)
          </div>
          <div className="space-y-1">
            {(body.adjacentRoles ?? []).map((role, index) => (
              <div key={`${index}:${role.who}`} className="flex items-center gap-1">
                <span className="flex-1 min-w-0 text-[var(--color-fg)]">
                  {role.who} - {role.staysOutOfTheirLaneBy}
                </span>
                <button
                  type="button"
                  className={AMEND_BUTTON}
                  disabled={busy}
                  aria-label={`Remove: ${role.who}`}
                  onClick={() =>
                    onAmend({
                      kind: 'edit-adjacent-role',
                      index,
                      role: { who: '', staysOutOfTheirLaneBy: '' },
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <AddLine
              label="Add a role, as: role - how I stay out of their lane"
              button="Add"
              busy={busy}
              onAdd={(text, clear, input) => {
                const [who, ...rest] = text.split(' - ');
                onAmend(
                  {
                    kind: 'edit-adjacent-role',
                    index: (body.adjacentRoles ?? []).length,
                    role: { who: who ?? '', staysOutOfTheirLaneBy: rest.join(' - ') },
                  },
                  clear,
                  input,
                );
              }}
            />
          </div>
        </div>
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Systems named
          </div>
          <div className="space-y-1">
            {(body.namedSystems ?? []).map((named) => (
              <div key={named.name} className="flex items-center gap-1">
                <span className="flex-1 min-w-0 text-[var(--color-fg)]">
                  {named.name} ({named.class})
                </span>
                <button
                  type="button"
                  className={AMEND_BUTTON}
                  disabled={busy}
                  aria-label={`Remove: ${named.name}`}
                  onClick={() => onAmend({ kind: 'remove-system', name: named.name })}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-1">
              <label
                htmlFor={`${ruleId}-system`}
                className="basis-full text-[10px] text-[var(--color-muted)]"
              >
                System name
              </label>
              <input
                id={`${ruleId}-system`}
                className={AMEND_INPUT}
                value={system.name}
                disabled={busy}
                onChange={(e) => setSystem({ ...system, name: e.target.value })}
              />
              <label
                htmlFor={`${ruleId}-system-kind`}
                className="basis-full text-[10px] text-[var(--color-muted)]"
              >
                Its kind
              </label>
              <select
                id={`${ruleId}-system-kind`}
                className={AMEND_INPUT}
                disabled={busy}
                value={system.class}
                onChange={(e) => setSystem({ ...system, class: e.target.value as SystemClass })}
              >
                {SYSTEM_CLASSES.map((systemClass) => (
                  <option key={systemClass} value={systemClass}>
                    {systemClass}
                  </option>
                ))}
              </select>
              <label
                htmlFor={`${ruleId}-system-where`}
                className="basis-full text-[10px] text-[var(--color-muted)]"
              >
                Where it is used, in your words
              </label>
              <input
                id={`${ruleId}-system-where`}
                className={AMEND_INPUT}
                value={system.whereMentioned}
                disabled={busy}
                onChange={(e) => setSystem({ ...system, whereMentioned: e.target.value })}
              />
              <button
                type="button"
                className={AMEND_BUTTON}
                disabled={busy || !system.name.trim() || !system.whereMentioned.trim()}
                onClick={() =>
                  onAmend({ kind: 'add-system', system }, () =>
                    setSystem({ name: '', class: 'other', whereMentioned: '' }),
                  )
                }
              >
                Add system
              </button>
            </div>
          </div>
        </div>
        {versions && versions.length > 1 ? (
          <div>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
              Versions
            </div>
            <ul className="space-y-0.5 text-[var(--color-muted)]">
              {versions.map((row) => (
                <li key={row._id}>
                  v{row.version}
                  {row._id === charter._id ? ' · current' : ''}
                  {row.supersedes ? ' · amendment' : ' · from the 1:1'}
                  {' · '}
                  <span title={clockTimeWithSeconds(row.createdAt, zone)}>
                    {relativeTime(row.createdAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
