/**
 * The 16 September draft in which GLM 5.3 Flash wrote a provenance suffix on
 * every clause and none in the next draft (run record, "16 Sep run", finding
 * 4). The clauses are the 14 September wording with the suffix appended, as
 * the record describes; the bed was not exported.
 */

export const PROVENANCE_SUFFIX_2026_09_16 = ' (from manager 1:1 day-1)';

const suffixed = (text: string): string => {
  const trailing = /[.]$/.test(text) ? '.' : '';
  return `${text.replace(/[.]$/, '')}${PROVENANCE_SUFFIX_2026_09_16}${trailing}`;
};

export const GLM_DRAFT_2026_09_16 = {
  whyThisHire: suffixed('A small RevOps team is drowning in tier-2 asks during the Q3 close.'),
  proposedFunction: suffixed(
    'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
  ),
  evidence: [
    { text: suffixed('Formal work is in Linear, team REVOPS, project Q3 close.'), source: 'from manager 1:1 day-1' },
  ],
  shortTermGoals: {
    day30: suffixed('Clean drafts on tickets.'),
    day60: suffixed('Own routine tickets.'),
    day90: suffixed('Cover close-week tracker maintenance.'),
  },
  proposedBoundaries: {
    willDo: [
      suffixed('Handle owned, prioritized Linear tickets in the Q3 close project.'),
      suffixed('Draft replies to asks in #revops-asks.'),
    ],
    willNotDo: [suffixed('Post to public Slack channels.')],
    escalationTriggers: [suffixed('A ticket outside the Q3 close project.')],
  },
  namedCollaborators: [{ name: 'Priya', topic: 'pipeline', introPath: 'manager' as const }],
  namedSystems: [
    { name: 'Linear', class: 'kanban' as const, whereMentioned: 'Formal work is in Linear, team REVOPS, project Q3 close.' },
    { name: 'Slack', class: 'chat' as const, whereMentioned: 'Asks arrive in Slack #revops-asks.' },
  ],
  priorityReading: [suffixed('team overview')],
  adjacentRoles: [],
  approvalChain: { boss: '', confidence: 'high' as const },
  openQuestions: ['Whether Northstar CRM access will be granted.'],
  constraints: [
    {
      kind: 'system-boundary' as const,
      quote: 'Never post to public channels.',
      wording: [suffixed('Post to public Slack channels.')],
    },
  ],
};

/** The same draft as the clauses should read. */
export const CLEAN_CLAUSES_2026_09_16 = {
  whyThisHire: 'A small RevOps team is drowning in tier-2 asks during the Q3 close.',
  proposedFunction:
    'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
  evidenceText: 'Formal work is in Linear, team REVOPS, project Q3 close.',
  willDo: [
    'Handle owned, prioritized Linear tickets in the Q3 close project.',
    'Draft replies to asks in #revops-asks.',
  ],
  willNotDo: ['Post to public Slack channels.'],
  escalationTriggers: ['A ticket outside the Q3 close project.'],
  priorityReading: ['team overview'],
  shortTermGoals: {
    day30: 'Clean drafts on tickets.',
    day60: 'Own routine tickets.',
    day90: 'Cover close-week tracker maintenance.',
  },
};
