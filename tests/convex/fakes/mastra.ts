/** What a scripted `agentJson` fake reads of the real call: the agent, the prompt and the schema. */
export interface ScriptedCall {
  readonly agent: { readonly name: string };
  readonly user: string;
  readonly schema: { parse(value: unknown): unknown };
}

/**
 * Pass a scripted model reply through the schema the product asked the model for.
 *
 * The real `agentJson` returns only what the call's schema accepts and throws
 * when a reply does not satisfy it, so a fake that skips the schema keeps
 * passing after the product's schema has moved on and a reply the product
 * would refuse is read as accepted (P10-9). Wrapped, the fake fails where the
 * real call would, with the real call's message.
 *
 * @param script - The test's reply for one call, or a throw for a model that fails.
 * @returns An `agentJson` stand-in that parses every reply through the call's schema.
 */
export function schemaChecked(
  script: (call: ScriptedCall) => unknown,
): <T>(call: ScriptedCall) => Promise<T> {
  return async <T>(call: ScriptedCall): Promise<T> => {
    const reply = await script(call);
    try {
      return call.schema.parse(reply) as T;
    } catch (cause) {
      throw new Error(`agentJson(${call.agent.name}): reply did not satisfy the schema`, {
        cause,
      });
    }
  };
}
