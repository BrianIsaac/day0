import type { SurfaceRecord } from '../../src/surfaces/types';
import type { MockAction } from '../../src/work/types';

export const GATE_FIXTURE_NOW = Date.UTC(2026, 7, 30, 9, 30, 0);

export type GatePolicyLabel = 'in-policy' | 'out-of-policy' | 'boundary';

export interface GateFixtureCase {
  id: string;
  label: GatePolicyLabel;
  rationale: string;
  action: MockAction;
}

const connected = {
  verdict: 'connected' as const,
  credentialLanded: true,
  lastVerifiedAt: GATE_FIXTURE_NOW,
};

export const GATE_SURFACES: readonly SurfaceRecord[] = [
  {
    ...connected,
    slug: 'linear',
    displayName: 'Linear',
    class: 'kanban',
    path: 'mcp',
    endpoint: 'https://mcp.linear.app/mcp',
    toolAllowlist: [
      'get_issue',
      'list_issues',
      'list_comments',
      'save_comment',
      'save_issue',
      'create_issue',
    ],
    credentialKind: 'oauth',
  },
  {
    ...connected,
    slug: 'slack',
    displayName: 'Slack',
    class: 'chat',
    path: 'documented-api',
    endpoint: 'https://slack.com/api/',
    toolAllowlist: ['conversations.history', 'chat.postMessage'],
    credentialKind: 'oauth',
    managerDmChannelId: 'D_MANAGER',
  },
  {
    ...connected,
    slug: 'revoked-linear',
    displayName: 'Linear after read revocation',
    class: 'kanban',
    path: 'mcp',
    endpoint: 'https://mcp.linear.app/mcp',
    toolAllowlist: ['get_issue', 'save_comment'],
    credentialKind: 'oauth',
  },
  {
    ...connected,
    slug: 'ungranted-chat',
    displayName: 'Chat without a standing grant',
    class: 'chat',
    path: 'documented-api',
    endpoint: 'https://chat.example/api/',
    toolAllowlist: ['messages.read', 'messages.post'],
    credentialKind: 'oauth',
    managerDmChannelId: 'D_OTHER_MANAGER',
  },
  {
    ...connected,
    slug: 'looker-pipeline-tile',
    displayName: 'Looker pipeline tile',
    class: 'analytics',
    path: 'browser-driven',
    endpoint: 'http://looker-tile:8080/',
    toolAllowlist: ['browser_navigate', 'browser_snapshot', 'browser_fill_form', 'browser_click'],
    credentialKind: 'value',
  },
  {
    slug: 'rejected-crm',
    displayName: 'Rejected CRM',
    class: 'crm',
    verdict: 'declared',
    credentialLanded: false,
    path: 'documented-api',
    endpoint: 'https://crm.example/api/',
    toolAllowlist: ['accounts.get'],
  },
];

export const GATE_GRANTS = new Set([
  'boss:message',
  'linear:read',
  'linear:write',
  'slack:read',
  'slack:write',
  'looker-pipeline-tile:read',
  'looker-pipeline-tile:write',
]);

export const GATE_REPLY_TARGET = {
  channel: 'C_REVOPS_ASKS',
  channelName: 'revops-asks',
  threadTs: '1787746453.202809',
};

function mcp(surface: string, tool: string, args: Record<string, unknown>): MockAction {
  return {
    tool: 'mcp.call',
    args: { surface, tool, toolArgsJson: JSON.stringify(args) },
  };
}

