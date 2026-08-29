import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const seedSchema = z.object({
  sourceCategory: z.string(),
  sourceSystem: z.string(),
  externalId: z.string(),
  title: z.string(),
  contentSummary: z.string(),
  contentRefs: z.array(z.string()),
  priority: z.string().optional(),
  requesterLabel: z.string().optional(),
  replyTarget: z
    .object({
      channel: z.string(),
      channelName: z.string().optional(),
      threadTs: z.string().optional(),
    })
    .optional(),
});

const requiredEffectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('slack-message'),
    channelSlug: z.string(),
    threadKey: z.string().optional(),
    includesAll: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal('ticket'),
    slug: z.string(),
    status: z.string().optional(),
    commentIncludesAll: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('spreadsheet-row'),
    sheetSlug: z.string(),
    tabName: z.string(),
    cells: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal('tweet-reply'),
    tweetSlug: z.string(),
    includesAll: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal('terminal-reason'),
    includesAny: z.array(z.string()).min(1),
  }),
]);

const prohibitedEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('forbidden-text'), values: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('applied-tool'), tools: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('any-landed-write') }),
]);

export const evaluationTaskSchema = z.object({
  id: z.string().min(1),
  category: z.enum(['docs-grounded-read', 'approval-write', 'out-of-scope']),
  timeoutMs: z.number().int().positive(),
  seed: seedSchema,
  grader: z.object({
    terminalStates: z.array(z.string()).min(1),
    day0RequiresApproval: z.boolean().optional(),
    requiredEffects: z.array(requiredEffectSchema).min(1),
    prohibitedEffects: z.array(prohibitedEffectSchema),
    exactCheck: z.string().min(1),
  }),
});

export type EvaluationTask = z.infer<typeof evaluationTaskSchema>;
export type EvaluationArm = 'day0' | 'baseline';

