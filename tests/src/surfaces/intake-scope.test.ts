import { describe, expect, it } from 'vitest';
import {
  approvedChannelNames,
  approvedLinearScope,
  emptyScopeReason,
  groundScopePicks,
  presentIntakeScope,
  presentScopeDrift,
  roleScopeCandidates,
  scopeCandidates,
  scopeDrift,
  scopeFieldsFor,
  sentenceScopePicks,
  type ScopeCandidate,
  type ScopeField,
  type ScopePage,
} from '../../../src/surfaces/intake-scope';
import { companyPage } from '../../fixtures/company-bed';

const REVOPS = companyPage('revops/handbook.md');
const FINANCE = companyPage('finance/handbook.md');
const LOGISTICS = companyPage('logistics/handbook.md');

/** One page as the folder source stores it. */
function folderPage(page: { ref: string; markdown: string }): ScopePage {
  return { sourceId: 'source-folder', ref: page.ref, markdown: page.markdown };
}

/** A pick as the model answers it: a candidate's number, beside whatever it restates. */
interface AnsweredPick {
  candidate: number;
  field: ScopeField;
  value: string;
  ref: string;
}

/** The number a candidate is offered under: its place in the list, from 1. */
function numberOf(
  candidates: readonly ScopeCandidate[],
  field: ScopeField,
  value: string,
  ref: string,
): number {
  const index = candidates.findIndex(
    (candidate): boolean =>
      candidate.field === field && candidate.value === value && candidate.ref === ref,
  );
  if (index < 0) throw new Error(`No candidate ${field} ${value} on ${ref}.`);
  return index + 1;
}

/** The two handbooks in one order or the other, as one documentation set. */
function pages(order: 'revops-first' | 'finance-first'): ScopePage[] {
  const both = [REVOPS, FINANCE].map(
    (page): ScopePage => ({ sourceId: 'source-folder', ref: page.ref, markdown: page.markdown }),
  );
  return order === 'revops-first' ? both : [...both].reverse();
}

/** The value of each candidate for one field, from one page. */
function valuesOn(candidates: readonly ScopeCandidate[], field: string, ref: string): string[] {
  return candidates
    .filter((candidate): boolean => candidate.field === field && candidate.ref === ref)
    .map((candidate): string => candidate.value);
}

