/**
 * The browser floor: what it may drive, and where it may drive it.
 *
 * A `browser-driven` surface is one whose documentation records a web UI and
 * nothing else - no MCP server, no API. It is the floor of the ladder, and it
 * is the one path where the transport and the target are different addresses:
 * the surface's endpoint is the system's own page, taken from the docs, while
 * the driver is Day0's own browser service, configured like the bundled
 * documentation reader rather than discovered. Keeping the documented address
 * on the row matters - it is the evidence the orientation run cited, and the
 * driver must never be able to rewrite it.
 *
 * Two boundaries apply, and they are different from each other. The tool
 * allowlist decides what the browser may *do*; the origin bound decides where
 * it may *go*. Either alone is insufficient: navigation is a legitimate tool,
 * so without the origin bound an approved surface would authorise browsing
 * anywhere the container can reach.
 */

/**
 * The bundled browser driver's address on the compose network.
 *
 * This is the value to put in `DAY0_BROWSER_MCP_URL` when running the `browser`
 * profile, not a fallback applied when the variable is unset: an unset variable
 * means this deployment has no browser component. See `browserComponent`.
 */
export const DEFAULT_BROWSER_MCP_URL = 'http://playwright-mcp:8931/mcp';

/**
 * Tools the floor may use, whatever else the driver exposes.
 *
 * Enough to read a page and to complete a form a person would complete: the
 * work item this exists for is "refresh the tile", which is a write. What is
 * deliberately absent is everything that turns a browser into a general
 * runtime or a file mover - `browser_evaluate`, `browser_run_code_unsafe`,
 * `browser_file_upload`, `browser_tabs`, `browser_network_requests`,
 * `browser_take_screenshot`. Playwright MCP has no read-only flag of its own
 * (upstream issue #885), so this list is the enforcement.
 */
export const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
] as const;

/** Tools whose arguments name a destination the origin bound applies to. */
const NAVIGATING_TOOLS = new Set(['browser_navigate']);

/**
 * Tools that address an element on the page rather than the page itself.
 *
 * The driver addresses elements by a `ref` it mints in a snapshot, and a ref is
 * only meaningful for the snapshot it came from. A skill emits its whole action
 * list before any of it runs, so it cannot know one - it names the element the
 * way the runbook does ("Save"), and the adapter resolves that against a
 * snapshot taken at the moment the action is applied.
 */
const ELEMENT_TOOLS = new Set(['browser_click', 'browser_type', 'browser_hover']);

/** Tools whose arguments carry a list of fields, each addressing an element. */
const FORM_TOOLS = new Set(['browser_fill_form']);

export interface SnapshotElement {
  name: string;
  ref: string;
  role: string;
}

/** Role words a description may carry that are not part of the element's name. */
const ROLE_WORDS =
  /\b(button|textbox|field|input|link|checkbox|combobox|box|control|element)\b/gi;

/**
 * Read the addressable elements out of one driver snapshot.
 *
 * The driver renders an accessibility tree as indented YAML-ish lines, each
 * ending in the ref it will accept back:
 *
 *     - textbox "Username" [ref=e11]
 *     - button "Sign in" [ref=e15] [cursor=pointer]
 *
 * Args:
 *   snapshot: The text a `browser_snapshot` call returned.
 *
 * Returns:
 *   Every named element the snapshot offers, in document order.
 */
export function parseSnapshotRefs(snapshot: string): SnapshotElement[] {
  const elements: SnapshotElement[] = [];
  for (const line of snapshot.split(/\r?\n/)) {
    // The ref is found on its own rather than in sequence with the name,
    // because the driver puts other attributes in between as it sees fit
    // (`heading "Sign in" [level=1] [ref=e7]`).
    const ref = /\[ref=([^\]]+)\]/.exec(line);
    if (!ref) continue;
    const named = /^\s*-\s+([a-z]+)\s+"([^"]*)"/i.exec(line);
    if (named) {
      elements.push({ name: named[2].trim(), ref: ref[1], role: named[1].toLowerCase() });
      continue;
    }
    // An unnamed node whose text follows the ref, e.g. `- generic [ref=e5]: Looker`.
    const labelled = /^\s*-\s+([a-z]+)\b[^:]*:\s*(.+)$/i.exec(line);
    if (labelled) {
      elements.push({
        name: labelled[2].trim(),
        ref: ref[1],
        role: labelled[1].toLowerCase(),
      });
    }
  }
  return elements;
}

/**
 * Roles a person can actually act on.
 *
 * A page routinely gives a field and its label the same accessible name, so a
 * skill writing "Username" would otherwise be ambiguous between the two. It is
 * not ambiguous to a person: they mean the thing you can type in.
 */
