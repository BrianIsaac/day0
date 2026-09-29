import { DAY_ONE_TOPICS } from '@/agent/charter';
import { DAY_ONE_TOPIC_COUNT, DAY_ONE_TOPIC_TITLES } from '@/agent/day-one-progress';

/**
 * Where the one-to-one stands: not yet asked, on a question (from 0, as the chat route numbers
 * it), or over with some of the seven answered.
 */
export type TopicProgressState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'asking'; readonly topicIndex: number }
  | { readonly kind: 'answered'; readonly count: number };

/** What each segment of the line is drawn as. */
type Segment = 'done' | 'now' | 'next';

const SEGMENT_CLASS: Readonly<Record<Segment, string>> = {
  done: 'bg-[var(--color-ok)]',
  now: 'bg-[var(--color-accent)]',
  next: 'bg-[var(--color-border)]',
};

/** The seven segments for a state, and the sentence that says the same to everyone. */
export function topicProgressOf(progress: TopicProgressState): {
  readonly line: string;
  readonly segments: readonly Segment[];
} {
  const segments = (current: (index: number) => Segment): Segment[] =>
    Array.from({ length: DAY_ONE_TOPIC_COUNT }, (_, index) => current(index));
  switch (progress.kind) {
    case 'waiting':
      return {
        line: `${DAY_ONE_TOPIC_COUNT} questions, one at a time`,
        segments: segments(() => 'next'),
      };
    case 'asking': {
      const index = Math.min(Math.max(progress.topicIndex, 0), DAY_ONE_TOPIC_COUNT - 1);
      return {
        line: `Question ${index + 1} of ${DAY_ONE_TOPIC_COUNT} · ${DAY_ONE_TOPIC_TITLES[DAY_ONE_TOPICS[index]]}`,
        segments: segments((i) => (i < index ? 'done' : i === index ? 'now' : 'next')),
      };
    }
    case 'answered': {
      const count = Math.min(Math.max(progress.count, 0), DAY_ONE_TOPIC_COUNT);
      return {
        line: `${count} of ${DAY_ONE_TOPIC_COUNT} answered`,
        segments: segments((i) => (i < count ? 'done' : 'next')),
      };
    }
  }
}

/**
 * "Question n of 7" over a seven-segment line (round two section 3.4). The sentence carries the
 * progress for a screen reader; the line is drawn for the eye and hidden from assistive
 * technology.
 */
export function TopicProgress({ progress }: { progress: TopicProgressState }) {
  const { line, segments } = topicProgressOf(progress);
  return (
    <div className="grid gap-2">
      <p className="text-[13px] text-[var(--color-muted)]">{line}</p>
      <div aria-hidden="true" className="grid grid-cols-7 gap-1" data-topic-progress="">
        {segments.map((segment, index) => (
          <span
            key={index}
            data-segment={segment}
            className={`h-1 rounded-full ${SEGMENT_CLASS[segment]}`}
          />
        ))}
      </div>
    </div>
  );
}
