import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verdictFor } from '../../../src/lib/skill-sandbox';
import { harnessedSmokeTest, SMOKE_HARNESS } from '../../../src/work/smoke-harness';

interface HarnessRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run the harnessed program the way both sandboxes run smoke.py. */
function runHarnessed(authored: string): HarnessRun {
  const dir = mkdtempSync(join(tmpdir(), 'day0-harness-'));
  try {
    writeFileSync(join(dir, 'SKILL.md'), '# skill\n');
    writeFileSync(join(dir, 'smoke.py'), harnessedSmokeTest(authored));
    const run = spawnSync('python3', ['smoke.py'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verdict(run: HarnessRun) {
  return verdictFor('local', { sandboxId: 'local:test', ...run });
}

const RUN = [
  'import json',
  '',
  '',
  'def run(inputs: dict) -> dict:',
  '    record = inputs["record-id"]',
  '    actions = [',
  '        {"action": "mcp.call", "surface": "linear", "tool": "save_comment",',
  '         "toolArgsJson": json.dumps({"issueId": record, "body": inputs["requested-value"]})},',
  '        {"action": "mcp.call", "surface": "linear", "tool": "save_issue",',
  '         "toolArgsJson": json.dumps({"id": record, "state": inputs["closing-state"]})},',
  '    ]',
  '    if inputs.get("reply-channel"):',
  '        actions.append({"action": "http.request", "surface": "slack", "method": "POST",',
  '                        "path": "chat.postMessage",',
  '                        "body": json.dumps({"channel": inputs["reply-channel"], "text": f"Done on {record}"})})',
  '    return {"actions": actions}',
];

const CASES = [
  'CASES = [',
  '    {"record-id": "OPS-31", "requested-value": "note one", "closing-state": "Done", "reply-channel": "C0ONE"},',
  '    {"record-id": "ENG-4", "requested-value": "note two", "closing-state": "Closed"},',
  ']',
];

describe('the real-mode smoke harness', (): void => {
  it('embeds the author source without letting any character end the string it sits in', (): void => {
    const hostile = 'x = """\nprint(\'"""\')\n\\u0000 ${`\u2028';
    const program = harnessedSmokeTest(hostile);
    expect(program).not.toContain(hostile);
    expect(program).toContain(Buffer.from(hostile, 'utf8').toString('base64'));
    expect(SMOKE_HARNESS).toContain('__DAY0_AUTHORED_SOURCE__');
    expect(program).not.toContain('__DAY0_AUTHORED_SOURCE__');
  });

  it('calls run() once per declared case and prints one line per case', (): void => {
    const run = runHarnessed([...RUN, '', ...CASES].join('\n'));

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim().split('\n')).toEqual([
      'case 1: run() emitted 3 actions (mcp.call save_comment, mcp.call save_issue, http.request chat.postMessage); carries OPS-31, note one, Done',
      'case 2: run() emitted 2 actions (mcp.call save_comment, mcp.call save_issue); carries ENG-4, note two, Closed',
    ]);
    expect(run.stderr).toContain('called run() on the 2 cases the smoke test declares');
    expect(verdict(run).ok).toBe(true);
  });

  it('runs none of the author top level beside CASES, so its own checks cannot fail the skill', (): void => {
    const run = runHarnessed(
      [
        ...RUN,
        '',
        ...CASES,
        '',
        'out = run(CASES[0])',
        'assert out["actions"][2]["body"].count("OPS-31") == 0',
        'if "OPS-31" in out["actions"][2]["body"]:',
        '    raise SystemExit(1)',
        'raise AssertionError("the author disagrees with itself")',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
    expect(verdict(run).ok).toBe(true);
  });

  it('compiles out an assert the author put inside run() itself', (): void => {
    const run = runHarnessed(
      [
        'def run(inputs: dict) -> dict:',
        '    body = f"posted on {inputs[\'record-id\']}"',
        '    assert body.count(inputs["record-id"]) == 0',
        '    return {"actions": [{"action": "mcp.call", "tool": "save_comment", "body": body}]}',
        '',
        'CASES = [{"record-id": "OPS-1"}, {"record-id": "OPS-2"}]',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
  });

  it('names each action by its verb first, whichever key the author put the verb under', (): void => {
    const run = runHarnessed(
      [
        'def run(inputs: dict) -> dict:',
        '    return {"actions": [',
        '        {"type": "mcp.call", "tool": "save_comment", "id": inputs["record-id"]},',
        '        {"tool": "http.request", "args": {"path": "chat.postMessage"}},',
        '        {"action": "notes", "text": "no verb here"},',
        '    ]}',
        '',
        'CASES = [{"record-id": "OPS-1"}, {"record-id": "OPS-2"}]',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('case 1: run() emitted 3 actions (mcp.call save_comment, http.request chat.postMessage, notes)');
  });

  it('awaits a run() written as a coroutine function', (): void => {
    const run = runHarnessed(
      [
        'async def run(inputs: dict) -> dict:',
        '    return {"actions": [{"action": "mcp.call", "tool": "save_comment", "id": inputs["record-id"]}]}',
        '',
        'CASES = [{"record-id": "OPS-1"}, {"record-id": "OPS-2"}]',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('case 2: run() emitted 1 action (mcp.call save_comment); carries OPS-2');
  });

  it('reads the older form without CASES by recording the calls the program makes, asserts not compiled', (): void => {
    const run = runHarnessed(
      [
        ...RUN,
        '',
        'a = run({"record-id": "OPS-31", "requested-value": "n1", "closing-state": "Done", "reply-channel": "C0ONE"})',
        'b = run({"record-id": "ENG-4", "requested-value": "n2", "closing-state": "Done"})',
        'assert a["actions"][2]["body"].count("OPS-31") == 0',
        'print("ok", a["actions"][0]["tool"], b["actions"][0]["tool"])',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('case 1: run() emitted 3 actions');
    expect(run.stdout).toContain('case 2: run() emitted 2 actions');
    expect(run.stderr).toContain('declares no CASES, so its program ran as written with its assert statements not compiled; 2 run() calls recorded');
  });

  it('keeps the calls an older-form program made before its own check stopped it', (): void => {
    const run = runHarnessed(
      [
        ...RUN,
        '',
        'def main():',
        '    a = run({"record-id": "OPS-31", "requested-value": "n1", "closing-state": "Done", "reply-channel": "C0ONE"})',
        '    b = run({"record-id": "ENG-4", "requested-value": "n2", "closing-state": "Done"})',
        '    if "OPS-31" in a["actions"][2]["body"]:',
        '        raise ValueError("reply names its ticket")',
        '',
        'if __name__ == "__main__":',
        '    main()',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('the program stopped on its own check, ValueError at line 22');
    expect(verdict(run).ok).toBe(true);
  });

  it('does not count a call the older-form program expected to raise', (): void => {
    const run = runHarnessed(
      [
        ...RUN,
        '',
        'try:',
        '    run({})',
        'except KeyError:',
        '    pass',
        'run({"record-id": "OPS-31", "requested-value": "n1", "closing-state": "Done"})',
        'run({"record-id": "ENG-4", "requested-value": "n2", "closing-state": "Done"})',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim().split('\n')).toHaveLength(2);
  });

  describe('refuses a run() that does not have the skill shape, saying why', (): void => {
    it('names the case run() could not run, with the author frames of the traceback', (): void => {
      const run = runHarnessed([...RUN, '', 'CASES = [{"record-id": "OPS-1", "requested-value": "n", "closing-state": "Done"}, {"record-id": "OPS-2"}]'].join('\n'));

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('smoke harness: run() raised KeyError on case 2');
      expect(run.stderr).toContain('File "authored_smoke.py", line 8, in run');
      expect(run.stderr).not.toMatch(/File "smoke\.py"/);
      expect(verdict(run).failureReason).toBe('smoke test exited 1');
    });

    it('a run() that returns something other than a dict', (): void => {
      const run = runHarnessed(['def run(inputs: dict) -> dict:', '    return [inputs]', 'CASES = [{"a": "1"}, {"a": "2"}]'].join('\n'));

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('run() returned list for case 1; it must return a dict with an actions list');
    });

    it('a dict with no actions list', (): void => {
      const run = runHarnessed(['def run(inputs: dict) -> dict:', '    return {"result": inputs["a"]}', 'CASES = [{"a": "1"}, {"a": "2"}]'].join('\n'));

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('run() returned no actions list for case 1');
    });

    it('no action for any case', (): void => {
      const run = runHarnessed(['def run(inputs: dict) -> dict:', '    return {"actions": [], "a": inputs["a"]}', 'CASES = [{"a": "1"}, {"a": "2"}]'].join('\n'));

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('run() emitted no actions for any case');
    });

    it('the same output whatever the inputs', (): void => {
      const run = runHarnessed(['def run(inputs: dict) -> dict:', '    return {"actions": [{"action": "mcp.call", "tool": "save_comment"}]}', 'CASES = [{"a": "1"}, {"a": "2"}]'].join('\n'));

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('run() returned the same output for every case, so its actions do not follow its inputs');
    });

    it('an older-form program whose own check stopped it before its second call', (): void => {
      const run = runHarnessed(
        [
          ...RUN,
          '',
          'a = run({"record-id": "OPS-31", "requested-value": "n1", "closing-state": "Done", "reply-channel": "C0ONE"})',
          'if "OPS-31" in a["actions"][2]["body"]:',
          '    raise SystemExit(1)',
          'b = run({"record-id": "ENG-4", "requested-value": "n2", "closing-state": "Done"})',
        ].join('\n'),
      );

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('the smoke test called run() on 1 input dict; declare CASES, a list of two representative input dicts');
      expect(run.stderr).toContain('the program stopped on its own check, SystemExit at line 20');
    });

    it('an older-form run() that raised where the program did not catch it', (): void => {
      const run = runHarnessed([...RUN, '', 'run({"record-id": "OPS-1", "requested-value": "n", "closing-state": "Done"})', 'run({})'].join('\n'));

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("run() raised KeyError on the smoke test's call 2");
    });
  });
});