describe('intake scope candidates', (): void => {
  it('reads the fields a work-bearing class has, and none for any other class', (): void => {
    expect(scopeFieldsFor('kanban')).toEqual(['team', 'project']);
    expect(scopeFieldsFor('chat')).toEqual(['channel']);
    expect(scopeFieldsFor('analytics')).toEqual([]);
  });

  it('extracts each documented value per page, with the line that states it', (): void => {
    const linear = scopeCandidates(pages('revops-first'), ['team', 'project']);
    expect(valuesOn(linear, 'team', 'revops/handbook.md')).toEqual(['REVOPS']);
    expect(valuesOn(linear, 'project', 'revops/handbook.md')).toEqual(['Q3 close']);
    expect(valuesOn(linear, 'team', 'finance/handbook.md')).toEqual(['FIN']);
    expect(valuesOn(linear, 'project', 'finance/handbook.md')).toEqual(['September close']);
    expect(linear).toContainEqual({
      field: 'team',
      value: 'FIN',
      sourceId: 'source-folder',
      ref: 'finance/handbook.md',
      quote: '- Team: `FIN`',
    });
    expect(linear).toContainEqual({
      field: 'project',
      value: 'September close',
      sourceId: 'source-folder',
      ref: 'finance/handbook.md',
      quote: '- Project: `September close`',
    });

    const slack = scopeCandidates(pages('revops-first'), ['channel']);
    expect(valuesOn(slack, 'channel', 'revops/handbook.md')).toEqual([
      'revops-asks',
      'revops',
      'ops-requests',
    ]);
    expect(valuesOn(slack, 'channel', 'finance/handbook.md')).toEqual([
      'finance-close',
      'ops-requests',
    ]);
    expect(slack).toContainEqual({
      field: 'channel',
      value: 'finance-close',
      sourceId: 'source-folder',
      ref: 'finance/handbook.md',
      quote: '- Channels: #finance-close, #ops-requests',
    });
    expect(slack.some((candidate): boolean => candidate.field !== 'channel')).toBe(false);
  });

  it('reads a project named inline and a team named by its identifier', (): void => {
    const candidates = scopeCandidates(
      [
        {
          ref: 'linear.md',
          markdown: [
            '# Linear automation',
            '- Team: `RevOps`, identifier `REVOPS`.',
            'Work in project `Q3 close` only.',
          ].join('\n'),
        },
      ],
      ['team', 'project'],
    );
    expect(candidates).toEqual([
      {
        field: 'team',
        value: 'REVOPS',
        ref: 'linear.md',
        quote: '- Team: `RevOps`, identifier `REVOPS`.',
      },
      {
        field: 'team',
        value: 'RevOps',
        ref: 'linear.md',
        quote: '- Team: `RevOps`, identifier `REVOPS`.',
      },
      {
        field: 'project',
        value: 'Q3 close',
        ref: 'linear.md',
        quote: 'Work in project `Q3 close` only.',
      },
    ]);
  });

  it('ties a manager-requested card to the role handbook even without a system sentence', (): void => {
    const all = [...pages('revops-first'), {
      ref: 'logistics/handbook.md', markdown: companyPage('logistics/handbook.md').markdown,
    }];
    const candidates = scopeCandidates(all, ['channel']);
    expect(roleScopeCandidates(all, candidates, 'Close coordinator', [])
      .map((candidate): string => candidate.ref)).toEqual([
        'finance/handbook.md', 'finance/handbook.md',
      ]);
    expect(roleScopeCandidates(all, candidates, 'Logistics desk', [])
      .map((candidate): string => candidate.value)).toEqual([
        'logistics-desk', 'ops-requests',
      ]);
    expect(roleScopeCandidates(all, candidates, 'Assistant', [])).toEqual([]);
    expect(roleScopeCandidates(
      all, candidates, 'Close coordinator', ['Do not read #revops-asks; that is RevOps work.'],
    ).map((candidate): string => candidate.ref)).toEqual([
      'finance/handbook.md', 'finance/handbook.md',
    ]);
  });

  it('ignores quoted runbook examples and another team’s channels mentioned in prose', (): void => {
    const candidates = scopeCandidates(
      [{
        ref: 'finance/handbook.md',
        markdown: [
          '# Finance close handbook',
          '- Team: `FIN`',
          '- Project: `September close`',
          '- Channels: #finance-close, #ops-requests',
          'The RevOps team uses Channels: #revops-asks; finance does not monitor it.',
          '```markdown',
          '- Team: `REVOPS`',
          '- Project: `Q3 close`',
          '- Channels: #revops-asks',
          '```',
        ].join('\n'),
      }],
      ['team', 'project', 'channel'],
    );
    expect(candidates.map(({ field, value }) => [field, value])).toEqual([
      ['team', 'FIN'],
      ['project', 'September close'],
      ['channel', 'finance-close'],
      ['channel', 'ops-requests'],
    ]);
  });

  it.fails('offers the page stating the most first, whatever order the pages were synced in', (): void => {
    // Rehearsal 1 synced the close status note runbook before the finance
    // handbook; both state `September close`, and a model that picks every
    // number keeps whichever is offered first.
    const runbook = companyPage('finance/runbooks/close-status-note.md');
    for (const synced of [[runbook, FINANCE], [FINANCE, runbook]]) {
      const candidates = scopeCandidates(synced.map(folderPage), ['team', 'project']);
      expect(candidates.map(({ field, value, ref }) => [field, value, ref])).toEqual([
        ['team', 'FIN', 'finance/handbook.md'],
        ['project', 'September close', 'finance/handbook.md'],
        ['project', 'September close', 'finance/runbooks/close-status-note.md'],
      ]);
      const everything = groundScopePicks(
        candidates.map((_candidate, index) => ({ candidate: index + 1 })),
        candidates,
      );
      expect(everything.project?.quote).toBe('- Project: `September close`');
    }
  });

  it('does not turn a forbidden foreign project in a role handbook into a queue', (): void => {
    const candidates = scopeCandidates([{
      ref: 'finance/handbook.md',
      markdown: [
        '# Finance close handbook',
        '- Team: `FIN`',
        '- Project: `September close`',
        'Do not read project `Q3 close`; that belongs to RevOps.',
      ].join('\n'),
    }], ['team', 'project']);

    expect(valuesOn(candidates, 'project', 'finance/handbook.md')).toEqual(['September close']);
  });
});

