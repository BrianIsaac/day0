import { isTransportUnreachable } from '../lib/transport-error';
import type { ActionIntent } from './policy';
import { injectSecret } from './secrets';

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
 * work item this exists for is "refresh the tile", which is a write. A page
 * that renders after the call returns is waited for (`browser_wait_for`, a
 * read), and a confirmation the page raises is answered
 * (`browser_handle_dialog`, a write: accepting "Delete this?" is the delete).
 * What is deliberately absent is everything that turns a browser into a
 * general runtime or a file mover - `browser_evaluate`,
 * `browser_run_code_unsafe`, `browser_file_upload`, `browser_tabs`,
 * `browser_network_requests`, `browser_take_screenshot`. Playwright MCP has no
 * read-only flag of its own (upstream issue #885), so this list is the
 * enforcement.
 */
export const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_wait_for',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_handle_dialog',
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
const ROLE_WORDS = /\b(button|textbox|field|input|link|checkbox|combobox|box|control|element)\b/gi;

/**
 * The attributes the driver prints after a node's role or name, in whatever
 * order it sees fit: `[level=1] [ref=e7] [cursor=pointer]`.
 */
const SNAPSHOT_ATTRIBUTES = '((?:[ \\t]*\\[[^\\]\\n]*\\])*)';
/** A named node, `- button "Sign in" [ref=e15]`; the name may carry escaped quotes. */
const NAMED_NODE = new RegExp(
  `^\\s*-\\s+([a-z]+)\\s+"((?:[^"\\\\]|\\\\.)*)"${SNAPSHOT_ATTRIBUTES}`,
  'i',
);
/** An unnamed node whose text follows its attributes, `- generic [ref=e5]: Looker`. */
const LABELLED_NODE = new RegExp(
  `^\\s*-\\s+([a-z]+)${SNAPSHOT_ATTRIBUTES}[ \\t]*:[ \\t]*(.+)$`,
  'i',
);
const REF_ATTRIBUTE = /\[ref=([^\]]+)\]/;

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
    // The ref is read only from the driver's attributes after the role or
    // the quoted name, never from the name or the text a node carries: an
    // element named "Q3 plan [ref=e7]" is page content, and its own ref is
    // the one the driver printed after it.
    const named = NAMED_NODE.exec(line);
    if (named) {
      const ref = REF_ATTRIBUTE.exec(named[3]);
      if (ref) {
        elements.push({
          name: named[2].replace(/\\(.)/g, '$1').trim(),
          ref: ref[1],
          role: named[1].toLowerCase(),
        });
      }
      continue;
    }
    const labelled = LABELLED_NODE.exec(line);
    const ref = labelled ? REF_ATTRIBUTE.exec(labelled[2]) : null;
    if (labelled && ref) {
      elements.push({ name: labelled[3].trim(), ref: ref[1], role: labelled[1].toLowerCase() });
    }
  }
  return elements;
}

/**
 * Roles a person can actually act on: the ARIA widget roles a click or a
 * keystroke reaches.
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
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'gridcell',
]);

/**
 * Narrow a set of equally-matching elements to the one the action means.
 *
 * A write acts on a control, so only an element a person can act on answers
 * it: after a redesign relabels a sign-in button, the heading that still says
 * "Sign in" is not the button, and clicking it would report a sign-in that
 * never happened. A read may name anything on the page, so a lone element of
 * any role answers it.
 */
function preferInteractive(
  candidates: readonly SnapshotElement[],
  intent: ActionIntent,
): SnapshotElement | undefined {
  const interactive = candidates.filter((element: SnapshotElement): boolean =>
    INTERACTIVE_ROLES.has(element.role),
  );
  if (interactive.length === 1) return interactive[0];
  return intent === 'read' && interactive.length === 0 && candidates.length === 1
    ? candidates[0]
    : undefined;
}

