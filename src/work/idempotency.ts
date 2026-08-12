/**
 * Idempotency keys for the actions an execution run applies.
 *
 * The mock adapters live in the same transactional store as the work item, so
 * today a duplicate write is only ever a duplicate row. A real Slack, ticket
 * or payment connector is a different matter: an action can land externally
 * and the run can then be interrupted before the completion is recorded
 * locally, and the only defence against re-applying it is a key the provider
 * recognises as one it has already seen.
 *
 * The key is derived from three ids the caller cannot choose: the work item,
 * the run (the id of the claim event minted by `work.claimForExecution`) and
 * the action's position in the emitted list. It is therefore stable for the
 * lifetime of one claim and different for the next one — a boss pressing
 * Retry is asking for the plan to run again, and gets a fresh run.
 */
export interface ActionIdempotencyArgs {
  workItemId: string;
  runId: string;
  actionIndex: number;
}

export function actionIdempotencyKey(args: ActionIdempotencyArgs): string {
  return `${args.workItemId}:${args.runId}:${args.actionIndex}`;
}
