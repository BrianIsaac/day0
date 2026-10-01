'use client';

import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { MAX_CONTROL_REASON_LENGTH } from '@/work/skill-controls';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';
import { CODE_CHIP, plainSkillName } from './skill-parts';
import { namesInWords, retireOutcome, withdrawOutcome } from './skill-card-words';

/** Who stops running the skill: the one employee, or every employee who runs its version. */
type RetireScope = 'one' | 'every';

/**
 * The Retire dialog of the Skills tab (10-C, over the shared `Dialog`): Retire takes the skill
 * from this employee alone; when another employee runs the same version, Withdraw for every
 * employee (A12) is the second choice, naming each of them from `skillVersions.forSkill`. An
 * optional reason is kept on the record. Keep holds focus, a refusal is said inside the dialog
 * and leaves it open, and nothing can be pressed until the holders are known.
 *
 * @param skill - The registered row.
 * @param employee - The employee's name.
 * @param revisionOpen - Whether a revision of the row is being written, which the retire ends.
 * @param onClose - Close the dialog without retiring.
 * @param onDone - The change landed, with what the Skills card's live region says.
 */
export function RetireSkillDialog({
  skill,
  employee,
  revisionOpen = false,
  onClose,
  onDone,
}: {
  skill: Doc<'skills'>;
  employee: string;
  revisionOpen?: boolean;
  onClose: () => void;
  onDone: (words: string) => void;
}) {
  const forSkill = useQuery(api.skillVersions.forSkill, { skillId: skill._id });
  const retire = useMutation(api.skillControls.retire);
  const withdraw = useMutation(api.skillControls.withdraw);
  const [scope, setScope] = useState<RetireScope>('one');
  const [reason, setReason] = useState('');
  const keep = useRef<HTMLButtonElement>(null);
  const change = useChange(keep);
  const scopeName = useId();
  const name = plainSkillName(skill);
  const ready = forSkill !== undefined;
  // The employees whose callable row runs this version, this one first.
  const runners = useMemo((): string[] => {
    const holders = forSkill?.held?.holders ?? [];
    const others = holders
      .filter((holder) => holder.skillId !== skill._id && holder.state === 'registered')
      .map((holder) => holder.agentName);
    return [employee, ...others];
  }, [forSkill, skill._id, employee]);
  const version = forSkill?.held?.version.version;
  const withdrawable = version !== undefined && runners.length > 1;
  const every = withdrawable && scope === 'every';

  let choice: ReactNode = null;
  if (!ready) {
    choice = (
      <p role="status" className="text-sm text-[var(--color-muted)]">
        Finding who runs this skill
      </p>
    );
  } else if (withdrawable) {
    const others = runners.slice(1);
    choice = (
      <fieldset className="grid min-w-0 gap-2">
        <legend className="mb-1 text-[13px] font-medium text-[var(--color-fg-2)]">
          Who stops running it
        </legend>
        <label className="flex min-h-11 items-start gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
          <input
            type="radio"
            name={scopeName}
            value="one"
            checked={scope === 'one'}
            onChange={() => setScope('one')}
            disabled={change.busy}
            className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="grid min-w-0 gap-0.5 break-words">
            <span className="text-[15px] text-[var(--color-fg)]">Only {employee}</span>
            <span className="text-[13px] text-[var(--color-muted)]">
              {namesInWords(others)} {others.length === 1 ? 'keeps' : 'keep'} running version{' '}
              {version}.
            </span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
          <input
            type="radio"
            name={scopeName}
            value="every"
            checked={scope === 'every'}
            onChange={() => setScope('every')}
            disabled={change.busy}
            className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="grid min-w-0 gap-0.5 break-words">
            <span className="text-[15px] text-[var(--color-fg)]">
              Every employee who runs it: {namesInWords(runners)}
            </span>
            <span className="text-[13px] text-[var(--color-muted)]">
              Version {version} is withdrawn: nobody runs it and it is offered to nobody.
            </span>
          </span>
        </label>
      </fieldset>
    );
  }

  const submitLabel = every
    ? `Withdraw from ${runners.length} employees`
    : `Retire from ${employee}`;
  const busyLabel = every ? 'Withdrawing…' : 'Retiring…';
  const trimmed = reason.trim();

  return (
    <Dialog
      role="alertdialog"
      title={
        every ? 'Withdraw this skill from every employee?' : `Retire this skill from ${employee}?`
      }
      description={`${
        every
          ? `${namesInWords(runners)} stop running this skill now.`
          : `${employee} stops running this skill now.`
      } Approved work that would have used it goes back to waiting for a skill, and a new one is proposed for it.${
        revisionOpen ? ' The revision being written for it ends too.' : ''
      }`}
      onClose={onClose}
      initialFocus={keep}
      busy={change.busy}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || change.busy) return;
          const withReason = trimmed === '' ? {} : { reason: trimmed };
          if (every) {
            change.run(() => withdraw({ skillId: skill._id, ...withReason }), {
              done: (result) => withdrawOutcome(skill.name, result.holders, result.returnedItems),
              refused: `${skill.name} was not withdrawn.`,
              after: (result) =>
                onDone(withdrawOutcome(skill.name, result.holders, result.returnedItems)),
            });
            return;
          }
          change.run(() => retire({ skillId: skill._id, ...withReason }), {
            done: (result) => retireOutcome(skill.name, employee, result.returnedItems),
            refused: `${skill.name} was not retired.`,
            after: (result) => onDone(retireOutcome(skill.name, employee, result.returnedItems)),
          });
        }}
      >
        <p className="grid min-w-0 gap-1 text-[15px] text-[var(--color-fg)]">
          <span className="break-words">{name}</span>
          <code className={`${CODE_CHIP} justify-self-start`}>{skill.name}</code>
        </p>
        {choice}
        <Field label="Reason (optional)" hint="Kept on the record.">
          {(control) => (
            <input
              {...control}
              name="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={MAX_CONTROL_REASON_LENGTH}
              autoComplete="off"
              disabled={change.busy}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={keep} size="large" disabled={change.busy} onClick={onClose}>
            Keep it
          </Button>
          <Button type="submit" variant="danger" size="large" disabled={!ready || change.busy}>
            {change.busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
