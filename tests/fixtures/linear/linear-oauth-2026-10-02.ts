/**
 * Linear's OAuth and MCP answers as Day0's Linear issuer meets them (wave 11, 11-AL, V-A3).
 *
 * Provenance, 2 October 2026. Two kinds of entry, each marked:
 *
 * - **recorded**: read live and read-only against the bed's Linear workspace `day00` and Linear's
 *   public endpoints, with the bed's API key in one process: `mcp.linear.app/mcp` with no
 *   bearer and with a bearer Linear never issued, `api.linear.app/oauth/token` with a client id
 *   Linear never issued (both grants), `viewer` and `get_user` with the bed's key, and the live
 *   `list_issues` schema. Verbatim but for the person: the operator's name is `Sam` and the
 *   address is replaced (decision N6); ids are the bed workspace's own (`tests/fixtures/README.md`).
 * - **documented**: the shape Linear's pages give for an answer no read could produce without an
 *   OAuth app (<https://linear.app/developers/oauth-2-0-authentication>, `/agents`, read 2 October
 *   2026), with fake tokens in the tree's short shapes and invented app user ids. The bed walk
 *   records these live once IT creates the app (the 11-AL handover, "For 11-AC and the review's
 *   bed walk").
 */

/** A recorded HTTP answer: its status, the headers Day0 reads, and its body as text. */
export interface RecordedAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Recorded: `initialize` on `mcp.linear.app/mcp` with no `Authorization` header. */
export const MCP_WITHOUT_BEARER: RecordedAnswer = {
  status: 401,
  headers: {
    'www-authenticate':
      'Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write"',
  },
  body: '',
};

/** Recorded: `initialize` on `mcp.linear.app/mcp` with a bearer Linear never issued. */
export const MCP_INVALID_TOKEN: RecordedAnswer = {
  status: 401,
  headers: {
    'content-type': 'application/json',
    'www-authenticate':
      'Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", error="invalid_token", scope="read write"',
  },
  body: '{"error":"invalid_token","error_description":"Invalid access token"}',
};

/**
 * The line the MCP client raises for {@link MCP_INVALID_TOKEN}, as the probe and intake see it
 * (the SDK's wording, recorded in `tests/convex/surfaceActions.test.ts`).
 */
export const MCP_INVALID_TOKEN_ERROR =
  'Failed to connect to MCP server surface: SdkHttpError: Error POSTing to endpoint: HTTP 401 {"error":"invalid_token"}';

/** Recorded: the MCP server's own authorisation server, which offers no `client_credentials`. */
export const MCP_AUTHORISATION_SERVER_GRANTS = [
  'authorization_code',
  'refresh_token',
  'urn:ietf:params:oauth:grant-type:jwt-bearer',
] as const;

/** Recorded: `POST api.linear.app/oauth/token` for a client Linear never issued, either grant. */
export const TOKEN_INVALID_CLIENT: RecordedAnswer = {
  status: 400,
  headers: { 'content-type': 'application/json' },
  body: '{"error":"invalid_client","error_description":"Invalid client: client is invalid"}',
};

/** Documented: a client-credentials request to an app without the grant turned on. */
export const TOKEN_GRANT_NOT_ENABLED: RecordedAnswer = {
  status: 400,
  headers: { 'content-type': 'application/json' },
  body: '{"error":"Error","error_description":"Client does not support the client_credentials grant type"}',
};

/** Documented: a refresh token that was revoked, or spent outside the 30-minute grace (RFC 6749). */
export const TOKEN_INVALID_GRANT: RecordedAnswer = {
  status: 400,
  headers: { 'content-type': 'application/json' },
  body: '{"error":"invalid_grant","error_description":"Refresh token is invalid or expired"}',
};

/** Documented: the client-credentials answer, an app-actor token for 30 days and no refresh token. */
export const CLIENT_CREDENTIALS_TOKEN = {
  access_token: 'lin_oauth_shared_1',
  token_type: 'Bearer',
  expires_in: 2_591_999,
  scope: 'read write',
} as const;

/** Documented: the authorisation-code answer, a 24-hour access token with its refresh token. */
export const AUTHORISATION_CODE_TOKEN = {
  access_token: 'lin_oauth_access_1',
  token_type: 'Bearer',
  expires_in: 86_399,
  scope: 'read write',
  refresh_token: 'lin_refresh_1',
} as const;

/** Documented: an app created before 1 December 2023 prints the scope as an array. */
export const ARRAY_SCOPE_TOKEN = {
  access_token: 'lin_oauth_access_2',
  token_type: 'Bearer',
  expires_in: 86_399,
  scope: ['read', 'write'],
  refresh_token: 'lin_refresh_2',
} as const;

/** Recorded: `{ viewer { id name email app } }` with the bed's personal API key. */
export const VIEWER_OF_API_KEY = {
  data: {
    viewer: {
      id: '11ecf8f2-2b26-4f9f-a24d-03ba2c3a283f',
      name: 'Sam',
      email: 'sam@day00.test',
      app: false,
    },
  },
} as const;

/** Documented: `viewer` with an app-actor token names the app user, unique to the workspace (L1). */
export const VIEWER_OF_SHARED_APP = {
  data: { viewer: { id: 'app-user-day0-shared', name: 'Day0', app: true } },
} as const;

/** Documented: `viewer` with a per-employee app's token names that employee's app user. */
export const VIEWER_OF_LEO_APP = {
  data: { viewer: { id: 'app-user-day0-leo', name: 'Day0 Leo', app: true } },
} as const;

/** Documented: GraphQL refuses a token it does not know with 401 and an authentication error. */
export const VIEWER_UNAUTHENTICATED: RecordedAnswer = {
  status: 401,
  headers: { 'content-type': 'application/json' },
  body: '{"errors":[{"message":"Authentication required, not authenticated","extensions":{"code":"AUTHENTICATION_ERROR"}}]}',
};

/** Recorded: the `fields` the live `list_issues` lets a caller select, `delegate` among them. */
export const LIST_ISSUES_SELECTABLE_FIELDS = [
  'id',
  'uuid',
  'title',
  'description',
  'projectMilestone',
  'priority',
  'estimate',
  'url',
  'gitBranchName',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'completedAt',
  'startedAt',
  'canceledAt',
  'startedTriageAt',
  'triagedAt',
  'dueDate',
  'slaStartedAt',
  'slaMediumRiskAt',
  'slaHighRiskAt',
  'slaBreachesAt',
  'slaType',
  'status',
  'statusType',
  'labels',
  'triageIntel',
  'createdBy',
  'createdById',
  'assignee',
  'assigneeId',
  'delegate',
  'delegateId',
  'project',
  'projectId',
  'parentId',
  'team',
  'teamId',
  'cycleId',
] as const;
