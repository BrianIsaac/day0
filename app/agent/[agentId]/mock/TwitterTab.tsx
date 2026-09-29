'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Chip } from '../../../components/Chip';

/** What an empty timeline means. The tab is mock-only: real mode does not
 * render it, so it has no real-mode copy to show. */
export const EMPTY_TWEETS = 'No posts are seeded in this office.';

/** The office's social timeline: each post with its replies, the employee's drafts marked. */
export function TwitterTab({ agentId }: { agentId: Id<'agents'> }) {
  const tweets = useQuery(api.mock.listTweets, { agentId });

  if (!tweets) return <p className="text-sm text-[var(--color-muted)]">Loading the posts…</p>;
  if (tweets.length === 0)
    return <p className="text-sm text-[var(--color-muted)]">{EMPTY_TWEETS}</p>;

  return (
    <div className="space-y-4">
      {tweets.map((t) => (
        <TweetThread
          key={t._id}
          agentId={agentId}
          slug={t.slug}
          author={t.author}
          handle={t.handle}
          body={t.body}
        />
      ))}
    </div>
  );
}

/** One post and the replies under it. */
function TweetThread({
  agentId,
  slug,
  author,
  handle,
  body,
}: {
  agentId: Id<'agents'>;
  slug: string;
  author: string;
  handle: string;
  body: string;
}) {
  const replies = useQuery(api.mock.listTweetReplies, { agentId, tweetSlug: slug }) ?? [];
  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-3">
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-muted)]/30 text-xs font-medium"
        >
          {author.slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">{author}</span>
            <span className="text-xs text-[var(--color-muted)]">{handle}</span>
          </div>
          <p className="text-sm text-[var(--color-fg)] mt-1">{body}</p>
        </div>
      </div>

      {replies.length > 0 ? (
        <div className="border-t border-[var(--color-border)] pt-3 space-y-2 ml-11">
          {replies.map((r) => (
            <div key={r._id} className="flex items-start gap-2 text-sm">
              <div
                aria-hidden="true"
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                  r.isAgentDraft
                    ? 'bg-[var(--color-warn)]/30 text-[var(--color-warn)]'
                    : 'bg-[var(--color-muted)]/30'
                }`}
              >
                {r.author.slice(0, 1).toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.author}</span>
                  <span className="text-xs text-[var(--color-muted)]">{r.handle}</span>
                  {r.isAgentDraft ? <Chip tone="warn">Employee draft</Chip> : null}
                </div>
                <p className="text-[var(--color-fg)] mt-0.5">{r.body}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="ml-11 text-xs text-[var(--color-muted)]">No replies yet.</p>
      )}
    </div>
  );
}
