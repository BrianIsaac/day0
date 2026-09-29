'use client';

import type { Doc, Id } from '@convex/_generated/dataModel';
import { transcriptTurns, type TranscriptTurn } from '@/agent/transcript-turns';
import { Card } from '../../../components/Card';
import { Disclosure } from '../../../components/Disclosure';
import { RecordLine } from '../../../components/RecordLine';
import { clockTime, useAgentZone } from '../time';
import type { CharterCardBody } from './CharterCard';
import { ChangesRequest } from './ChangesRequest';
import type { SentBackOutcome } from '../employee-context';

/** The answers of a transcript, each beside the question it answered. */
export interface Exchange {
  readonly question: string | null;
  readonly answer: string;
}

/** The manager's turns of a stored transcript, each with the employee's turn before it. */
export function exchangesOf(turns: readonly TranscriptTurn[]): Exchange[] {
  return turns.flatMap((turn, index): Exchange[] => {
    if (turn.speaker !== 'manager') return [];
    const before = turns[index - 1];
    return [{ question: before?.speaker === 'employee' ? before.text : null, answer: turn.text }];
  });
}

/**
 * What the manager said in the one-to-one the charter was drafted from, kept beside it (round two
 * section 3.5): each answer under the question it answered, in a scrolling region of its own.
 *
 * @param transcript - The stored transcript; null when none was kept, undefined while it loads.
 */
export function WhatYouSaid({ transcript }: { transcript: string | null | undefined }) {
  return (
    <Card title="What you said" meta={transcript ? 'kept' : undefined}>
      {transcript === undefined ? (
        <p className="text-sm text-[var(--color-muted)]">Loading the one-to-one</p>
      ) : transcript === null ? (
        <p className="text-sm text-[var(--color-muted)]">
          No transcript was kept: this charter was drafted from answers handed in directly.
        </p>
      ) : (
        <TranscriptAnswers transcript={transcript} />
      )}
    </Card>
  );
}

/** Each answer of a stored transcript under the question it answered, scrolling on its own. */
function TranscriptAnswers({ transcript }: { transcript: string }) {
  const exchanges = exchangesOf(transcriptTurns(transcript));
  if (exchanges.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">The transcript holds no answers.</p>;
  }
  return (
    <ol
      tabIndex={0}
      aria-label="Your answers in the one-to-one"
      className="grid max-h-[32rem] gap-3 overflow-y-auto"
    >
      {exchanges.map((exchange, index) => (
        <li key={index} className="grid gap-1">
          {exchange.question ? (
            <p className="line-clamp-2 text-[13px] text-[var(--color-muted)]">
              <span className="sr-only">Asked: </span>
              {exchange.question}
            </p>
          ) : null}
          <p className="rounded-xl rounded-br-[4px] border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] px-3.5 py-2.5 text-sm whitespace-pre-wrap text-[var(--color-fg)]">
            <span className="sr-only">You: </span>
            {exchange.answer}
          </p>
        </li>
      ))}
    </ol>
  );
}

/** How many rules a charter's strikes took out, in words. */
function struckWords(charter: Doc<'charters'>): string {
  const struck = ((charter.body as CharterCardBody).constraints ?? []).filter(
    (constraint) => constraint.struck,
  ).length;
  return struck === 0 ? '' : `, ${struck} ${struck === 1 ? 'rule' : 'rules'} struck`;
}

/** The versions list's lines for one row: an amendment is one line, the first version two. */
function versionLines(
  row: Doc<'charters'>,
  current: boolean,
): Array<{ key: string; kind: 'landed' | 'noted'; at: number; text: string }> {
  const marker = current ? ' · in force' : '';
  if (row.supersedes) {
    return [
      {
        key: row._id,
        kind: 'landed',
        at: row.createdAt,
        text: `v${row.version} amended by you${marker}`,
      },
    ];
  }
  const drafted = {
    key: `${row._id}:drafted`,
    kind: 'noted' as const,
    at: row.createdAt,
    text: `v${row.version} drafted from your one-to-one${row.approved ? '' : marker}`,
  };
  if (!row.approved) return [drafted];
  return [
    {
      key: `${row._id}:approved`,
      kind: 'landed',
      at: row.approvedAt ?? row.createdAt,
      text: `v${row.version} approved by you${struckWords(row)}${marker}`,
    },
    drafted,
  ];
}

/**
 * Every version of the charter, newest first (`agent-charter.html`): each amendment, the approval
 * with the rules it struck, and the draft the one-to-one wrote. An approved version and every
 * amendment are kept, so this is the charter's history; a draft sent back is not among them.
 *
 * @param versions - `charters.listForAgent`, newest first; undefined while it loads.
 */
export function CharterVersions({
  versions,
  current,
}: {
  versions: readonly Doc<'charters'>[] | undefined;
  current: Doc<'charters'>;
}) {
  const zone = useAgentZone();
  return (
    <Card title="Versions">
      {versions === undefined ? (
        <p className="text-sm text-[var(--color-muted)]">Loading the versions</p>
      ) : (
        <ul className="grid gap-2">
          {versions
            .flatMap((row) => versionLines(row, row._id === current._id))
            .map((line) => (
              <RecordLine
                key={line.key}
                kind={line.kind}
                time={{ at: line.at, label: clockTime(line.at, zone) }}
              >
                {line.text}
              </RecordLine>
            ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * What sits beside the charter: on a draft, what the manager said and the way to ask for changes
 * (`charter-review.html`); once approved, the versions and the transcript one disclosure away
 * (`agent-charter.html`).
 *
 * @param transcript - The stored transcript; null when none was kept, undefined while it loads.
 * @param versions - Every version, newest first, once approved; undefined while it loads.
 * @param onSentBack - Told which draft the manager sent back, and whether it is being redrafted.
 */
export function CharterAside({
  charter,
  name,
  transcript,
  versions,
  onSentBack,
}: {
  charter: Doc<'charters'>;
  name: string;
  transcript: string | null | undefined;
  versions: readonly Doc<'charters'>[] | undefined;
  onSentBack: (charterId: Id<'charters'>, outcome: SentBackOutcome) => void;
}) {
  if (!charter.approved) {
    return (
      <>
        <WhatYouSaid transcript={transcript} />
        <ChangesRequest
          charter={charter}
          name={name}
          hasTranscript={transcript === undefined ? undefined : transcript !== null}
          onSentBack={onSentBack}
        />
      </>
    );
  }
  return (
    <>
      <CharterVersions versions={versions} current={charter} />
      <Card title="What you said">
        <p className="text-sm text-[var(--color-muted)]">
          {transcript === null
            ? 'No transcript was kept: this charter was drafted from answers handed in directly.'
            : 'The one-to-one this charter was drafted from is kept beside every version.'}
        </p>
        {transcript ? (
          <Disclosure summary="Read what you said">
            <TranscriptAnswers transcript={transcript} />
          </Disclosure>
        ) : null}
      </Card>
    </>
  );
}
