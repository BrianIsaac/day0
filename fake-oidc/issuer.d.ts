/** One test person and the claims its ID tokens carry. */
export interface FakePerson {
  readonly id: string;
  /** The `sub` claim; `fake-oidc|<id>` when unset. */
  readonly subject?: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

/** A registered client: its id, secret and the redirect URIs it may use. */
export interface FakeClient {
  readonly id: string;
  readonly secret: string;
  readonly redirectUris: readonly string[];
}

/** How the test issuer is set up. */
export interface FakeIssuerOptions {
  /** The issuer URL exactly as tokens carry it in `iss`. */
  readonly issuer: string;
  readonly clients: readonly FakeClient[];
  readonly people?: readonly FakePerson[];
  /** How long an ID token lives, in seconds. */
  readonly tokenSeconds?: number;
  /** The clock, in milliseconds. */
  readonly now?: () => number;
}

/** The running test issuer. */
export interface FakeIssuer {
  readonly issuer: string;
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
  /** Answers one request to any of the issuer's endpoints. */
  handle(request: Request): Promise<Response>;
  /** Signs a hand-made token with the issuer's own key, as a forged-past-the-callback test needs. */
  mintIdToken(claims: Readonly<Record<string, unknown>>): string;
}

/** The two people in the allowed domain and the one outside it. */
export declare const DEFAULT_PEOPLE: readonly FakePerson[];

/** How long an ID token lives unless the issuer is told otherwise. */
export declare const DEFAULT_TOKEN_SECONDS: number;

/** Create the test issuer. */
export declare function createIssuer(options: FakeIssuerOptions): FakeIssuer;
