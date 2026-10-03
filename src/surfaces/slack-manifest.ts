import { slackAuthorizeUrl } from './slack-endpoint';

/**
 * The manifest a dedicated Slack app is created from, taken from the team's own
 * policy page rather than from this repository.
 *
 * The product claim is that access is discovered from the documentation, so the
 * shape of the app an employee registers for itself is the shape the team wrote
 * down: this module locates the fenced manifest template on the synced policy
 * page, substitutes the two placeholders the page documents, and refuses
 * anything that is not a usable manifest. The template decides the app's name,
 * its description, its bot user and its bot scopes. Everything else is Day0's:
 * the manifest sent with the administrator's token is rebuilt from an
 * allowlist, so a page edit cannot add an event subscription, an interactivity
 * or slash-command address, user-token scopes or a second redirect.
 */

/** The placeholder the policy page uses for the employee's name. */
export const EMPLOYEE_NAME_PLACEHOLDER = '<employee name>';

/** The placeholder the policy page uses for Day0's public origin. */
export const PUBLIC_URL_PLACEHOLDER = '<Day0 public URL>';

/** The redirect path the OAuth install returns to. */
export const SLACK_REDIRECT_PATH = '/api/oauth/slack';

/** Slack refuses an app whose name is longer than this. */
const APP_NAME_LIMIT = 35;

/** The only settings a dedicated app may carry, each a switch Slack documents. */
const SETTING_KEYS = [
  'org_deploy_enabled',
  'socket_mode_enabled',
  'token_rotation_enabled',
] as const;

/** A Slack OAuth scope: a resource, a colon and an action, as `users:read.email` or `links.embed:write`. */
const SLACK_SCOPE = /^[a-z][a-z_.]*:[a-z][a-z_.]*$/;

/** The shape of a dedicated app's manifest, and all of it Day0 sends. */
export interface SlackManifest {
  display_information: {
    name: string;
    description?: string;
    long_description?: string;
    background_color?: string;
  };
  features?: { bot_user?: { display_name?: string; always_online?: boolean } };
  oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } };
  settings?: Partial<Record<(typeof SETTING_KEYS)[number], boolean>>;
}

export interface BuiltSlackManifest {
  appName: string;
  manifest: SlackManifest;
  redirectUrl: string;
  scopes: string[];
}

export class ManifestTemplateError extends Error {}

/**
 * Compose the app name the policy page's placeholder resolves to.
 *
 * Args:
 *   agentName: The employee's name as the manager deployed it.
 *
 * Returns:
 *   The name, clipped to Slack's app-name limit.
 */
export function dedicatedAppName(agentName: string, template: string): string {
  const name = template.split(EMPLOYEE_NAME_PLACEHOLDER).join(agentName.trim());
  return name.length > APP_NAME_LIMIT ? name.slice(0, APP_NAME_LIMIT).trimEnd() : name;
}

/**
 * Read every fenced code block out of a markdown page.
 *
 * Args:
 *   markdown: One or more synced documentation pages.
 *
 * Returns:
 *   The bodies of the fenced blocks, in page order.
 */
function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let open: string[] | undefined;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (open) {
        blocks.push(open.join('\n'));
        open = undefined;
      } else {
        open = [];
      }
      continue;
    }
    if (open) open.push(line);
  }
  return blocks;
}

/**
 * Decide whether a parsed object is the manifest the policy page documents.
 *
 * A manifest without a redirect list or bot scopes cannot produce an install
 * link, so it is not a template this code can use, whatever it is called.
 */
function looksLikeManifest(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const display = record.display_information;
  const oauth = record.oauth_config;
  if (!display || typeof display !== 'object') return false;
  if (!oauth || typeof oauth !== 'object') return false;
  const config = oauth as Record<string, unknown>;
  const scopes = config.scopes as Record<string, unknown> | undefined;
  return Array.isArray(config.redirect_urls) && Array.isArray(scopes?.bot);
}

/**
 * Locate the app manifest template on the synced policy pages.
 *
 * Args:
 *   markdown: The joined markdown of the pages the agent reads.
 *
 * Returns:
 *   The template as written, or undefined when the documentation carries none.
 */
export function extractManifestTemplate(markdown: string): string | undefined {
  for (const block of fencedBlocks(markdown)) {
    const text = block.trim();
    if (!text.startsWith('{')) continue;
    try {
      if (looksLikeManifest(JSON.parse(text))) return text;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Replace the documented placeholders inside every string of a parsed template.
 *
 * Substitution happens after parsing so a name carrying a quote or a backslash
 * cannot break out of its JSON string and rewrite the manifest.
 */
function substitute(value: unknown, agentName: string, origin: string): unknown {
  if (typeof value === 'string') {
    return value
      .split(EMPLOYEE_NAME_PLACEHOLDER)
      .join(agentName)
      .split(PUBLIC_URL_PLACEHOLDER)
      .join(origin);
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown): unknown => substitute(entry, agentName, origin));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substitute(entry, agentName, origin);
    }
    return out;
  }
  return value;
}

/**
 * Normalise a public origin so the redirect the manifest declares is the
 * redirect the route later receives.
 *
 * Args:
 *   publicUrl: The configured `DAY0_PUBLIC_URL`.
 *
 * Returns:
 *   The origin with no trailing slash.
 *
 * Raises:
 *   ManifestTemplateError: If the value is not an absolute https URL.
 */
