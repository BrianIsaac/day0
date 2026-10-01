'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMutation, useQueries } from 'convex/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { MAX_DECLINE_REASON_LENGTH } from '@/agent/manager-transfer';
import { deploymentZone } from '@/lib/zone';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Field, INPUT_CLASS } from '../components/Field';
import { StatusRegion } from '../components/StatusRegion';
import { refusalText, useChange, type Change } from '../components/use-change';
import {
  acceptedWords,
  CHECK,
  BACK_FROM_DECLINE,
  DECLINE,
  declinedWords,
  declineReasonLabel,
  DOES_NOT_COME,
  HANDOVER_NOT_WAITING,
  HANDOVER_TITLE,
  HANDOVER_UNREADABLE,
  leavesBehindLines,
  NO_DOCUMENTATION,
  READING_HANDOVER,
  READS_FOR_IT,
  READS_FOR_IT_HINT,
  reportingLineCheck,
  runsInFlightLine,
  takeOnLabel,
  takeOnLead,
  takeOnTitle,
  takesOnLines,
  YOU_TAKE_ON,
  type HandoverPreview,
} from '../handover-words';

/** The address parameter that opens the acceptance dialog: `/?transfer=<transferId>`. */
export const TRANSFER_PARAMETER = 'transfer';

/**
 * The preview the dialog reads, subscribed through `useQueries` so a refusal comes back as a
 * value: a link to a handover addressed to another account, or one that no longer exists, must
 * say so in the dialog rather than take the home down.
 *
 * @param transferId - The request, as the address names it.
 * @returns The preview, null when it no longer waits for an answer, undefined while it loads,
 *   and the `Error` the backend refused the read with.
 */
function useTransferPreview(transferId: string): HandoverPreview | null | undefined | Error {
  // `useQueries` subscribes by the object's identity: a new one each render would subscribe again
  // on every render, and the update each subscription brings would render again, without end.
  const queries = useMemo(
    () => ({
      preview: {
        query: api.transferAcceptance.transferPreview,
        // The backend reads a string that names no request as not found, refused as a value above.
        args: { transferId },
      },
    }),
    [transferId],
  );
  const { preview }: Record<string, HandoverPreview | null | undefined | Error> =
    useQueries(queries);
  return preview;
}

/** One section of the dialog's account: its term and the short lines under it. */
interface AccountSection {
  readonly term: string;
  readonly lines: readonly string[];
}

/**
 * What accepting brings and leaves, section by section, as the retire dialog lays its account
 * out (plan 7.3): what the new manager takes on, what does not come with the employee, and the
 * charter's reporting lines to check, when it has any.
 *
 * @param preview - The request's preview.
 */
export function acceptanceSections(preview: HandoverPreview): AccountSection[] {
  const sections: AccountSection[] = [
    { term: YOU_TAKE_ON, lines: takesOnLines(preview) },
    { term: DOES_NOT_COME, lines: leavesBehindLines(preview) },
  ];
  if (preview.reportingLines.length > 0) {
    sections.push({
      term: CHECK,
      lines: [
        ...preview.reportingLines.map((rule) => `“${rule}”`),
        reportingLineCheck(preview.employee.name),
      ],
    });
  }
  return sections;
}

/** Which answer is in flight, so its own control says so while it runs. */
type Answering = 'accept' | 'decline';

/** What the dialog's body is drawn from once the preview is read. */
interface TakeOnProps {
  readonly preview: HandoverPreview;
  readonly change: Change;
  readonly notice: RefObject<HTMLParagraphElement | null>;
  readonly onClose: () => void;
  /** Keep this preview drawn while the answer runs: the request leaves `asked` before it returns. */
  readonly onAnswer: (preview: HandoverPreview) => void;
}

/**
 * The acceptance dialog's body (plan 7.3): the note, what comes and what does not, the reporting
 * lines to check, the acceptor's documentation with ticks, the runs in flight, and Decline and
 * Take on. Decline opens a short reason first, then sends it. No typed confirmation: taking on is
 * additive for the acceptor and can be handed back by the same flow.
 */
