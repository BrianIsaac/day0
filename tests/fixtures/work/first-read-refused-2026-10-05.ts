import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

/*
 * The walk on real Slack's first read refused by the tool's schema (W12V-12, 4 and 5 October,
 * GLM 5.3 Flash in supervised real mode, the in-tree fake Linear): REVOPS-5's `list_issues` with
 * `fields` as a list, refused by the MCP client against the schema the fake advertises (2
 * October's recording of the live field list), and the one argument repair turning `fields` into
 * a string, refused again (6 of 14 runs on the second pre-tag's bed). The first call and the first
 * message are the walk's (`wave12-v-2026-10-05-handover.md`, W12V-12), the message's elided
 * second line written out in the client's format; the repair's string and the second message were
 * not logged and are written in the same format. Whether live Linear refuses the same call in the
 * same words is not proven: no walk has called Linear with it.
 */

export const LINEAR_LIST: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: 1,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['list_issues', 'get_issue', 'save_comment', 'save_issue'],
  toolArguments: [
    {
      tool: 'list_issues',
      arguments: [
        'assignee',
        'createdAt',
        'cursor',
        'cycle',
        'delegate',
        'fields',
        'includeArchived',
        'label',
        'limit',
        'orderBy',
        'parentId',
        'priority',
        'project',
        'query',
        'release',
        'state',
        'team',
        'updatedAt',
      ],
    },
  ],
};

/** REVOPS-5's first read as GLM wrote it. */
export const FIELDS_AS_LIST_ARGS = {
  team: 'REVOPS',
  project: 'Q3 close',
  state: 'unstarted',
  limit: 50,
  fields: ['id', 'identifier', 'title', 'state'],
};

/** The same read after the one argument repair: `fields` a string. */
export const FIELDS_AS_STRING_ARGS = { ...FIELDS_AS_LIST_ARGS, fields: 'id,identifier,title,state' };

export function listIssues(args: Record<string, unknown>): MockAction {
  return {
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'list_issues', toolArgsJson: JSON.stringify(args) },
  };
}

/** The client's refusal of the first call (the walk's words). */
export const FIELDS_REFUSED = `Tool input validation failed for linear_list_issues. Please fix the following errors and try again:
- fields.1: must be equal to one of the allowed values
- fields.3: must be equal to one of the allowed values

Provided arguments: ${JSON.stringify(FIELDS_AS_LIST_ARGS)}`;

/** The client's refusal of the repaired call. */
export const FIELDS_REFUSED_AGAIN = `Tool input validation failed for linear_list_issues. Please fix the following errors and try again:
- fields: must be array

Provided arguments: ${JSON.stringify(FIELDS_AS_STRING_ARGS)}`;
