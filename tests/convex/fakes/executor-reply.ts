/**
 * A recorded executor reply as today's real-mode provider schema takes it.
 *
 * The recordings predate two required, nullable fields: the question a set
 * waits on (`openQuestion`, decision N20) and the charter clause a closing
 * outcome was decided under (`charterClause`, backlog step 4). A double that
 * returns a recording declares both empty, as a model with nothing to declare
 * would; a field the recording already carries is kept.
 *
 * @param reply - The recorded reply.
 * @returns The reply with the two fields filled where absent.
 */
export function asCurrentExecutorReply(reply: unknown): unknown {
  if (typeof reply !== 'object' || reply === null) return reply;
  const recorded = reply as { openQuestion?: unknown; planStepOutcomes?: unknown };
  return {
    ...recorded,
    openQuestion: recorded.openQuestion ?? null,
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
