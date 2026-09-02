/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import {
  AUTHOR_SYSTEM,
  buildAuthorPrompt,
  verifyAuthoredSkill,
} from '../../convex/skillActions';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';
import type { SurfaceRecord } from '../../src/surfaces/types';

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
    expect(AUTHOR_SYSTEM).toContain('take the action shape (tool names, argument names, paths) from the runbook');
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

  it('keeps the mock author prompt unchanged when nothing is connected', (): void => {
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
    expect(prompt).toContain('preserve its tool name, argument names and literal values exactly');
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
    ).resolves.toEqual({ ok: true, result: sandboxResult });
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
    ).resolves.toEqual({ ok: true, result: sandboxResult });
    expect(verify).toHaveBeenCalledOnce();
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