export function publicOrigin(publicUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl.trim());
  } catch {
    throw new ManifestTemplateError(
      'DAY0_PUBLIC_URL is not a URL; set it to the public origin Slack redirects back to.',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ManifestTemplateError(
      'DAY0_PUBLIC_URL must be https: Day0 has Slack send its codes and tokens back to an https address only.',
    );
  }
  return parsed.origin;
}

/**
 * Build the manifest for one employee's dedicated app from the team's template.
 *
 * Args:
 *   input.agentName: The employee's name, which the template's placeholder takes.
 *   input.publicUrl: Day0's public origin, which the redirect placeholder takes.
 *   input.template: The manifest template as the policy page wrote it.
 *
 * Returns:
 *   The manifest to send, the resulting app name, its redirect URL and scopes.
 *
 * Raises:
 *   ManifestTemplateError: If the template or the resulting manifest is unusable.
 */
export function buildSlackManifest(input: {
  agentName: string;
  publicUrl: string;
  template: string;
}): BuiltSlackManifest {
  const agentName = input.agentName.trim();
  if (!agentName)
    throw new ManifestTemplateError('The employee has no name to register an app for.');
  const origin = publicOrigin(input.publicUrl);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.template);
  } catch {
    throw new ManifestTemplateError('The documented manifest template is not valid JSON.');
  }
  if (!looksLikeManifest(parsed)) {
    throw new ManifestTemplateError(
      'The documented manifest template has no redirect URL or bot scopes.',
    );
  }

  const written = substitute(parsed, agentName, origin) as Record<string, unknown>;
  const display = record(written.display_information);
  const appName = dedicatedAppName(agentName, stringOr(display.name, ''));
  if (!appName) {
    throw new ManifestTemplateError('The documented manifest template names no app.');
  }

  const oauth = record(written.oauth_config);
  const redirectUrl = `${origin}${SLACK_REDIRECT_PATH}`;
  const declared = (Array.isArray(oauth.redirect_urls) ? oauth.redirect_urls : []).map(
    (url: unknown): string => stringOr(url, '').trim(),
  );
  if (!declared.includes(redirectUrl)) {
    throw new ManifestTemplateError(
      `The documented manifest redirects to ${declared.join(', ') || '(nothing)'}, not to ${redirectUrl}.`,
    );
  }

  const scopes = botScopes(record(oauth.scopes).bot);
  const manifest: SlackManifest = {
    display_information: displayInformation(display, appName),
    ...features(record(written.features), agentName),
    oauth_config: { redirect_urls: [redirectUrl], scopes: { bot: scopes } },
    ...settings(record(written.settings)),
  };
  return { appName, manifest, redirectUrl, scopes };
}

/** A parsed JSON value as an object, or an empty one when it is anything else. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** The app's name and the three optional display strings, nothing else. */
function displayInformation(
  display: Record<string, unknown>,
  appName: string,
): SlackManifest['display_information'] {
  const out: SlackManifest['display_information'] = { name: appName };
  for (const key of ['description', 'long_description', 'background_color'] as const) {
    const value = display[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

/** The bot user and nothing else: no slash commands, shortcuts or unfurl domains. */
function features(
  written: Record<string, unknown>,
  agentName: string,
): Pick<SlackManifest, 'features'> {
  const bot = record(written.bot_user);
  if (Object.keys(bot).length === 0) return {};
  const displayName = stringOr(bot.display_name, '');
  return {
    features: {
      bot_user: {
        ...(displayName ? { display_name: dedicatedAppName(agentName, displayName) } : {}),
        ...(typeof bot.always_online === 'boolean' ? { always_online: bot.always_online } : {}),
      },
    },
  };
}

/** The documented switches, when the template set them, and no addresses. */
function settings(written: Record<string, unknown>): Pick<SlackManifest, 'settings'> {
  const out: NonNullable<SlackManifest['settings']> = {};
  for (const key of SETTING_KEYS) {
    const value = written[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length > 0 ? { settings: out } : {};
}

/** The bot scopes, trimmed, each one a Slack scope, at least one. */
function botScopes(value: unknown): string[] {
  const scopes = (Array.isArray(value) ? value : [])
    .map((scope: unknown): string => stringOr(scope, '').trim())
    .filter((scope: string): boolean => scope !== '');
  if (scopes.length === 0) {
    throw new ManifestTemplateError('The documented manifest requests no bot scopes.');
  }
  const odd = scopes.find((scope: string): boolean => !SLACK_SCOPE.test(scope));
  if (odd !== undefined) {
    throw new ManifestTemplateError(
      `The documented manifest's bot scope "${odd}" is not a Slack scope.`,
    );
  }
  return scopes;
}

/**
 * Compose the install link the administrator clicks.
 *
 * Args:
 *   input.clientId: The client id `apps.manifest.create` returned.
 *   input.redirectUrl: The redirect the manifest declares.
 *   input.scopes: The bot scopes the manifest requests.
 *   input.state: The signed, single-use state bound to this surface.
 *
 * Returns:
 *   The `https://slack.com/oauth/v2/authorize` URL for the install click.
 */
export function slackInstallUrl(input: {
  clientId: string;
  redirectUrl: string;
  scopes: readonly string[];
  state: string;
}): string {
  const url = slackAuthorizeUrl();
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('scope', input.scopes.join(','));
  url.searchParams.set('redirect_uri', input.redirectUrl);
  url.searchParams.set('state', input.state);
  return url.toString();
}