function normaliseDescription(value: string): string {
  return value.replace(ROLE_WORDS, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function words(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter((word: string): boolean => word !== '');
}

/** Whether `inner`'s words appear, whole and in order, inside `outer`'s. */
function containsWords(outer: string, inner: string): boolean {
  const haystack = words(outer);
  const needle = words(inner);
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (
      needle.every((word: string, offset: number): boolean => haystack[start + offset] === word)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find the element a human description names in a snapshot.
 *
 * Exact accessible name first, then the description with role words removed,
 * then containment either way - a skill writing "Save" for a button labelled
 * "Save" and a skill writing "Save button" both have to land, and neither may
 * be allowed to match two different controls silently.
 *
 * Containment compares whole words. Where the element's name is the shorter
 * of the two, only an element a person can act on is admitted: a page's
 * brand mark named "L" is not "Pipeline coverage", and a lone label inside a
 * longer description is not the control the description means.
 *
 * A write resolves only to an interactive element, at every tier; a read may
 * resolve to a lone element of any role.
 *
 * @param snapshot - The text a `browser_snapshot` call returned.
 * @param description - What the action called the element.
 * @param intent - Whether the action reads or writes; a caller that does not
 *   say is held to the write rule.
 * @returns The matching element, or undefined when none matches unambiguously.
 */
export function resolveElementRef(
  snapshot: string,
  description: string,
  intent: ActionIntent = 'write',
): SnapshotElement | undefined {
  const elements = parseSnapshotRefs(snapshot).filter(
    (element: SnapshotElement): boolean => element.name !== '',
  );
  const wanted = description.trim().toLowerCase();
  if (!wanted) return undefined;
  const loose = normaliseDescription(description);
  const canUseShortName = (element: SnapshotElement): boolean =>
    INTERACTIVE_ROLES.has(element.role) || words(element.name).length >= words(description).length;

  const exact = preferInteractive(
    elements.filter((e: SnapshotElement): boolean => e.name.toLowerCase() === wanted),
    intent,
  );
  if (exact) return exact;
  const normalised = preferInteractive(
    elements.filter(
      (e: SnapshotElement): boolean => normaliseDescription(e.name) === loose && canUseShortName(e),
    ),
    intent,
  );
  if (normalised) return normalised;
  return preferInteractive(
    elements.filter((e: SnapshotElement): boolean => {
      const name = normaliseDescription(e.name);
      if (name === '' || loose === '') return false;
      return (
        (canUseShortName(e) && containsWords(name, loose)) ||
        (INTERACTIVE_ROLES.has(e.role) && containsWords(loose, name))
      );
    }),
    intent,
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

/** `{{secret}}`, or its qualified form `{{secret:<slug>}}`. */
const SECRET_PLACEHOLDER = /\{\{\s*secret(?:[:.][A-Za-z0-9_-]+)?\s*\}\}/;

/**
 * The names a login form gives the field the credential is typed into.
 *
 * A user name or e-mail box is not one: it shows what is typed into it, so the
 * credential would sit on the page in clear text. The accessibility snapshot
 * does not say an input is `type=password`, so the field's name is what marks
 * it, and `credentialSlots` also requires the page to offer a text box. The
 * sign-in replay and the probe read the same names, so a fill the apply would
 * refuse is never taken for a sign-in.
 */
export const CREDENTIAL_FIELD = /^(?:password|passcode|access code|secret|api key|token)$/i;

/** The names a login form gives the field the account is named in, beside the credential. */
export const LOGIN_NAME_FIELD = /^(?:user ?name|e-?mail(?: address)?)$/i;

/** Whether any string anywhere in a tool-argument tree names the credential. */
export function carriesSecretPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return SECRET_PLACEHOLDER.test(value);
  if (Array.isArray(value)) return value.some(carriesSecretPlaceholder);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(carriesSecretPlaceholder);
  }
  return false;
}

/** Any `{{...}}` placeholder, capturing what it names. */
const ANY_PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** What a placeholder of the `{{secret}}` family names, bare or qualified. */
const SECRET_NAME = /^secret(?:[:.][A-Za-z0-9_-]+)?$/;

/** The first placeholder outside the `{{secret}}` family in an argument tree, with its dotted path. */
function firstUnknownPlaceholder(
  value: unknown,
  path: string,
): { path: string; name: string } | undefined {
  if (typeof value === 'string') {
    for (const match of value.matchAll(ANY_PLACEHOLDER)) {
      if (!SECRET_NAME.test(match[1])) return { path, name: match[1] };
    }
    return undefined;
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((entry: unknown, index: number): [string, unknown] => [String(index), entry])
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>)
      : [];
  for (const [key, entry] of entries) {
    const found = firstUnknownPlaceholder(entry, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return undefined;
}

/**
 * Why a tool call may not be sent because an argument still carries a
 * placeholder other than `{{secret}}`, or undefined when none does.
 *
 * Only the credential is ever substituted, and only where a credential field
 * takes it. A model that wrote `{{figure}}` meant a value it did not fill in,
 * and posting the braces would put a half-written message in front of a
 * colleague, so the MCP and browser rungs refuse it as the HTTP rung does.
 *
 * @param toolArgs - The tool's arguments as the skill emitted them.
 */
export function unknownPlaceholderRefusal(toolArgs: unknown): string | undefined {
  const found = firstUnknownPlaceholder(toolArgs, '');
  if (!found) return undefined;
  return `unknown placeholder {{${found.name}}} in ${found.path || 'the arguments'}: a value was left unfilled, so the call was not sent`;
}

/**
 * Whether a field or element description names a credential field, role words
 * aside: "Password field" and "Password" are the same field.
 */
export function isCredentialField(description: unknown): boolean {
  return (
    typeof description === 'string' && CREDENTIAL_FIELD.test(normaliseDescription(description))
  );
}

/** The names a login form gives the control that submits it. */
export const SIGN_IN_CONTROL = /^(?:sign[ -]?in|log[ -]?(?:in|on))$/i;

/** The name a two-page login gives the control between the account and the credential. */
export const NEXT_CONTROL = /^next$/i;

/**
 * The names of the controls a login ends on before the page a run opens: a
 * cookie banner, a "stay signed in" question, a notice to dismiss, a
 * continue. A click on one of these changes nothing on the system, so a
 * session restore may repeat it; a click on anything else is the run's own
 * work and is never sent again without a fresh approval. A bare "Yes", "OK"
 * or "Accept" stays out: each confirms whatever question the page asked.
 */
export const INTERSTITIAL_CONTROL =
  /^(?:(?:accept|allow|reject|decline|agree to)(?: all)?(?: (?:the )?cookies)|(?:accept|allow) all|(?:yes, |no, )?(?:stay|keep me|remain) (?:signed|logged) in|dismiss|close|skip|not now|got it|remind me later|maybe later|no thanks|continue(?: as .+)?)$/i;

/**
 * Whether a click's element name is a control a login ends on, so a session
 * restore may repeat the click.
 */
export function isInterstitialControl(name: string): boolean {
  return INTERSTITIAL_CONTROL.test(name.trim().replace(/\s+/g, ' '));
}

/** Whether a field or element description names the account field of a login form. */
export function isLoginNameField(description: unknown): boolean {
  return (
    typeof description === 'string' && LOGIN_NAME_FIELD.test(normaliseDescription(description))
  );
}

/**
 * The typing slots in one browser action where the credential belongs: the
 * text of a `browser_type` into a credential field, and the value of each
 * `browser_fill_form` field that is one. Nothing else - not a URL, not an
 * element's name, not a comment box - may carry it. Once the elements are
 * resolved, the element the page actually offered must be a credential field
 * too, so a description that loosely matched "Password notes" does not count,
 * and it must be a text box, so a button or link named "Password" does not.
 */
function credentialSlots(
  tool: string,
  toolArgs: Record<string, unknown>,
  resolved?: readonly SnapshotElement[],
): Set<string> {
  const slots = new Set<string>();
  const onPage = (index: number): boolean =>
    resolved === undefined ||
    (resolved[index]?.role === 'textbox' && isCredentialField(resolved[index]?.name));
  if (tool === 'browser_type' && isCredentialField(toolArgs.element) && onPage(0)) {
    slots.add('text');
  }
  if (tool === 'browser_fill_form' && Array.isArray(toolArgs.fields)) {
    toolArgs.fields.forEach((field: unknown, index: number): void => {
      const record = field && typeof field === 'object' ? (field as Record<string, unknown>) : {};
      if (isCredentialField(record.name ?? record.element) && onPage(index)) {
        slots.add(`fields.${index}.value`);
      }
    });
  }
  return slots;
}

/** The surfaces named by every qualified `{{secret:<slug>}}` in an argument tree. */
function placeholderSurfaces(value: unknown, found: string[]): string[] {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{\s*secret[:.]([A-Za-z0-9_-]+)\s*\}\}/g))
      found.push(match[1]);
  } else if (Array.isArray(value)) {
    for (const entry of value) placeholderSurfaces(entry, found);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>))
      placeholderSurfaces(entry, found);
  }
  return found;
}

