'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

export function TwitterTab({ agentId }: { agentId: Id<'agents'> }) {
  const tweets = useQuery(api.mock.listTweets, { agentId });

  if (!tweets) return <div className="text-xs text-[var(--color-muted)]">loading…</div>;
  if (tweets.length === 0)
    return <div className="text-xs text-[var(--color-muted)]">no tweets seeded</div>;

  return (
    <div className="space-y-4">
      {tweets.map((t) => (
        <TweetThread key={t._id} agentId={agentId} slug={t.slug} author={t.author} handle={t.handle} body={t.body} />
      ))}
    </div>
  );
}

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
    <div className="border border-[var(--color-border)] rounded-md p-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-[var(--color-muted)]/30 flex items-center justify-center text-xs font-medium">
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
            <div key={r._id} className="flex items-start gap-2 text-xs">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium ${
                  r.isAgentDraft
                    ? 'bg-[var(--color-warn)]/30 text-[var(--color-warn)]'
                    : 'bg-[var(--color-muted)]/30'
                }`}
              >
                {r.author.slice(0, 1).toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.author}</span>
                  <span className="text-[var(--color-muted)]">{r.handle}</span>
                  {r.isAgentDraft ? (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-warn)]/20 text-[var(--color-warn)]">
                      draft
                    </span>
                  ) : null}
                </div>
                <p className="text-[var(--color-fg)] mt-0.5">{r.body}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-[var(--color-muted)] ml-11">no replies yet</div>
      )}
    </div>
  );
}
