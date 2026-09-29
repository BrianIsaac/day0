import type { UIMessage } from 'ai';
import { DAY_ONE_TOPICS } from '@/agent/charter';
import { DAY_ONE_TOPIC_TITLES, dayOneTurnMetadataOf } from '@/agent/day-one-progress';
import { INIT_PROMPT } from '@/agent/day-one-turn';
import { Card } from '../../../components/Card';

/** One answer the manager gave, under the question it answered when the route named it. */
export interface NotedAnswer {
  /** The topic's title, or null for a turn the route did not number. */
  readonly topic: string | null;
  readonly text: string;
}

/** The most characters of one answer the aside shows; the transcript keeps it whole. */
export const NOTED_MAX_CHARS = 160;

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string }).text)
    .join('')
    .trim();
}

/** An answer cut at a word near the bound, marked as cut. */
function clipped(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= NOTED_MAX_CHARS) return flat;
  const cut = flat.slice(0, NOTED_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > NOTED_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * What the manager has answered so far, each under the question the employee asked before it,
 * as the chat route numbered that question. The priming turn and a message sent without a
 * question before it are not answers, as the close gate counts them.
 *
 * @param messages - The chat room's history.
 */
export function notedAnswers(messages: readonly UIMessage[]): NotedAnswer[] {
  return messages.flatMap((message, index): NotedAnswer[] => {
    const text = textOf(message);
    const asked = messages[index - 1];
    if (message.role !== 'user' || !text || text === INIT_PROMPT) return [];
    if (asked?.role !== 'assistant' || !textOf(asked)) return [];
    const metadata = dayOneTurnMetadataOf(asked.metadata);
    return [
      {
        topic: metadata ? DAY_ONE_TOPIC_TITLES[DAY_ONE_TOPICS[metadata.topicIndex]] : null,
        text: clipped(text),
      },
    ];
  });
}

/** "Noted so far": each answer under its question, so the manager sees what became of it. */
export function NotedSoFar({ answers }: { answers: readonly NotedAnswer[] }) {
  return (
    <Card title="Noted so far">
      {answers.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">Nothing yet: your answers gather here.</p>
      ) : (
        <ul className="grid list-disc gap-2 pl-5 text-sm text-[var(--color-fg-2)]">
          {answers.map((answer, index) => (
            <li key={index}>
              {answer.topic ? (
                <span className="text-[var(--color-muted)]">{answer.topic}: </span>
              ) : null}
              {answer.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** What the one-to-one becomes, said before the manager has answered anything. */
export function WhatThisBecomes({ name }: { name: string }) {
  return (
    <Card title="What this becomes">
      <p className="text-sm text-[var(--color-muted)]">
        After the seventh answer {name} drafts a charter: why this hire, the role, 30, 60 and 90
        days, what it will and will not do, who it reports to, and the rules taken from your words.
        You confirm or strike each rule before anything else happens.
      </p>
    </Card>
  );
}
