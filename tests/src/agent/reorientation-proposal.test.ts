import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  ProposalRefused,
  proposalOf,
  proposalPrompt,
  proposalReplySchema,
  type ProposalCandidate,
  type ProposalReply,
} from '../../../src/agent/reorientation-proposal';

const page = { sourceId: 'source-1' as Id<'docSources'>, ref: 'revops/escalation-paths.md' };
const successor = {
  sourceId: 'source-1' as Id<'docSources'>,
  ref: 'revops/escalation-paths-v2.md',
};

const CANDIDATES: readonly ProposalCandidate[] = [
  { kind: 'charter-clause', field: 'willDo', index: 2, text: 'Triage tier-2 asks' },
  {
    kind: 'agreement',
    agreementId: 'agreement-1' as Id<'workingAgreements'>,
    statement: 'Cc Priya',
    actions: ['keep', 'edit', 'retire'],
  },
  {
    kind: 'relationship',
    relationshipId: 'edge-1' as Id<'relationships'>,
    description: 'Priya (approval authority), active',
    type: 'approval-authority',
  },
  {
    kind: 'page',
    page,
    title: 'Escalation paths',
    status: 'active',
    supersededBy: { page: successor, title: 'Escalation paths, version 2' },
  },
  { kind: 'scope', scope: 'linear:write', held: false },
  { kind: 'skill', skillId: 'skill-1' as Id<'skills'>, name: 'kanban-comment-and-close' },
];

/** A reply with the fields a test does not set left empty. */
function reply(fields: Partial<ProposalReply>): ProposalReply {
  return {
    change: 'none',
    candidate: null,
    action: null,
    text: null,
    rationale: 'Because.',
    ...fields,
  };
}

describe('proposalPrompt', (): void => {
  it('numbers every candidate with the actions it takes', (): void => {
    const prompt = proposalPrompt({
      employeeName: 'Mira',
      roleFunction: 'Triage tier-2 asks.',
      trigger: 'page-status-changed',
      summary: '“Escalation paths” was superseded',
      evidence: ['Work affected: “Answer the ask”, plan-approved'],
      candidates: CANDIDATES,
    });
    expect(prompt).toContain('You are Mira. Your role: Triage tier-2 asks.');
    expect(prompt).toContain('- Work affected: “Answer the ask”, plan-approved');
    expect(prompt).toContain('1. Charter clause (Will do): “Triage tier-2 asks” [edit-clause]');
    expect(prompt).toContain(
      '4. Page “Escalation paths”, now active; its successor is “Escalation paths, version 2” [page-status: superseded, archived, draft]',
    );
    expect(prompt).toContain('5. Access “linear:write”, not held [scope: grant]');
  });

  it('says the only answer is none when the card holds no candidate', (): void => {
    expect(
      proposalPrompt({
        employeeName: 'Mira',
        roleFunction: 'Triage.',
        trigger: 'access-ended',
        summary: 'Linear access ended',
        evidence: [],
        candidates: [],
      }),
    ).toContain('(none: the only answer is `none`)');
  });
});

