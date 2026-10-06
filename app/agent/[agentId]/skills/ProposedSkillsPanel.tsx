'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import { type AuthoringAttempt, AUTHORING_UNFINISHED } from './authoring';
import { useMutation, useAction, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useNow } from '../../../components/time';
import { useChange, refusalText } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { skillApprovalRefusal } from '@/surfaces/policy';
import { adoptionHelp, adoptionStateAt } from '@/work/skill-adoption';
import { useEmployee } from '../employee-context';
import { AdoptionCard, type Adoption } from './AdoptionCard';
import { plainSkillName, ScopeChips } from './skill-parts';
import { rationaleBesideItem } from '@/work/skill-rationale';
import { heldStartLine } from '@/work/held-starts';
import { runHoldOf } from '@/work/item-display';

/** A skill's name and the item that first needs it, as the panel's rows open. */
function ProposalHead({
  skill,
  item,
  rationale,
}: {
  skill: Pick<Doc<'skills'>, 'name' | 'description'>;
  item: string | undefined;
  rationale: string | undefined;
}) {
  return (
    <>
      <p className="text-sm text-[var(--color-fg)] break-words">
        <span className="font-medium">{skill.name}</span>
        <span className="text-[var(--color-fg-2)]"> · {plainSkillName(skill)}</span>
      </p>
      {item || rationale ? (
        <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)]">
          {item ? <>First needed by &ldquo;{item}&rdquo;. </> : null}
          {rationale ? (item ? rationaleBesideItem(rationale) : rationale) : null}
        </p>
      ) : null}
    </>
  );
}

/** The row classes of every entry of the panel's list. */
const ROW = 'grid gap-2 border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0';

/**
 * The skills the employee proposed and the manager has not decided, each with the item that
 * first needs it, what approving grants, and Approve and Reject; a proposal that offers a
 * sibling's verified skill draws the adoption card in their place (A3), and an adoption stays on
 * the panel while the sandbox checks it again, when that check stops short or fails, and once it
 * is declined. With nothing waiting on the manager the card is titled plainly.
 * Every decision is said in the panel's one live region.
 */