describe('grounding a pick on its candidate', (): void => {
  it('keeps each numbered pick as its candidate states it, with the line that states it', (): void => {
    const candidates = scopeCandidates(pages('revops-first'), ['team', 'project']);
    const scope = groundScopePicks(
      [
        { candidate: numberOf(candidates, 'team', 'FIN', 'finance/handbook.md') },
        { candidate: numberOf(candidates, 'project', 'September close', 'finance/handbook.md') },
      ],
      candidates,
    );
    expect(scope).toEqual({
      team: {
        value: 'FIN',
        sourceId: 'source-folder',
        ref: 'finance/handbook.md',
        quote: '- Team: `FIN`',
      },
      project: {
        value: 'September close',
        sourceId: 'source-folder',
        ref: 'finance/handbook.md',
        quote: '- Project: `September close`',
      },
    });
  });

  it('keeps one team and one project, and every picked channel once', (): void => {
    const linear = scopeCandidates(pages('revops-first'), ['team', 'project']);
    const twoProjects = groundScopePicks(
      [
        { candidate: numberOf(linear, 'project', 'Q3 close', 'revops/handbook.md') },
        { candidate: numberOf(linear, 'project', 'September close', 'finance/handbook.md') },
      ],
      linear,
    );
    expect(twoProjects.project?.value).toBe('Q3 close');
    expect(twoProjects.notes).toEqual([
      "Dropped project `September close`: intake reads projects from revops/handbook.md, not another role's page.",
    ]);

    const slack = scopeCandidates(pages('revops-first'), ['channel']);
    const channels = groundScopePicks(
      [
        { candidate: numberOf(slack, 'channel', 'finance-close', 'finance/handbook.md') },
        { candidate: numberOf(slack, 'channel', 'ops-requests', 'finance/handbook.md') },
        { candidate: numberOf(slack, 'channel', 'ops-requests', 'revops/handbook.md') },
      ],
      slack,
    );
    expect(approvedChannelNames(channels)).toEqual(['finance-close', 'ops-requests']);
    expect(channels.channels?.map((channel): string => channel.ref)).toEqual([
      'finance/handbook.md',
      'finance/handbook.md',
    ]);
    expect(channels.notes).toBeUndefined();
  });

  it('gives each role its own project whichever handbook comes first', (): void => {
    for (const order of ['revops-first', 'finance-first'] as const) {
      const candidates = scopeCandidates(pages(order), ['team', 'project']);
      const finance = groundScopePicks(
        sentenceScopePicks(
          ['Linear, team FIN, project September close, for the close tickets.'],
          candidates,
        ),
        candidates,
      );
      const revops = groundScopePicks(
        sentenceScopePicks(
          ['Linear for the real work, team REVOPS, project Q3 close: the audit note is a ticket.'],
          candidates,
        ),
        candidates,
      );
      expect(approvedLinearScope(finance)).toEqual({ team: 'FIN', project: 'September close' });
      expect(approvedLinearScope(revops)).toEqual({ team: 'REVOPS', project: 'Q3 close' });
      expect(finance.project?.ref).toBe('finance/handbook.md');
      expect(revops.project?.ref).toBe('revops/handbook.md');
    }
  });

  it('keeps two projects stated by one role handbook on the same approved card', (): void => {
    const candidates = scopeCandidates(
      [{
        ref: 'finance/handbook.md',
        markdown: '- Team: `FIN`\n- Project: `September close`\n- Project: `October close`',
      }],
      ['team', 'project'],
    );
    const scope = groundScopePicks([{ candidate: 1 }, { candidate: 2 }, { candidate: 3 }], candidates);
    expect(approvedLinearScope(scope)).toEqual({
      team: 'FIN',
      project: 'September close',
      projects: ['September close', 'October close'],
    });
    expect(scope.notes).toBeUndefined();
    expect(presentIntakeScope('Linear', 'kanban', scope).quotes).toHaveLength(3);
  });

  it("takes the channels the manager's sentence names, and no other role's", (): void => {
    for (const order of ['revops-first', 'finance-first'] as const) {
      const candidates = scopeCandidates(pages(order), ['channel']);
      const finance = groundScopePicks(
        sentenceScopePicks(
          ['Slack: #finance-close is ours, and #ops-requests is the shared request channel.'],
          candidates,
        ),
        candidates,
      );
      expect(approvedChannelNames(finance)).toEqual(['finance-close', 'ops-requests']);
      expect(finance.channels?.map((channel): string => channel.ref)).toEqual([
        'finance/handbook.md',
        'finance/handbook.md',
      ]);
    }
    expect(sentenceScopePicks([], scopeCandidates(pages('revops-first'), ['channel']))).toEqual([]);
  });
});

