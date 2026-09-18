import type { SurfaceMode } from '../lib/surface-mode';
import {
  ISSUE_KEYS,
  actionIntent,
  messageTarget,
  targetIssueReferences,
  type ParsedHttpRequest,
  type ParsedSurfaceAction,
} from '../surfaces/policy';

/** What a provider item's identity is read from on the surface that found it. */
export interface ClaimKeySurface {
  slug: string;
  class: string;
  path?: string;
  endpoint?: string;
  providerWorkspaceId?: string;
}

/** The work item's own reference to the provider item. */
export interface ClaimKeyItem {
  sourceSystem: string;
  externalId: string;
}

/** Linear's own domain; its MCP server and its GraphQL API both sit under it. */
const LINEAR_DOMAIN = 'linear.app';
const SLACK_DOMAIN = 'slack.com';

/**
 * Whether an endpoint host is Linear's.
 *
 * Args:
 *   host: The endpoint's host.
 *
 * Returns:
 *   True for `linear.app` and its subdomains, never a look-alike.
 */
function isLinearHost(host: string): boolean {
  return host === LINEAR_DOMAIN || host.endsWith(`.${LINEAR_DOMAIN}`);
}

function isSlackHost(host: string): boolean {
  return host === SLACK_DOMAIN || host.endsWith(`.${SLACK_DOMAIN}`);
}

/**
 * The origin of an http(s) endpoint.
 *
 * Args:
 *   endpoint: The surface's documented endpoint.
 *
 * Returns:
 *   The origin, or undefined when there is no parseable http(s) endpoint.
 */
function httpOrigin(endpoint: string | undefined): URL | undefined {
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The key one external item is claimed under across the owner's employees.
 *
 * The provider is recognised by where the surface reaches it, never by its
 * slug or its path, so two employees whose cards name or reach one system
 * differently still meet on one key. A Linear issue id is a UUID, unique
 * across workspaces and the same over Linear's MCP server and its API. A
 * Slack message's channel and timestamp are unique only inside a workspace,
 * so the workspace is part of the key. Any other surface is keyed by its
 * endpoint's origin, and one with no usable endpoint by its slug, which
 * still separates it from every other kind: the prefixes `linear:`,
 * `slack:` and `slug:` cannot begin an http(s) origin. Mock mode claims
 * nothing, since every mock employee has a world of its own.
 *
 * Args:
 *   surface: The surface the item was read from, when it is still listed.
 *   item: The work item's source system and external id.
 *   mode: The deployment's surface mode.
 *
 * Returns:
 *   The key, or undefined when the item is not claimed across employees.
 */
export function providerItemKey(
  surface: ClaimKeySurface | undefined,
  item: ClaimKeyItem,
  mode: SurfaceMode,
): string | undefined {
  if (mode !== 'real') return undefined;
  const origin = httpOrigin(surface?.endpoint);
  if (origin && isLinearHost(origin.hostname)) return `linear:${item.externalId}`;
  if (origin && isSlackHost(origin.hostname) && surface?.class === 'chat' && surface.providerWorkspaceId) {
    return `slack:${surface.providerWorkspaceId}:${item.externalId}`;
  }
  if (origin) return `${origin.origin}|${item.externalId}`;
  return `slug:${item.sourceSystem}|${item.externalId}`;
}

/** The most external ids one write is checked under; each is one indexed read. */
const WRITE_TARGET_LIMIT = 16;
/** How deep a request body is read for a ticket reference (`variables.input.issueId`). */
const BODY_DEPTH = 3;

/**
 * The ticket references a documented-API write carries: every segment of its
 * path (`/issue/OPS-12/comment`) and every ticket-named string in its JSON
 * body, nested as a GraphQL request nests its variables. A segment that is
 * no ticket matches no claim, so reading them all costs lookups, not errors.
 */
function httpTicketReferences(parsed: ParsedHttpRequest): string[] {
  const segments = parsed.path
    .split(/[?#]/, 1)[0]!
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment).trim();
      } catch {
        return segment.trim();
      }
    })
    .filter((segment) => segment !== '');
  const named: string[] = [];
  const read = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > BODY_DEPTH) return;
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === 'string' && inner.trim() !== '' && ISSUE_KEYS.includes(key)) named.push(inner.trim());
      else read(inner, depth + 1);
    }
  };
  read(parsed.bodyJson, 1);
  return [...named, ...segments];
}

