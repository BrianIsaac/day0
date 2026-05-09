import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';

/**
 * 8-file workspace storage. One row per (agentId, fileName).
 */

const WORKSPACE_FILE_NAMES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'BOOTSTRAP.md',
  'MEMORY.md',
  'HEARTBEAT.md',
] as const;

function isKnown(name: string): boolean {
  return (WORKSPACE_FILE_NAMES as readonly string[]).includes(name);
}

export const read = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Record<string, string>> => {
    const rows = await ctx.db
      .query('workspace')
      .withIndex('by_agent_file', (q) => q.eq('agentId', args.agentId))
      .collect();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.fileName] = r.content;
    for (const name of WORKSPACE_FILE_NAMES) {
      if (!(name in out)) out[name] = '';
    }
    return out;
  },
});

export const readFile = query({
  args: { agentId: v.id('agents'), fileName: v.string() },
  handler: async (ctx, args): Promise<string> => {
    if (!isKnown(args.fileName)) {
      throw new Error(`workspace.readFile: unknown ${args.fileName}`);
    }
    const row = await ctx.db
      .query('workspace')
      .withIndex('by_agent_file', (q) =>
        q.eq('agentId', args.agentId).eq('fileName', args.fileName),
      )
      .unique();
    return row?.content ?? '';
  },
});

export const writeFile = mutation({
  args: { agentId: v.id('agents'), fileName: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    return await writeFileImpl(ctx, args);
  },
});

export const writeFileInternal = internalMutation({
  args: { agentId: v.id('agents'), fileName: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    return await writeFileImpl(ctx, args);
  },
});

async function writeFileImpl(
  ctx: { db: { query: any; insert: any; patch: any } },
  args: { agentId: any; fileName: string; content: string },
) {
  if (!isKnown(args.fileName)) {
    throw new Error(`workspace.writeFile: unknown ${args.fileName}`);
  }
  const existing = await ctx.db
    .query('workspace')
    .withIndex('by_agent_file', (q: any) =>
      q.eq('agentId', args.agentId).eq('fileName', args.fileName),
    )
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { content: args.content, updatedAt: Date.now() });
    return existing._id;
  }
  return await ctx.db.insert('workspace', {
    agentId: args.agentId,
    fileName: args.fileName,
    content: args.content,
    updatedAt: Date.now(),
  });
}