function TakeOn({ preview, change, notice, onClose, onAnswer }: TakeOnProps) {
  const accept = useMutation(api.transferAcceptance.accept);
  const decline = useMutation(api.managerTransfers.decline);
  const [excluded, setExcluded] = useState<Id<'docSources'>[]>([]);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [answering, setAnswering] = useState<Answering | null>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  // Set by Back, so focus returns to the Decline that opened the reason, not on first draw.
  const backFromReason = useRef(false);
  const { name } = preview.employee;
  const from = preview.fromAddress;

  useEffect(() => {
    if (declining) {
      reasonField.current?.focus();
    } else if (backFromReason.current) {
      backFromReason.current = false;
      revealButton.current?.focus();
    }
  }, [declining]);

  const takeOn = (): void => {
    setAnswering('accept');
    onAnswer(preview);
    change.run(
      () =>
        accept({
          transferId: preview.transferId,
          // The acceptor's day is the employee's from now on (N12), as deploy takes it.
          zone: deploymentZone(),
          ...(excluded.length > 0 ? { excludedDocSourceIds: excluded } : {}),
        }),
      {
        // What the acceptance answered, not the preview read before it: a run that ended in
        // between means the employee moved at once.
        done: (answer) => acceptedWords(name, answer.state),
        refused: `${name} was not taken on.`,
        after: onClose,
        focus: () => notice.current,
      },
    );
  };

  const submitDecline = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (change.busy) return;
    const why = reason.trim();
    setAnswering('decline');
    onAnswer(preview);
    change.run(
      () => decline({ transferId: preview.transferId, ...(why === '' ? {} : { reason: why }) }),
      {
        done: declinedWords(name, from),
        refused: `${name} was not declined.`,
        after: onClose,
        focus: () => notice.current,
      },
    );
  };

  return (
    <>
      {preview.note === undefined ? null : (
        <blockquote className="border-l-2 border-[var(--color-border-2)] pl-3 text-[15px] whitespace-pre-line text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
          <p>“{preview.note}”</p>
        </blockquote>
      )}
      <dl className="grid gap-x-4 text-[15px] sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-3">
        {acceptanceSections(preview).map((section) => (
          <div key={section.term} className="contents">
            <dt className="font-medium text-[var(--color-fg)]">{section.term}</dt>
            <dd className="mb-3 text-[var(--color-fg-2)] sm:mb-0">
              <ul className="grid gap-1 [overflow-wrap:anywhere]">
                {section.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
      {preview.runsInFlight > 0 ? (
        <p className="text-[15px] text-[var(--color-fg-2)]">
          {runsInFlightLine({ name, from, runs: preview.runsInFlight })}
        </p>
      ) : null}
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-[15px] font-medium text-[var(--color-fg)]">
          {READS_FOR_IT}
        </legend>
        {preview.documentation.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">{NO_DOCUMENTATION}</p>
        ) : (
          <>
            {preview.documentation.map((source) => (
              <label
                key={source.sourceId}
                className="flex min-h-11 items-center gap-2 text-[15px] text-[var(--color-fg-2)]"
              >
                <input
                  type="checkbox"
                  className="size-4"
                  checked={!excluded.includes(source.sourceId)}
                  disabled={change.busy}
                  onChange={(event) =>
                    setExcluded((current) =>
                      event.target.checked
                        ? current.filter((id) => id !== source.sourceId)
                        : [...current, source.sourceId],
                    )
                  }
                />
                {source.label}
              </label>
            ))}
            <p className="text-[13px] text-[var(--color-muted)]">{READS_FOR_IT_HINT}</p>
          </>
        )}
      </fieldset>
      <form className="grid gap-4" onSubmit={submitDecline}>
        {declining ? (
          <Field label={declineReasonLabel(from)}>
            {(control) => (
              <textarea
                {...control}
                ref={reasonField}
                rows={2}
                maxLength={MAX_DECLINE_REASON_LENGTH}
                value={reason}
                disabled={change.busy}
                onChange={(event) => setReason(event.target.value)}
                className={`${INPUT_CLASS} w-full resize-y`}
              />
            )}
          </Field>
        ) : null}
        <StatusRegion outcome={change.outcome} />
        <div className="flex flex-wrap justify-end gap-2">
          {/* Two buttons, never one that changes its type: a click that opened the reason must
              not also submit the form it turned into a submit button for. */}
          {declining ? (
            <>
              {/* The way back sends nothing: the reason is dropped and the two answers stand
                  (the wave 9 review's U4-m7: only Escape left the reason, closing the dialog). */}
              <Button
                key="back-from-reason"
                variant="quiet"
                size="large"
                disabled={change.busy}
                onClick={() => {
                  backFromReason.current = true;
                  setReason('');
                  setDeclining(false);
                }}
              >
                {BACK_FROM_DECLINE}
              </Button>
              <Button
                key="send-decline"
                type="submit"
                variant="danger"
                size="large"
                disabled={change.busy}
              >
                {change.busy && answering === 'decline' ? 'Declining…' : DECLINE}
              </Button>
            </>
          ) : (
            <Button
              key="ask-reason"
              ref={revealButton}
              size="large"
              disabled={change.busy}
              onClick={() => {
                // A refusal of the acceptance is not left beside the decline it no longer concerns.
                change.clear();
                setDeclining(true);
              }}
            >
              {DECLINE}
            </Button>
          )}
          <Button variant="primary" size="large" disabled={change.busy} onClick={takeOn}>
            {change.busy && answering === 'accept' ? 'Taking on…' : takeOnLabel(name)}
          </Button>
        </div>
      </form>
    </>
  );
}

/** What the dialog for one request is drawn from. */
interface AcceptTransferDialogProps {
  readonly transferId: string;
  readonly change: Change;
  readonly notice: RefObject<HTMLParagraphElement | null>;
  readonly onClose: () => void;
}

/**
 * The acceptance dialog for one request, in whichever state its preview is: one dialog whose body
 * changes, so a change of state neither plays the dialog in again nor moves focus. While an
 * answer is in flight the preview the manager answered stays drawn: the request leaves `asked`
 * (and the preview answers null) a moment before the answer's own result arrives.
 */
function AcceptTransferDialog({ transferId, change, notice, onClose }: AcceptTransferDialogProps) {
  const read = useTransferPreview(transferId);
  const top = useRef<HTMLDivElement>(null);
  const live = read instanceof Error || read === null || read === undefined ? undefined : read;
  // The preview an answer was given on, kept from the event that gave it; the live client hands
  // a new object on every render, so it is never compared here.
  const [answered, setAnswered] = useState<HandoverPreview | undefined>(undefined);
  const preview = live ?? (change.busy ? answered : undefined);
  let body: ReactNode;
  if (preview !== undefined) {
    body = (
      <TakeOn
        preview={preview}
        change={change}
        notice={notice}
        onClose={onClose}
        onAnswer={setAnswered}
      />
    );
  } else {
    let said: ReactNode;
    if (read === undefined) {
      said = (
        <p role="status" className="text-sm text-[var(--color-muted)]">
          {READING_HANDOVER}
        </p>
      );
    } else if (read instanceof Error) {
      said = (
        <p className="text-[15px] text-[var(--color-fg-2)]">
          {refusalText(read, HANDOVER_UNREADABLE)}
        </p>
      );
    } else {
      said = <p className="text-[15px] text-[var(--color-fg-2)]">{HANDOVER_NOT_WAITING}</p>;
    }
    body = (
      <>
        {said}
        <div className="flex justify-end">
          <Button size="large" onClick={onClose}>
            Close
          </Button>
        </div>
      </>
    );
  }
  return (
    <Dialog
      title={preview === undefined ? HANDOVER_TITLE : takeOnTitle(preview.employee.name)}
      description={preview === undefined ? undefined : takeOnLead(preview)}
      onClose={onClose}
      initialFocus={top}
      busy={change.busy}
    >
      {/* The dialog opens on its account, read from the top, rather than on its last control. */}
      <div ref={top} tabIndex={-1} className="grid gap-4 outline-none">
        {body}
      </div>
    </Dialog>
  );
}

/**
 * The new manager's acceptance of a handover on the home (the transfer plan, section 7.3): the
 * inbox entry's control opens `/?transfer=<transferId>`, and this opens the dialog for it. Closing
 * takes the parameter off the address. Once the acceptance or the decline lands, what it came to
 * is said on the home in a line that takes focus, since the entry that opened the dialog has left
 * the inbox; a refusal is said inside the dialog and leaves it open.
 */
export function AcceptTransfer() {
  const parameters = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const transferId = parameters.get(TRANSFER_PARAMETER);
  const notice = useRef<HTMLParagraphElement>(null);
  const change = useChange(notice);
  const [shown, setShown] = useState<string | null>(null);
  // The request whose dialog was closed, gone at once rather than when the router has taken the
  // parameter off, so focus settles on the home in the same render that says what landed.
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (transferId === null && dismissed !== null) setDismissed(null);
  const open = transferId !== null && transferId !== dismissed ? transferId : null;
  // A refusal belongs to the request it was said for: another one, reached by the browser's Back
  // or a second link, opens without it.
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  if (change.outcome?.tone === 'refused' && refusedFor === null && open !== null) {
    setRefusedFor(open);
  }
  if (refusedFor !== null && refusedFor !== open) {
    setRefusedFor(null);
    if (change.outcome?.tone === 'refused') change.clear();
  }
  const close = (): void => {
    // A refusal said inside the dialog is not carried to the home once it is closed (m38).
    if (change.outcome?.tone === 'refused') change.clear();
    setDismissed(transferId);
    router.replace(pathname, { scroll: false });
  };
  // What a landed answer said stays on the home until another lands.
  const said = change.outcome?.tone === 'done' ? change.outcome.text : null;
  if (said !== null && said !== shown) setShown(said);
  return (
    <>
      {/* In the page before anything is said, so the line is announced when it is filled; it also
          takes focus then, since the entry that opened the dialog has gone. */}
      <p
        ref={notice}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="mb-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-sm text-[var(--color-fg-2)] outline-none empty:sr-only"
      >
        {shown ?? ''}
      </p>
      {open === null ? null : (
        <AcceptTransferDialog
          key={open}
          transferId={open}
          change={change}
          notice={notice}
          onClose={close}
        />
      )}
    </>
  );
}