/**
 * The external items a write addresses, as a work item's `externalId` names them.
 *
 * A ticket write names its ticket in its arguments, its request body or its
 * path; a chat reply names the message it sits under as intake keys one,
 * `<channel>:<thread>`. A ticket reference is also offered in upper and in
 * lower case, since a tracker accepts `fin-1` for `FIN-1` and a UUID in
 * capitals, and intake stores each name as the provider prints it. A read, a top-level chat post and a
 * write that names no item address nothing another work item could hold.
 *
 * Args:
 *   parsed: The parsed surface action.
 *   surface: The surface it targets.
 *
 * Returns:
 *   The external ids, each once and at most `WRITE_TARGET_LIMIT`; empty when
 *   the action addresses none.
 */
export function writeTargetIds(parsed: ParsedSurfaceAction, surface: { class: string }): string[] {
  if (actionIntent(parsed) !== 'write') return [];
  if (surface.class === 'chat') {
    const [channel, thread] = (messageTarget(parsed) ?? '').split('/');
    return channel && thread ? [`${channel}:${thread}`] : [];
  }
  const references = parsed.kind === 'mcp.call' ? targetIssueReferences(parsed) : httpTicketReferences(parsed);
  return [...new Set(references.flatMap((ref) => [ref, ref.toUpperCase(), ref.toLowerCase()]))].slice(0, WRITE_TARGET_LIMIT);
}

/** The work item holding an external item a write addresses, as the ledger names it. */
export interface WriteClaimHolder {
  /** The external id the write addressed. */
  target: string;
  holderName: string;
  /** Whether the holder is another item of the writing employee. */
  sameEmployee: boolean;
  title: string;
  state: string;
  /** The provider id of the last comment the holder landed on the item. */
  landedComment?: string;
  /**
   * True when the holder was discovered from the item and has not claimed it
   * yet: the item is its work all the same, whichever of the two writes first.
   */
  unclaimed?: boolean;
}

/** How the ledger line of a write withheld for another work item's claim begins. */
export const WITHHELD_BY_CLAIM_PREFIX = "withheld for another work item's claim: ";

/**
 * The ledger line of a write withheld because another work item holds its target.
 *
 * A holder that has not claimed the item yet has landed nothing to cite, so
 * the line says where the write will be made instead: the item has a work
 * item of its own, and with whom.
 *
 * Args:
 *   holder: The holding work item.
 *
 * Returns:
 *   The reason, naming the holder, its state and the comment it landed.
 */
export function withheldByClaimReason(holder: WriteClaimHolder): string {
  const landed = holder.landedComment ? `, which landed comment ${holder.landedComment} on it` : '';
  if (holder.unclaimed) {
    const who = holder.sameEmployee ? 'this employee' : holder.holderName;
    return `${WITHHELD_BY_CLAIM_PREFIX}${holder.target} has its own work item with ${who}, "${holder.title}" (${holder.state})${landed}; ${landed ? 'it is written there' : 'it will be written there'}, and one work item writes an external item, so this write is not sent`;
  }
  const owner = holder.sameEmployee ? "this employee's" : `${holder.holderName}'s`;
  return `${WITHHELD_BY_CLAIM_PREFIX}${holder.target} is held by ${owner} work item "${holder.title}" (${holder.state})${landed}; one work item writes an external item, so this write is not sent`;
}

/**
 * Whether a ledger row is a write withheld for another work item's claim:
 * work that is the holder's to land, not work this run failed to land.
 *
 * Args:
 *   row: A ledger row, possibly absent.
 *
 * Returns:
 *   True for a held row carrying the claim line.
 */
export function withheldByClaim(row: { held?: boolean; reason?: string } | undefined): boolean {
  return row?.held === true && row.reason?.startsWith(WITHHELD_BY_CLAIM_PREFIX) === true;
}
