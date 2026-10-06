'use client';

import type { Doc, Id } from '@convex/_generated/dataModel';
import { type AuthoringAttempt, AUTHORING_UNFINISHED } from './authoring';
import { useAction, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { clockTime, useAgentZone, useNow } from '../../../components/time';
import {
  focusIsFree,
  refusalText,
  returnFocus,
  useChange,
  type ChangeOutcome,
} from '../../../components/use-change';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import { Disclosure } from '../../../components/Disclosure';
import { StatusRegion } from '../../../components/StatusRegion';
import type { Tone } from '../../../components/tone';
import { holdsLiveAuthoringClaim } from '@/lib/skill-authoring';
import { attemptsSpent } from '@/work/needs-manager';
import { stalledReason, stalledWords } from '@/work/skill-adoption';
import { RefusedDraft } from './RefusedDraft';
import { RetireSkillDialog } from './RetireSkillDialog';
import { CODE_CHIP, plainSkillName, ScopeChips, SkillInputs, SkillStatusLine } from './skill-parts';
import {
  adoptedFromWords,
  attemptLine,
  attemptsSpentSentence,
  givenUpOutcome,
  recheckSentence,
  recheckStartedOutcome,
  registeredSourceChip,
  revisionRowSentence,
  revisionStartedOutcome,
  revisionSentence,
  usedTimes,
} from './skill-card-words';
import type { AdoptedSource } from '@/work/skill-library';

/**
 * Whether Retry on this row verifies the draft it already has rather than
 * authoring a new one.
 *
 * A skill parked because the sandbox was busy or unavailable keeps the body
 * and smoke test that were authored and passed the static gate, so its retry
 * runs the check on them with no second model call. The condition is the one
 * `convex/skillActions.ts` acts on, so the button says what the backend will
 * do; every other row - a refusal, a smoke test the sandbox turned down, a run
 * that stopped before its draft was saved - has no draft to verify.
 *
 * Args:
 *   skill: The unregistered skill row the panel is listing.
 *
 * Returns:
 *   True when Retry verifies the saved draft without authoring again.
 */
export function retryVerifiesSavedDraft(
  skill: Pick<Doc<'skills'>, 'state' | 'body' | 'pendingSmokeTest'>,
): boolean {
  return skill.state === 'authoring' && Boolean(skill.body) && Boolean(skill.pendingSmokeTest);
}

/**
 * Where an unregistered skill stands, as its chip says it: being written by a run now, a run that
 * stopped without reporting, waiting for a check that never ran, refused by its check, or checked
 * but not registered. Never the danger tone: danger text on its own fill is under AA (wave 6 A,
 * decision 4), and a failed check waits on the manager rather than being final.
 *
 * @param skill - The unregistered row.
 * @param now - The page's clock, for whether a run's hold is live.
 */
export function unregisteredState(
  skill: Doc<'skills'>,
  now: number,
): { readonly label: string; readonly tone: Tone } {
  if (holdsLiveAuthoringClaim(skill, now)) return { label: 'Being written', tone: 'accent' };
  if (skill.authoringRunId) return { label: 'Run stopped', tone: 'warn' };
  if (skill.state === 'failed') return { label: 'Failed its check', tone: 'warn' };
  if (skill.state === 'verified') return { label: 'Not registered', tone: 'warn' };
  return { label: 'Waiting for a check', tone: 'warn' };
}

/**
 * Whether Retry on a row authors again with the reasons it stopped: a failed draft whose check
 * said why. The prototype's "Retry with the reasons"; every other row's Retry is plain.
 *
 * @param skill - The unregistered row.
 */
export function retriesWithReasons(
  skill: Pick<Doc<'skills'>, 'state' | 'verificationLog'>,
): boolean {
  return skill.state === 'failed' && Boolean(skill.verificationLog);
}

/**
 * The status line of a not-callable row with no run on it: for a skill parked because its check
 * never ran, why, in the manager's words (the sandbox's own log names the operator's commands, as
 * the stalled adoption card's did before A-m6); otherwise the row's verdict as it stands.
 *
 * @param skill - The unregistered row.
 */
function parkedLine(
  skill: Pick<
    Doc<'skills'>,
    'state' | 'body' | 'pendingSmokeTest' | 'verificationLog' | 'description'
  >,
): string {
  if (!retryVerifiesSavedDraft(skill)) return skill.verificationLog ?? skill.description;
  return `The check did not run: ${stalledWords(stalledReason(skill.verificationLog)) ?? 'Day0 could not start the check'}.`;
}

/** The day a skill registered, in the employee's zone. */
function registeredOn(at: number, zone: string | undefined): string {
  return clockTime(at, zone).split(',')[0] ?? '';
}

/** A row the manager is retiring, and the control that opened the dialog. */
interface Retiring {
  readonly skill: Doc<'skills'>;
  readonly origin: HTMLElement;
}

/**
 * The registered skills and the ones not callable yet, with the authoring's verdict and the
 * manager's controls (the enhancements plan, section 4.1, "the five controls"): on a registered
 * skill an employee wrote, how often it was used, the Re-check due chip with its reason and
 * Re-check now, Ask for a revision (a new version written while this one keeps running) and
 * Retire; on a skill not callable, the attempt it is on, Retry with the reasons until the third
 * attempt, and Give up.
 */
export function RegisteredSkillsPanel({
  skills,
  unregistered,
  authoringFailure,
  authoringHeld = null,
  registered = null,
  onAuthoringAttempt,
  surfaceMode,
  focusRef,
  loading = false,
  employee = 'This employee',
  autonomous = false,
  adoptedFrom = [],
}: {
  skills: Doc<'skills'>[];
  /** The registered skills' query has not answered yet. */
  loading?: boolean;
  /**
   * Authored but never registered: `authoring` (a run is holding it now, or no
   * sandbox ran), `failed` (the sandbox said no), and `verified` (registration
   * was interrupted before the lifecycle was collapsed into one mutation), and
   * a revision approved and not yet being written.
   * A skill a run holds is listed here throughout, so a run that dies mid-flight
   * leaves something the boss can see and, once its claim lapses, retry.
   */
  unregistered: Doc<'skills'>[];
  /**
   * The most recent authoring attempt's verdict, already checked against the
   * skill it names. Null once that skill has moved past it, which is what keeps
   * it from sitting above a row that says something else.
   */
  authoringFailure: string | null;
  /** The most recent attempt a pause held, as a sentence saying when it starts (D-8 (b)). */
  authoringHeld?: string | null;
  /** The skill the manager's last attempt registered, said once its row is registered. */
  registered?: string | null;
  /** Retries report here too, so the notice is never older than the last try. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
  /** Real mode lists the inputs the executor binds for a skill that predates them. */
  surfaceMode?: 'mock' | 'real';
  /** The Registered card, the place focus goes when a decided skill leaves either list. */
  focusRef?: RefObject<HTMLElement | null>;
  /** The employee's name, for the sentences that say who keeps running a skill. */
  employee?: string;
  /** Whether the employee's autonomous actions are on, for what Retire says of a run under way. */
  autonomous?: boolean;
  /** Whose version each adopted skill runs, as `skillVersions.adoptedSources` answers. */
  adoptedFrom?: readonly AdoptedSource[];
}) {
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const askForRevision = useMutation(api.skillControls.askForRevision);
  const recheckNow = useMutation(api.skillControls.recheckNow);
  const giveUp = useMutation(api.skillControls.giveUp);
  const [retrying, setRetrying] = useState<Id<'skills'> | null>(null);
  // The control that started a run, and the card that stands in for it once a
  // registration moves its row out of this list.
  const [returnTo, setReturnTo] = useState<{
    control: HTMLElement;
    card: HTMLElement | null;
  } | null>(null);
  const [retiring, setRetiring] = useState<Retiring | null>(null);
  // What the last Retire or Withdraw did, said once its dialog has closed, or why a revision
  // was refused before any authoring began.
  const [notice, setNotice] = useState<ChangeOutcome | null>(null);
  const now = useNow();
  const zone = useAgentZone();
  const describedBy = useId();
  // The Registered card, where a skill a run registers goes: it takes focus
  // when that run's control leaves the page with its row.
  const ownCard = useRef<HTMLElement | null>(null);
  const registeredCard = focusRef ?? ownCard;
  const controls = useChange(registeredCard);

  // A retry or a revision authors for minutes, so its verdict is filed as the
  // attempt (said in the card's live region) rather than awaited by a hook.
  async function reauthor(
    skillId: Id<'skills'>,
    name: string,
    revise: boolean,
    origin: HTMLElement,
  ): Promise<void> {
    setRetrying(skillId);
    setReturnTo({ control: origin, card: registeredCard.current });
    onAuthoringAttempt(null);
    setNotice(null);
    controls.clear();
    // A revision is its own row, written while this one keeps running.
    let written = skillId;
    let started: string | undefined;
    try {
      if (revise) {
        try {
          written = (await askForRevision({ skillId })).revisionId;
          // The control is disabled while the revision is written, which drops its focus: the
          // card holds it meanwhile, unless the manager moved on, and the live region says what
          // began until the run's own verdict is said (C-m2; the second pass).
          started = revisionStartedOutcome(name, employee);
          setNotice({ tone: 'done', text: started });
          if (focusIsFree(origin)) registeredCard.current?.focus();
        } catch (err) {
          // Refused before anything was authored: said here, since no attempt names a new row.
          setNotice({
            tone: 'refused',
            text: refusalText(err, `${name} was not sent for a revision.`),
          });
          return;
        }
      }
      const result = await author({ skillId: written });
      onAuthoringAttempt(
        result.ok
          ? { skillId: written, name }
          : {
              skillId: written,
              name,
              reason:
                result.reason ?? (revise ? 'revision did not succeed' : 'retry did not succeed'),
              ...(result.held === true ? { held: true } : {}),
            },
      );
    } catch (err) {
      onAuthoringAttempt({
        skillId: written,
        name,
        reason: refusalText(err, AUTHORING_UNFINISHED),
      });
    } finally {
      setRetrying(null);
      // The run's verdict is said by the Skills card now; the line that it began goes.
      if (started !== undefined) {
        const said = started;
        setNotice((current) => (current?.text === said ? null : current));
      }
    }
  }

  /**
   * Start one of the row controls that change a skill at once, said in the card's live region.
   * `holder`, when given, takes focus once the change lands, because the change disables its
   * control (a check that starts); a manager who moved focus elsewhere meanwhile keeps it there.
   */
  function runControl(
    call: () => Promise<string>,
    refused: string,
    holder?: RefObject<HTMLElement | null>,
  ): void {
    setNotice(null);
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    controls.run(call, {
      done: (words) => words,
      refused,
      ...(holder ? { focus: () => (focusIsFree(origin) ? holder.current : null) } : {}),
    });
  }

  // The button is disabled while its run holds it, so focus comes back to it
  // once it is enabled again, unless the manager has moved on.
  useEffect(() => {
    if (retrying !== null || returnTo === null) return;
    // The card held focus for a control the run disabled: the control takes it back, if it can.
    if (document.activeElement === returnTo.card) returnTo.card?.blur();
    returnFocus(returnTo.control, returnTo.card);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the focus return happens once per settled run
    setReturnTo(null);
  }, [retrying, returnTo]);

  // A revision is listed with the rows not callable yet, and named on the row it revises.
  const revising = new Set(unregistered.flatMap((row) => row.revisionOf ?? []));

  return (
    <>
      <Card
        title="Registered"
        meta={loading ? undefined : `${skills.length} callable`}
        focusRef={registeredCard}
      >
        <div role="status" aria-live="polite" aria-atomic="true">
          {authoringFailure ? (
            <p className="mb-3 rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn)]/10 px-3 py-2 text-[13px] text-[var(--color-fg)]">
              Authoring did not finish: {authoringFailure}
            </p>
          ) : authoringHeld ? (
            <p className="mb-3 text-[13px] text-[var(--color-fg-2)]">{authoringHeld}</p>
          ) : registered ? (
            <p className="mb-3 text-[13px] text-[var(--color-ok)]">
              {registered} is registered: it passed the check and is callable.
            </p>
          ) : null}
        </div>
        <div className="mb-3 has-[p:empty]:mb-0">
          <StatusRegion outcome={notice ?? controls.outcome} />
        </div>
        {loading ? (
          <p className="text-sm text-[var(--color-muted)]">loading skills…</p>
        ) : skills.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">none yet</p>
        ) : (
          <ul className="grid gap-4">
            {skills.map((s) => {
              const authored = s.sourceType === 'agent-authored';
              const source = registeredSourceChip(s);
              const adopted = adoptedFrom.find((entry) => entry.skillId === s._id);
              const checking = holdsLiveAuthoringClaim(s, now);
              const due = s.recheckDueAt !== undefined && s.recheckReason !== undefined;
              const hasRevision = revising.has(s._id);
              return (
                <li
                  key={s._id}
                  className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-4 first:border-t-0 first:pt-0"
                >
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-fg)]">
                      <span className="font-medium break-words">{plainSkillName(s)}</span>
                      <Chip tone={authored ? 'accent' : 'muted'}>{source}</Chip>
                      {checking ? <Chip tone="accent">Re-checking</Chip> : null}
                      {due && !checking ? <Chip tone="warn">Re-check due</Chip> : null}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)] break-words">
                      <code className={CODE_CHIP}>{s.name}</code>
                      {source === 'adopted' && adopted !== undefined
                        ? ` · ${adoptedFromWords(adopted)}`
                        : ''}
                      {s.registeredAt !== undefined
                        ? ` · registered ${registeredOn(s.registeredAt, zone)}`
                        : ''}
                      {` · ${usedTimes(s.useCount)}`}
                      {s.requiredScopes && s.requiredScopes.length > 0 ? ' · ' : ''}
                      <ScopeChips scopes={s.requiredScopes} lead="needs" />
                    </p>
                    {authored ? <SkillInputs body={s.body} surfaceMode={surfaceMode} /> : null}
                    {due && s.recheckReason !== undefined ? (
                      <p className="mt-1 text-[13px] text-[var(--color-fg-2)] break-words">
                        {recheckSentence(s.recheckReason, employee)}
                      </p>
                    ) : null}
                    {hasRevision ? (
                      <p className="mt-1 text-[13px] text-[var(--color-fg-2)]">
                        {revisionSentence(employee)}
                      </p>
                    ) : null}
                  </div>
                  {authored ? (
                    <div className="flex max-w-full flex-wrap gap-2">
                      {due && s.versionId !== undefined ? (
                        <Button
                          size="small"
                          onClick={() =>
                            runControl(
                              async () => {
                                await recheckNow({ skillId: s._id });
                                return recheckStartedOutcome(s.name);
                              },
                              `${s.name} was not re-checked.`,
                              registeredCard,
                            )
                          }
                          disabled={checking || controls.busy}
                          aria-label={`Re-check now: ${s.name}`}
                        >
                          Re-check now
                        </Button>
                      ) : null}
                      <Button
                        size="small"
                        onClick={(event) => {
                          // reauthor files every outcome as the attempt and never rejects.
                          void reauthor(s._id, s.name, true, event.currentTarget);
                        }}
                        disabled={retrying === s._id || hasRevision}
                        title={hasRevision ? revisionSentence(employee) : REVISE_HINT}
                        // While its run writes, the visible words are the name.
                        aria-label={
                          retrying === s._id ? undefined : `Ask for a revision of ${s.name}`
                        }
                        aria-describedby={`${describedBy}-revise`}
                      >
                        {retrying === s._id ? 'Writing the revision…' : 'Ask for a revision'}
                      </Button>
                      <Button
                        size="small"
                        variant="danger"
                        onClick={(event) => {
                          setNotice(null);
                          setRetiring({ skill: s, origin: event.currentTarget });
                        }}
                        disabled={controls.busy}
                        aria-label={`Retire ${s.name}`}
                      >
                        Retire
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {skills.some((skill) => skill.sourceType === 'agent-authored') ? (
          <p id={`${describedBy}-revise`} className="mt-3 text-xs text-[var(--color-muted)]">
            {REVISE_HINT}
          </p>
        ) : null}
      </Card>

      {unregistered.length > 0 ? (
        <Card title="Not callable" meta={`${unregistered.length}`}>
          <ul className="grid gap-4">
            {unregistered.map((s) => {
              const state = unregisteredState(s, now);
              const attempt = s.state === 'failed' ? attemptLine(s.authoringAttempts) : undefined;
              const spent = attemptsSpent(s);
              const withReasons = retriesWithReasons(s);
              return (
                <li
                  key={s._id}
                  // A waiting work card links here, to the row's Retry (D3); `SkillsView` lands it.
                  id={`skill-${s._id}`}
                  tabIndex={-1}
                  className="scroll-mt-24 flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-4 first:border-t-0 first:pt-0"
                >
                  {/* A traceback's caret line has no break opportunity: without
                      min-w-0 the column keeps its full width and pushes Retry
                      past the card's edge. */}
                  <div className="flex-1 basis-64 min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-fg)]">
                      <span className="font-medium break-words">{s.name}</span>
                      <Chip tone={state.tone}>{state.label}</Chip>
                      {s.revisionOf !== undefined ? <Chip tone="muted">revision</Chip> : null}
                    </p>
                    {s.revisionOf !== undefined ? (
                      <p className="mt-1 text-[13px] text-[var(--color-fg-2)]">
                        {revisionRowSentence(employee)}
                      </p>
                    ) : null}
                    {attempt !== undefined ? (
                      <p className="mt-1 text-[13px] font-medium text-[var(--color-fg)]">
                        {attempt}
                      </p>
                    ) : null}
                    {/* Three different things, and the row used to say the
                        first for two of them: a run working on it now, whose
                        log is the previous attempt's; a run that died holding
                        it, which the lease has since released; and no run at
                        all, where the log is this skill's own verdict. */}
                    <SkillStatusLine
                      skill={s.name}
                      text={
                        holdsLiveAuthoringClaim(s, now)
                          ? 'authoring now · a run holds this skill'
                          : s.authoringRunId
                            ? 'a run stopped without reporting · Retry takes the skill over'
                            : parkedLine(s)
                      }
                    />
                    <SkillInputs body={s.body || s.refusedBody || ''} />
                    <p
                      id={`${describedBy}-${s._id}`}
                      className="mt-1 text-xs text-[var(--color-muted)]"
                    >
                      {spent
                        ? attemptsSpentSentence(s.revisionOf !== undefined)
                        : retryHint(s, now)}
                    </p>
                    <RefusedDraft skill={s} />
                  </div>
                  <div className="flex max-w-full flex-wrap gap-2">
                    {spent ? null : (
                      <Button
                        variant="retry"
                        size="small"
                        onClick={(event) => {
                          // reauthor files every outcome as the attempt and never rejects.
                          void reauthor(s._id, s.name, false, event.currentTarget);
                        }}
                        disabled={retrying === s._id || holdsLiveAuthoringClaim(s, now)}
                        title={retryHint(s, now)}
                        // While its run writes, the visible words are the name.
                        aria-label={
                          retrying === s._id
                            ? undefined
                            : withReasons
                              ? `Retry with the reasons for ${s.name}`
                              : `Retry ${s.name}`
                        }
                        aria-describedby={`${describedBy}-${s._id}`}
                      >
                        {retrying === s._id
                          ? 'Retrying…'
                          : withReasons
                            ? 'Retry with the reasons'
                            : 'Retry'}
                      </Button>
                    )}
                    {s.state === 'failed' ? (
                      <Button
                        variant="quiet"
                        size="small"
                        onClick={() =>
                          runControl(async () => {
                            const result = await giveUp({ skillId: s._id });
                            return givenUpOutcome(s.name, result.cancelled);
                          }, `${s.name} was not given up.`)
                        }
                        disabled={retrying === s._id || controls.busy}
                        aria-label={`Give up ${s.name}`}
                        // Described only once its line says what Give up does.
                        aria-describedby={spent ? `${describedBy}-${s._id}` : undefined}
                      >
                        Give up
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {/* A retry costs an authoring call for some of these rows and none for others, which
              is the difference between waiting on a sandbox and waiting on the model, so the
              text says which is which rather than claiming one for all of them. Starting a
              sandbox is the operator's step, not the manager's: the card says whom to ask, as
              the stalled adoption card does (A-m6), and the operator's commands stay in the
              running guide (docs/running/components.md). */}
          <div className="mt-3">
            <Disclosure summary="What Retry does">
              <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                Retry picks a skill up where it stopped. One parked because the check never ran (the
                sandbox was busy, not running, or failed) keeps its body and smoke test and is
                checked again as it stands, with no second authoring call; one the gate or the check
                itself turned down is authored again, with the reason fed back. Either way it has to
                pass the check before it is callable. If no sandbox was running, ask whoever runs
                this Day0 installation to start one, then press Retry. Only one authoring run holds
                a skill at a time, so a retry while one is still running is refused until that run
                finishes or its claim lapses.
              </p>
            </Disclosure>
          </div>
        </Card>
      ) : null}

      {retiring !== null ? (
        <RetireSkillDialog
          skill={retiring.skill}
          employee={employee}
          revisionOpen={revising.has(retiring.skill._id)}
          autonomous={autonomous}
          onClose={() => {
            // Some browsers do not focus a button on click, so the dialog's own return can land
            // on the page: the control that opened it takes focus back, unless a run is still
            // going, whose own control keeps the return.
            if (retrying === null) {
              setReturnTo({ control: retiring.origin, card: registeredCard.current });
            }
            setRetiring(null);
          }}
          onDone={(words) => {
            setNotice({ tone: 'done', text: words });
            // The row leaves the list with its Retire, so focus goes to the card.
            setReturnTo({ control: retiring.origin, card: registeredCard.current });
            setRetiring(null);
          }}
        />
      ) : null}
    </>
  );
}

/** What Ask for a revision does, beside the registered list and for its hover. */
const REVISE_HINT =
  'Ask for a revision: a new version is written and checked in the sandbox, and this one keeps running until the new one registers';

/** What Retry does for a row whose draft is kept. */
const RETRY_CHECKS_HINT =
  'Run the body and smoke test this skill already has through the sandbox check - no new authoring call';

/** What Retry does for every other row. */
const RETRY_AUTHORS_HINT = 'Author this skill again, with the reason it stopped, then verify it';

/** Why Retry waits on a row a run is writing now. */
const RETRY_WAITS_HINT =
  'A run is writing this skill now; Retry opens once it finishes or its hold lapses';

/**
 * What Retry does on an unregistered row: nothing while a run holds it, the check alone on a kept
 * draft, a new authoring call otherwise.
 *
 * @param skill - The unregistered row.
 * @param now - The page's clock, for whether a run's hold is live.
 */
function retryHint(skill: Doc<'skills'>, now: number): string {
  if (holdsLiveAuthoringClaim(skill, now)) return RETRY_WAITS_HINT;
  return retryVerifiesSavedDraft(skill) ? RETRY_CHECKS_HINT : RETRY_AUTHORS_HINT;
}
