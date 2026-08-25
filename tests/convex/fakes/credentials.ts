import type { GenericId } from 'convex/values';
import { v } from 'convex/values';
import { internalAction } from '../../../convex/_generated/server';

/** Record the Lane A store contract without persisting a credential value. */
export const store = internalAction({
  args: {
    userId: v.string(),
    kind: v.union(v.literal('value'), v.literal('location'), v.literal('oauth')),
    label: v.string(),
    plaintext: v.optional(v.string()),
    source: v.union(
      v.object({ sourceId: v.id('docSources'), ref: v.string() }),
      v.literal('entered'),
    ),
    appId: v.optional(v.string()),
  },
  handler: async (): Promise<GenericId<'credentials'>> =>
    '10000credentials' as GenericId<'credentials'>,
});
