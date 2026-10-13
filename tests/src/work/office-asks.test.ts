import { describe, expect, it } from 'vitest';
import {
  OFFICE_ASKS,
  TEAM_ASKS,
  otherRolesAskThreads,
  otherRolesTeamDocs,
} from '../../../src/work/office-asks';
import type { Charter } from '../../../src/agent/charter';
import { charterWords } from '../../../src/work/scope';
import { LARK, MOSS, NELL, PIP, QUILL } from '../../fixtures/agent/office-roles-2026-10-07';
import { LARK_W19, NELL_W19, PIP_W19 } from '../../fixtures/agent/office-roles-2026-10-11';
import { NELL_W20, PIP_W20 } from '../../fixtures/agent/office-roles-2026-10-13';

describe("the office's company-wide asks by role (finding 2 of the v0.17.0 redeploy)", (): void => {
  it("names every other role's ask for each of the redeploy's five employees", (): void => {
    const drive = 'office-asks#thread-drive-access';
    const monitor = 'office-asks#thread-spare-monitor';
    const charge = 'office-asks#thread-double-charge';
    // Re-taken for W19-3: the revenue team's pipeline coverage ask joined the pool, and only Lark's
    // role is shown it.
    const coverage = 'revops-asks#thread-pipeline-coverage';
    expect([...otherRolesAskThreads(charterWords(NELL))]).toEqual([monitor, charge, coverage]);
    expect([...otherRolesAskThreads(charterWords(PIP))]).toEqual([drive, monitor, coverage]);
    expect([...otherRolesAskThreads(charterWords(QUILL))]).toEqual([drive, charge, coverage]);
    // Lark's role is shown the coverage ask by its own sentence, as the generator reads it.
    expect([...otherRolesAskThreads(charterWords(LARK), LARK.proposedFunction)]).toEqual([
      drive,
      monitor,
      charge,
    ]);
    expect([...otherRolesAskThreads(charterWords(MOSS))]).toEqual([
      drive,
      monitor,
      charge,
      coverage,
    ]);
  });
});

describe('the ask pool beside roles outside the redeploy five (the second pass)', (): void => {
  const role = (proposedFunction: string, willDo: string[]): Charter =>
    ({
      proposedFunction,
      proposedBoundaries: { willDo, willNotDo: [], escalationTriggers: [] },
    }) as unknown as Charter;
  const drive = 'office-asks#thread-drive-access';
  const charge = 'office-asks#thread-double-charge';

  it("shows an IT support role the drive lock-out and not the customer's invoice", (): void => {
    const others = otherRolesAskThreads(
      charterWords(
        role('Act as the IT support desk: answer password and sign-in questions.', [
          'Reset passwords with the wiki steps.',
        ]),
      ),
    );
    expect(others.has(drive)).toBe(false);
    expect(others.has(charge)).toBe(true);
  });

  it('keeps the drive lock-out from a customer support role whose clauses say access', (): void => {
    const others = otherRolesAskThreads(
      charterWords(
        role('Act as the customer support coordinator.', [
          'Give customers access to the help centre articles.',
        ]),
      ),
    );
    expect(others.has(drive)).toBe(true);
    expect(others.has(charge)).toBe(false);
  });
});

describe('a role a word of four letters cannot name (W14-R49)', (): void => {
  const named = (proposedFunction: string): Charter =>
    ({
      proposedFunction,
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
    }) as unknown as Charter;
  const others = (role: string): ReadonlySet<string> =>
    otherRolesAskThreads(charterWords(named(role)), role);
  const drive = 'office-asks#thread-drive-access';
  const monitor = 'office-asks#thread-spare-monitor';
  const charge = 'office-asks#thread-double-charge';
  // Re-taken for W19-3: the revenue team's ask joined the pool; none of these roles is its.
  const coverage = 'revops-asks#thread-pipeline-coverage';

  it('shows an IT role by its name alone the drive lock-out, and never the invoice its "support" reads', (): void => {
    for (const role of ['IT support', 'IT/Systems administrator']) {
      expect([...others(role)], role).toEqual([monitor, charge, coverage]);
    }
  });

  it('still shows a customer-facing role the invoice and not the lock-out', (): void => {
    for (const role of ['Customer success', 'Support engineer']) {
      expect([...others(role)], role).toEqual([drive, monitor, coverage]);
    }
  });

  it('reads the pronoun "it" as no IT role', (): void => {
    expect([...others('Answer each customer and close it out.')]).toEqual([
      drive,
      monitor,
      coverage,
    ]);
  });

  it('shows a role none of the three asks name none of them', (): void => {
    for (const role of ['Office manager', 'Operations', 'Finance analyst']) {
      expect([...others(role)], role).toEqual([drive, monitor, charge, coverage]);
    }
  });

  it('shows a revenue operations role by its name alone the coverage ask', (): void => {
    for (const role of ['RevOps analyst', 'Revenue operations lead', 'Sales operations']) {
      expect(others(role).has(coverage), role).toBe(false);
    }
  });
});

