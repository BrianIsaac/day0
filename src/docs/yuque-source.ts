/**
 * A Yuque documentation source's location and reader secret, as the link form, the link's
 * validators and the reader all read them (wave 15, 15-X).
 *
 * The location is one repository (知识库): `https://www.yuque.com/<group>/<repository>`, or the
 * same on a space's own subdomain (`https://<space>.yuque.com/...`), which is also where its API
 * answers. The reader secret is a Yuque token, which Yuque gives on a paid plan only (超级会员 for
 * a personal account, 旗舰版 for a team space).
 */

/** Yuque's own site, and the suffix every space's subdomain ends with. */
const YUQUE_HOST = 'yuque.com';

/** One Yuque repository, as its API names it. */
export interface YuqueLocator {
  /** The host the repository is on, and its API with it: `www.yuque.com` or a space's subdomain. */
  readonly host: string;
  /** The group or user the repository belongs to (its login). */
  readonly group: string;
  /** The repository's path (its slug). */
  readonly book: string;
}

const LOCATOR_REFUSAL =
  "A Yuque location is a repository's address as the browser shows it: " +
  "https://www.yuque.com/<group>/<repository>, or the same on your space's own yuque.com " +
  'address. The address of a single document works too: Day0 keeps the repository it is in.';

/** A login or a slug: letters, digits, dots, underscores and hyphens. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Whether a host is Yuque's own or a space's subdomain of it. */
function isYuqueHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host.endsWith(`.${YUQUE_HOST}`) && /^[a-z0-9-]+$/.test(host.slice(0, -YUQUE_HOST.length - 1))
  );
}

/**
 * Parse a Yuque source's stored locator.
 *
 * @param locator - `https://<www or a space>.yuque.com/<group>/<repository>`.
 * @throws Error when it is anything else; the message never repeats the locator.
 */
export function parseYuqueLocator(locator: string): YuqueLocator {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error(LOCATOR_REFUSAL);
  }
  const [, group, book, ...rest] = url.pathname.split('/');
  if (
    url.protocol !== 'https:' ||
    !isYuqueHost(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    rest.length > 0 ||
    !SEGMENT.test(group ?? '') ||
    !SEGMENT.test(book ?? '')
  ) {
    throw new Error(LOCATOR_REFUSAL);
  }
  return { host: url.hostname.toLowerCase(), group, book };
}

/**
 * The stored locator for an address copied from anywhere in a Yuque repository.
 *
 * @param typed - What the manager pasted: the repository's address, or a document's in it.
 * @returns The repository's own address, which `parseYuqueLocator` reads, or the text as typed
 *   when it is not an address of a repository on Yuque, for the link to refuse.
 */
export function yuqueLocator(typed: string): string {
  const text = typed.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  const [, group, book] = url.pathname.split('/');
  if (
    !isYuqueHost(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    !SEGMENT.test(group ?? '') ||
    !SEGMENT.test(book ?? '')
  ) {
    return text;
  }
  return `https://${url.hostname.toLowerCase()}/${group}/${book}`;
}

const TOKEN_REFUSAL = 'A Yuque token is one line with no spaces, as Yuque showed it.';

/**
 * Check a Yuque source's reader secret.
 *
 * @throws Error when it holds a space; the message never repeats it.
 */
export function checkYuqueToken(secret: string): void {
  if (!/^\S+$/.test(secret)) throw new Error(TOKEN_REFUSAL);
}