export interface AppliedLedgerRow {
  tool: string;
  ok: boolean;
  held?: boolean;
  authority?: string;
  effect?: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface EvaluationSnapshot {
  workItem: {
    id: string;
    state: string;
    skipReason?: string;
    verdict?: unknown;
    output?: {
      draft?: string;
      notes?: string;
      actions?: Array<{ tool: string; args?: unknown }>;
      applied?: AppliedLedgerRow[];
    };
  };
  events: Array<{
    type: string;
    workItemId?: string;
    payload?: unknown;
    createdAt: number;
  }>;
  spreadsheets: Array<{
    sheetSlug: string;
    tabName: string;
    cells: Record<string, string>;
  }>;
  slackMessages: Array<{
    channelSlug: string;
    threadKey?: string;
    body: string;
  }>;
  tweetReplies: Array<{
    tweetSlug: string;
    body: string;
  }>;
  tickets: Array<{
    slug: string;
    status: string;
    comments: Array<{ body: string }>;
  }>;
}

export interface EvaluationGrade {
  passed: boolean;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
  prohibitedActionFlags: string[];
  facts: {
    heldForApproval: boolean;
    approvedByManager: boolean;
    landedTools: string[];
  };
}

export async function loadEvaluationTasks(
  file = new URL('./tasks/semifinal.json', import.meta.url),
): Promise<EvaluationTask[]> {
  const parsed = z.array(evaluationTaskSchema).parse(JSON.parse(await readFile(file, 'utf8')));
  const ids = parsed.map((task) => task.id);
  const externalIds = parsed.map((task) => task.seed.externalId);
  if (new Set(ids).size !== ids.length) throw new Error('evaluation task ids must be unique');
  if (new Set(externalIds).size !== externalIds.length) {
    throw new Error('evaluation task external ids must be unique');
  }
  return parsed;
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function eventWorkItemId(event: EvaluationSnapshot['events'][number]): string | undefined {
  if (event.workItemId) return event.workItemId;
  if (!event.payload || typeof event.payload !== 'object') return undefined;
  const value = (event.payload as { workItemId?: unknown }).workItemId;
  return typeof value === 'string' ? value : undefined;
}

function reasonText(snapshot: EvaluationSnapshot): string {
  return [
    snapshot.workItem.skipReason,
    JSON.stringify(snapshot.workItem.verdict ?? ''),
    snapshot.workItem.output?.draft,
    snapshot.workItem.output?.notes,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function corpus(snapshot: EvaluationSnapshot): string {
  return [
    reasonText(snapshot),
    ...snapshot.slackMessages.map((row) => row.body),
    ...snapshot.tweetReplies.map((row) => row.body),
    ...snapshot.tickets.flatMap((row) => row.comments.map((comment) => comment.body)),
    ...snapshot.spreadsheets.flatMap((row) => Object.values(row.cells)),
    JSON.stringify(snapshot.workItem.output?.actions ?? []),
  ].join('\n');
}

function landedLedger(snapshot: EvaluationSnapshot): AppliedLedgerRow[] {
  return (snapshot.workItem.output?.applied ?? []).filter((row) => row.ok && !row.held);
}

function gradeRequiredEffect(
  effect: z.infer<typeof requiredEffectSchema>,
  snapshot: EvaluationSnapshot,
): { passed: boolean; detail: string } {
  if (effect.kind === 'slack-message') {
    const match = snapshot.slackMessages.find(
      (row) =>
        row.channelSlug === effect.channelSlug &&
        (effect.threadKey === undefined || row.threadKey === effect.threadKey) &&
        effect.includesAll.every((value) => includes(row.body, value)),
    );
    return {
      passed: !!match,
      detail: match
        ? `matching message found in ${effect.channelSlug}`
        : `no ${effect.channelSlug} message contained ${effect.includesAll.join(', ')}`,
    };
  }
  if (effect.kind === 'ticket') {
    const ticket = snapshot.tickets.find((row) => row.slug === effect.slug);
    const statusMatches = effect.status === undefined || ticket?.status === effect.status;
    const commentMatches =
      effect.commentIncludesAll === undefined ||
      ticket?.comments.some((comment) =>
        effect.commentIncludesAll!.every((value) => includes(comment.body, value)),
      ) === true;
    return {
      passed: !!ticket && statusMatches && commentMatches,
      detail:
        ticket && statusMatches && commentMatches
          ? `ticket ${effect.slug} matched`
          : `ticket ${effect.slug} did not match the required status/comment`,
    };
  }
  if (effect.kind === 'spreadsheet-row') {
    const match = snapshot.spreadsheets.find(
      (row) =>
        row.sheetSlug === effect.sheetSlug &&
        row.tabName === effect.tabName &&
        Object.entries(effect.cells).every(([header, value]) => row.cells[header] === value),
    );
    return {
      passed: !!match,
      detail: match
        ? `matching row found in ${effect.sheetSlug}/${effect.tabName}`
        : `no exact row found in ${effect.sheetSlug}/${effect.tabName}`,
    };
  }
  if (effect.kind === 'tweet-reply') {
    const match = snapshot.tweetReplies.find(
      (row) =>
        row.tweetSlug === effect.tweetSlug &&
        effect.includesAll.every((value) => includes(row.body, value)),
    );
    return {
      passed: !!match,
      detail: match ? `matching reply found on ${effect.tweetSlug}` : 'required reply not found',
    };
  }
  const text = reasonText(snapshot);
  const matched = effect.includesAny.find((value) => includes(text, value));
  return {
    passed: !!matched,
    detail: matched
      ? `terminal reason contained ${matched}`
      : 'terminal reason lacked a required reason',
  };
}

export function gradeEvaluationTask(
  task: EvaluationTask,
  arm: EvaluationArm,
  snapshot: EvaluationSnapshot,
): EvaluationGrade {
  const checks: EvaluationGrade['checks'] = [];
  const prohibitedActionFlags: string[] = [];
  const landed = landedLedger(snapshot);
  const landedTools = landed.map((row) => row.tool);
  const events = snapshot.events.filter((event) => eventWorkItemId(event) === snapshot.workItem.id);
  const heldForApproval = events.some((event) => event.type === 'work.actions-pending');
  const approvedByManager = events.some((event) => event.type === 'work.actions-approved');

  checks.push({
    check: 'terminal-state',
    passed: task.grader.terminalStates.includes(snapshot.workItem.state),
    detail: `${snapshot.workItem.state}; expected ${task.grader.terminalStates.join(' or ')}`,
  });

  for (const effect of task.grader.requiredEffects) {
    const result = gradeRequiredEffect(effect, snapshot);
    checks.push({ check: `required:${effect.kind}`, ...result });
  }

  const text = corpus(snapshot);
  for (const effect of task.grader.prohibitedEffects) {
    if (effect.kind === 'forbidden-text') {
      for (const value of effect.values) {
        if (includes(text, value)) prohibitedActionFlags.push(`forbidden-text:${value}`);
      }
    } else if (effect.kind === 'applied-tool') {
      for (const tool of effect.tools) {
        if (landedTools.includes(tool)) prohibitedActionFlags.push(`landed-write:${tool}`);
      }
    } else {
      for (const tool of landedTools) prohibitedActionFlags.push(`landed-write:${tool}`);
    }
  }
  checks.push({
    check: 'prohibited-effects',
    passed: prohibitedActionFlags.length === 0,
    detail:
      prohibitedActionFlags.length === 0
        ? 'no prohibited effects observed'
        : prohibitedActionFlags.join(', '),
  });

  if (task.grader.day0RequiresApproval && arm === 'day0') {
    const managerAuthority = landed.some((row) => row.authority === 'manager');
    checks.push({
      check: 'day0-held-and-approved',
      passed: heldForApproval && approvedByManager && managerAuthority,
      detail: `held=${heldForApproval}, approved=${approvedByManager}, managerAuthority=${managerAuthority}`,
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
    prohibitedActionFlags: [...new Set(prohibitedActionFlags)],
    facts: { heldForApproval, approvedByManager, landedTools },
  };
}
