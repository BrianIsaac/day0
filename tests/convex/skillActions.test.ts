/** @vitest-environment node */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AUTHOR_SYSTEM,
  AUTHOR_SYSTEM_REAL,
  authorSchema,
  authorSchemaFor,
  authorSystemFor,
  buildAuthorPrompt,
  verifyAuthoredSkill,
} from '../../convex/skillActions';
import { harnessedSmokeTest, smokeHarnessContract } from '../../src/work/smoke-harness';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';
import type { SurfaceRecord } from '../../src/surfaces/types';
import { clipRefusedDraft, REFUSED_DRAFT_CHARS, REFUSED_DRAFT_PROMPT_CHARS } from '../../src/work/authored-skill';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

const now = Date.UTC(2026, 7, 29, 9);

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['save_comment', 'save_issue'],
};

const skill = {
  name: 'update-linear-ticket',
  description: 'Comment on and close a Linear ticket.',
  rationale: 'No skill handles linear work yet.',
  requiredScopes: ['boss:message', 'linear:read', 'linear:write'],
};

describe('skill author prompts', (): void => {
  it('teaches the two surface verbs, their arguments and the connected-surface rule', (): void => {
    expect(AUTHOR_SYSTEM).toContain('mcp.call             — { surface, tool, toolArgsJson }');
    expect(AUTHOR_SYSTEM).toContain('http.request         — { surface, method, path, headersJson, body }');
    expect(AUTHOR_SYSTEM).toContain('name the surface exactly as the Surfaces list does');
    expect(AUTHOR_SYSTEM).toContain('take the tool sequence and paths from the runbook for that system and the argument names from the probed schema');
    expect(AUTHOR_SYSTEM).toContain('emit the reply as its own `http.request` POST `chat.postMessage` action with `channel` set to the source channel and `thread_ts` set to the source thread timestamp');
    expect(AUTHOR_SYSTEM).toContain('it must never carry a draft reply that belongs in the channel');
    expect(AUTHOR_SYSTEM).not.toContain(
      'If the skill drafts text for human review, ALSO emit a `slack.postMessage` to `dm-manager`',
    );
    expect(AUTHOR_SYSTEM).not.toContain('`dm-manager`');
    expect(AUTHOR_SYSTEM).toContain(
      'Choose exactly one available action schema whose operation matches the runtime candidate and loaded procedure.',
    );
    expect(AUTHOR_SYSTEM).toContain(
      'Take the action verb and every argument from the candidate, connected-surface schema and loaded procedures',
    );
    expect(AUTHOR_SYSTEM).not.toContain('If the skill\'s purpose is "draft a tweet reply"');
    expect(AUTHOR_SYSTEM).not.toContain('If "update the spreadsheet"');
    expect(AUTHOR_SYSTEM).toContain(
      'A public reply draft is never copied into the manager DM',
    );
    expect(AUTHOR_SYSTEM).toContain('never include a token or key');
    expect(AUTHOR_SYSTEM).toContain('you may only target a connected surface');
    expect(AUTHOR_SYSTEM).toContain('The first real call is the gated execution');
    expect(AUTHOR_SYSTEM).toContain('A registered skill runs under either live action mode');
    expect(AUTHOR_SYSTEM).toContain('Never hardcode approval-state language into the skill body or into comments and messages');
    expect(AUTHOR_SYSTEM).toContain('read the current mode from the run context');
    expect(AUTHOR_SYSTEM).toContain('do not say a write is queued, pending, awaiting approval or "for your approval"');
    for (const verb of ['spreadsheet.appendRow', 'slack.postMessage', 'twitter.reply', 'ticket.update']) {
      expect(AUTHOR_SYSTEM).toContain(verb);
    }
  });

  it('teaches a reusable procedure with declared inputs and no work-item constants', (): void => {
    expect(AUTHOR_SYSTEM).not.toContain('no template placeholders');
    expect(AUTHOR_SYSTEM).toContain('A skill is a reusable procedure for one operation on one surface class');
    expect(AUTHOR_SYSTEM).toContain('`## Inputs`');
    expect(AUTHOR_SYSTEM).toContain('`<record-id>`');
    expect(AUTHOR_SYSTEM).toContain('`{{secret}}` stays the only double-brace placeholder');
    expect(AUTHOR_SYSTEM).toContain('no percentage, amount, identifier, channel, thread or quoted request from any single work item');
  });

  it('takes invoke conditions from the runbook and leaves scope to the evaluator', (): void => {
    expect(AUTHOR_SYSTEM).toContain('`## When to invoke` describes the operation and its preconditions as the runbook states them');
    expect(AUTHOR_SYSTEM).toContain('never restates the charter');
    expect(AUTHOR_SYSTEM).toContain('owned, prioritised, assigned');
  });

  it('makes the probed schema the authority for argument names over runbook examples', (): void => {
    expect(AUTHOR_SYSTEM).toContain('the probed argument names in the Surfaces list are the authority for every tool\'s `toolArgsJson` keys, over any example in a runbook');
    expect(AUTHOR_SYSTEM).toContain('the runbook is the authority for the sequence, the element names and the verification');
    expect(AUTHOR_SYSTEM).not.toContain('take the action shape (tool names, argument names, paths) from the runbook for that system');
  });

  it('asks for a smoke test that runs the procedure with two different input sets', (): void => {
    expect(AUTHOR_SYSTEM).toContain('reads every value it needs from `inputs`');
    expect(AUTHOR_SYSTEM).toContain('Call run() once for each of two different representative input dicts');
    expect(AUTHOR_SYSTEM).toContain('none of them the values of the work item that first needed this skill');
    expect(AUTHOR_SYSTEM).not.toContain('Call run() once.');
  });

  it('asks a real-mode author for run() and its CASES only, because the harness calls and checks', (): void => {
    expect(authorSystemFor('mock')).toBe(AUTHOR_SYSTEM);
    const real = authorSystemFor('real');
    expect(real).toBe(AUTHOR_SYSTEM_REAL);
    expect(real).toContain('reads every value it needs from `inputs`');
    expect(real).toContain('Define `CASES`, a list of two different representative input dicts');
    expect(real).toContain('none of them the values of the work item that first needed this skill');
    expect(real).toContain('no call to run(), no assertion, no check and no print() at the top level');
    expect(real).toContain('The harness calls run() once per case and checks those rules itself');
    expect(real).toContain('`{"tool": "mcp.call", "args": {"surface", "tool", "toolArgsJson"}}`');
    expect(real).toContain('`{"tool": "http.request", "args": {"surface", "method", "path", "headersJson", "body"}}`');
    expect(real).toContain("with a tool from that surface's allowed tools. Both cases emit actions");
    expect(real).toContain("Name in SKILL.md's procedure, by its exact name, every tool `run()` uses");
    expect(real).toContain('the record id, and the reply channel and thread when a case gives them, reach the arguments');
    expect(real).not.toContain('Call run() once for each of two different representative input dicts');
    expect(real).not.toContain('print() one concise success line per call');
    // Everything but the smoke-test contract is the mock prompt, word for word.
    const [mockHead, mockTail] = AUTHOR_SYSTEM.split('You also produce a small Python smoke test');
    expect(real.startsWith(mockHead!)).toBe(true);
    expect(real.endsWith(mockTail!.slice(mockTail!.indexOf('Discipline:')))).toBe(true);
  });

  it('describes the real-mode smoke test in the schema the author answers with', (): void => {
    expect(authorSchemaFor('mock')).toBe(authorSchema);
    const real = z.toJSONSchema(authorSchemaFor('real')) as {
      properties: Record<string, { description?: string }>;
    };
    const mock = z.toJSONSchema(authorSchema) as { properties: Record<string, { description?: string }> };
    expect(real.properties.body).toEqual(mock.properties.body);
    expect(real.properties.smokeTest?.description).toContain('CASES, a list of two different representative input dicts');
    expect(real.properties.smokeTest?.description).toContain('the verification harness calls run() once per case');
    expect(real.properties.smokeTest?.description).not.toContain('print one success line');
  });

  it('puts the shape and the execution inputs in front of the author', (): void => {
    const prompt = buildAuthorPrompt(
      {
        ...skill,
        name: 'analytics-refresh-value',
        surfaceClass: 'analytics',
        operation: 'refresh-value',
      },
      [],
      now,
    );
    expect(prompt).toContain('Skill name: analytics-refresh-value');
    expect(prompt).toContain('Shape: value refresh on an analytics surface');
    expect(prompt).toContain('Execution inputs the executor can supply');
    expect(prompt).toContain('`<record-id>`');
    expect(prompt).toContain('`<requested-value>`');
    expect(prompt).toContain('`<reply-channel>`');
    expect(prompt).toContain('`<originating-surface>`');
    expect(prompt).toContain('The rationale names the first work item; it is an instance');
  });

  // Demo rehearsal 2, 19 Sep 2026, finding 1: real mode says which surface
  // carries the reply; the mock author's prompt is the recorded one.
  const slack: SurfaceRecord = {
    slug: 'slack',
    displayName: 'Slack',
    class: 'chat',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now,
    path: 'documented-api',
    endpoint: 'https://slack.com/api/',
    toolAllowlist: ['chat.postMessage', 'conversations.replies'],
  };
  const kanbanSkill = { ...skill, name: 'kanban-comment-and-close', surfaceClass: 'kanban', operation: 'comment-and-close', targetSurface: 'linear' };

  it('keeps the mock author prompt with a shape and surfaces byte-identical', (): void => {
    const prompt = buildAuthorPrompt(kanbanSkill, [linear, slack], now, [], 'mock');
    expect(prompt).not.toContain('<reply-surface>');
    expect(createHash('sha256').update(prompt).digest('hex')).toMatchInlineSnapshot(`"de4943a3dd8b2b14e7c067511b0637a36dc1f2b6a98f1a598b3647359a6ca492"`);
  });

  it('teaches a real-mode author the reply surface as an input, and names it from the connected surfaces', (): void => {
    const prompt = buildAuthorPrompt(kanbanSkill, [linear, slack], now, [], 'real');
    expect(prompt).toContain('The reply is an action on `<reply-surface>`, the connected chat surface the `Reply target:` line names, by that surface\'s own path');
    expect(prompt).toContain('never on `<originating-surface>` unless that is the chat surface.');
    expect(prompt).toContain('  - `<reply-surface>`: the slug of the connected chat surface');
    expect(prompt).not.toContain('a reply in the thread on chat');
    expect(prompt).toContain(
      '  Here `<reply-surface>` is `slack`, the connected chat surface (path documented-api, reached by `http.request`); `linear` is path mcp, reached by `mcp.call` only, so it never carries a reply. In `CASES`, a case that gives `reply-channel` gives `reply-surface` too, set to `slack`, and `run()` sends the reply on `inputs["reply-surface"]`. SKILL.md writes `<reply-surface>` as the reply action\'s `surface`, never the slug: the executor binds it for each run.',
    );
  });

  it('names no reply surface when no chat surface is connected', (): void => {
    const prompt = buildAuthorPrompt(kanbanSkill, [linear], now, [], 'real');
    expect(prompt).toContain('  - `<reply-surface>`:');
    expect(prompt).not.toContain('Here `<reply-surface>` is');
  });

  it('tells a real-mode author that a case with a reply channel gives the reply surface too', (): void => {
    expect(AUTHOR_SYSTEM_REAL).toContain(
      'A case that gives `reply-channel` gives `reply-surface` too, and the reply action\'s `surface` is that input, never `originating-surface`.',
    );
    expect(AUTHOR_SYSTEM).not.toContain('reply-surface');
  });

  it('keeps the shape-free author prompt as it was when nothing is connected', (): void => {
    expect(buildAuthorPrompt(skill, [], now)).toBe(
      [
        'Skill name: update-linear-ticket',
        'Description: Comment on and close a Linear ticket.',
        'Rationale (why I need this): No skill handles linear work yet.',
        'Required scopes: boss:message, linear:read, linear:write',
        '',
        'Author SKILL.md and smoke.py now.',
      ].join('\n'),
    );
    expect(buildAuthorPrompt(skill, [{ ...linear, verdict: 'approved', credentialLanded: false }], now)).not.toContain('Connected real surfaces');
  });

  it('passes the connected surfaces, their allowlists and the target into the prompt', (): void => {
    const prompt = buildAuthorPrompt({ ...skill, targetSurface: 'linear' }, [linear], now);
    expect(prompt).toContain('Target surface: linear');
    expect(prompt).toContain('Connected real surfaces');
    expect(prompt).toContain('linear (Linear) - class kanban · path mcp · endpoint https://mcp.linear.app/mcp · allowed tools: save_comment, save_issue');
    expect(prompt).toContain('{{secret}}');
    expect(prompt.endsWith('Author SKILL.md and smoke.py now.')).toBe(true);
  });

  it('preserves the mock author prompt with persisted probed surfaces', () => {
    const probed = { ...linear, toolArguments: [{ tool: 'save_comment', arguments: ['issueId', 'body'] }] };
    expect(buildAuthorPrompt(skill, [probed], now, [], 'mock')).toBe(
      buildAuthorPrompt(skill, [linear], now, [], 'mock'),
    );
  });

  it('carries the probed argument names into the author prompt so authored skills use the right keys', (): void => {
    const prompt = buildAuthorPrompt(
      { ...skill, targetSurface: 'linear' },
      [
        {
          ...linear,
          toolAllowlist: ['get_issue', 'save_comment'],
          toolArguments: [
            { tool: 'get_issue', arguments: ['id', 'includeRelations'] },
            { tool: 'save_comment', arguments: ['issueId', 'body'] },
          ],
        },
      ],
      now,
    );
    expect(prompt).toContain('allowed tools: get_issue(id, includeRelations), save_comment(issueId, body)');
    expect(prompt).toContain('probed argument names');
  });

  it('lists only live surfaces and says when a connected surface allows no tools', (): void => {
    const prompt = buildAuthorPrompt(
      { ...skill, targetSurface: 'linear' },
      [
        { ...linear, slug: 'dead', displayName: 'Dead', lastVerifiedAt: now - 7 * 60 * 60 * 1000 },
        { ...linear, slug: 'empty', displayName: 'Empty', toolAllowlist: [] },
      ],
      now,
    );
    expect(prompt).not.toContain('dead (Dead)');
    expect(prompt).toContain('empty (Empty)');
    expect(prompt).toContain('allowed tools: (none)');
  });

  it('grounds a real-surface skill in the linked redacted runbook action contract', (): void => {
    const prompt = buildAuthorPrompt(
      {
        ...skill,
        name: 'refresh-looker-pipeline-tile',
        targetSurface: 'looker',
      },
      [
        {
          ...linear,
          slug: 'looker',
          displayName: 'Looker',
          path: 'browser-driven',
          endpoint: 'http://looker-tile:8080/',
          toolAllowlist: ['browser_fill_form', 'browser_click'],
        },
      ],
      now,
      [
        {
          ref: 'runbooks/how-to-refresh-the-tile.md',
          title: 'How to refresh the Looker pipeline tile',
          markdown:
            'Use `browser_fill_form` with `{"fields":[{"name":"Password","value":"{{secret}}"}]}` then `browser_click` with `{"element":"Save"}`.',
        },
        {
          ref: 'runbooks/how-to-post-slack.md',
          title: 'How to post Slack',
          markdown: 'Use chat.postMessage.',
        },
      ],
    );

    expect(prompt).toContain('Linked, already-redacted team documentation');
    expect(prompt).toContain('runbooks/how-to-refresh-the-tile.md');
    expect(prompt).toContain(
      '`browser_fill_form` with `{"fields":[{"name":"Password","value":"{{secret}}"}]}`',
    );
    expect(prompt).toContain('preserve its tool name, its sequence and its element names');
    expect(prompt).toContain('a literal value in an example is that document\'s instance value, not the skill\'s: write the named input it stands for');
    expect(prompt).toContain('argument names come from the probed schema in the Surfaces list when it shows them');
    expect(prompt).not.toContain('literal values exactly');
    expect(prompt).toContain('never invent a selector, driver reference or path');
    expect(prompt).not.toContain('runbooks/how-to-post-slack.md');
  });

  it('rejects a non-program smoke test before invoking a sandbox', async (): Promise<void> => {
    const verify = vi.fn<() => Promise<SkillSandboxRun>>();

    const result = await verifyAuthoredSkill(
      {
        skillName: 'update-spreadsheet',
        skillBody: '# Update spreadsheet',
        smokeTest: 'Success: Row appended to spreadsheet',
      },
      verify,
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('not valid Python 3.12 source'),
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('unwraps a smoke test that arrived in a markdown fence and verifies the program inside', async (): Promise<void> => {
    const sandboxResult: SkillSandboxRun = {
      backend: 'local',
      sandboxId: 'local:run-3',
      stdout: 'ok\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
    const verify = vi.fn(async (): Promise<SkillSandboxRun> => sandboxResult);
    const program = 'def run(inputs: dict) -> dict:\n    return {"actions": []}\nprint("ok", run({}))';

    await expect(
      verifyAuthoredSkill(
        { skillName: 'update-spreadsheet', skillBody: '# Update spreadsheet', smokeTest: '```python\n' + program + '\n```' },
        verify,
      ),
    ).resolves.toEqual({ ok: true, result: sandboxResult, smokeTest: program, unwrapped: true });
    expect(verify).toHaveBeenCalledWith({
      skillName: 'update-spreadsheet',
      skillBody: '# Update spreadsheet',
      smokeTest: program,
    });
  });

  it('reports the line and column of an unfenced program that does not parse', async (): Promise<void> => {
    const verify = vi.fn<() => Promise<SkillSandboxRun>>();
    const broken = 'def run(inputs: dict) -> dict:\n    return {"actions": [}\nprint(run({}))';

    const result = await verifyAuthoredSkill(
      { skillName: 'update-spreadsheet', skillBody: '# Update spreadsheet', smokeTest: broken },
      verify,
    );

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('smoke test rejected before sandbox');
    expect((result as { reason: string }).reason).toContain('does not parse at line 2, column');
    expect((result as { reason: string }).reason).toContain('`    return {"actions": [}`');
    expect(verify).not.toHaveBeenCalled();
  });

  it('passes a valid Python smoke program to verification', async (): Promise<void> => {
    const sandboxResult: SkillSandboxRun = {
      backend: 'local',
      sandboxId: 'local:run-1',
      stdout: 'success actions\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
    const verify = vi.fn(async (): Promise<SkillSandboxRun> => sandboxResult);
    const smokeTest = [
      'def run(inputs: dict) -> dict:',
      '    return {"actions": inputs["actions"]}',
      '',
      'result = run({"actions": []})',
      'print("success", result["actions"])',
    ].join('\n');

    await expect(
      verifyAuthoredSkill(
        { skillName: 'update-spreadsheet', skillBody: '# Update spreadsheet', smokeTest },
        verify,
      ),
    ).resolves.toEqual({ ok: true, result: sandboxResult, smokeTest, unwrapped: false });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('accepts Python 3.12 syntax and subscripted dict annotations on the run landmark', async (): Promise<void> => {
    const sandboxResult: SkillSandboxRun = {
      backend: 'local',
      sandboxId: 'local:run-2',
      stdout: 'ok\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
    const verify = vi.fn(async (): Promise<SkillSandboxRun> => sandboxResult);
    const smokeTest = [
      'import sys',
      'type Cells = list[dict[str, str]]',
      'def first[T](xs: list[T]) -> T:',
      '    return xs[0]',
      'def run(inputs: dict[str, object]) -> dict[str, object]:',
      '    cells: Cells = [{"header": k, "value": str(v)} for k, v in inputs.items()]',
      '    if (n := len(cells)) > 0:',
      '        label = f"{n} cells: {", ".join(c["header"] for c in cells)}"',
      '    else:',
      '        label = "empty"',
      '    match inputs.get("kind"):',
      '        case "append":',
      '            action = {"tool": "spreadsheet.appendRow", "args": {"cells": cells}}',
      '        case _:',
      '            action = {"tool": "noop", "args": {}}',
      '    return {"label": label, "actions": [action]}',
      'out = run({"kind": "append", "a": 1})',
      'sys.stdout.write(f"ok {first(out["actions"])["tool"]}\\n")',
    ].join('\n');

    await expect(
      verifyAuthoredSkill(
        { skillName: 'update-spreadsheet', skillBody: '# Update spreadsheet', smokeTest },
        verify,
      ),
    ).resolves.toEqual({ ok: true, result: sandboxResult, smokeTest, unwrapped: false });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('hands the sandbox the harness around the author program in real mode, and keeps the author program', async (): Promise<void> => {
    const sandboxResult: SkillSandboxRun = {
      backend: 'local',
      sandboxId: 'local:run-4',
      stdout: 'case 1\ncase 2\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
    const verify = vi.fn(async (): Promise<SkillSandboxRun> => sandboxResult);
    const program = [
      'def run(inputs: dict) -> dict:',
      '    return {"actions": [{"action": "mcp.call", "tool": "save_comment", "id": inputs["record-id"]}]}',
      'CASES = [{"record-id": "OPS-1"}, {"record-id": "OPS-2"}]',
    ].join('\n');

    await expect(
      verifyAuthoredSkill(
        { skillName: 's', skillBody: '# s', smokeTest: '```python\n' + program + '\n```' },
        verify,
        'real',
      ),
    ).resolves.toEqual({ ok: true, result: sandboxResult, smokeTest: program, unwrapped: true });
    expect(verify).toHaveBeenCalledWith({
      skillName: 's',
      skillBody: '# s',
      smokeTest: harnessedSmokeTest(program, smokeHarnessContract('# s', [], undefined, 0)),
    });
  });

  it('refuses a real-mode program without the run landmark before the sandbox, and needs no print', async (): Promise<void> => {
    const verify = vi.fn<() => Promise<SkillSandboxRun>>();

    await expect(
      verifyAuthoredSkill(
        { skillName: 's', skillBody: '# s', smokeTest: 'def main(inputs: dict) -> dict:\n    return {}\nCASES = []\n' },
        verify,
        'real',
      ),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('must define run(inputs: dict) -> dict') });
    expect(verify).not.toHaveBeenCalled();
  });

  it('names the missing landmark when a parsable program lacks the contract', async (): Promise<void> => {
    const verify = vi.fn<() => Promise<SkillSandboxRun>>();
    const noRun = 'def main(inputs: dict) -> dict:\n    return {}\nprint(main({}))\n';
    const noPrint = 'def run(inputs: dict) -> dict:\n    return {}\nrun({})\n';

    await expect(
      verifyAuthoredSkill({ skillName: 's', skillBody: '# s', smokeTest: noRun }, verify),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('must define run(inputs: dict) -> dict'),
    });
    await expect(
      verifyAuthoredSkill({ skillName: 's', skillBody: '# s', smokeTest: noPrint }, verify),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('must print a success line'),
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('hands the refused draft back with the reasons and asks for one corrected full replacement', (): void => {
    const refusedBody = '# Refresh\n## Inputs\n- analytics-surface: the tile\n## Procedure\nOpen <analytics-surface>.';
    const refusedSmokeTest = 'def run(inputs: dict) -> dict:\n    return {"actions": []}\nprint(run({}))';
    const prompt = buildAuthorPrompt(
      {
        ...skill,
        previousAuthoringFailure:
          'the authored skill is not a reusable procedure: SKILL.md uses `<analytics-surface>` without declaring it under `## Inputs`',
        previousAuthoringDraft: { body: refusedBody, smokeTest: refusedSmokeTest },
      },
      [],
      now,
    );

    expect(prompt).toContain('Previous authoring attempt failed before registration:');
    expect(prompt).toContain('SKILL.md uses `<analytics-surface>` without declaring it under `## Inputs`');
    expect(prompt).toContain('--- Required correction ---');
    expect(prompt).toContain('Return one corrected full replacement of both SKILL.md and smoke.py');
    expect(prompt).toContain('Refused SKILL.md:\n' + refusedBody);
    expect(prompt).toContain('Refused smoke.py:\n' + refusedSmokeTest);
    expect(prompt).not.toContain('do not repeat the rejected output');
    expect(prompt.endsWith('Author SKILL.md and smoke.py now.')).toBe(true);
    expect(prompt.indexOf('Refused SKILL.md:')).toBeLessThan(prompt.indexOf('Refused smoke.py:'));
    expect(prompt.indexOf('Previous authoring attempt')).toBeLessThan(prompt.indexOf('--- Required correction ---'));
  });

  it('bounds each refused draft in the prompt below what the row keeps, so a local window is not overrun', (): void => {
    const refusedBody = `# Refresh\n## Inputs\n- <analytics-surface>: the tile\n## Procedure\n${'Open <analytics-surface> and read the tile. '.repeat(400)}`;
    const refusedSmokeTest = `def run(inputs: dict) -> dict:\n${'    value = inputs["analytics-surface"]\n'.repeat(200)}    return {"actions": []}\nprint(run({}))`;
    expect(refusedBody.length).toBeGreaterThan(REFUSED_DRAFT_PROMPT_CHARS.body);
    expect(refusedSmokeTest.length).toBeGreaterThan(REFUSED_DRAFT_PROMPT_CHARS.smokeTest);
    const prompt = buildAuthorPrompt(
      {
        ...skill,
        previousAuthoringFailure: 'the authored skill is not a reusable procedure: SKILL.md declares no `## Inputs` section',
        previousAuthoringDraft: { body: refusedBody, smokeTest: refusedSmokeTest },
      },
      [],
      now,
    );
    const body = prompt.slice(prompt.indexOf('Refused SKILL.md:\n') + 'Refused SKILL.md:\n'.length, prompt.indexOf('\n\nRefused smoke.py:'));
    const smokeTest = prompt.slice(prompt.indexOf('Refused smoke.py:\n') + 'Refused smoke.py:\n'.length, prompt.lastIndexOf('\n\nAuthor SKILL.md and smoke.py now.'));
    expect(body).toBe(clipRefusedDraft(refusedBody, REFUSED_DRAFT_PROMPT_CHARS.body));
    expect(smokeTest).toBe(clipRefusedDraft(refusedSmokeTest, REFUSED_DRAFT_PROMPT_CHARS.smokeTest));
    expect(body).toMatch(/more characters not kept\)$/);
    expect(smokeTest).toMatch(/more characters not kept\)$/);
    expect(REFUSED_DRAFT_PROMPT_CHARS.body + REFUSED_DRAFT_PROMPT_CHARS.smokeTest).toBeLessThan(REFUSED_DRAFT_CHARS);
  });

  it('keeps the draft-free failure notice when nothing was kept', (): void => {
    const prompt = buildAuthorPrompt(
      { ...skill, previousAuthoringFailure: 'authoring failed before any sandbox ran: model unavailable' },
      [],
      now,
    );
    expect(prompt).toContain('Correct that failure in this attempt; do not repeat the rejected output.');
    expect(prompt).not.toContain('Refused SKILL.md');
    expect(prompt).not.toContain('--- Required correction ---');
  });

  // The hosted demo and the frozen evaluation author skills in mock mode, so
  // the author's instructions and the schema it answers in are byte-for-byte
  // what they were when those runs were recorded.
  it('keeps the mock author system prompt byte-identical', (): void => {
    expect(createHash('sha256').update(AUTHOR_SYSTEM).digest('hex')).toMatchInlineSnapshot(`"18ef5587bdadf6bac04c6dde98ac05c08025f135ff46caf6297f2fa34ad3ba20"`);
  });

  it('keeps the mock author schema byte-identical', (): void => {
    const schema = JSON.stringify(z.toJSONSchema(authorSchema));
    expect(createHash('sha256').update(schema).digest('hex')).toMatchInlineSnapshot(`"5e9fdc6c1f59fcee97c4b1504d62e838f1042c27436ff368467881945ca43a22"`);
  });

  it('tells the next authoring attempt why the prior smoke source was rejected', (): void => {
    const prompt = buildAuthorPrompt(
      {
        ...skill,
        previousAuthoringFailure:
          'smoke test rejected before sandbox: not valid Python 3.12 source',
      },
      [],
      now,
    );

    expect(prompt).toContain('Previous authoring attempt failed before registration');
    expect(prompt).toContain('not valid Python 3.12 source');
    expect(prompt).toContain('Correct that failure in this attempt');
  });
});
