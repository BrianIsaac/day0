/**
 * The tools Linear's MCP server lists, by name and argument name, as the run of 17 September 2026
 * recorded them (`tests/fixtures/recording-2026-09-17-trace.json`, the Linear surface's
 * `toolArguments`, 66 tools), and the `fields` the live `list_issues` let a caller select (recorded
 * 2 October, `LIST_ISSUES_SELECTABLE_FIELDS`).
 *
 * The walks of 3 October counted 68 tools for an app actor's token and 59 for a person's key, the
 * nine `*_diff*` tools listed to the app alone (R41V-7, the re-walk, row 6). So the fake lists every
 * recorded tool to an app and every one but the diff tools to a person; the two tools Linear added
 * between the recordings are not named in any record, and a real walk must list them. The argument
 * types and descriptions are not recorded: each argument is a string unless its name says
 * otherwise, which a real walk's `tools/list` must confirm.
 */

/** @type {ReadonlyArray<readonly [string, readonly string[]]>} */
export const RECORDED_TOOLS = [
  ['get_agent_skill', ['id']],
  ['get_attachment', ['format', 'id']],
  ['get_diff', ['urlOrId']],
  ['get_diff_threads', ['orderBy', 'resolved', 'threadId', 'urlOrId']],
  ['get_document', ['id']],
  ['get_issue', ['id', 'includeCustomerNeeds', 'includeRelations', 'includeReleases']],
  ['get_issue_status', ['id', 'name', 'team']],
  ['get_milestone', ['project', 'query']],
  ['get_notifications', ['cursor', 'limit', 'unreadOnly']],
  [
    'get_project',
    [
      'customerNeedsCursor',
      'customerNeedsLimit',
      'includeCustomerNeeds',
      'includeMembers',
      'includeMilestones',
      'includeResources',
      'query',
    ],
  ],
  ['get_release', ['id', 'includeReleaseNotes']],
  ['get_release_note', ['id', 'includeReleases']],
  [
    'get_status_updates',
    [
      'createdAt',
      'cursor',
      'id',
      'includeArchived',
      'initiative',
      'limit',
      'orderBy',
      'project',
      'type',
      'updatedAt',
      'user',
    ],
  ],
  ['get_team', ['query']],
  ['get_template', ['id']],
  ['get_user', ['query']],
  ['get_workspace', []],
  ['list_agent_skills', ['cursor', 'limit', 'orderBy']],
  [
    'list_comments',
    [
      'cursor',
      'documentId',
      'initiativeId',
      'issueId',
      'limit',
      'milestoneId',
      'orderBy',
      'projectId',
      'statusUpdateId',
      'statusUpdateType',
    ],
  ],
  ['list_cycles', ['teamId', 'type']],
  [
    'list_diffs',
    [
      'author',
      'cursor',
      'limit',
      'orderBy',
      'owner',
      'query',
      'repo',
      'reviewer',
      'reviewState',
      'status',
    ],
  ],
  [
    'list_documents',
    [
      'createdAt',
      'creatorId',
      'cursor',
      'fields',
      'includeArchived',
      'initiativeId',
      'limit',
      'orderBy',
      'projectId',
      'query',
      'teamId',
      'updatedAt',
    ],
  ],
  [
    'list_issue_labels',
    ['cursor', 'includeArchived', 'includeGroups', 'limit', 'name', 'orderBy', 'team'],
  ],
  ['list_issue_statuses', ['team']],
  [
    'list_issues',
    [
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
  ],
  ['list_milestones', ['project']],
  [
    'list_project_labels',
    ['cursor', 'includeArchived', 'includeGroups', 'limit', 'name', 'orderBy'],
  ],
  [
    'list_projects',
    [
      'createdAt',
      'cursor',
      'fields',
      'includeArchived',
      'includeMembers',
      'includeMilestones',
      'initiative',
      'label',
      'limit',
      'member',
      'orderBy',
      'query',
      'state',
      'team',
      'updatedAt',
    ],
  ],
  [
    'list_release_notes',
    [
      'createdAt',
      'cursor',
      'includeArchived',
      'includeContent',
      'includeReleases',
      'limit',
      'orderBy',
      'pipeline',
      'query',
      'release',
      'updatedAt',
    ],
  ],
  [
    'list_release_pipelines',
    [
      'createdAt',
      'cursor',
      'includeArchived',
      'includeStages',
      'includeTeams',
      'isProduction',
      'limit',
      'orderBy',
      'query',
      'team',
      'type',
      'updatedAt',
    ],
  ],
  [
    'list_releases',
    [
      'createdAt',
      'cursor',
      'hasReleaseNotes',
      'includeArchived',
      'includeReleaseNotes',
      'limit',
      'orderBy',
      'pipeline',
      'query',
      'stage',
      'stageType',
      'updatedAt',
      'version',
    ],
  ],
  [
    'list_teams',
    ['createdAt', 'cursor', 'includeArchived', 'limit', 'orderBy', 'query', 'updatedAt'],
  ],
  ['list_templates', ['team', 'type']],
  ['list_users', ['cursor', 'limit', 'orderBy', 'query', 'team']],
  ['search_documentation', ['page', 'query']],
  [
    'create_attachment',
    ['base64Content', 'contentType', 'filename', 'issue', 'sha256', 'size', 'subtitle', 'title'],
  ],
  ['create_attachment_from_upload', ['assetUrl', 'issue', 'subtitle', 'title']],
  ['create_issue_label', ['color', 'description', 'isGroup', 'name', 'parent', 'teamId']],
  ['delete_attachment', ['id']],
  ['delete_comment', ['id']],
  ['delete_diff_comment', ['commentId', 'draftId']],
  ['delete_status_update', ['id', 'type']],
  ['extract_images', ['markdown']],
  ['mark_notification', ['id', 'read', 'snoozedUntilAt']],
  ['merge_diff', ['mergeMethod', 'urlOrId']],
  ['prepare_attachment_upload', ['contentType', 'filename', 'issue', 'size', 'subtitle', 'title']],
  ['resolve_diff_thread', ['resolved', 'threadId']],
  ['restore_issue_label', ['id']],
  ['restore_project_label', ['id']],
  ['retire_issue_label', ['id']],
  ['retire_project_label', ['id']],
  [
    'save_comment',
    [
      'body',
      'documentId',
      'id',
      'initiativeId',
      'issueId',
      'milestoneId',
      'parentId',
      'projectId',
      'statusUpdateId',
      'statusUpdateType',
    ],
  ],
  [
    'save_diff_comment',
    ['anchor', 'anchorContent', 'body', 'commentId', 'draft', 'draftId', 'parentId', 'urlOrId'],
  ],
  [
    'save_document',
    [
      'color',
      'content',
      'cycle',
      'icon',
      'id',
      'initiative',
      'issue',
      'patch',
      'project',
      'team',
      'title',
    ],
  ],
  [
    'save_issue',
    [
      'addLabels',
      'addReleases',
      'assignee',
      'blockedBy',
      'blocks',
      'cycle',
      'delegate',
      'description',
      'dueDate',
      'duplicateOf',
      'estimate',
      'id',
      'labels',
      'links',
      'milestone',
      'parentId',
      'patch',
      'priority',
      'project',
      'relatedTo',
      'removeBlockedBy',
      'removeBlocks',
      'removeLabels',
      'removeRelatedTo',
      'removeReleases',
      'setReleases',
      'slaBreachesAt',
      'slaType',
      'state',
      'team',
      'template',
      'title',
    ],
  ],
  ['save_issue_label', ['color', 'description', 'id', 'isGroup', 'name', 'parent', 'teamId']],
  ['save_milestone', ['description', 'id', 'name', 'project', 'targetDate']],
  [
    'save_project',
    [
      'addInitiatives',
      'addTeams',
      'color',
      'description',
      'icon',
      'id',
      'labels',
      'lead',
      'leadTeam',
      'links',
      'name',
      'patch',
      'priority',
      'removeInitiatives',
      'removeTeams',
      'setInitiatives',
      'setTeams',
      'startDate',
      'startDateResolution',
      'state',
      'summary',
      'targetDate',
      'targetDateResolution',
      'template',
    ],
  ],
  ['save_project_label', ['color', 'description', 'id', 'isGroup', 'name', 'parent']],
  [
    'save_release',
    [
      'commitSha',
      'completedAt',
      'createdAt',
      'description',
      'id',
      'name',
      'pipeline',
      'stage',
      'startDate',
      'startedAt',
      'targetDate',
      'version',
    ],
  ],
  [
    'save_release_note',
    [
      'content',
      'id',
      'patch',
      'pipeline',
      'rangeFromRelease',
      'rangeToRelease',
      'releases',
      'title',
    ],
  ],
  ['save_status_update', ['body', 'health', 'id', 'initiative', 'isDiffHidden', 'project', 'type']],
  ['share_issue', ['issue', 'user']],
  ['submit_diff_review', ['body', 'decision', 'urlOrId']],
  ['unshare_issue', ['issue', 'user']],
  [
    'update_diff',
    [
      'addedIssueLinks',
      'addedReviewRequests',
      'description',
      'removedIssueLinks',
      'removedReviewRequests',
      'statusAction',
      'title',
      'urlOrId',
    ],
  ],
];

/** The `fields` the live `list_issues` let a caller select (recorded 2 October 2026). */
export const LIST_ISSUES_FIELDS = [
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
];

/** Whether a tool is one the walks saw listed to an app actor alone (R41V-7). */
export function appOnly(name) {
  return /(^|_)diffs?(_|$)/.test(name);
}

/**
 * One argument's schema, by its name: a number for a count, a boolean for a switch, a list for the
 * plural lists, a string otherwise.
 *
 * @param {string} tool
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function argumentSchema(tool, name) {
  if (tool === 'list_issues' && name === 'fields') {
    return { type: 'array', items: { type: 'string', enum: LIST_ISSUES_FIELDS } };
  }
  if (/^(limit|size|page|estimate|priority|customerNeedsLimit)$/.test(name))
    return { type: 'number' };
  if (/^(include|is|has|unread|resolved|read|draft)[A-Z]?/.test(name)) return { type: 'boolean' };
  if (
    /^(fields|labels|links|addLabels|removeLabels|addReleases|removeReleases|setReleases|blocks|blockedBy|relatedTo|removeBlocks|removeBlockedBy|removeRelatedTo|addTeams|removeTeams|setTeams|addInitiatives|removeInitiatives|setInitiatives|releases)$/.test(
      name,
    )
  ) {
    return { type: 'array', items: { type: 'string' } };
  }
  return { type: 'string' };
}

/**
 * The tool definitions `tools/list` answers for an actor.
 *
 * @param {boolean} app whether the token acts as an app user
 * @returns {Array<{ name: string, description: string, inputSchema: Record<string, unknown> }>}
 */
export function toolDefinitions(app) {
  return RECORDED_TOOLS.filter(([name]) => app || !appOnly(name)).map(([name, args]) => ({
    name,
    description: `${name.replace(/_/g, ' ')} (Linear MCP, as this test double lists it).`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(args.map((arg) => [arg, argumentSchema(name, arg)])),
    },
  }));
}
