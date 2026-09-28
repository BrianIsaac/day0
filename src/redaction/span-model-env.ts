import { HttpSpanModel, type SpanModel } from './client';

/**
 * The span model the deployment names, read from `DAY0_REDACTOR_URL`. Only
 * Convex actions import this module: the address is a server-side setting
 * and the client module beside it reads no environment (standard 1.8).
 *
 * @param url - The configured address; defaults to the environment.
 * @returns A client, or undefined when nothing is configured.
 */
export function spanModelFromEnv(
  url: string | undefined = process.env.DAY0_REDACTOR_URL,
): SpanModel | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return new HttpSpanModel(trimmed);
}
