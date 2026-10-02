/// <reference types="node" />
import { errorMessage } from '../../src/lib/errors';

/**
 * The deployment's HTTP function API called with its admin key, for the setup verbs and the
 * checks that must reach an internal function with a secret in its arguments.
 *
 * `npx convex run <fn> '<json>'` would put those arguments on a command line, where `ps` and a
 * shell's history show them (A12: a secret goes in on stdin or a hidden prompt, never on a command
 * line). Here they travel in one POST body to the customer's own backend, the admin key in the
 * `Authorization` header as the Convex CLI sends it, and nothing of either is ever printed.
 */

/** The three kinds of function the API runs, each at its own path. */
export type FunctionKind = 'query' | 'mutation' | 'action';

/** Runs one deployed function, internal ones included, as the deployment's administrator. */
export interface DeploymentAdmin {
  /**
   * Run one function and return its value.
   *
   * @param kind - Query, mutation or action.
   * @param path - The function's path, as `module:function`.
   * @param args - Its arguments, as plain JSON.
   * @param options.secrets - The secret values among the arguments: removed from any refusal,
   *   since a validator's refusal quotes the arguments it was given.
   * @throws DeploymentCallFailed with the function's own refusal, or why the backend did not answer.
   */
  run<T>(
    kind: FunctionKind,
    path: string,
    args: Readonly<Record<string, unknown>>,
    options?: { readonly secrets?: readonly string[] },
  ): Promise<T>;
}

/** A call the deployment refused or could not answer; the message never carries a named secret. */
export class DeploymentCallFailed extends Error {}

/** What stands in a message for a value it must not repeat. */
const SECRET_STAND_IN = '<secret>';

/** A message with every named secret, and the admin key, taken out. */
function withoutSecrets(message: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret: string): boolean => secret !== '')
    .reduce(
      (text: string, secret: string): string => text.split(secret).join(SECRET_STAND_IN),
      message,
    );
}

/** The address and admin key of a self-hosted deployment, as the env file names them. */
export interface AdminTarget {
  readonly url: string;
  readonly adminKey: string;
}

/** How long one call may take: an action that reaches a vendor is the slowest. */
const CALL_TIMEOUT_MS = 60_000;

/**
 * The self-hosted deployment the env file names, or why there is none to call. A customer-local
 * install is self-hosted by construction; a cloud deployment is refused, never written to.
 *
 * @param values - The env file's values.
 */
export function adminTarget(
  values: Readonly<Record<string, string>>,
): AdminTarget | { gap: string } {
  const url = (values.CONVEX_SELF_HOSTED_URL ?? '').trim();
  if (url === '') {
    return {
      gap:
        'The env file names no self-hosted backend (CONVEX_SELF_HOSTED_URL): the access verbs ' +
        'act on a customer-local install only. Set Day0 up first: `./setup.sh --route <...>`.',
    };
  }
  const adminKey = (values.CONVEX_SELF_HOSTED_ADMIN_KEY ?? '').trim();
  if (adminKey === '') {
    return {
      gap: 'CONVEX_SELF_HOSTED_ADMIN_KEY is unset, so nothing can reach the deployment as its administrator.',
    };
  }
  return { url, adminKey };
}

/** One answer of the HTTP function API. */
interface FunctionAnswer {
  readonly status?: unknown;
  readonly value?: unknown;
  readonly errorMessage?: unknown;
}

/**
 * The deployment at `target`, called through `fetch`.
 *
 * @param target - The backend's address and admin key.
 * @param target.fetch - The network seam; the global `fetch` unless a test passes one.
 */
export function deploymentAdmin(
  target: AdminTarget & { readonly fetch?: typeof fetch },
): DeploymentAdmin {
  const base = target.url.replace(/\/+$/, '');
  const send = target.fetch ?? fetch;
  return {
    run: async <T>(
      kind: FunctionKind,
      path: string,
      args: Readonly<Record<string, unknown>>,
      options: { readonly secrets?: readonly string[] } = {},
    ): Promise<T> => {
      const hidden = [target.adminKey, ...(options.secrets ?? [])];
      let response: Response;
      try {
        response = await send(`${base}/api/${kind}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Convex ${target.adminKey}`,
          },
          body: JSON.stringify({ path, args, format: 'json' }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      } catch (err) {
        throw new DeploymentCallFailed(
          `The backend at ${base} could not be reached: ${withoutSecrets(errorMessage(err), hidden)}`,
        );
      }
      let answer: FunctionAnswer;
      try {
        answer = (await response.json()) as FunctionAnswer;
      } catch {
        throw new DeploymentCallFailed(
          `${path} answered HTTP ${response.status} with no function result.`,
        );
      }
      if (answer.status === 'success') return answer.value as T;
      const said = typeof answer.errorMessage === 'string' ? answer.errorMessage : 'no message';
      throw new DeploymentCallFailed(`${path} refused: ${withoutSecrets(said, hidden)}`);
    },
  };
}
