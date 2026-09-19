import type { SurfaceMode } from '../lib/surface-mode';
import { redactTokenShapes } from '../surfaces/redact';
import {
  ISSUE_KEYS,
  actionIntent,
  isSurfaceTool,
  messageTarget,
  parseSurfaceAction,
  targetIssueReferences,
  type ParsedHttpRequest,
  type ParsedSurfaceAction,
} from '../surfaces/policy';
import { messageTexts } from './evidence-claims';
import { planObligations } from './obligations';
import type { ExecutionPlan, MockAction } from './types';

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

/** The path of a surface reached through a browser, where a write fills a page's fields. */
const BROWSER_DRIVEN = 'browser-driven';
const SECRET_VALUE = /\{\{\s*secret\s*\}\}/;

/**
 * A page field as a claim names it: the label without its case or outer
 * space, so the documented `Pipeline coverage` and an emitted
 * `pipeline coverage` meet on one key.
 *
 * Args:
 *   name: The field's label.
 *
 * Returns:
 *   The external id the field is claimed and looked up under.
 */
export function browserFieldId(name: string): string {
  return name.trim().toLowerCase();
}

/** The `name`s of a `browser_fill_form` argument, or nothing when the form carries the login. */
function formFieldNames(toolArgs: unknown): string[] {
  const fields = (toolArgs as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields)) return [];
  const rows = fields.filter((field): field is Record<string, unknown> => !!field && typeof field === 'object' && !Array.isArray(field));
  if (rows.some((row) => typeof row.value === 'string' && SECRET_VALUE.test(row.value))) return [];
  return rows.flatMap((row) => (typeof row.name === 'string' && row.name.trim() !== '' ? [row.name.trim()] : []));
}

/** The page fields a browser action fills: a form's fields, never the sign-in form's. */
function browserFieldIds(parsed: ParsedSurfaceAction): string[] {
  if (parsed.kind !== 'mcp.call' || parsed.tool !== 'browser_fill_form') return [];
  return [...new Set(formFieldNames(parsed.toolArgs).map(browserFieldId))].slice(0, WRITE_TARGET_LIMIT);
}

/** A page field a browser-driven surface's documentation says is written. */
export interface BrowserWriteTarget {
  surfaceSlug: string;
  /** The field's label as the documentation prints it. */
  field: string;
}

/** The most documented fields one surface is claimed under. */
const DOCUMENTED_FIELD_LIMIT = 8;

/**
 * The fields a browser-driven surface's documentation says are filled.
 *
 * Read from the documented action shapes, never from a plan or a model's
 * wording: every fenced JSON action on the pages that addresses the surface
 * with `browser_fill_form`. The sign-in form is not a write target; it is the
 * one that carries `{{secret}}`.
 *
 * Args:
 *   pages: The loaded documentation.
 *   slug: The browser-driven surface.
 *
 * Returns:
 *   The documented field labels, each once, in the order the pages print them.
 */
export function documentedBrowserFields(pages: ReadonlyArray<{ body: string }>, slug: string): string[] {
  const names = new Map<string, string>();
  for (const page of pages) {
    for (const block of page.body.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
      let shape: unknown;
      try {
        shape = JSON.parse(block[1]!);
      } catch {
        continue;
      }
      const args = (shape as { args?: { surface?: unknown; tool?: unknown; toolArgsJson?: unknown } } | null)?.args;
      if (args?.surface !== slug || args.tool !== 'browser_fill_form' || typeof args.toolArgsJson !== 'string') continue;
      let toolArgs: unknown;
      try {
        toolArgs = JSON.parse(args.toolArgsJson);
      } catch {
        continue;
      }
      for (const name of formFieldNames(toolArgs)) if (!names.has(browserFieldId(name))) names.set(browserFieldId(name), name);
    }
  }
  return [...names.values()].slice(0, DOCUMENTED_FIELD_LIMIT);
}