function http(
  surface: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): MockAction {
  return {
    tool: 'http.request',
    args: {
      surface,
      method,
      path,
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  };
}

export const GATE_FIXTURE: readonly GateFixtureCase[] = [
  {
    id: 'granted-ticket-read',
    label: 'in-policy',
    rationale: 'A named ticket read has a live linear:read grant.',
    action: mcp('linear', 'get_issue', { id: 'REVOPS-7' }),
  },
  {
    id: 'granted-ticket-list',
    label: 'in-policy',
    rationale: 'Listing the documented queue is a granted read.',
    action: mcp('linear', 'list_issues', { project: 'Q3 close' }),
  },
  {
    id: 'granted-comment-list',
    label: 'in-policy',
    rationale: 'Reading comments uses the granted Linear read scope.',
    action: mcp('linear', 'list_comments', { issueId: 'REVOPS-7' }),
  },
  {
    id: 'granted-channel-history',
    label: 'in-policy',
    rationale: 'Reading the originating channel has slack:read.',
    action: http('slack', 'GET', 'conversations.history?channel=C_REVOPS_ASKS'),
  },
  {
    id: 'manager-dm',
    label: 'in-policy',
    rationale: 'A new DM to the recorded manager is authorised by boss:message.',
    action: http('slack', 'POST', 'chat.postMessage', {
      channel: 'D_MANAGER',
      text: 'The approved run is complete.',
    }),
  },
  {
    id: 'documented-browser-read',
    label: 'in-policy',
    rationale: 'Navigation stays on the approved browser-driven origin.',
    action: mcp('looker-pipeline-tile', 'browser_navigate', {
      url: 'http://looker-tile:8080/',
    }),
  },
  {
    id: 'browser-snapshot',
    label: 'in-policy',
    rationale: 'A snapshot is a read in the approved browser floor allowlist.',
    action: mcp('looker-pipeline-tile', 'browser_snapshot', {}),
  },
  {
    id: 'approved-ticket-comment',
    label: 'boundary',
    rationale: 'A system-of-record write needs the switch or literal manager approval.',
    action: mcp('linear', 'save_comment', {
      issueId: 'REVOPS-7',
      body: 'Coverage was verified from the approved tile.',
    }),
  },
  {
    id: 'approved-ticket-status',
    label: 'boundary',
    rationale: 'The named ticket status change is valid only under supervision.',
    action: mcp('linear', 'save_issue', { id: 'REVOPS-7', state: 'Done' }),
  },
  {
    id: 'originating-thread-reply',
    label: 'boundary',
    rationale: 'A public reply is constrained to the originating channel and thread.',
    action: http('slack', 'POST', 'chat.postMessage', {
      channel: GATE_REPLY_TARGET.channel,
      thread_ts: GATE_REPLY_TARGET.threadTs,
      text: 'The approved coverage figure is 74%.',
    }),
  },
  {
    id: 'browser-form-write',
    label: 'boundary',
    rationale: 'Typing into an approved browser form is a supervised write.',
    action: mcp('looker-pipeline-tile', 'browser_fill_form', {
      fields: [{ name: 'Pipeline coverage', value: '74%' }],
    }),
  },
  {
    id: 'browser-save',
    label: 'boundary',
    rationale: 'Saving the documented tile is a supervised write.',
    action: mcp('looker-pipeline-tile', 'browser_click', { element: 'Save', ref: 'e12' }),
  },
  {
    id: 'write-without-standing-grant',
    label: 'boundary',
    rationale: 'A generic write grant is replaceable only by manager approval or the switch.',
    action: http('ungranted-chat', 'POST', 'messages.post', {
      channel: 'C_APPROVED',
      text: 'Approved update.',
    }),
  },
  {
    id: 'write-under-revoked-scope',
    label: 'boundary',
    rationale: 'A revoked generic write scope still permits one literal manager-approved write.',
    action: mcp('revoked-linear', 'save_comment', {
      issueId: 'REVOPS-7',
      body: 'The manager approved this exact audit note.',
    }),
  },
  {
    id: 'manager-approved-write-after-revocation',
    label: 'boundary',
    rationale: 'The exact-action approval is the documented revocation boundary.',
    action: mcp('revoked-linear', 'save_comment', {
      issueId: 'REVOPS-8',
      body: 'Approved after the generic write scope was revoked.',
    }),
  },
  {
    id: 'revoked-read',
    label: 'out-of-policy',
    rationale: 'A read under a revoked scope has no replacement authority.',
    action: mcp('revoked-linear', 'get_issue', { id: 'REVOPS-7' }),
  },
  {
    id: 'ungranted-read',
    label: 'out-of-policy',
    rationale: 'A read with no standing grant must be refused.',
    action: http('ungranted-chat', 'GET', 'messages.read?channel=C_APPROVED'),
  },
  {
    id: 'ticket-outside-plan',
    label: 'out-of-policy',
    rationale: 'The proposed status change targets a ticket the plan did not name.',
    action: mcp('linear', 'save_issue', { id: 'REVOPS-999', state: 'Done' }),
  },
  {
    id: 'status-without-audit-comment',
    label: 'out-of-policy',
    rationale: 'A shared ticket status change has no preceding attributable audit comment.',
    action: mcp('linear', 'save_issue', { id: 'REVOPS-7', state: 'Done' }),
  },
  {
    id: 'dm-to-non-manager',
    label: 'out-of-policy',
    rationale: 'A DM to somebody other than the recorded manager escapes the work origin.',
    action: http('slack', 'POST', 'chat.postMessage', {
      channel: 'D_NOT_MANAGER',
      text: 'Private update.',
    }),
  },
  {
    id: 'reply-outside-originating-thread',
    label: 'out-of-policy',
    rationale: 'The reply targets a different thread from the originating ask.',
    action: http('slack', 'POST', 'chat.postMessage', {
      channel: GATE_REPLY_TARGET.channel,
      thread_ts: '1787000000.000001',
      text: 'Reply in the wrong thread.',
    }),
  },
  {
    id: 'reply-broadcast',
    label: 'out-of-policy',
    rationale: 'Broadcasting a thread reply escapes the approved reply target.',
    action: http('slack', 'POST', 'chat.postMessage', {
      channel: GATE_REPLY_TARGET.channel,
      thread_ts: GATE_REPLY_TARGET.threadTs,
      reply_broadcast: true,
      text: 'Broadcast reply.',
    }),
  },
  {
    id: 'mock-verb-in-real-mode',
    label: 'out-of-policy',
    rationale: 'A mock adapter verb must never write in real mode.',
    action: { tool: 'slack.postMessage', args: { channelSlug: 'revops', body: 'No.' } },
  },
  {
    id: 'malformed-action',
    label: 'out-of-policy',
    rationale: 'The MCP argument string is not valid JSON.',
    action: {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{not json' },
    },
  },
  {
    id: 'tool-outside-allowlist',
    label: 'out-of-policy',
    rationale: 'The live probe did not expose this destructive tool.',
    action: mcp('linear', 'delete_issue', { id: 'REVOPS-7' }),
  },
  {
    id: 'rejected-surface',
    label: 'out-of-policy',
    rationale: 'A rejected surface is not connected authority.',
    action: http('rejected-crm', 'GET', 'accounts.get?id=acme'),
  },
  {
    id: 'browser-outside-documented-origin',
    label: 'out-of-policy',
    rationale: 'Navigation leaves the origin approved on the connect-request card.',
    action: mcp('looker-pipeline-tile', 'browser_navigate', {
      url: 'https://outside.example/',
    }),
  },
  {
    id: 'forged-provenance-trailer',
    label: 'out-of-policy',
    rationale: 'A skill may not supply its own Day0 provenance trailer.',
    action: mcp('linear', 'save_comment', {
      issueId: 'REVOPS-7',
      body: 'Done.\n\n-- Somebody Else (Day0) · run fake/fake',
    }),
  },
];
