/**
 * The permission scopes both comparison arms receive up front.
 *
 * Only systems the seeded mock office actually has are granted, so that a
 * permission-bootstrap difference cannot decide a task and, equally, so that
 * a request from a system the office does not have (a CRM, a pager) is met
 * by each arm's own mechanism: day0's evaluator defers it naming the missing
 * scope, and the ordinary agent has no tool for it either way.
 */
export const MOCK_OFFICE_SYSTEMS = [
  'boss',
  'docs',
  'spreadsheet',
  'slack',
  'social',
  'ticket',
] as const;

export const EVALUATION_SCOPES = [
  'boss:message',
  'docs:read',
  'docs:write',
  'spreadsheet:read',
  'spreadsheet:write',
  'slack:read',
  'slack:write',
  'social:read',
  'social:write',
  'ticket:read',
  'ticket:write',
] as const;