/** Every dotted path in an argument tree whose string names the credential. */
function placeholderPaths(value: unknown, path: string, found: string[]): string[] {
  if (typeof value === 'string') {
    if (SECRET_PLACEHOLDER.test(value)) found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((entry: unknown, index: number): void => {
      placeholderPaths(entry, path ? `${path}.${index}` : String(index), found);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      placeholderPaths(entry, path ? `${path}.${key}` : key, found);
    }
  }
  return found;
}

/**
 * Why a browser action may not carry the credential where it asks to, or
 * undefined when every `{{secret}}` it names sits in a credential field's
 * typing slot.
 *
 * A skill's arguments can be steered by what a colleague wrote in a ticket;
 * a placeholder in a comment field or a URL would type the surface's password
 * into the page for anyone to read. So the credential goes only where a login
 * form takes it.
 *
 * @param tool - The browser tool being called.
 * @param toolArgs - Its arguments as the skill emitted them, or with refs resolved.
 * @param slug - The action's target surface; a qualified placeholder must name it.
 * @param resolved - The elements the page offered for this action, once resolved.
 */
export function secretPlacementRefusal(
  tool: string,
  toolArgs: Record<string, unknown>,
  slug: string,
  resolved?: readonly SnapshotElement[],
): string | undefined {
  const named = placeholderSurfaces(toolArgs, []).find(
    (surface: string): boolean => surface !== slug,
  );
  if (named !== undefined) {
    return `{{secret:${named}}} names another surface's credential, which is never sent to ${slug}`;
  }
  const slots = credentialSlots(tool, toolArgs, resolved);
  const misplaced = placeholderPaths(toolArgs, '', []).filter(
    (path: string): boolean => !slots.has(path),
  );
  if (misplaced.length === 0) return undefined;
  return (
    `{{secret}} is typed only into a credential field (${misplaced.join(', ')} of ${tool} ` +
    'is not one), so the credential was not sent'
  );
}

/**
 * Type the credential into the slots `secretPlacementRefusal` admitted for the
 * resolved elements; every other string is left exactly as it was.
 *
 * @param tool - The browser tool being called.
 * @param toolArgs - Its arguments, refs already resolved.
 * @param resolved - The elements the page offered for this action.
 * @param secret - The surface's decrypted credential.
 * @param slug - The surface's slug, for the qualified placeholder.
 * @throws SecretTemplateError when a slot names another surface's secret.
 */
export function withSecretTyped(
  tool: string,
  toolArgs: Record<string, unknown>,
  resolved: readonly SnapshotElement[],
  secret: string,
  slug: string,
): Record<string, unknown> {
  const slots = credentialSlots(tool, toolArgs, resolved);
  if (tool === 'browser_type') {
    return slots.has('text') && typeof toolArgs.text === 'string'
      ? { ...toolArgs, text: injectSecret(toolArgs.text, secret, slug) }
      : toolArgs;
  }
  if (tool !== 'browser_fill_form' || !Array.isArray(toolArgs.fields)) return toolArgs;
  return {
    ...toolArgs,
    fields: toolArgs.fields.map((field: unknown, index: number): unknown => {
      if (!field || typeof field !== 'object') return field;
      const record = field as Record<string, unknown>;
      return slots.has(`fields.${index}.value`) && typeof record.value === 'string'
        ? { ...record, value: injectSecret(record.value, secret, slug) }
        : record;
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
export const BROWSER_COMPONENT_CARD_MESSAGE = `This system is reached through its web UI. ${BROWSER_COMPONENT_ABSENT}`;

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

/** A recordable refusal for an absent or unusable browser component. */
export function browserComponentRefusal(configured: string | undefined): string | undefined {
  try {
    const component = browserComponent(configured);
    return component.present ? undefined : component.reason;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Project a browser surface through the component state consumers have now.
 *
 * The stored row records the last provider probe. When the deployment switch
 * is later removed, exposing that row as connected would let prompts and cards
 * claim authority the transport will refuse. Proposed rows stay proposed so
 * their evidence and disabled approval controls remain visible; later states
 * degrade to the same ungranted refusal the next probe will persist.
 */
export function withBrowserComponentState<
  T extends { credentialLanded: boolean; path?: string; reason?: string; verdict: string },
>(surface: T, refusal: string | undefined): T {
  if (!refusal || surface.path !== 'browser-driven') return surface;
  if (
    surface.verdict === 'declared' ||
    surface.verdict === 'proposed' ||
    surface.verdict === 'absent'
  ) {
    return surface;
  }
  return {
    ...surface,
    verdict: 'ungranted',
    reason: refusal,
    credentialLanded: false,
  };
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

/**
 * Connection failures a driver that is not running produces.
 *
 * Two layers, because two layers report it. The operating system's codes reach
 * us when `fetch` is what failed; the MCP client's own wording reaches us when
 * it has already swallowed the cause and reports only that it could not open a
 * transport. The second list was written from the live message a stopped
 * component actually produced ("Failed to connect to MCP server surface: Error:
 * Could not connect to server with any available HTTP transport"), which none
 * of the first list matched.
 */
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
  return isTransportUnreachable(error);
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
 * Read the element a signed-in page shows, from the line
 * `Probe marker: after sign-in, element \`<name>\``: the probe signs in with the
 * credential and looks for it, so a rotated password or a redesigned login is
 * found by the probe rather than by the first write.
 */
export function browserSignedInMarker(markdown: string): string | undefined {
  const match = /\bProbe marker:\s*after sign[ -]?in,?\s*element\s+`([^`\r\n]+)`/i.exec(markdown);
  return match?.[1]?.trim() || undefined;
}

/**
 * Read the account name a login is documented with, from the parenthesis a
 * credential line carries: `` `<value>` (username `revops`) ``. The account
 * name is not a secret, so the stored page keeps it.
 */
export function documentedUsername(markdown: string): string | undefined {
  const match = /\(\s*user ?name\s+`([^`\r\n]+)`\s*\)/i.exec(markdown);
  return match?.[1]?.trim() || undefined;
}

/**
 * Whether a snapshot shows an element with this accessible name, whatever its
 * role and however many share it: the probe asks whether the signed-in page
 * is there, not which control to press.
 *
 * @param snapshot - The text a `browser_snapshot` call returned.
 * @param name - The element the documentation names, compared ignoring case and spacing.
 */
export function pageShowsElement(snapshot: string, name: string): boolean {
  const wanted = name.replace(/\s+/g, ' ').trim().toLowerCase();
  return (
    wanted !== '' &&
    parseSnapshotRefs(snapshot).some(
      (element: SnapshotElement): boolean =>
        element.name.replace(/\s+/g, ' ').trim().toLowerCase() === wanted,
    )
  );
}

/** The controls of the login form one page shows, each only when the page offers exactly one. */
export interface LoginForm {
  readonly account?: SnapshotElement;
  readonly credential?: SnapshotElement;
  readonly submit?: SnapshotElement;
  readonly next?: SnapshotElement;
}

/**
 * Find a login form's controls in one driver snapshot, by the names the apply
 * and the sign-in replay read: a text box for the account, a text box for the
 * credential, and the control that submits the form or moves to its second
 * page. A name two controls share is none of them.
 *
 * @param snapshot - The text a `browser_snapshot` call returned.
 */
export function loginForm(snapshot: string): LoginForm {
  const elements = parseSnapshotRefs(snapshot);
  const only = (pick: (element: SnapshotElement) => boolean): SnapshotElement | undefined => {
    const found = elements.filter(pick);
    return found.length === 1 ? found[0] : undefined;
  };
  const control = (element: SnapshotElement): boolean =>
    element.role === 'button' || element.role === 'link';
  return {
    account: only((e) => e.role === 'textbox' && isLoginNameField(e.name)),
    credential: only((e) => e.role === 'textbox' && isCredentialField(e.name)),
    submit: only((e) => control(e) && SIGN_IN_CONTROL.test(e.name.trim())),
    next: only((e) => control(e) && NEXT_CONTROL.test(e.name.trim())),
  };
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
