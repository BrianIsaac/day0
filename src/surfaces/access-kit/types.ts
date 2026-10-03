import type { OrganisationConnectionKind, OrganisationConnectionMode } from '../access-identity';

/*
 * The Day0 access kit's shapes (the access plan, section 4.8; B13): one recipe per system IT
 * connects at install, read by `./setup.sh access` (what to ask), `check:access` (what to check),
 * `check:setup` (what to report) and the recipe pages under `docs/running/access-<system>.md`
 * (pinned against these by a test), so the scopes on a page are the scopes in code.
 */

/** The systems the kit connects at install: each has an issuer that uses the connection (AI1). */
export const ACCESS_KIT_SYSTEMS = ['slack', 'linear', 'mcp'] as const;

/** One of {@link ACCESS_KIT_SYSTEMS}. An MCP server's connection is keyed `mcp:<host>`. */
export type AccessKitSystem = (typeof ACCESS_KIT_SYSTEMS)[number];

/** A value the verb asks IT for, and where the landing carries it. */
export const RECIPE_FIELDS = [
  'secret',
  'refreshToken',
  'clientId',
  'appId',
  'issuer',
  'resource',
  'serverUrl',
  'scopes',
] as const;

/** One of {@link RECIPE_FIELDS}. */
export type RecipeField = (typeof RECIPE_FIELDS)[number];

/** One value the verb asks for: its words, whether it is a secret, and the stdin name it takes. */
export interface RecipeAsk {
  readonly field: RecipeField;
  /** The question, as the terminal asks it. */
  readonly label: string;
  /** A secret: asked in a hidden prompt or read from stdin, never a flag, never printed. */
  readonly secret: boolean;
  /** The name a `NAME=value` line on stdin gives it (`--secrets-stdin`), for secrets and the rest alike. */
  readonly stdinName: string;
  /** Whether an empty answer is accepted (an MCP public client has no secret). */
  readonly optional: boolean;
}

/** How long a secret IT hands over lives, and what renews it: every recipe names it (O3). */
export interface SecretLifetime {
  /** The lifetime in a sentence, as the recipe page and the install record print it. */
  readonly words: string;
  /** Days until it expires, where the vendor fixes a number; absent when it does not expire or IT decides. */
  readonly days?: number;
}

/** One way a system is connected: per employee or shared (D3 with B11). */
export interface RecipeMode {
  readonly mode: OrganisationConnectionMode;
  readonly kind: OrganisationConnectionKind;
  /** The vendor scopes the registration holds: the ceiling the rungs use (AC6, B10). */
  readonly scopes: readonly string[];
  /** The fixed scope set of a shared app's client-credentials tokens (L2), where the mode uses them. */
  readonly clientCredentialsScopes?: readonly string[];
  /**
   * What Day0 cannot do without a scope, by scope, where a missing one costs more than its name
   * says: `check:access` prints it beside the gap.
   */
  readonly missingScopeWords?: Readonly<Record<string, string>>;
  /** What the verb asks for, in order. */
  readonly asks: readonly RecipeAsk[];
  readonly secretLifetime: SecretLifetime;
  /**
   * Whether the verb lands this mode at install. False where nothing exists to land yet: a
   * per-employee Linear connection holds no organisation secret (each employee's app brings its
   * own), which 11-AO's landing refuses (AI5).
   */
  readonly landsAtInstall: boolean;
  /** One line on what IT does for this mode, as the verb prints it before asking. */
  readonly summary: string;
}

/** A system's recipe: its name, its page, where its redirect returns and the modes it offers. */
export interface AccessRecipe {
  readonly system: AccessKitSystem;
  readonly displayName: string;
  /** The recipe page, from the repository root. */
  readonly guide: string;
  /** The path Day0's redirect for this system returns to, under `DAY0_PUBLIC_URL`. */
  readonly redirectPath: string;
  /** The modes offered, the first being the default. */
  readonly modes: readonly [RecipeMode, ...RecipeMode[]];
  /** The vendor hosts the deployment and the check reach for this system, for the egress list. */
  readonly vendorHosts: readonly string[];
}
