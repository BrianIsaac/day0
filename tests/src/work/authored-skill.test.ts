import { describe, expect, it } from 'vitest';
import {
  authoredSkillIssues,
  instanceLiterals,
  type AuthoredSkillInstance,
} from '../../../src/work/authored-skill';

const tileTicket: AuthoredSkillInstance = {
  externalId: 'REVOPS-7',
  title: 'Refresh the Looker pipeline tile',
  contentSummary:
    'The Friday standup states 74% pipeline coverage; enter 74% on the tile and note "coverage refreshed" on REVOPS-7. Budget is $1,200 for week 37.',
  contentRefs: ['ticket://REVOPS-7'],
};

const slackAsk: AuthoredSkillInstance = {
  externalId: 'C0BSF04TZ19:1789000500.000200',
  title: 'Mention in #revops-asks',
  contentSummary: 'Which coverage figure are we quoting in the Friday standup this week?',
  contentRefs: [],
  replyTarget: { channel: 'C0BSF04TZ19', threadTs: '1789000500.000200' },
};

const reusableBody = [
  '# Value refresh on an analytics surface',
  '',
  '## When to invoke',
  'A ticket on a kanban surface asks for the analytics tile figure to be set to a stated value.',
  '',
  '## Inputs',
  '- `<record-id>`: the ticket identifier from the candidate id.',
  '- `<requested-value>`: the figure the candidate or the runbook names for this run.',
  '',
  '## Procedure',
  '1. Navigate, sign in with `{{secret}}`, fill `Pipeline coverage` with `<requested-value>`, click `Save`.',
  '2. Comment on `<record-id>` quoting the audit line `Last updated by <user> at <time> UTC`.',
  '',
  '## Verification',
  'The snapshot shows the audit line and `<requested-value>`.',
].join('\n');

const reusableSmoke = [
  'def run(inputs: dict) -> dict:',
  '    return {"actions": [{"tool": "mcp.call", "args": {"toolArgsJson": inputs["requested_value"]}}]}',
  'for case in ({"record_id": "OPS-3", "requested_value": "61%"}, {"record_id": "OPS-9", "requested_value": "58%"}):',
  '    print("ok", run(case)["actions"][0]["args"]["toolArgsJson"])',
].join('\n');

describe('the values a skill must not repeat from its first work item', (): void => {
  it('reads the identifier, references, percentages, amounts, whole numbers and quoted phrases', (): void => {
    expect(instanceLiterals(tileTicket)).toEqual([
      'REVOPS-7',
      'ticket://REVOPS-7',
      '74%',
      '$1,200',
      '1,200',
      '37',
      '74',
      'coverage refreshed',
    ]);
  });

  it('reads the reply channel and thread of a chat ask', (): void => {
    expect(instanceLiterals(slackAsk)).toEqual([
      'C0BSF04TZ19:1789000500.000200',
      'C0BSF04TZ19',
      '1789000500.000200',
    ]);
  });
});

describe('the static gate on an authored skill', (): void => {
  it('passes a parameterised procedure whose smoke test runs two representative inputs', (): void => {
    expect(
      authoredSkillIssues({ body: reusableBody, smokeTest: reusableSmoke, instance: tileTicket }),
    ).toEqual([]);
  });

  it('refuses the 14 Sep body: the ticket id and the approved figure baked in', (): void => {
    const body = reusableBody.replace(
      '## Procedure',
      '## Procedure\nThe sole approved value for this skill is 74% for REVOPS-7.',
    );
    expect(authoredSkillIssues({ body, smokeTest: reusableSmoke, instance: tileTicket })).toEqual([
      "SKILL.md carries the first work item's value `REVOPS-7`; a skill reads it from the candidate at execution and names the input it stands for",
      "SKILL.md carries the first work item's value `74%`; a skill reads it from the candidate at execution and names the input it stands for",
    ]);
  });

  it('refuses a smoke test that runs the first work item as its representative input', (): void => {
    const smokeTest = reusableSmoke.replace('"OPS-3"', '"revops-7"');
    expect(
      authoredSkillIssues({ body: reusableBody, smokeTest, instance: tileTicket }),
    ).toEqual([
      "smoke.py carries the first work item's value `REVOPS-7`; a skill reads it from the candidate at execution and names the input it stands for",
    ]);
  });

  it('refuses a chat skill that names the first thread', (): void => {
    const body = reusableBody.replace(
      '## Verification',
      '## Verification\nReply in C0BSF04TZ19 with thread_ts 1789000500.000200.',
    );
    expect(authoredSkillIssues({ body, smokeTest: reusableSmoke, instance: slackAsk })).toEqual([
      "SKILL.md carries the first work item's value `C0BSF04TZ19`; a skill reads it from the candidate at execution and names the input it stands for",
      "SKILL.md carries the first work item's value `1789000500.000200`; a skill reads it from the candidate at execution and names the input it stands for",
    ]);
  });

  it('does not read a longer identifier or number as the first item', (): void => {
    const body = `${reusableBody}\nExample: REVOPS-70 is a different ticket at 174% or 3.74.`;
    expect(authoredSkillIssues({ body, smokeTest: reusableSmoke, instance: tileTicket })).toEqual([]);
  });

  it('reports a figure once whether the body writes it with or without its unit', (): void => {
    const body = reusableBody.replace('## Procedure', '## Procedure\nEnter 74 percent, that is 74%.');
    expect(authoredSkillIssues({ body, smokeTest: reusableSmoke, instance: tileTicket })).toEqual([
      "SKILL.md carries the first work item's value `74%`; a skill reads it from the candidate at execution and names the input it stands for",
    ]);
  });

  it('requires an Inputs section and a declaration for every placeholder used', (): void => {
    expect(
      authoredSkillIssues({ body: '# Bare\nComment on <record-id>.', smokeTest: reusableSmoke }),
    ).toEqual([
      'SKILL.md declares no `## Inputs` section; every value that varies per run is an angle-bracket input declared there',
    ]);
    expect(
      authoredSkillIssues({
        body: `${reusableBody}\nPost to <audit-channel> as well.`,
        smokeTest: reusableSmoke,
      }),
    ).toEqual(['SKILL.md uses `<audit-channel>` without declaring it under `## Inputs`']);
  });

  it('keeps {{secret}} as the only double-brace placeholder', (): void => {
    expect(
      authoredSkillIssues({
        body: reusableBody + '\nSet `{{issue_id}}` and `{{ secret:linear }}`.',
        smokeTest: 'print("{{value}}")\n',
      }),
    ).toEqual([
      'SKILL.md uses `{{issue_id}}`; `{{secret}}` is the only double-brace placeholder, every other per-run value is an angle-bracket input',
      'smoke.py uses `{{value}}`; `{{secret}}` is the only double-brace placeholder, every other per-run value is an angle-bracket input',
    ]);
  });

  it('checks the placeholder contract alone when the first work item is unknown', (): void => {
    const body = reusableBody.replace('## Procedure', '## Procedure\nEnter 74% on REVOPS-7.');
    expect(authoredSkillIssues({ body, smokeTest: reusableSmoke, instance: null })).toEqual([]);
  });
});
