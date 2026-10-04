/** One of the workspace's people, with the personal API key a bed stages tickets with. */
export interface FakePerson {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
  /** Whether the person may install an app with `actor=app` (L1: admin permissions required). */
  readonly admin: boolean;
  /** The person's personal API key, a fake in the tree's short shape (`lin_api_day0_fake_sam`). */
  readonly apiKey?: string;
}

/** One OAuth app registered in the workspace. */
export interface FakeLinearApp {
  /** The OAuth application's id, which names its app user's address; a fresh uuid when unset. */
  readonly id?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The app's name, which its app user carries (`Day0`, `Leo (Day0)`). */
  readonly name: string;
  /** Whether the client-credentials grant is turned on for the app. */
  readonly clientCredentials: boolean;
  readonly redirectUris: readonly string[];
  /** The app user's id once installed; a fresh uuid when unset. */
  readonly appUserId?: string;
}

/** The workspace's teams, projects and labels, besides its people. */
export interface FakeWorkspaceOptions {
  /** The workspace's URL key, in each issue's `url`. */
  readonly urlKey?: string;
  readonly people?: readonly FakePerson[];
  readonly teams?: readonly {
    readonly id?: string;
    readonly key: string;
    readonly name: string;
    readonly issueCount?: number;
  }[];
  readonly projects?: readonly {
    readonly id?: string;
    readonly name: string;
    readonly team: string;
  }[];
  readonly labels?: readonly string[];
}

/** How the double is set up. */
export interface FakeLinearOptions {
  readonly apps: readonly FakeLinearApp[];
  readonly people?: readonly FakePerson[];
  readonly workspace?: Omit<FakeWorkspaceOptions, 'people'>;
  /** The person signed in to the authorise page, by id or address; the first administrator when unset. */
  readonly signedIn?: string;
  /** The clock, in milliseconds. */
  readonly now?: () => number;
}

/** A person or an app user, as the workspace holds them. */
export interface WorkspaceUser {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
  readonly app: boolean;
  readonly admin?: boolean;
  readonly apiKey?: string;
  readonly clientId?: string;
}

/** The user an OAuth app installs. */
export interface AppUser extends WorkspaceUser {
  readonly app: true;
  readonly clientId: string;
}

/** Why the workspace refused a change, in the shape of Linear's GraphQL error. */
export interface WorkspaceRefusal {
  readonly message: string;
  readonly code: string;
  readonly type: string;
  readonly status: number;
  readonly userPresentableMessage: string;
}

/** One comment on an issue. */
export interface IssueComment {
  readonly id: string;
  readonly body: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One state change in an issue's history, with the user who made it. */
export interface IssueHistoryEntry {
  readonly id: string;
  readonly actorId: string;
  readonly fromStateId: string;
  readonly toStateId: string;
  readonly createdAt: string;
}

/** One issue. */
export interface Issue {
  id: string;
  number: number;
  teamId: string;
  title: string;
  description: string;
  priority: number;
  projectId: string | null;
  stateId: string;
  assigneeId: string | null;
  delegateId: string | null;
  labelIds: string[];
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  completedAt: string | null;
  startedAt: string | null;
  canceledAt: string | null;
  comments: IssueComment[];
  history: IssueHistoryEntry[];
}

/** The fields one change to an issue sets; a state by id, name or type, a user by id or name. */
export interface IssueChange {
  assigneeId?: string | null;
  delegateId?: string | null;
  state?: string;
  projectId?: string | null;
  labelIds?: string[];
  title?: string;
  description?: string;
  priority?: number;
}

/** One team and its workflow. */
export interface WorkspaceTeam {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  issueCount: number;
  readonly states: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly position: number;
  }[];
}

/** The workspace the GraphQL API and the MCP server share. */
export interface FakeWorkspace {
  readonly urlKey: string;
  readonly people: readonly WorkspaceUser[];
  readonly appUsers: Map<string, AppUser>;
  readonly teams: readonly WorkspaceTeam[];
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly teamId: string;
  }[];
  readonly labels: readonly { readonly id: string; readonly name: string }[];
  readonly issues: Issue[];
  userById(id: string | null | undefined): WorkspaceUser | undefined;
  userByAny(
    value: string | null | undefined,
    actor: WorkspaceUser | undefined,
  ): WorkspaceUser | undefined;
  issueByAny(value: string): Issue | undefined;
  teamByAny(value: string | null | undefined): WorkspaceTeam | undefined;
  teamOf(issue: Issue): WorkspaceTeam;
  stateOf(issue: Issue): WorkspaceTeam['states'][number];
  installApp(app: FakeLinearApp & { readonly id: string }): AppUser;
  urlOf(issue: Issue): string;
  identifierOf(issue: Issue): string;
  createIssue(
    input: IssueChange & { readonly teamId: string; readonly title: string },
    actor: WorkspaceUser,
  ): { readonly issue: Issue } | { readonly refused: WorkspaceRefusal };
  updateIssue(
    issue: Issue,
    change: IssueChange,
    actor: WorkspaceUser,
  ): WorkspaceRefusal | undefined;
  addComment(issue: Issue, body: string, actor: WorkspaceUser): IssueComment;
  archiveIssue(issue: Issue): void;
}