describe('proposalOf: a reply read against the card’s candidates', (): void => {
  it('reads each change into the target and action Approve applies it through', (): void => {
    expect(
      proposalOf(
        reply({ change: 'edit-clause', candidate: 1, text: 'Triage tier-2 asks daily' }),
        CANDIDATES,
      ),
    ).toEqual({
      kind: 'charter-change',
      changes: [
        { kind: 'edit-clause', field: 'willDo', index: 2, text: 'Triage tier-2 asks daily' },
      ],
      rationale: 'Because.',
      before: 'Triage tier-2 asks',
      after: 'Triage tier-2 asks daily',
    });
    expect(
      proposalOf(reply({ change: 'agreement', candidate: 2, action: 'Retire' }), CANDIDATES),
    ).toEqual({
      kind: 'agreement',
      agreementId: 'agreement-1',
      action: 'retire',
      rationale: 'Because.',
    });
    expect(
      proposalOf(
        reply({ change: 'relationship', candidate: 3, action: 'edit', text: 'renewals only' }),
        CANDIDATES,
      ),
    ).toEqual({
      kind: 'relationship',
      relationshipId: 'edge-1',
      action: 'edit',
      type: 'approval-authority',
      scope: 'renewals only',
      rationale: 'Because.',
    });
    expect(
      proposalOf(reply({ change: 'page-status', candidate: 4, action: 'superseded' }), CANDIDATES),
    ).toEqual({
      kind: 'page-status',
      page,
      status: 'superseded',
      supersededBy: successor,
      rationale: 'Because.',
    });
    expect(
      proposalOf(reply({ change: 'scope', candidate: 5, action: 'grant' }), CANDIDATES),
    ).toEqual({
      kind: 'scope',
      scope: 'linear:write',
      action: 'grant',
      rationale: 'Because.',
    });
    expect(
      proposalOf(reply({ change: 'skill', candidate: 6, action: 'recheck' }), CANDIDATES),
    ).toEqual({
      kind: 'skill-action',
      skillId: 'skill-1',
      action: 'recheck',
      rationale: 'Because.',
    });
    expect(proposalOf(reply({ change: 'none' }), CANDIDATES)).toEqual({
      kind: 'none',
      rationale: 'Because.',
    });
  });

  it('refuses a candidate the card does not hold, one of another kind, or an action it does not take', (): void => {
    const refusals: Array<[Partial<ProposalReply>, string]> = [
      [{ change: 'skill', candidate: 7, action: 'recheck' }, 'which the card does not hold'],
      [{ change: 'skill', candidate: null, action: 'recheck' }, 'which the card does not hold'],
      [{ change: 'skill', candidate: 1, action: 'recheck' }, 'is a charter-clause, not a skill'],
      [{ change: 'scope', candidate: 5, action: 'revoke' }, 'is not one of grant'],
      [
        { change: 'agreement', candidate: 2, action: 'activate' },
        'is not one of keep, edit, retire',
      ],
      [
        { change: 'agreement', candidate: 2, action: 'dismiss' },
        'is not one of keep, edit, retire',
      ],
      [{ change: 'agreement', candidate: 2, action: 'edit', text: '  ' }, 'gives no statement'],
      [{ change: 'edit-clause', candidate: 1, text: 'Triage tier-2 asks' }, 'proposed unchanged'],
      [{ change: 'none', rationale: ' ' }, 'gives no rationale'],
    ];
    for (const [fields, words] of refusals) {
      expect((): unknown => proposalOf(reply(fields), CANDIDATES), JSON.stringify(fields)).toThrow(
        ProposalRefused,
      );
      expect((): unknown => proposalOf(reply(fields), CANDIDATES)).toThrow(words);
    }
  });

  it('offers to hand a page back to its source only where the manager set its status (the second pass’s M2)', (): void => {
    const bySource: ProposalCandidate[] = [
      { kind: 'page', page, title: 'Escalation paths', status: 'archived', setByManager: false },
    ];
    expect((): unknown =>
      proposalOf(reply({ change: 'page-status', candidate: 1, action: 'clear' }), bySource),
    ).toThrow('is not one of active, draft');
    const byManager: ProposalCandidate[] = [
      { kind: 'page', page, title: 'Escalation paths', status: 'archived', setByManager: true },
    ];
    expect(
      proposalOf(reply({ change: 'page-status', candidate: 1, action: 'clear' }), byManager),
    ).toMatchObject({ kind: 'page-status', status: 'clear' });
  });

  it('offers a page no status it already has (the walk’s W-1)', (): void => {
    const superseded: ProposalCandidate[] = [
      {
        kind: 'page',
        page,
        title: 'Escalation paths',
        status: 'superseded',
        setByManager: true,
        supersededBy: { page, title: 'Escalation paths, version 2' },
      },
    ];
    expect(
      proposalPrompt({
        employeeName: 'Mira',
        roleFunction: 'Triage tier-2 asks.',
        trigger: 'page-status-changed',
        summary: '“Escalation paths” was superseded',
        evidence: [],
        candidates: superseded,
      }),
    ).toContain('[page-status: active, archived, draft, clear]');
    expect((): unknown =>
      proposalOf(reply({ change: 'page-status', candidate: 1, action: 'superseded' }), superseded),
    ).toThrow('is not one of active, archived, draft, clear');
  });

  it('offers superseded only for a page whose successor the evidence names', (): void => {
    const lone: ProposalCandidate[] = [
      { kind: 'page', page, title: 'Escalation paths', status: 'active' },
    ];
    expect((): unknown =>
      proposalOf(reply({ change: 'page-status', candidate: 1, action: 'superseded' }), lone),
    ).toThrow('is not one of archived, draft');
  });

  it('bounds a rationale and an edit to six hundred characters', (): void => {
    const long = 'word '.repeat(400);
    const proposed = proposalOf(
      reply({ change: 'edit-clause', candidate: 1, text: long, rationale: long }),
      CANDIDATES,
    );
    expect(proposed.rationale).toHaveLength(600);
    expect(proposed.kind === 'charter-change' && proposed.after).toHaveLength(600);
  });
});

describe('proposalReplySchema', (): void => {
  it('takes a flat reply with nulls, and refuses a change it does not know', (): void => {
    expect(proposalReplySchema.safeParse(reply({})).success).toBe(true);
    expect(proposalReplySchema.safeParse({ ...reply({}), change: 'relation' }).success).toBe(false);
  });
});
