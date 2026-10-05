'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  AGREEMENTS_EMPTY,
  AGREEMENTS_META,
  AGREEMENTS_TITLE,
  awaitingCheck,
  awaitingManager,
  bindingWords,
  checkingLine,
  refusalSentence,
  sourceWords,
  type AgreementView,
} from '@/work/agreement-words';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { clockTime, clockTimeWithSeconds, useAgentZone } from '../../../components/time';
import { useChange } from '../../../components/use-change';
import { INLINE_LINK } from './CharterDocument';

/** What the card does to one agreement, each call answered by the backend's own refusal words. */
export interface AgreementCalls {
  readonly onKeepForEveryEmployee: (agreementId: AgreementView['_id']) => Promise<unknown>;
  readonly onEdit: (agreementId: AgreementView['_id'], statement: string) => Promise<unknown>;
  readonly onRetire: (agreementId: AgreementView['_id']) => Promise<unknown>;
  readonly onDismiss: (agreementId: AgreementView['_id']) => Promise<unknown>;
}

/**
 * The words of an active agreement, rewritten in place. Save keeps the new words as a new version
 * that replaces the old once its check passes; Cancel closes the editor and gives focus back to
 * Edit.
 */
function AgreementEditor({
  statement,
  busy,
  onSave,
  onCancel,
}: {
  statement: string;
  busy: boolean;
  onSave: (statement: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(statement);
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const changed = draft.trim() !== '' && draft.trim() !== statement.trim();
  return (
    <div className="mt-2 grid gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-[var(--color-fg-2)]">
        The agreement, in your words
      </label>
      <input
        ref={field}
        id={id}
        type="text"
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        className={`${INPUT_CLASS} w-full`}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="small"
          disabled={busy || !changed}
          onClick={() => onSave(draft)}
        >
          Save
        </Button>
        <Button variant="quiet" size="small" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The Agreements card on the Charter tab (A18; the wave file's section 7): the working agreements
 * in force for the employee, its own and every employee's, each with whom it binds, where it came
 * from and since when, and Edit (a supersede), Retire and, for the employee's own, Keep for every
 * employee (A10); an agreement kept here waiting on its check; a refusal of what was kept here,
 * with Dismiss; and a proposal, which is decided on the Work tab. Real mode only, as agreements
 * are.
 *
 * @param props - The agreements, the employee's name, the Work tab, and the four calls.
 */
export function AgreementsCard({
  agreements,
  employeeName,
  workHref,
  onKeepForEveryEmployee,
  onEdit,
  onRetire,
  onDismiss,
}: {
  agreements: readonly AgreementView[];
  employeeName: string;
  /** The Work tab, where a proposal is decided. */
  workHref: string;
} & AgreementCalls) {
  const zone = useAgentZone();
  const list = useRef<HTMLUListElement>(null);
  const change = useChange(list);
  const [editing, setEditing] = useState<AgreementView['_id'] | null>(null);
  // The agreement whose editor was closed without saving: its Edit takes focus back.
  const cancelled = useRef<string | null>(null);
  useEffect(() => {
    if (editing !== null || cancelled.current === null) return;
    const id = cancelled.current;
    cancelled.current = null;
    list.current
      ?.querySelector<HTMLButtonElement>(`button[data-agreement-edit="${CSS.escape(id)}"]`)
      ?.focus();
  }, [editing]);
  const inForce = agreements.filter((row) => row.status === 'active');
  const checking = agreements.filter(
    (row) => awaitingCheck(row) && row.sourceType === 'manager-card',
  );
  const refused = agreements.filter(
    (row) => row.status === 'refused' && row.sourceType === 'manager-card',
  );
  const waiting = agreements.filter(awaitingManager);
  const empty = inForce.length + checking.length + refused.length + waiting.length === 0;
  return (
    <Card title={AGREEMENTS_TITLE} meta={AGREEMENTS_META}>
      {empty ? (
        <p className="text-sm text-[var(--color-muted)]">{AGREEMENTS_EMPTY}</p>
      ) : (
        <ul ref={list} tabIndex={-1} aria-label={AGREEMENTS_TITLE} className="space-y-2">
          {inForce.map((row) => (
            <li
              key={row._id}
              className="p-3 rounded-md border border-[var(--color-border)] text-sm"
            >
              <p className="text-[var(--color-fg)] whitespace-pre-wrap break-words">
                {row.statement}
              </p>
              <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
                {bindingWords(row, employeeName)} · {sourceWords(row.sourceType)}
                {row.effectiveFrom !== undefined ? (
                  <>
                    {' · since '}
                    <span title={clockTimeWithSeconds(row.effectiveFrom, zone)}>
                      {clockTime(row.effectiveFrom, zone)}
                    </span>
                  </>
                ) : null}
              </p>
              {editing === row._id ? (
                <AgreementEditor
                  statement={row.statement}
                  busy={change.busy}
                  onCancel={() => {
                    cancelled.current = row._id;
                    setEditing(null);
                  }}
                  onSave={(statement) =>
                    change.run(() => onEdit(row._id, statement), {
                      done: 'Saved. Day0 checks the new words against the charter; until then the old ones stay in effect.',
                      refused: 'The new words were not saved.',
                      after: () => setEditing(null),
                    })
                  }
                />
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="small"
                    disabled={change.busy}
                    aria-label={`Edit “${row.statement}”`}
                    data-agreement-edit={row._id}
                    onClick={() => setEditing(row._id)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="quiet"
                    size="small"
                    disabled={change.busy}
                    aria-label={`Retire “${row.statement}”`}
                    onClick={() =>
                      change.run(() => onRetire(row._id), {
                        done: 'Retired: no later plan reads it.',
                        refused: 'The working agreement was not retired.',
                      })
                    }
                  >
                    Retire
                  </Button>
                  {row.agentId !== undefined ? (
                    <Button
                      size="small"
                      disabled={change.busy}
                      aria-label={`Keep “${row.statement}” for every employee`}
                      onClick={() =>
                        change.run(() => onKeepForEveryEmployee(row._id), {
                          done: `Kept for every employee once Day0 checks it against each charter; until then it stays ${employeeName}'s.`,
                          refused: 'The working agreement was not kept for every employee.',
                        })
                      }
                    >
                      Keep for every employee
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          ))}
          {checking.map((row) => (
            <li
              key={row._id}
              className="p-3 rounded-md border border-[var(--color-border)] text-sm text-[var(--color-fg-2)]"
            >
              {checkingLine(row.statement)}
            </li>
          ))}
          {refused.map((row) => (
            <li
              key={row._id}
              className="p-3 rounded-md border border-[var(--color-warn)]/50 text-sm"
            >
              <p className="text-[var(--color-fg-2)] whitespace-pre-wrap break-words">
                “{row.statement}”
              </p>
              {row.refusal ? (
                <p className="mt-1 text-[var(--color-fg)]">
                  {refusalSentence(row.refusal, employeeName)}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="quiet"
                  size="small"
                  disabled={change.busy}
                  aria-label={`Dismiss the refused agreement “${row.statement}”`}
                  onClick={() =>
                    change.run(() => onDismiss(row._id), {
                      done: 'Dismissed.',
                      refused: 'The refusal was not dismissed.',
                    })
                  }
                >
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
          {waiting.map((row) => (
            <li
              key={row._id}
              className="p-3 rounded-md border border-dashed border-[var(--color-border)] text-sm text-[var(--color-fg-2)]"
            >
              Waiting for you on the Work tab: “{row.statement}”{' '}
              <Link href={workHref} className={INLINE_LINK}>
                Open Work
              </Link>
            </li>
          ))}
        </ul>
      )}
      <StatusRegion outcome={change.outcome} />
    </Card>
  );
}