/** Who a token acts as. */
export type FakeActor =
  | { readonly kind: 'app'; readonly appUserId: string }
  | { readonly kind: 'person'; readonly personId: string };

/** A token's state, as the admin state lists it. */
export type FakeTokenState = 'live' | 'revoked' | 'expired' | 'spent';

/** One token the double issued. */
export interface FakeToken {
  readonly value: string;
  readonly serial: number;
  readonly kind: 'app-actor' | 'access' | 'refresh';
  readonly grant: 'client_credentials' | 'authorization_code' | 'refresh_token';
  /** The grant the token belongs to: a revoke of any token in it ends every one (R41V-8). */
  readonly grantId: string;
  readonly clientId: string;
  readonly actor: FakeActor;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  spentAt: number | null;
  /** The pair a spent refresh token was exchanged for, answered again inside its grace. */
  replay: { readonly access: FakeToken; readonly refresh: FakeToken } | null;
}

/** One authorisation code waiting for its exchange. */
export interface FakeCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string | null;
  readonly scopes: string[];
  readonly actor: FakeActor;
  readonly expiresAt: number;
  used: boolean;
}

/** The double's token store. */
export interface FakeGrants {
  readonly tokens: Map<string, FakeToken>;
  stateOf(token: FakeToken): FakeTokenState;
  find(value: string): FakeToken | undefined;
  revokeGrant(grantId: string): void;
  issueAppActor(clientId: string, appUserId: string, scopes: string[]): FakeToken;
  issueCode(fields: Omit<FakeCode, 'expiresAt' | 'used'>): string;
  exchangeCode(
    clientId: string,
    code: string,
    redirectUri: string,
    verifier: string,
  ):
    | { readonly access: FakeToken; readonly refresh: FakeToken }
    | { readonly refused: 'code' | 'redirect' | 'verifier' };
  refresh(
    clientId: string,
    value: string,
  ):
    | { readonly access: FakeToken; readonly refresh: FakeToken }
    | { readonly refused: 'unknown' | 'revoked' | 'expired' | 'spent' };
  revokeApp(clientId: string): number;
  expire(value: string): boolean;
}

/** A parsed GraphQL argument value. */
export type GraphqlValue =
  | { readonly variable: string }
  | { readonly list: readonly GraphqlValue[] }
  | { readonly object: Readonly<Record<string, GraphqlValue>> }
  | { readonly literal: string | number | boolean | null };

/** One selected field. */
export interface GraphqlField {
  readonly alias: string;
  readonly name: string;
  readonly args: Readonly<Record<string, GraphqlValue>>;
  readonly selections: readonly GraphqlField[] | null;
}

/** One parsed operation. */
export interface GraphqlOperation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly defaults: Readonly<Record<string, GraphqlValue>>;
  readonly selections: readonly GraphqlField[];
}

/** One request the double answered, without any secret it carried. */
export interface LoggedRequest {
  readonly sequence: number;
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly grant_type?: string;
  readonly client_id?: string;
  readonly scope?: string;
  readonly token_type_hint?: string;
  /** The JSON-RPC method of an MCP request, and the tool a `tools/call` named. */
  readonly rpc?: string;
  readonly tool?: string;
}

/** The running double. */
export interface FakeLinear {
  readonly workspace: FakeWorkspace;
  /** Answers one request to any of the double's endpoints. */
  handle(request: Request): Promise<Response>;
}

/** The workspace's people by default: an administrator and a member. */
export declare const DEFAULT_PEOPLE: readonly FakePerson[];

/** The shared app and one employee's own app, with the bed's redirect URIs. */
export declare function defaultApps(redirectUris: readonly string[]): FakeLinearApp[];

/** Create the double. */
export declare function createLinear(options: FakeLinearOptions): FakeLinear;
