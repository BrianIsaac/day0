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
