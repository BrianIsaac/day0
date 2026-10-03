/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { verifyAuthoredSkill } from '../../convex/skillSandboxCheck';
import { harnessedSmokeTest, smokeHarnessContract } from '../../src/work/smoke-harness';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';

/*
 * The sandbox check of an authored skill (`convex/skillSandboxCheck.ts`, split from
 * `skillActions` by 11-FI): the static refusals before a sandbox is asked, the harness around a
 * real-mode program, and what the sandbox's answer becomes. Moved here from the author prompt's
 * tests unchanged (the wave 11 review's m16).
 */

describe('the sandbox check of an authored skill', (): void => {
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
    const program =
      'def run(inputs: dict) -> dict:\n    return {"actions": []}\nprint("ok", run({}))';

    await expect(
      verifyAuthoredSkill(
        {
          skillName: 'update-spreadsheet',
          skillBody: '# Update spreadsheet',
          smokeTest: '```python\n' + program + '\n```',
        },
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
        {
          skillName: 's',
          skillBody: '# s',
          smokeTest: 'def main(inputs: dict) -> dict:\n    return {}\nCASES = []\n',
        },
        verify,
        'real',
      ),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('must define run(inputs: dict) -> dict'),
    });
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
});