const INTERACTIVE_ROLES = new Set([
  'textbox',
  'button',
  'link',
  'checkbox',
  'combobox',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'option',
  'menuitem',
]);

/** Narrow a set of equally-matching elements to the one that can be acted on. */
function preferInteractive(candidates: readonly SnapshotElement[]): SnapshotElement | undefined {
  if (candidates.length === 1) return candidates[0];
  const interactive = candidates.filter((element: SnapshotElement): boolean =>
    INTERACTIVE_ROLES.has(element.role),
  );
  return interactive.length === 1 ? interactive[0] : undefined;
}

function normaliseDescription(value: string): string {
  return value.replace(ROLE_WORDS, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Find the element a human description names in a snapshot.
 *
 * Exact accessible name first, then the description with role words removed,
 * then containment either way - a skill writing "Save" for a button labelled
 * "Save" and a skill writing "Save button" both have to land, and neither may
 * be allowed to match two different controls silently.
 *
 * Args:
 *   snapshot: The text a `browser_snapshot` call returned.
 *   description: What the action called the element.
 *
 * Returns:
 *   The matching element, or undefined when none matches unambiguously.
 */
export function resolveElementRef(
  snapshot: string,
  description: string,
): SnapshotElement | undefined {
  const elements = parseSnapshotRefs(snapshot).filter(
    (element: SnapshotElement): boolean => element.name !== '',
  );
  const wanted = description.trim().toLowerCase();
  if (!wanted) return undefined;
  const loose = normaliseDescription(description);

  const exact = preferInteractive(
    elements.filter((e: SnapshotElement): boolean => e.name.toLowerCase() === wanted),
  );
  if (exact) return exact;
  const normalised = preferInteractive(
    elements.filter((e: SnapshotElement): boolean => normaliseDescription(e.name) === loose),
  );
  if (normalised) return normalised;
  return preferInteractive(
    elements.filter((e: SnapshotElement): boolean => {
      const name = normaliseDescription(e.name);
      return name !== '' && loose !== '' && (name.includes(loose) || loose.includes(name));
    }),
  );
}

/** Whether this tool needs an element reference the skill cannot know. */
export function needsElementRef(tool: string): boolean {
  return ELEMENT_TOOLS.has(tool) || FORM_TOOLS.has(tool);
}

/** The descriptions one action needs resolved, in the order they appear. */
export function elementDescriptions(tool: string, toolArgs: Record<string, unknown>): string[] {
  if (ELEMENT_TOOLS.has(tool)) {
    const element = toolArgs.element;
    return typeof element === 'string' && element.trim() !== '' ? [element] : [];
  }
  if (!FORM_TOOLS.has(tool)) return [];
  const fields = Array.isArray(toolArgs.fields) ? toolArgs.fields : [];
  return fields.map((field: unknown): string => {
    const record = field && typeof field === 'object' ? (field as Record<string, unknown>) : {};
    const name = record.name ?? record.element;
    return typeof name === 'string' ? name : '';
  });
}

/** The field name a driver takes an element reference in. */
export type RefField = 'target' | 'ref';

/**
 * The field the driver's own schema says a reference goes in.
 *
 * The bundled driver takes it as `target` and refuses unknown properties, so
 * guessing is not survivable. The probe already stores each tool's argument
 * names from the live schema, so the answer is read from there rather than
 * assumed, and `target` is the fallback because it is what the pinned driver
 * documents.
 *
 * Args:
 *   argumentNames: The argument names the probe discovered for this tool.
 *
 * Returns:
 *   The field to put the reference in.
 */
export function refFieldFor(argumentNames: readonly string[] | undefined): RefField {
  if (argumentNames?.includes('target')) return 'target';
  if (argumentNames?.includes('ref')) return 'ref';
  return 'target';
}

/** Field types the driver's form tool accepts; anything else is a textbox. */
const FIELD_TYPES = new Set(['textbox', 'checkbox', 'radio', 'combobox', 'slider']);

/**
 * Put resolved references into one action's arguments.
 *
 * Only known properties are written: the driver's schemas set
 * `additionalProperties: false`, so an extra key is a validation failure
 * rather than something it ignores.
 *
 * Args:
 *   tool: The browser tool being called.
 *   toolArgs: Its arguments as the skill supplied them.
 *   refs: A resolved element per description, in the same order.
 *   refField: The field the driver takes a reference in.
 *
 * Returns:
 *   The arguments the driver will accept.
 */
export function withResolvedRefs(
  tool: string,
  toolArgs: Record<string, unknown>,
  refs: readonly SnapshotElement[],
  refField: RefField = 'target',
): Record<string, unknown> {
  if (ELEMENT_TOOLS.has(tool)) {
    const found = refs[0];
    if (!found) return toolArgs;
    return {
      ...toolArgs,
      [refField]: found.ref,
      element: String(toolArgs.element ?? found.name),
    };
  }
  if (!FORM_TOOLS.has(tool)) return toolArgs;
  const fields = Array.isArray(toolArgs.fields) ? toolArgs.fields : [];
  return {
    ...toolArgs,
    fields: fields.map((field: unknown, index: number): unknown => {
      const record = field && typeof field === 'object' ? (field as Record<string, unknown>) : {};
      const found = refs[index];
      if (!found) return record;
      const declared = typeof record.type === 'string' ? record.type : undefined;
      const type =
        declared && FIELD_TYPES.has(declared)
          ? declared
          : FIELD_TYPES.has(found.role)
            ? found.role
            : 'textbox';
      return {
        ...record,
        [refField]: found.ref,
        name: String(record.name ?? found.name),
        type,
      };
    }),
  };
}

export class BrowserBoundError extends Error {}

/**
 * The one code every path uses when the browser component is not there.
 *
 * The floor is an optional component, and an enterprise whose systems all have
 * APIs never starts it. That is a complete installation, not a broken one, so
 * every path that meets its absence says the same short thing: a code the
 * executor, the probe and intake can all record, and a sentence a human can
 * act on. What it must never be is a stack trace out of a fetch that could not
 * resolve a compose service name.
 */
export const BROWSER_DRIVER_ABSENT = 'BROWSER_DRIVER_ABSENT';

/** What to do about it, in the words the running instructions use. */
export const BROWSER_COMPONENT_ABSENT =
  "day0's browser component is not running - add `--profile browser` (see running instructions)";

/** The card's sentence: why this system needs the component, then what to do. */
export const BROWSER_COMPONENT_CARD_MESSAGE =
  `This system is reached through its web UI. ${BROWSER_COMPONENT_ABSENT}`;

/** The refusal an action, a probe or an intake sweep records. */
export const BROWSER_DRIVER_ABSENT_REASON = `${BROWSER_DRIVER_ABSENT}: ${BROWSER_COMPONENT_ABSENT}`;

/** Either the driver this deployment drives, or why there is none. */
export type BrowserComponent =
  | { present: true; url: URL }
  | { present: false; code: typeof BROWSER_DRIVER_ABSENT; reason: string };

/**
 * The browser driver this deployment uses, or the fact that it has none.
 *
 * `DAY0_BROWSER_MCP_URL` is both the switch and the address. Unset means this
 * deployment has no browser component - not "use the bundled one and find out
 * later", which is what an implicit default meant and why the component looked
 * mandatory. The compose address is still the value to set (and what
 * `.env.example` ships), so turning the component on is one line beside
 * `--profile browser`.
 *
 * Reading the switch rather than the socket is also what lets the card answer
 * before anything is probed: a Convex query can read an environment variable
 * and cannot open a connection. Reachability is a separate question, answered
 * where a connection is actually made - see `isDriverUnreachable`.
 *
 * Args:
 *   configured: The value of `DAY0_BROWSER_MCP_URL`, if set.
 *
 * Returns:
 *   The driver endpoint, or the absence and its reason.
 *
 * Raises:
 *   BrowserBoundError: If a configured value is not an http(s) URL. A typo is
 *     not an absent component and must not be reported as one. The scheme is
 *     checked because `new URL` accepts `playwright-mcp:8931` as a URL with a
 *     scheme of its own, which would reach nothing and say nothing useful.
 */
export function browserComponent(configured: string | undefined): BrowserComponent {
  const raw = (configured ?? '').trim();
  if (!raw) {
    return { present: false, code: BROWSER_DRIVER_ABSENT, reason: BROWSER_DRIVER_ABSENT_REASON };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrowserBoundError('DAY0_BROWSER_MCP_URL is not a URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserBoundError('DAY0_BROWSER_MCP_URL must be an http or https URL.');
  }
  return { present: true, url: parsed };
}

/**
 * What the Surfaces card should say about this deployment's browser component.
 *
 * The card is the one place a human meets the absence before anything has been
 * probed, so it answers from the switch (`componentPresent`, read by a query)
 * and from the last thing a probe recorded (`reason`, which carries the code
 * when a configured driver turned out not to be listening). Either is enough:
 * approving a path day0 cannot drive is a decision the operator would have to
 * take back.
 *
 * Args:
 *   input: The surface's approved path, whether the component is configured,
 *     and the reason its last probe recorded.
 *
 * Returns:
 *   The sentence to show and whether approval should be withheld.
 */
export function presentBrowserComponent(input: {
  componentPresent: boolean;
  path?: string;
  reason?: string;
}): { absent: boolean; message?: string } {
  if (input.path !== 'browser-driven') return { absent: false };
  const absent = !input.componentPresent || (input.reason ?? '').includes(BROWSER_DRIVER_ABSENT);
  return absent ? { absent, message: BROWSER_COMPONENT_CARD_MESSAGE } : { absent: false };
}

/** Connection failures a driver that is not running produces, whatever the client. */
const UNREACHABLE_MARKERS = [
  'econnrefused',
  'enotfound',
  'eai_again',
  'ehostunreach',
  'enetunreach',
  'etimedout',
  'econnreset',
  'fetch failed',
  'failed to fetch',
  'connection refused',
  'socket hang up',
  'network error',
  'getaddrinfo',
];

/**
 * Decide whether a client failure means the driver is not there.
 *
 * The configured half of the question is answered by `browserComponent`; this
 * is the other half, and it can only be asked of a failure that has already
 * happened. A stopped container and an unresolvable compose name both arrive
 * as a transport error rather than an MCP one, so the two are reported as the
 * same absence. A driver that answers and refuses is a different failure and
 * keeps its own message.
 *
 * Args:
 *   error: The failure a driver call raised.
 *
 * Returns:
 *   Whether it reads as "nothing is listening there".
 */
export function isDriverUnreachable(error: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (!(current instanceof Error)) break;
    parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(code);
    current = current.cause;
  }
  const text = parts.join(' ').toLowerCase();
  return UNREACHABLE_MARKERS.some((marker: string): boolean => text.includes(marker));
}

/**
 * Decide whether a destination is inside the surface the human approved.
 *
 * Same origin, and the documented path is a prefix: a surface approved for
 * `http://host:8080/dashboards/7` does not authorise `http://host:8080/admin`.
 * A documented address ending in `/` is treated as the whole site under it,
 * which is what a bare dashboard root means.
 *
 * Args:
 *   destination: The URL the action asks the browser to open.
 *   documented: The surface's endpoint as the orientation run recorded it.
 *
 * Returns:
 *   Whether the browser may go there.
 */
export function withinDocumentedSurface(destination: string, documented: string): boolean {
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(destination);
    allowed = new URL(documented);
  } catch {
    return false;
  }
  if (target.origin !== allowed.origin) return false;
  const base = allowed.pathname.endsWith('/') ? allowed.pathname : `${allowed.pathname}/`;
  return target.pathname === allowed.pathname || `${target.pathname}/`.startsWith(base);
}

/**
 * Refuse a browser action that would leave the approved surface.
 *
 * Args:
 *   tool: The browser tool being called.
 *   toolArgs: Its arguments, as the skill supplied them.
 *   documented: The surface's documented endpoint.
 *
 * Returns:
 *   A refusal reason, or undefined when the action stays inside the surface.
 */
export function navigationRefusal(
  tool: string,
  toolArgs: Record<string, unknown>,
  documented: string | undefined,
): string | undefined {
  if (!NAVIGATING_TOOLS.has(tool)) return undefined;
  if (!documented) return 'the surface has no documented address to browse';
  const destination = toolArgs.url;
  if (typeof destination !== 'string' || destination.trim() === '') {
    return 'browser_navigate was given no url';
  }
  if (!withinDocumentedSurface(destination, documented)) {
    return `navigation outside the approved surface (${documented})`;
  }
  return undefined;
}

/** Read the final page address Playwright reports after a navigation. */
export function browserPageUrl(result: string): string | undefined {
  const match = /^\s*-\s*Page URL:\s*(\S.*?)\s*$/im.exec(result);
  return match?.[1]?.trim() || undefined;
}

/** Read the final page title Playwright reports after a navigation. */
export function browserPageTitle(result: string): string | undefined {
  const match = /^\s*-\s*Page Title:\s*(.*?)\s*$/im.exec(result);
  return match?.[1]?.trim() || undefined;
}

/** Read an explicit page-title liveness marker from the linked runbook. */
export function browserTitleMarker(markdown: string): string | undefined {
  const match = /\bProbe marker:\s*page title\s+`([^`\r\n]+)`/i.exec(markdown);
  return match?.[1]?.trim() || undefined;
}

/**
 * Re-apply the origin bound to where a navigation actually landed.
 *
 * A permitted address can redirect to a different host. The requested URL is
 * therefore only the first half of the check; the driver's final Page URL is
 * authoritative for the second half.
 */
export function navigationResultRefusal(
  tool: string,
  result: string,
  documented: string | undefined,
): string | undefined {
  if (!NAVIGATING_TOOLS.has(tool)) return undefined;
  if (!documented) return 'the surface has no documented address to browse';
  const landed = browserPageUrl(result);
  if (!landed) return 'the browser driver reported no final page URL';
  if (!withinDocumentedSurface(landed, documented)) {
    return `the page redirected outside the approved surface (${documented})`;
  }
  return undefined;
}
