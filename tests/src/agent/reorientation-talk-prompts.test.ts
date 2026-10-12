import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import type { ProposalInput } from '../../../src/agent/reorientation-proposal';
import {
  PLAIN_PUNCTUATION_IN_EVERY_FIELD,
  PLAIN_PUNCTUATION_RULE,
} from '../../../src/agent/drafted-text-rules';
import {
  REORIENTATION_COMPLETE_TOOL,
  REORIENTATION_TALK_PROMPT_CACHE_KEY,
  TALK_FINISH_NOTE,
  currentProposalWords,
  talkSystemPrompt,
} from '../../../src/agent/reorientation-talk-prompts';

/*
 * The Discuss talk's system prompt (16-D; the wave file's 5.3): built from the card, it says the
 * trigger, the evidence, the current clause or edge, the proposed change and asks one question per
 * affected item, and the `reorientationComplete` tool's words. A new prompt (the standard's 15.2).
 */

/** The handover's quickest card: a change of role, reaching the whole charter. */
const INPUT: ProposalInput = {
  employeeName: 'Mira',
  roleFunction: 'Triage tier-2 asks in #revops-asks.',
  trigger: 'role-changed',
  summary: 'Priya now approves committee-deck numbers',
  evidence: ['Work affected: “Answer the tier-2 ask about the committee deck”, plan-pending'],
  candidates: [
    {
      kind: 'charter-clause',
      field: 'willDo',
      index: 0,
      text: 'Triage tier-2 asks in #revops-asks',
    },
    {
      kind: 'charter-clause',
      field: 'escalationTriggers',
      index: 0,
      text: 'Surface tier-2 answer drafts to the manager for review',
    },
    {
      kind: 'relationship',
      relationshipId: 'rel-1' as Id<'relationships'>,
      description: 'Priya Shah (approver, for committee-deck numbers), active',
      type: 'approval-authority',
    },
  ],
};

describe('the talk’s system prompt', (): void => {
  it('says the trigger, the evidence and the numbered items the change reaches', (): void => {
    const system = talkSystemPrompt(INPUT, { kind: 'pending' });
    expect(system).toContain('You are Mira. Your role: Triage tier-2 asks in #revops-asks.');
    expect(system).toContain('What changed: Priya now approves committee-deck numbers');
    expect(system).toContain(
      '- Work affected: “Answer the tier-2 ask about the committee deck”, plan-pending',
    );
    expect(system).toContain(
      '2. Charter clause (Escalates when): “Surface tier-2 answer drafts to the manager for review” [edit-clause]',
    );
    expect(system).toContain(
      '3. Person: Priya Shah (approver, for committee-deck numbers), active [relationship: edit, retire]',
    );
  });

  it('says what the card proposes now', (): void => {
    expect(
      talkSystemPrompt(INPUT, {
        kind: 'charter-change',
        changes: [
          {
            kind: 'edit-clause',
            field: 'escalationTriggers',
            index: 0,
            text: 'Surface committee-deck drafts to Priya first',
          },
        ],
        rationale: 'Priya approves them now.',
        before: 'Surface tier-2 answer drafts to the manager for review',
        after: 'Surface committee-deck drafts to Priya first',
      }),
    ).toContain(
      'What the card proposes now: rewrite “Surface tier-2 answer drafts to the manager for review” as “Surface committee-deck drafts to Priya first”. Why: Priya approves them now.',
    );
  });

  it('asks one question a turn, at most one per item, and ends on the card by the tool', (): void => {
    const system = talkSystemPrompt(INPUT, { kind: 'pending' });
    expect(system).toContain('Ask one question a turn');
    expect(system).toContain('at most one question for each numbered item');
    expect(system).toContain('call reorientationComplete');
    expect(system).toContain('Nothing changes until the manager approves the card');
  });

  it('holds its turns and the words it puts on the card to the house copy rules (the walk’s W-2)', (): void => {
    const system = talkSystemPrompt(INPUT, { kind: 'pending' });
    expect(system).toContain(PLAIN_PUNCTUATION_RULE);
    expect(system).toContain(PLAIN_PUNCTUATION_IN_EVERY_FIELD);
    expect(system).not.toContain('—');
  });

  it('is cached under its own key, moved with the prompt (v2: the scope phrase, W16-R3)', (): void => {
    expect(REORIENTATION_TALK_PROMPT_CACHE_KEY).toBe('day0-reorientation-talk-v2');
  });

  it('asks for a relationship’s new scope as a phrase, never a sentence (W16-R3, D-3 (a))', (): void => {
    const phrase =
      'a short phrase naming what the relationship covers, such as “NetLedger journal changes”, never a sentence';
    expect(talkSystemPrompt(INPUT, { kind: 'pending' })).toContain(
      `\`text\` is the new scope for edit: ${phrase}.`,
    );
    expect(REORIENTATION_COMPLETE_TOOL.text).toContain(phrase);
  });
});

describe('the card’s proposal in the talk’s words', (): void => {
  it('says each kind by what it changes', (): void => {
    expect(currentProposalWords({ kind: 'pending' }, INPUT.candidates)).toBe(
      'nothing yet: the card is still working out what to propose',
    );
    expect(
      currentProposalWords({ kind: 'pending', failedAt: 1, failure: 'timeout' }, INPUT.candidates),
    ).toBe('nothing: the card could not work out a proposal');
    expect(
      currentProposalWords(
        { kind: 'none', rationale: 'Only the title changed.' },
        INPUT.candidates,
      ),
    ).toBe('that nothing needs to change. Why: Only the title changed.');
    expect(
      currentProposalWords(
        {
          kind: 'relationship',
          relationshipId: 'rel-1' as Id<'relationships'>,
          action: 'retire',
          rationale: 'Priya left.',
        },
        INPUT.candidates,
      ),
    ).toBe('retire Priya Shah (approver, for committee-deck numbers), active. Why: Priya left.');
    expect(
      currentProposalWords(
        { kind: 'scope', scope: 'linear:write', action: 'revoke', rationale: 'Refused thrice.' },
        INPUT.candidates,
      ),
    ).toBe('revoke access “linear:write”. Why: Refused thrice.');
  });
});

describe('the reorientationComplete tool', (): void => {
  it('says it changes nothing, and that its quotes are the manager’s own words', (): void => {
    expect(REORIENTATION_COMPLETE_TOOL.description).toContain('changes nothing');
    expect(REORIENTATION_COMPLETE_TOOL.quotes).toContain('copied exactly');
    expect(REORIENTATION_COMPLETE_TOOL.quotes).toContain('never your own');
    expect(TALK_FINISH_NOTE).toContain('reorientationComplete');
  });
});