export function ProposedSkillsPanel({
  skills,
  surfaces,
  onAuthoringAttempt,
  fallback,
  name,
  itemTitles,
}: {
  skills: Doc<'skills'>[];
  /** The agent's surfaces in real mode; a skill targeting one that is not
   *  connected cannot be approved yet, and the button says why. */
  surfaces: SurfaceRecord[];
  /** Approving moves the row out of this panel, so the authoring's verdict has
   *  to be reported somewhere that survives the unmount. `null` opens an
   *  attempt and retires whatever the last one said. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
  /** Where focus goes when the decided row leaves the panel: the Skills card it moves to. */
  fallback?: React.RefObject<HTMLElement | null>;
  /** The employee's name. */
  name: string;
  /** The employee's work item titles by id, for the item that first needs each skill. */
  itemTitles: ReadonlyMap<string, string>;
}) {
  const { agent, surfaceMode, scheduledWorkPaused } = useEmployee();
  // A pause holds the authoring an approval starts (D-8 (b)), so the approval says so.
  const authoringHold = runHoldOf({
    real: surfaceMode === 'real',
    employeeName: name,
    employeePaused: agent.pausedAt !== undefined,
    scheduledWorkPaused,
  });
  const approve = useMutation(api.skills.approve);
  const reject = useMutation(api.skills.reject);
  const adopt = useMutation(api.skillAdoption.adopt);
  const setOfferAside = useMutation(api.skillAdoption.setOfferAside);
  const verifyAgain = useMutation(api.skillAdoption.verifyAgain);
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const adoptionArgs = useMemo(() => ({ agentId: agent._id }), [agent._id]);
  const adoptions = useQuery(api.skillAdoption.adoptions, adoptionArgs);
  const now = useNow();
  const change = useChange(fallback);
  // A declined adoption leaves every list with its row; its card stays drawn, declined, until the
  // manager leaves the tab, so each decision is read where it was made.
  const [declined, setDeclined] = useState<readonly Adoption[]>([]);
  // The adoption whose check the panel's last line says is under way, and the line: it stands
  // while the check does, and goes once the card says otherwise (the wave 10 review, A-m4).
  const [checkLine, setCheckLine] = useState<{
    readonly skillId: Id<'skills'>;
    readonly text: string;
    /** The card's state when the check was asked for: an offer adopted, or a stopped check. */
    readonly from: 'offered' | 'stalled';
    /** Whether the card has been seen with the check under way since. */
    readonly ran?: true;
  } | null>(null);

  const offers = useMemo(
    (): ReadonlyMap<Id<'skills'>, Adoption> =>
      new Map((adoptions ?? []).map((adoption) => [adoption.skillId, adoption])),
    [adoptions],
  );
  const proposedIds = new Set(skills.map((skill) => skill._id));
  // Past its offer, each adoption is drawn as it stands at this moment: a check no live run holds
  // has stalled, by the browser's clock.
  const inFlight = (adoptions ?? []).flatMap((adoption) =>
    adoption.state !== 'offered' && !proposedIds.has(adoption.skillId)
      ? [{ adoption, state: adoptionStateAt(adoption, now) }]
      : [],
  );
  const shownDeclined = declined.filter(
    (adoption) => !proposedIds.has(adoption.skillId) && !offers.has(adoption.skillId),
  );

  // The authoring an approval starts runs for minutes and files its verdict with the Skills card.
  function startAuthoring(skill: Pick<Doc<'skills'>, '_id' | 'name'>): void {
    const file = (reason?: string, held?: boolean): void =>
      onAuthoringAttempt({
        skillId: skill._id,
        name: skill.name,
        ...(reason ? { reason } : {}),
        ...(held === true ? { held } : {}),
      });
    onAuthoringAttempt(null);
    // Discarded because both outcomes are handled here and filed as the
    // attempt the Skills card shows in its live region.
    void author({ skillId: skill._id }).then(
      (result) =>
        file(result.ok ? undefined : (result.reason ?? AUTHORING_UNFINISHED), result.held),
      (err: unknown) => file(refusalText(err, AUTHORING_UNFINISHED)),
    );
  }

  /** What an approval that starts an authoring says: the authoring under way, or held by a pause. */
  function approvedWords(skillName: string): string {
    return authoringHold === undefined
      ? `Approved ${skillName}: the employee is authoring it now, and the Skills card says when it is callable.`
      : `Approved ${skillName}. It is ${heldStartLine(authoringHold, 'authoring')}.`;
  }

  function onApprove(skill: Doc<'skills'>): void {
    change.run(() => approve({ skillId: skill._id }), {
      done: approvedWords(skill.name),
      refused: `${skill.name} was not approved.`,
      after: () => startAuthoring(skill),
    });
  }

  function onAdopt(adoption: Adoption): void {
    const text = `Adopting ${adoption.name} for ${name}: the sandbox is checking it again, and this card says when ${name} can use it.`;
    change.run(() => adopt({ skillId: adoption.skillId }), {
      done: text,
      refused: `${adoption.name} was not adopted.`,
      after: () => {
        setCheckLine({ skillId: adoption.skillId, text, from: 'offered' });
        // Filed with no reason, so the Skills card says so once the check registers it.
        onAuthoringAttempt({ skillId: adoption.skillId, name: adoption.name });
      },
    });
  }

  function onCheckAgain(adoption: Adoption): void {
    const text = `Checking ${adoption.name} again for ${name}: this card says when ${name} can use it.`;
    change.run(() => verifyAgain({ skillId: adoption.skillId }), {
      done: text,
      refused: `${adoption.name} was not checked again.`,
      after: () => setCheckLine({ skillId: adoption.skillId, text, from: 'stalled' }),
    });
  }

  // A line about a check under way says nothing true once its card does not: the adoption
  // registered (or was declined) and left the panel, its check failed, or its check stopped
  // short. A Check it again is pressed on a stopped card, which reads stopped until the check
  // claims the row, so its line goes on a stop only once the check has been seen under way.
  const checkAt = checkLine === null ? undefined : offers.get(checkLine.skillId);
  const checkState = checkAt === undefined ? undefined : adoptionStateAt(checkAt, now);
  const checkSeenRunning = checkLine !== null && checkState === 'verifying';
  useEffect(() => {
    if (!checkSeenRunning) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a check seen under way once is remembered, so a later stop ends its line
    setCheckLine((line) => (line === null || line.ran ? line : { ...line, ran: true }));
  }, [checkSeenRunning]);
  const checkLineStale =
    checkLine !== null &&
    change.outcome?.text === checkLine.text &&
    (checkState === undefined ||
      checkState === 'failed' ||
      (checkState === 'stalled' && (checkLine.from === 'offered' || checkLine.ran === true)));

  // Write a new one instead: the offer is set aside first, so a refused approval leaves an
  // ordinary proposal to approve, never an approved row the card would take for an adoption.
  // Past the proposal (failed, or stopped short) the row is approved already: only the authoring.
  function onWriteNew(adoption: Adoption): void {
    const skill = { _id: adoption.skillId, name: adoption.name };
    if (adoption.state !== 'offered') {
      change.run(() => setOfferAside({ skillId: adoption.skillId }), {
        done:
          authoringHold === undefined
            ? `${name} is writing ${adoption.name} now, and the Skills card says when it is callable.`
            : `${adoption.name} is ${heldStartLine(authoringHold, 'authoring')}.`,
        refused: `${adoption.name} was not sent to be written.`,
        after: () => startAuthoring(skill),
      });
      return;
    }
    change.run(
      async () => {
        await setOfferAside({ skillId: adoption.skillId });
        return await approve({ skillId: adoption.skillId });
      },
      {
        done: approvedWords(adoption.name),
        refused: `${adoption.name} was not approved.`,
        after: () => startAuthoring(skill),
      },
    );
  }

  function onDecline(adoption: Adoption): void {
    change.run(() => reject({ skillId: adoption.skillId }), {
      done: `Declined ${adoption.name}: ${name} will not adopt it.`,
      refused: `${adoption.name} was not declined.`,
      after: () => setDeclined((earlier) => [...earlier, adoption]),
    });
  }

  const offering = skills.some((skill) => offers.get(skill._id)?.state === 'offered');
  const waiting =
    skills.length +
    inFlight.filter(({ state }) => state === 'failed' || state === 'stalled').length;
  const shown = skills.length + inFlight.length + shownDeclined.length;

  // One live region, outside the card and in the same place whether or not
  // the card is drawn: the last row leaving takes the card, and a region put
  // in anew already holding its words is not announced.
  return (
    <>
      {shown > 0 ? (
        <Card
          title={waiting > 0 ? 'Proposed · waiting on you' : 'Proposed'}
          {...(waiting > 0 ? { meta: `${waiting}`, tone: 'warn' as const } : {})}
        >
          <ul className="grid gap-5">
            {skills.map((s) => {
              const refusal = skillApprovalRefusal(
                s.targetSurface,
                surfaces.find((surface) => surface.slug === s.targetSurface),
                now,
              );
              const item = s.proposedFor ? itemTitles.get(s.proposedFor) : undefined;
              const offer = offers.get(s._id);
              const head = <ProposalHead skill={s} item={item} rationale={s.rationale} />;
              if (
                s.offeredVersionId !== undefined &&
                (adoptions === undefined || offer?.state === 'offered')
              ) {
                // The offer is drawn once the backend has said what it is; until then the row
                // offers nothing to press, so no Approve can land on an offered row. An offer
                // the backend no longer draws (its version gone) leaves an ordinary proposal.
                return (
                  <li key={s._id} className={ROW}>
                    {head}
                    {offer?.state === 'offered' ? (
                      <AdoptionCard
                        adoption={offer}
                        state="offered"
                        adopterName={name}
                        writeRefusal={refusal}
                        busy={change.busy}
                        onAdopt={() => onAdopt(offer)}
                        onCheckAgain={() => onCheckAgain(offer)}
                        onWriteNew={() => onWriteNew(offer)}
                        onDecline={() => onDecline(offer)}
                      />
                    ) : null}
                  </li>
                );
              }
              return (
                <li key={s._id} className={ROW}>
                  {head}
                  {s.requiredScopes && s.requiredScopes.length > 0 ? (
                    <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                      <ScopeChips scopes={s.requiredScopes} lead="Approving grants" />
                    </p>
                  ) : null}
                  {refusal ? (
                    <p className="text-[13px] text-[var(--color-warn)]">
                      Cannot approve yet: {refusal}{' '}
                      <a href="#surfaces" className="underline underline-offset-4">
                        Surfaces tab
                      </a>
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="approve"
                      size="small"
                      disabled={Boolean(refusal) || change.busy}
                      title={refusal}
                      // Named by its skill, as Reject is: two proposals' Approves are told apart.
                      aria-label={`Approve · author and verify ${s.name}`}
                      onClick={() => onApprove(s)}
                    >
                      Approve · author and verify
                    </Button>
                    <Button
                      variant="quiet"
                      size="small"
                      disabled={change.busy}
                      aria-label={`Reject ${s.name}`}
                      onClick={() =>
                        change.run(() => reject({ skillId: s._id }), {
                          done: `Rejected ${s.name}: the employee will not author it.`,
                          refused: `${s.name} was not rejected.`,
                        })
                      }
                    >
                      Reject
                    </Button>
                  </div>
                </li>
              );
            })}
            {inFlight.map(({ adoption, state }) => (
              <li key={adoption.skillId} className={ROW}>
                <ProposalHead
                  skill={adoption}
                  item={adoption.proposedFor ? itemTitles.get(adoption.proposedFor) : undefined}
                  rationale={undefined}
                />
                <AdoptionCard
                  adoption={adoption}
                  state={state}
                  adopterName={name}
                  busy={change.busy}
                  onAdopt={() => onAdopt(adoption)}
                  onCheckAgain={() => onCheckAgain(adoption)}
                  onWriteNew={() => onWriteNew(adoption)}
                  onDecline={() => onDecline(adoption)}
                />
              </li>
            ))}
            {shownDeclined.map((adoption) => (
              <li key={`declined-${adoption.skillId}`} className={ROW}>
                <ProposalHead skill={adoption} item={undefined} rationale={undefined} />
                <AdoptionCard
                  adoption={adoption}
                  state="declined"
                  adopterName={name}
                  busy={change.busy}
                  onAdopt={() => onAdopt(adoption)}
                  onCheckAgain={() => onCheckAgain(adoption)}
                  onWriteNew={() => onWriteNew(adoption)}
                  onDecline={() => onDecline(adoption)}
                />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
            {adoptionHelp(name, {
              offersAdoption: offering,
              proposals: skills.length > 0,
              adoptions: inFlight.length + shownDeclined.length > 0,
            })}
          </p>
        </Card>
      ) : null}
      <StatusRegion outcome={checkLineStale ? null : change.outcome} />
    </>
  );
}