/**
 * The documented page fields a plan takes as its own to write.
 *
 * On 19 September (second sitting) four work items each ran the whole
 * sign-in, fill, Save sequence on the Looker tile within 92 seconds: a page
 * field has no intake row, so no claim reached it. The item whose approved
 * plan declares an unconditional write to a browser-driven surface takes the
 * surface's documented fields before it authors. A step that writes only if
 * a read says so (an audit that refreshes a stale tile) reads first and takes
 * nothing.
 *
 * Args:
 *   obligations: The approved plan's declared obligations, if it has them.
 *   surfaces: The agent's surfaces.
 *   pages: The loaded documentation.
 *
 * Returns:
 *   The targets to claim; empty when the plan writes no browser-driven surface.
 */
export function plannedWriteTargets(
  obligations: { steps: ReadonlyArray<{ kind: string; writes: readonly string[] }> } | undefined,
  surfaces: ReadonlyArray<{ slug: string; path?: string }>,
  pages: ReadonlyArray<{ body: string }>,
): BrowserWriteTarget[] {
  const written = new Set((obligations?.steps ?? []).filter((step) => step.kind === 'write').flatMap((step) => step.writes));
  return surfaces
    .filter((surface) => surface.path === BROWSER_DRIVEN && written.has(surface.slug))
    .flatMap((surface) => documentedBrowserFields(pages, surface.slug).map((field) => ({ surfaceSlug: surface.slug, field })));
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
export function writeTargetIds(parsed: ParsedSurfaceAction, surface: { class: string; path?: string }): string[] {
  if (actionIntent(parsed) !== 'write') return [];
  if (surface.path === BROWSER_DRIVEN) return browserFieldIds(parsed);
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

/** An external item another work item of the company has, as the executor is told before it authors. */
export interface HeldExternalItem {
  externalId: string;
  /** The item's other name, when the provider prints two. */
  externalAlias?: string;
  /** The holder's surface the item was discovered on. */
  sourceSystem: string;
  holderName: string;
  /** Whether the holder is another item of the authoring employee. */
  sameEmployee: boolean;
  title: string;
  state: string;
  /** The provider id of the last comment the holder landed on the item. */
  landedComment?: string;
  /** True when the holder was discovered from the item and has not claimed it yet. */
  unclaimed?: boolean;
  /** True for a documented page field of a browser-driven surface, which its holder writes and others read. */
  pageField?: boolean;
}

/** The most held items one prompt lists. */
export const HELD_ELSEWHERE_LIMIT = 12;
const HELD_TITLE_CHARS = 120;

/**
 * One row per held item, as the prompt lists them: surface, item, whose work
 * item has it, that work item and its state, and what it has landed.
 *
 * The rows alone are what a reply may cite as evidence; the rule printed
 * beside them in the prompt is an instruction and vouches for nothing. Each
 * row passes the structural redaction the ledger prompt applies.
 *
 * Args:
 *   items: The held items, already scrubbed of the owner's exact values.
 *
 * Returns:
 *   At most `HELD_ELSEWHERE_LIMIT` rows.
 */
export function heldElsewhereRows(items: readonly HeldExternalItem[] | undefined): string[] {
  return (items ?? []).slice(0, HELD_ELSEWHERE_LIMIT).map((item, index): string => {
    const title = item.title.length > HELD_TITLE_CHARS ? `${item.title.slice(0, HELD_TITLE_CHARS)} ...` : item.title;
    const names = item.externalAlias ? `${item.externalId} (also ${item.externalAlias})` : item.externalId;
    const who = item.sameEmployee ? 'this employee' : item.holderName;
    const state = item.unclaimed ? `${item.state}, not claimed yet` : item.state;
    const finished = item.state === 'completed' || item.state === 'failed';
    if (item.pageField) {
      return redactTokenShapes(
        `  ${index}. ${item.sourceSystem} · page field "${item.externalId}" · ${who} · "${title}" (${state}) · ${finished ? 'that work item has run' : 'that work item writes it'}; read the page for its value`,
      );
    }
    const landed = item.landedComment
      ? `landed comment ${item.landedComment}`
      : finished ? 'no comment landed' : 'nothing landed yet';
    return redactTokenShapes(`  ${index}. ${item.sourceSystem} · ${names} · ${who} · "${title}" (${state}) · ${landed}`);
  });
}

/**
 * The prompt section that tells the executor, before it authors, which
 * external items other work items hold and what has landed on them.
 *
 * On 19 September an ask authored its thread reply and a note on FIN-1 in one
 * phase; the apply withholds the note, but a reply written before the apply
 * cannot know that. Told here, the reply says where the note is or will be.
 *
 * Args:
 *   items: The held items, already scrubbed of the owner's exact values.
 *
 * Returns:
 *   Prompt lines, empty when nothing is held elsewhere.
 */
export function heldElsewhereLines(items: readonly HeldExternalItem[] | undefined): string[] {
  if (!items || items.length === 0) return [];
  const rows = heldElsewhereRows(items);
  return [
    '',
    `--- External items other work items hold (${items.length}${items.length > rows.length ? `, first ${rows.length} shown` : ''}) ---`,
    'Each line: surface · item · whose work item has it · that work item and its state · what it has landed on the item. One work item writes an external item.',
    ...rows,
    'Do not author a comment, a state change or a thread reply addressed to an item listed here: it is withheld and never sent. When this work asks for something that belongs on one, say in your reply that the item has its own work item, with whom, and that it will be posted there; when a comment has landed, cite it by its id instead of posting another.',
    ...(items.slice(0, rows.length).some((item) => item.pageField)
      ? ['A page field listed here is filled and saved by its holder alone: a fill or a Save from this work is withheld and never sent. Open the page, sign in and read it (navigate, the sign-in form, the snapshot), and cite the figure and the audit line you read; say in your reply which work item refreshes the field, and never that this work did.']
      : []),
  ];
}

/** A ticket id as a plan step writes one: `FIN-1`, `REVOPS-27`. */
const TICKET_ID = /(?<![A-Za-z0-9-])[A-Za-z][A-Za-z0-9]{1,9}-\d+(?![A-Za-z0-9])/g;

function namesWhole(text: string, name: string): boolean {
  const lower = text.toLowerCase();
  const wanted = name.toLowerCase();
  for (let at = lower.indexOf(wanted); at !== -1; at = lower.indexOf(wanted, at + 1)) {
    const before = at === 0 ? '' : lower[at - 1]!;
    const after = lower[at + wanted.length] ?? '';
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

/**
 * The held item a blocked plan step was left out for, if it was.
 *
 * The held-items block tells the executor not to author a write addressed to
 * an item another work item holds. One that obeys authors nothing and reports
 * the step blocked; the apply guard would have withheld the write had it been
 * authored, so the step is the holder's to land either way. On 19 September
 * (third sitting) the `#finance-close` ask did exactly that and was stopped
 * for it, its thread reply withheld with the rest.
 *
 * A step is a held item's when the step's own words or the executor's
 * evidence name the item whole, by either of its names; the declared
 * obligations, when the plan has them, make the step a write to the surface
 * the item is on; and the step's own words name no other ticket. A page field
 * is never matched here: its name is ordinary words.
 *
 * Args:
 *   outcome: The blocked step's accounting.
 *   plan: The approved plan.
 *   held: The items other work items hold, as the prompt listed them.
 *
 * Returns:
 *   The held item, or undefined when the step was blocked for another reason.
 */
export function heldItemOfBlockedStep(
  outcome: { step: number; evidence: string },
  plan: Pick<ExecutionPlan, 'steps' | 'obligations'>,
  held: readonly HeldExternalItem[] | undefined,
): HeldExternalItem | undefined {
  if (!held || held.length === 0) return undefined;
  const words = plan.steps[outcome.step - 1];
  if (words === undefined) return undefined;
  const declared = planObligations(plan)?.steps[outcome.step - 1];
  if (declared && declared.kind !== 'write' && declared.kind !== 'conditional-write') return undefined;
  return held.find((item): boolean => {
    if (item.pageField) return false;
    const names = [item.externalId, ...(item.externalAlias ? [item.externalAlias] : [])];
    if (declared && !(declared.writes ?? []).some((slug) => slug.toLowerCase() === item.sourceSystem.toLowerCase())) {
      return false;
    }
    const tickets = words.match(TICKET_ID) ?? [];
    if (tickets.length > 0 && !tickets.some((ticket) => names.some((name) => name.toLowerCase() === ticket.toLowerCase()))) {
      return false;
    }
    return names.some((name) => namesWhole(words, name) || namesWhole(outcome.evidence, name));
  });
}

/** A set whose reply does not say where a write it makes to a held item is, or will be. */
export interface HeldItemReplyFinding {
  item: HeldExternalItem;
  /** The line the executor is sent back with. */
  issue: string;
  /** The sentence added to the reply when the executor still does not say it. */
  sentence: string;
}

function parsedOn(
  action: MockAction,
  surfaces: ReadonlyArray<{ slug: string; class: string; path?: string }>,
): { parsed: ParsedSurfaceAction; surface: { slug: string; class: string; path?: string } } | undefined {
  if (!isSurfaceTool(action.tool)) return undefined;
  const result = parseSurfaceAction(action);
  if (!result.ok) return undefined;
  const surface = surfaces.find((row) => row.slug === result.action.surface);
  return surface ? { parsed: result.action, surface } : undefined;
}

/** The chat messages of a set that are sent: a reply into a thread another item holds is not. */
function sentMessages(
  actions: readonly MockAction[],
  held: readonly HeldExternalItem[],
  surfaces: ReadonlyArray<{ slug: string; class: string; path?: string }>,
): number[] {
  const heldNames = new Set(held.flatMap((item) => [item.externalId, item.externalAlias ?? item.externalId]));
  return actions.flatMap((action, index): number[] => {
    const on = parsedOn(action, surfaces);
    if (!on || on.surface.class !== 'chat' || actionIntent(on.parsed) !== 'write') return [];
    return writeTargetIds(on.parsed, on.surface).some((target) => heldNames.has(target)) ? [] : [index];
  });
}

/**
 * The held items a set writes to without its reply saying where that work is.
 *
 * On 19 September (second sitting) the `#finance-close` ask was told FIN-1 had
 * its own work item and still authored the note on FIN-1 beside its thread
 * reply, as its approved plan said to. The apply withheld the note, and the
 * reply was the status lines alone: the person who asked was told nothing of
 * where the note would be. The rule in the prompt is advice; this is the check
 * behind it. A set that writes a ticket another work item holds, and sends a
 * chat message, owes that message the item's name with either the words
 * `work item` or the id of the comment the holder landed.
 *
 * Args:
 *   actions: The set as the executor authored it.
 *   held: The items other work items hold, as the prompt listed them.
 *   surfaces: The agent's surfaces, for the class of each one addressed.
 *   alreadyOwed: Held items an earlier response of this phase wrote to. A
 *     repaired set that drops the write still owes the reply where the work is.
 *
 * Returns:
 *   One finding per held item the set writes to and no sent message accounts for.
 */
export function heldItemReplyFindings(
  actions: readonly MockAction[],
  held: readonly HeldExternalItem[] | undefined,
  surfaces: ReadonlyArray<{ slug: string; class: string; path?: string }>,
  alreadyOwed: readonly HeldExternalItem[] = [],
): HeldItemReplyFinding[] {
  if (!held || held.length === 0) return [];
  const messages = sentMessages(actions, held, surfaces).flatMap((index) => messageTexts(actions[index]!));
  if (messages.length === 0) return [];
  const written = new Set<string>();
  for (const action of actions) {
    const on = parsedOn(action, surfaces);
    if (!on || on.surface.class === 'chat') continue;
    for (const target of writeTargetIds(on.parsed, on.surface)) written.add(target.toLowerCase());
  }
  return held.slice(0, HELD_ELSEWHERE_LIMIT).flatMap((item): HeldItemReplyFinding[] => {
    const names = [item.externalId, ...(item.externalAlias ? [item.externalAlias] : [])].map((name) => name.toLowerCase());
    if (!alreadyOwed.includes(item) && !names.some((name) => written.has(name))) return [];
    const said = messages.some((text) => {
      const lower = text.toLowerCase();
      if (!names.some((name) => lower.includes(name))) return false;
      return lower.includes('work item') || (item.landedComment !== undefined && lower.includes(item.landedComment.toLowerCase()));
    });
    if (said) return [];
    const who = item.sameEmployee ? 'this employee' : item.holderName;
    const title = item.title.length > HELD_TITLE_CHARS ? `${item.title.slice(0, HELD_TITLE_CHARS)} ...` : item.title;
    if (item.pageField) {
      const field = `"${item.externalId}" on ${item.sourceSystem}`;
      return [{
        item,
        issue: redactTokenShapes(
          `this set fills ${field}, and the reply does not say whose work that is: the field is written by the work item of ${who}, "${title}" (${item.state}), so a fill or a Save from here is withheld and never sent. Read the page and cite what you read; in the chat reply, name "${item.externalId}" and say its own work item refreshes it; never say this work refreshed it.`,
        ),
        sentence: redactTokenShapes(
          `${item.externalId} on ${item.sourceSystem} is refreshed by its own work item${item.sameEmployee ? '' : ` with ${item.holderName}`} ("${title}"); it was not written from this request.`,
        ),
      }];
    }
    const where = item.landedComment
      ? `cite comment ${item.landedComment}, which that work item landed on ${item.externalId}, instead of reporting a note of your own`
      : `say that ${item.externalId} has its own work item and that what was asked for will be posted there`;
    return [{
      item,
      issue: redactTokenShapes(
        `this set writes to ${item.externalId}, and the reply does not say where it is: ${item.externalId} has its own work item with ${who}, "${title}" (${item.state}), so a write to it from here is withheld and never sent. In the chat reply, ${where}; never say this work posted it.`,
      ),
      sentence: redactTokenShapes(
        `${item.externalId} has its own work item${item.sameEmployee ? '' : ` with ${item.holderName}`} ("${title}"); ${
          item.landedComment
            ? `it is posted there as comment ${item.landedComment}.`
            : `what this request asked for on ${item.externalId} will be posted there.`
        }`,
      ),
    }];
  });
}

function withMessageAppended(action: MockAction, sentence: string): MockAction | undefined {
  const [text] = messageTexts(action);
  const payload = action.tool === 'http.request' ? action.args?.body : action.args?.toolArgsJson;
  if (text === undefined || typeof payload !== 'string') return undefined;
  let record: unknown;
  try {
    record = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const entry = Object.entries(record).find(([, value]) => value === text);
  if (!entry) return undefined;
  const next = JSON.stringify({ ...record, [entry[0]]: `${text}\n\n${sentence}` });
  return { ...action, args: { ...action.args, ...(action.tool === 'http.request' ? { body: next } : { toolArgsJson: next }) } };
}

/**
 * Say where the work is, in the reply itself, for an executor that was sent
 * back once and still does not. The sentences are Day0's, built from the
 * holding work items' rows, and are added to the message that answers the
 * work item's own thread when the set has one, else to its first message.
 *
 * Args:
 *   actions: The set after its one repair.
 *   findings: What `heldItemReplyFindings` still finds in it.
 *   surfaces: The agent's surfaces.
 *   replyTarget: The thread the work item answers, when it came from chat.
 *
 * Returns:
 *   The set with the sentences added, or unchanged when no message can carry them.
 */
export function withHeldItemsSaid(
  actions: readonly MockAction[],
  findings: readonly HeldItemReplyFinding[],
  surfaces: ReadonlyArray<{ slug: string; class: string; path?: string }>,
  replyTarget?: { channel: string; threadTs?: string },
): MockAction[] {
  if (findings.length === 0) return [...actions];
  const candidates = sentMessages(actions, findings.map((finding) => finding.item), surfaces);
  const thread = replyTarget?.threadTs ? `${replyTarget.channel}/${replyTarget.threadTs}` : undefined;
  const ordered = [
    ...candidates.filter((index) => {
      const on = parsedOn(actions[index]!, surfaces);
      return thread !== undefined && on !== undefined && messageTarget(on.parsed) === thread;
    }),
    ...candidates,
  ];
  const sentence = findings.map((finding) => finding.sentence).join(' ');
  for (const index of ordered) {
    const appended = withMessageAppended(actions[index]!, sentence);
    if (appended) return actions.map((action, at) => (at === index ? appended : action));
  }
  return [...actions];
}