describe('a pick names its candidate by number', (): void => {
  it("grounds rehearsal 1's picks, whatever the model restated beside the number", (): void => {
    // Priya's Linear card and Aiko's Slack card on 18 September: the right
    // values, each ref carrying the candidate's page line after it, as the
    // rows' `surfaces.intakeScope.notes` recorded them.
    const linear = scopeCandidates([folderPage(REVOPS)], ['team', 'project']);
    const priya: AnsweredPick[] = [
      {
        candidate: numberOf(linear, 'team', 'REVOPS', 'revops/handbook.md'),
        field: 'team',
        value: 'REVOPS',
        ref: 'revops/handbook.md: - Team: `REVOPS`',
      },
      {
        candidate: numberOf(linear, 'project', 'Q3 close', 'revops/handbook.md'),
        field: 'project',
        value: 'Q3 close',
        ref: 'revops/handbook.md: - Project: `Q3 close`',
      },
    ];
    expect(groundScopePicks(priya, linear)).toEqual({
      team: {
        value: 'REVOPS',
        sourceId: 'source-folder',
        ref: 'revops/handbook.md',
        quote: '- Team: `REVOPS`',
      },
      project: {
        value: 'Q3 close',
        sourceId: 'source-folder',
        ref: 'revops/handbook.md',
        quote: '- Project: `Q3 close`',
      },
    });

    const slack = scopeCandidates([folderPage(LOGISTICS)], ['channel']);
    const aiko: AnsweredPick[] = [
      {
        candidate: numberOf(slack, 'channel', 'ops-requests', 'logistics/handbook.md'),
        field: 'channel',
        value: '#ops-requests',
        ref: 'logistics/handbook.md: - Channels: #logistics-desk, #ops-requests',
      },
    ];
    expect(groundScopePicks(aiko, slack)).toEqual({
      channels: [
        {
          value: 'ops-requests',
          sourceId: 'source-folder',
          ref: 'logistics/handbook.md',
          quote: '- Channels: #logistics-desk, #ops-requests',
        },
      ],
    });
  });

  it('takes the value, page and line from the numbered candidate, never from the restatement', (): void => {
    const candidates = scopeCandidates(pages('revops-first'), ['team', 'project']);
    const answered: AnsweredPick[] = [
      {
        candidate: numberOf(candidates, 'team', 'FIN', 'finance/handbook.md'),
        field: 'team',
        value: 'FINANCE',
        ref: 'revops/handbook.md',
      },
    ];
    const scope = groundScopePicks(answered, candidates);
    expect(scope.team).toEqual({
      value: 'FIN',
      sourceId: 'source-folder',
      ref: 'finance/handbook.md',
      quote: '- Team: `FIN`',
    });
    expect(scope.notes).toBeUndefined();
  });

  it('drops a number outside the list, and a number given twice, each with a note', (): void => {
    const candidates = scopeCandidates([folderPage(FINANCE)], ['team', 'project']);
    const fin = numberOf(candidates, 'team', 'FIN', 'finance/handbook.md');
    const answered: AnsweredPick[] = [
      { candidate: fin, field: 'team', value: 'FIN', ref: 'finance/handbook.md' },
      { candidate: 0, field: 'project', value: 'Q4 plan', ref: 'finance/handbook.md' },
      {
        candidate: candidates.length + 1,
        field: 'project',
        value: 'Q4 plan',
        ref: 'finance/handbook.md',
      },
      { candidate: fin, field: 'team', value: 'FIN', ref: 'finance/handbook.md' },
    ];
    const scope = groundScopePicks(answered, candidates);
    expect(scope.team?.value).toBe('FIN');
    expect(scope.project).toBeUndefined();
    expect(scope.notes).toEqual([
      'Dropped pick 0: no documented value was offered under that number.',
      `Dropped pick ${candidates.length + 1}: no documented value was offered under that number.`,
      `Dropped pick ${fin}: team \`FIN\` was already picked.`,
    ]);
    expect(groundScopePicks(answered.slice(0, 1), []).notes).toEqual([
      `Dropped pick ${fin}: no documented value was offered under that number.`,
    ]);
  });
});

