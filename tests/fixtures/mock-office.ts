/**
 * The systems the seeded mock office has (`convex/mockSeed.ts`): the
 * manager's channel, the documentation, and the four mock surfaces. The
 * evaluation scopes and the out-of-scope tasks are checked against this list.
 */
export const MOCK_OFFICE_SYSTEMS = [
  'boss',
  'docs',
  'spreadsheet',
  'slack',
  'social',
  'ticket',
] as const;