describe("the revenue team's ask in #revops-asks by role (W19-3)", (): void => {
  const coverage = 'revops-asks#thread-pipeline-coverage';

  it('keeps Priya’s pipeline coverage ask from the IT helpdesk and support triage roles the walk handed it to', (): void => {
    expect(
      otherRolesAskThreads(charterWords(NELL_W19), NELL_W19.proposedFunction).has(coverage),
    ).toBe(true);
    expect(
      otherRolesAskThreads(charterWords(PIP_W19), PIP_W19.proposedFunction).has(coverage),
    ).toBe(true);
  });

  it('shows it to the revenue operations role, and to no finance close role', (): void => {
    expect(
      otherRolesAskThreads(charterWords(LARK_W19), LARK_W19.proposedFunction).has(coverage),
    ).toBe(false);
    expect(otherRolesAskThreads(charterWords(LARK), LARK.proposedFunction).has(coverage)).toBe(
      false,
    );
    expect(otherRolesAskThreads(charterWords(MOSS)).has(coverage)).toBe(true);
    expect(otherRolesAskThreads(charterWords(QUILL)).has(coverage)).toBe(true);
  });
});

describe("the coverage ask beside roles whose words are the team's too (W19-3, the second pass)", (): void => {
  const coverage = 'revops-asks#thread-pipeline-coverage';
  const role = (proposedFunction: string, willDo: string[]): Charter =>
    ({
      proposedFunction,
      proposedBoundaries: { willDo, willNotDo: [], escalationTriggers: [] },
    }) as unknown as Charter;
  const shown = (charter: Charter): boolean =>
    !otherRolesAskThreads(charterWords(charter), charter.proposedFunction).has(coverage);

  it('keeps it from a role that deals, books, forecasts or runs a pipeline of its own', (): void => {
    for (const charter of [
      role('Act as the facilities coordinator.', ['Manage the meeting room bookings.']),
      role('Act as the support lead.', ['Deal with customer deals and complaints politely.']),
      role('Act as the DevOps engineer.', ['Keep the deployment pipeline green.']),
      role('Act as the finance analyst.', ['Explain the forecast variance each month.']),
      role('Act as the IT support desk.', ['Answer Salesforce sign-in questions.']),
    ]) {
      expect(shown(charter), charter.proposedFunction).toBe(false);
    }
  });

  it('shows it to a revenue or sales operations role, however its name is spelt', (): void => {
    for (const name of ['Rev ops analyst', 'RevOps lead', 'Sales ops coordinator']) {
      expect(shown(role(name, [])), name).toBe(true);
    }
    expect(
      shown(role('Act as the pipeline analyst.', ['Keep Salesforce opportunities current.'])),
    ).toBe(true);
  });
});

describe('the team documents that answer another role’s ask (16-FW’s F7; finding 3 of the v0.20.0 walk)', (): void => {
  const others = (charter: Charter): string[] =>
    [...otherRolesTeamDocs(charterWords(charter), charter.proposedFunction)].sort();

  it('names, for each ask, the team document the office answers it from', (): void => {
    expect([...OFFICE_ASKS, ...TEAM_ASKS].map((ask) => [ask.threadKey, ask.answeredBy])).toEqual([
      ['thread-drive-access', 'it-access'],
      ['thread-spare-monitor', 'office-supplies'],
      ['thread-double-charge', 'billing-replies'],
      ['thread-pipeline-coverage', 'team-overview'],
    ]);
  });

  it('keeps from the IT helpdesk role the supplies page its monitor ticket was written from', (): void => {
    expect(others(NELL_W20)).toEqual(['billing-replies', 'office-supplies', 'team-overview']);
  });

  it('keeps from the support triage role the team overview its pipeline coverage ticket was written from', (): void => {
    expect(others(PIP_W20)).toEqual(['it-access', 'office-supplies', 'team-overview']);
    expect(others(PIP_W19)).toEqual(['it-access', 'office-supplies', 'team-overview']);
  });

  it('shows a revenue role its own team overview, and a facilities role its supplies page', (): void => {
    expect(others(LARK_W19)).toEqual(['billing-replies', 'it-access', 'office-supplies']);
    expect(others(QUILL)).toEqual(['billing-replies', 'it-access', 'team-overview']);
  });

  it('keeps every such page from a role none of the asks reaches', (): void => {
    expect(others(MOSS)).toEqual([
      'billing-replies',
      'it-access',
      'office-supplies',
      'team-overview',
    ]);
  });
});
