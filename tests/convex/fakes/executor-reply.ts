import { reportedEarlierWrites } from '../../../src/work/evidence-claims';
import type { MockAction } from '../../../src/work/types';

/** The verbs whose actions can carry a message, and so a declared `reports` (D-5 (b)). */
const MESSAGE_CAPABLE = new Set([
  'slack.postMessage',
  'twitter.reply',
  'ticket.update',
  'mcp.call',
  'http.request',
]);

/**
 * A recorded action as today's schema takes it: a message-capable action recorded before the
 * run declared what a message reports declares the earlier writes its words report, as a model
 * filling the field would, so the apply binds it as the release it was recorded under did. Re-pinned
 * for W14-R8: it declared null, which now means the run declared none, a tripwire finding on a
 * message whose words report a write.
 */
function withUndeclaredReports(
  action: unknown,
  index: number,
  actions: readonly unknown[],
): unknown {
  if (typeof action !== 'object' || action === null || 'reports' in action) return action;
  const tool = (action as { tool?: unknown }).tool;
  if (typeof tool !== 'string' || !MESSAGE_CAPABLE.has(tool)) return action;
  return {
    ...action,
    reports: reportedEarlierWrites(action as MockAction, actions.slice(0, index) as MockAction[]),
  };
}

/**
 * A recorded executor reply as today's real-mode provider schema takes it.
 *
 * The recordings predate three required, nullable fields: the question a set
 * waits on (`openQuestion`, decision N20), the charter clause a closing
 * outcome was decided under (`charterClause`, backlog step 4) and the writes a
 * message reports (`reports`, the wave 13 review's D-5 (b)). A double that
 * returns a recording declares each empty, as a model with nothing to declare
 * would, and `reports` as the writes its words report, which binds a message as
 * before; a field the recording already carries is kept.
 *
 * @param reply - The recorded reply.
 * @returns The reply with the three fields filled where absent.
 */
export function asCurrentExecutorReply(reply: unknown): unknown {
  if (typeof reply !== 'object' || reply === null) return reply;
  const recorded = reply as {
    openQuestion?: unknown;
    planStepOutcomes?: unknown;
    actions?: unknown;
  };
  return {
    ...recorded,
    openQuestion: recorded.openQuestion ?? null,
    ...(Array.isArray(recorded.actions)
      ? { actions: recorded.actions.map(withUndeclaredReports) }
      : {}),
    ...(Array.isArray(recorded.planStepOutcomes)
      ? {
          planStepOutcomes: recorded.planStepOutcomes.map((outcome: unknown) =>
            typeof outcome === 'object' && outcome !== null && !('charterClause' in outcome)
              ? { ...outcome, charterClause: null }
              : outcome,
          ),
        }
      : {}),
  };
}

/** A provider schema as a double receives it; an object schema can leave fields out. */
interface ReplySchema {
  parse(value: unknown): unknown;
  shape?: Record<string, unknown>;
  omit?: (mask: Record<string, true>) => { parse(value: unknown): unknown };
}

/**
 * Validate a reply recorded before v0.16.0 against today's executor schema, under the rule for
 * output recorded before the release (`src/work/work-done.ts`).
 *
 * The recordings, and the doubles scripted before the release, carry no `workDone`: the run's
 * answer on whether the work was done did not exist yet, and no answer is made up for them. Such a
 * reply is checked against every other field the schema requires and returned without the answer,
 * so the run reads it as the release before did. A reply that carries the answer is parsed whole.
 *
 * @param schema - The schema the executor handed the model call.
 * @param reply - The recorded or scripted reply.
 * @returns The parsed reply.
 */
export function parseRecordedReply<T>(schema: ReplySchema, reply: unknown): T {
  const current = asCurrentExecutorReply(reply);
  const answered = typeof current === 'object' && current !== null && 'workDone' in current;
  const asksForAnswer = schema.shape !== undefined && 'workDone' in schema.shape;
  if (answered || !asksForAnswer || schema.omit === undefined) return schema.parse(current) as T;
  return schema.omit({ workDone: true, workDoneWhy: true }).parse(current) as T;
}