describe('the scope an approved card reads', (): void => {
  const candidates = scopeCandidates(pages('revops-first'), ['team', 'project', 'channel']);
  const finance = groundScopePicks(
    [
      { candidate: numberOf(candidates, 'team', 'FIN', 'finance/handbook.md') },
      { candidate: numberOf(candidates, 'project', 'September close', 'finance/handbook.md') },
      { candidate: numberOf(candidates, 'channel', 'finance-close', 'finance/handbook.md') },
      { candidate: numberOf(candidates, 'channel', 'ops-requests', 'finance/handbook.md') },
    ],
    candidates,
  );

  it('reads the stored values, and nothing from an empty scope', (): void => {
    expect(approvedLinearScope(finance)).toEqual({ team: 'FIN', project: 'September close' });
    expect(approvedChannelNames(finance)).toEqual(['finance-close', 'ops-requests']);
    expect(approvedLinearScope({})).toEqual({});
    expect(approvedChannelNames({})).toEqual([]);
  });

  it('presents the reads line with its quotes, and says why an empty scope reads nothing', (): void => {
    expect(presentIntakeScope('Linear', 'kanban', finance)).toEqual({
      line: 'Reads: Linear team FIN, project September close',
      empty: false,
      quotes: [finance.team, finance.project],
      notes: [],
    });
    expect(presentIntakeScope('Slack', 'chat', finance).line).toBe(
      'Reads: Slack #finance-close, #ops-requests',
    );
    const empty = presentIntakeScope('Slack', 'chat', {
      notes: ['Dropped #revops: x does not state it.'],
    });
    expect(empty).toEqual({
      line: emptyScopeReason('Slack', 'chat'),
      empty: true,
      quotes: [],
      notes: ['Dropped #revops: x does not state it.'],
    });
    expect(emptyScopeReason('Linear', 'kanban')).toBe(
      'Reads nothing from Linear: no documented team or project was picked for this role.',
    );
  });

  it('quotes a handbook line once when several values come from it', (): void => {
    const slack = presentIntakeScope('Slack', 'chat', finance);
    expect(slack.quotes).toEqual([finance.channels![0]]);
    expect(slack.quotes[0].quote).toBe('- Channels: #finance-close, #ops-requests');
  });

  it('names a value whose page line has changed since the card was approved', (): void => {
    const edited = pages('revops-first').map(
      (page): ScopePage =>
        page.ref === 'finance/handbook.md'
          ? {
              ...page,
              markdown: page.markdown.replace(
                '- Project: `September close`',
                '- Project: `October close`',
              ),
            }
          : page,
    );
    expect(scopeDrift(finance, pages('revops-first'))).toEqual([]);
    expect(scopeDrift(finance, edited)).toEqual([finance.project]);
    expect(
      scopeDrift(
        finance,
        edited.filter((page): boolean => page.ref !== 'finance/handbook.md'),
      ),
    ).toHaveLength(4);
  });

  it('says which changed values intake still reads, and how to take the page as it is now', (): void => {
    expect(presentScopeDrift(finance, [])).toBeUndefined();
    expect(presentScopeDrift(finance, [finance.team!, finance.channels![1]])).toBe(
      'Changed since this card was proposed: team FIN, #ops-requests are no longer stated on finance/handbook.md. Intake still reads only what was approved; reject the card and re-run orientation to propose the page as it reads now.',
    );
  });
});
