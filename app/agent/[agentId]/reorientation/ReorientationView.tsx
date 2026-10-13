'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { useAgentZone, useNow } from '../../../components/time';
import { useChange } from '../../../components/use-change';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { employeeTabHref } from '../employee-tabs';
import { ReorientationCard } from './ReorientationCard';

/** The longest description of a change of role a card takes. */
const SUMMARY_LIMIT = 300;

/**
 * The card the manager opens by hand when the employee's role or goals change (section 3's last
 * row): one sentence of what changed, and the employee proposes the clause to change.
 */
function OpenByHand({ name }: { name: string }) {
  const { agent } = useEmployee();
  const open = useMutation(api.reorientationDecisions.openByHand);
  const [summary, setSummary] = useState('');
  const cardRef = useRef<HTMLElement>(null);
  const change = useChange(cardRef);
  const trimmed = summary.replace(/\s+/g, ' ').trim();
  return (
    <Card title="When the role changes" focusRef={cardRef}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          change.run(() => open({ agentId: agent._id, summary: trimmed }), {
            // A second change typed the same day joins the standing card (W16-R24); it is judged
            // again over both unless the card's proposal is one a talk put there. A card whose
            // summary is full takes no more words: the record's joined event keeps them.
            done: (opened) =>
              !opened.joined
                ? `A card is open. ${name} is working out what to propose.`
                : !opened.onCard
                  ? `Today’s card has no room for more words, so this change is in ${name}’s record and not on the card.`
                  : opened.asked
                    ? `Added to today’s card. ${name} is working out what to propose over both.`
                    : 'Added to today’s card.',
            refused: 'No card was opened.',
            after: () => setSummary(''),
          });
        }}
      >
        <Field
          label={`What changed about ${name}'s role or goals`}
          hint={`${name} proposes the clause to change; nothing changes until you approve it.`}
        >
          {(control) => (
            <input
              {...control}
              type="text"
              value={summary}
              maxLength={SUMMARY_LIMIT}
              onChange={(event) => setSummary(event.target.value)}
              className={`${INPUT_CLASS} w-full`}
            />
          )}
        </Field>
        <div>
          <Button type="submit" disabled={change.busy || trimmed === ''}>
            Open a card
          </Button>
        </div>
        <StatusRegion outcome={change.outcome} />
      </form>
    </Card>
  );
}

/**
 * Why the cards exist, beside them (the prototype's aside): every trigger opens a card, only
 * Approve changes anything, a low-risk card never holds work, at most a few a day.
 */
function WhyCards() {
  return (
    <Card title="Why these cards exist">
      <p className="text-[13px] text-[var(--color-fg-2)]">
        A document, a person or a connection the charter relies on changed. Every trigger opens a
        card; only Approve changes anything; a low-risk card never holds work; at most a few a day.
      </p>
    </Card>
  );
}

/**
 * Bring the card an address names into view and focus (`/agent/<id>/reorientation#card-<id>`,
 * 16-D's W-3): the inbox's Review and the talk's Back to the card navigate on the client, where
 * the cards arrive after the page and the browser's own jump to the fragment finds nothing; a
 * later change of the fragment lands the same way. The card's scroll margin keeps its title clear
 * of the sticky header, as a direct load does.
 *
 * @param ready - Whether the cards are drawn.
 */
function useCardAnchor(ready: boolean): void {
  // Counts the fragment's changes, so each one lands again.
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const changed = (): void => {
      if (window.location.hash.startsWith('#card-')) setChanges((count) => count + 1);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    if (!ready || !window.location.hash.startsWith('#card-')) return;
    // A fragment typed or mangled by hand may not be a valid escape: it names no card.
    let id: string;
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return;
    }
    const card = document.getElementById(id);
    if (!card) return;
    card.scrollIntoView({ block: 'start' });
    card.focus({ preventScroll: true });
  }, [ready, changes]);
}

/**
 * The reorientation page, under the Needs you tab (`/agent/<id>/reorientation`; wave 16, 16-O):
 * the employee's cards, the ones waiting on the manager first, each with its evidence, what it
 * reaches, what the employee proposes and the decisions; the decided ones after with what their
 * decision did. With none open it says what opens one (section 7), and the manager can open one
 * for a change of role.
 */
export function ReorientationView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  const zone = useAgentZone();
  const now = useNow();
  const views = useQuery(api.reorientationDecisions.listForAgent, { agentId: agent._id });
  useCardAnchor(views !== undefined);
  const charter = <Link href={employeeTabHref(agent._id, 'charter')}>Charter tab</Link>;
  const standing = (views ?? []).filter(
    (view) => view.card.status !== 'applied' && view.card.status !== 'dismissed',
  );
  const decided = (views ?? []).filter(
    (view) => view.card.status === 'applied' || view.card.status === 'dismissed',
  );
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <EmployeeRail />
          <WhyCards />
        </>
      }
    >
      {views === undefined ? (
        <p role="status" className="text-sm text-[var(--color-muted)]">
          Loading the reorientation cards
        </p>
      ) : standing.length === 0 ? (
        <Card title="No reorientation card is open">
          {surfaceMode === 'real' ? (
            <p className="text-sm text-[var(--color-fg-2)]">
              A card opens when a person, a page, a skill or an access {agent.name} relies on
              changes. Meanwhile you can amend the charter on the {charter}.
            </p>
          ) : (
            <p className="text-sm text-[var(--color-fg-2)]">
              The hosted office&apos;s pages do not change, so a card opens here when {agent.name}{' '}
              is handed over to you, or when you open one below. You can amend the charter on the{' '}
              {charter}.
            </p>
          )}
        </Card>
      ) : (
        standing.map((view) => (
          <ReorientationCard
            key={view.card._id}
            view={view}
            name={agent.name}
            zone={zone}
            now={now}
          />
        ))
      )}
      {views !== undefined ? <OpenByHand name={agent.name} /> : null}
      {decided.length > 0 ? (
        <section aria-labelledby="decided-cards" className="grid gap-3">
          <h2 id="decided-cards" className="text-sm font-semibold text-[var(--color-muted)]">
            Decided
          </h2>
          {decided.map((view) => (
            <ReorientationCard
              key={view.card._id}
              view={view}
              name={agent.name}
              zone={zone}
              now={now}
            />
          ))}
        </section>
      ) : null}
    </Columns>
  );
}
