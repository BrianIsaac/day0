/**
 * The suite's environment, cleaned of what a developer's shell carries.
 *
 * The gate must give the same answer on every machine. A shell that exports a
 * model address, a surface mode, a credential key or a local fake's address
 * changed what the product modules read at import, so the same tree passed on
 * one machine and failed on the next (P11-1). Every variable the product
 * reads for its deployment is removed before any test module loads; a test
 * that needs one stubs it (`vi.stubEnv`) and restores it.
 */

/** The deployment variables the product reads, by prefix or by name. */
export const PRODUCT_VARIABLE =
  /^(?:DAY0_|NEXT_PUBLIC_|CONVEX_|OPENAI_|OLLAMA_|DAYTONA_|ELEVENLABS_|GEMINI_|GOOGLE_|CLERK_|DEV_NO_AUTH|FEATHERLESS_|EXA_|SKILL_SANDBOX_|FAKE_SLACK_|MODEL_GPU|VERCEL|ANTHROPIC_|HF_)|^(?:AUTH_TOKEN|COMPOSE_PROJECT_NAME|MCP_URL|PORT|SCRATCHPAD_DIR)$/;

/**
 * The names in an environment that the suite must not inherit.
 *
 * @param env - The environment the suite was started with.
 * @returns The product variables it carries, sorted.
 */
export function inheritedProductVariables(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.keys(env)
    .filter((name) => PRODUCT_VARIABLE.test(name))
    .sort();
}

for (const name of inheritedProductVariables(process.env)) delete process.env[name];
