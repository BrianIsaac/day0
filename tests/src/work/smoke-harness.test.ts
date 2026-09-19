import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verdictFor } from '../../../src/lib/skill-sandbox';
import { bindSkillInputs, CANDIDATE_BOUND_TARGET_INPUTS, REPLY_SURFACE_INPUT } from '../../../src/work/skill-inputs';
import {
  harnessedSmokeTest,
  SMOKE_HARNESS,
  smokeHarnessContract,
  type SmokeHarnessContract,
} from '../../../src/work/smoke-harness';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import {
  UNDECLARED_BODY_2026_09_19,
  UNDECLARED_SMOKE_TEST_2026_09_19,
} from '../../fixtures/skill-undeclared-inputs-2026-09-19';
import {
  REPLY_SURFACE_BODY_2026_09_19,
  REPLY_SURFACE_REASON_2026_09_19,
  REPLY_SURFACE_SMOKE_TEST_2026_09_19,
} from '../../fixtures/skill-reply-surface-2026-09-19';

interface HarnessRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A comment-and-close procedure that names the three tools its smoke test emits. */
const BODY = [
  '# kanban-comment-and-close',
  '',
  '## Inputs',
  '',
  '- `<record-id>`: the ticket.',
  '- `<requested-value>`: the note.',
  '- `<reply-channel>` and `<reply-thread>`: the Reply target line.',
  '',
  '## Procedure',
  '',
  '1. Emit an `mcp.call` with tool `save_comment` on `<record-id>` carrying `<requested-value>`.',
  '2. Emit an `mcp.call` with tool save_issue. Then, when a reply is owed, an `http.request` POST to `chat.postMessage`.',
].join('\n');

/** The surfaces the author was shown: a ticket surface over MCP and a chat surface over its API. */
const CONTRACT: SmokeHarnessContract = {
  body: BODY,
  targetSurface: 'linear',
  surfaces: [
    { slug: 'linear', path: 'mcp', allowedTools: ['get_issue', 'save_comment', 'save_issue', 'delete_issue'] },
    { slug: 'slack', path: 'documented-api', allowedTools: ['chat.postMessage', 'conversations.history'] },
  ],
  boundInputs: [...CANDIDATE_BOUND_TARGET_INPUTS],
  replySurfaceInput: REPLY_SURFACE_INPUT,
};

/** Run the harnessed program the way both sandboxes run smoke.py. */
function runHarnessed(authored: string, contract: SmokeHarnessContract = CONTRACT): HarnessRun {
  const dir = mkdtempSync(join(tmpdir(), 'day0-harness-'));
  try {
    writeFileSync(join(dir, 'SKILL.md'), '# skill\n');
    writeFileSync(join(dir, 'smoke.py'), harnessedSmokeTest(authored, contract));
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
    const program = harnessedSmokeTest(hostile, { ...CONTRACT, body: hostile });
    expect(program).not.toContain(hostile);
    expect(program).toContain(Buffer.from(hostile, 'utf8').toString('base64'));
    expect(SMOKE_HARNESS).toContain('__DAY0_AUTHORED_SOURCE__');
    expect(program).not.toContain('__DAY0_AUTHORED_SOURCE__');
    expect(SMOKE_HARNESS).toContain('__DAY0_SMOKE_CONTRACT__');
    expect(program).not.toContain('__DAY0_SMOKE_CONTRACT__');
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
        '    return {"actions": [{"tool": "mcp.call", "args": {"surface": "linear", "tool": "save_comment", "toolArgsJson": body}}]}',
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
        '        {"type": "mcp.call", "surface": "linear", "tool": "save_comment", "id": inputs["record-id"]},',
        '        {"tool": "http.request", "args": {"surface": "slack", "method": "POST", "path": "/chat.postMessage?pretty=1", "body": inputs["record-id"]}},',
        '    ]}',
        '',
        'CASES = [{"record-id": "OPS-1"}, {"record-id": "OPS-2"}]',
      ].join('\n'),
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('case 1: run() emitted 2 actions (mcp.call save_comment, http.request chat.postMessage)');
  });

  it('awaits a run() written as a coroutine function', (): void => {
    const run = runHarnessed(
      [
        'async def run(inputs: dict) -> dict:',
        '    return {"actions": [{"action": "mcp.call", "surface": "linear", "tool": "save_comment", "id": inputs["record-id"]}]}',
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
      // The reason is the first thing on stderr: the card shows the top of the log, and the
      // note about how the harness ran belongs to a run that passed.
      expect(run.stderr.startsWith('smoke harness: run() raised KeyError on case 2\n')).toBe(true);
      expect(run.stderr).not.toContain('called run() on the 2 cases');
      expect(run.stderr).toContain('File "authored_smoke.py", line 8, in run');
      // The line itself, as Python prints it under a frame: the author's file exists only inside the harness.
      expect(run.stderr).toContain('"toolArgsJson": json.dumps({"issueId": record, "body": inputs["requested-value"]})},');
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
      expect(run.stderr).toContain('run() emitted actions for 0 of 2 cases; 2 representative inputs must each make the skill emit an action');
    });

    it('the same output whatever the inputs', (): void => {
      const run = runHarnessed(
        [
          'def run(inputs: dict) -> dict:',
          '    return {"actions": [{"action": "mcp.call", "surface": "linear", "tool": "save_comment", "body": inputs["state"]}]}',
          'CASES = [{"state": "Done", "n": 1}, {"state": "Done", "n": 2}]',
        ].join('\n'),
      );

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('run() emitted the same action arguments for every case, so its writes do not follow its inputs');
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

  describe('refuses a run() whose actions are not the skill the manager approved', (): void => {
    const smoke = (...lines: string[]): string =>
      ['import json', '', 'def run(inputs: dict) -> dict:', ...lines.map((line: string): string => `    ${line}`), '', 'CASES = [', '    {"record-id": "OPS-31", "requested-value": "note one"},', '    {"record-id": "ENG-4", "requested-value": "note two"},', ']'].join('\n');
    const comment = (id: string, body: string): string =>
      `{"tool": "mcp.call", "args": {"surface": "linear", "tool": "save_comment", "toolArgsJson": json.dumps({"issueId": ${id}, "body": ${body}})}}`;

    it('one case that emits nothing while the other emits', (): void => {
      const run = runHarnessed(
        smoke(`actions = [] if inputs["record-id"] == "OPS-31" else [${comment('inputs["record-id"]', 'inputs["requested-value"]')}]`, 'return {"record": inputs["record-id"], "actions": actions}'),
      );

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('run() emitted actions for 1 of 2 cases');
    });

    it('a mock verb, which real mode refuses at execution', (): void => {
      const run = runHarnessed(smoke('return {"actions": [{"tool": "ticket.update", "args": {"slug": inputs["record-id"], "status": "done"}}]}'));

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('case 1 action 1 uses ticket.update; only mcp.call and http.request reach a real surface');
    });

    it('the wrong verb for the surface it names', (): void => {
      const run = runHarnessed(
        smoke('return {"actions": [{"tool": "http.request", "args": {"surface": "linear", "method": "POST", "path": "save_comment", "headersJson": None, "body": inputs["record-id"]}}]}'),
      );

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('case 1 action 1 uses http.request on linear, whose path is mcp');
    });

    it('arguments that are constants behind an output that follows the inputs', (): void => {
      const run = runHarnessed(smoke(`return {"observed": inputs["record-id"], "actions": [${comment('"OPS-HARDCODED"', '"a fixed note"')}]}`));

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('no action argument in case 1 carries a value that case supplied; a write that ignores its inputs is hard-coded');
    });

    it('a hard-coded ticket behind a comment that follows the inputs', (): void => {
      const run = runHarnessed(smoke(`return {"actions": [${comment('"OPS-HARDCODED"', 'inputs["requested-value"]')}]}`));

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('case 1 supplies <record-id> but no action argument carries it');
      expect(run.stderr).toContain('aimed at a constant');
    });

    it('a reply sent to a hard-coded channel when the case gave the reply target, underscores or not', (): void => {
      const run = runHarnessed(
        [
          'import json',
          'def run(inputs: dict) -> dict:',
          `    return {"actions": [${comment('inputs["record_id"]', '"n"')}, {"tool": "http.request", "args": {"surface": "slack", "method": "POST", "path": "chat.postMessage", "headersJson": None, "body": json.dumps({"channel": "C0GENERAL", "text": inputs["record_id"]})}}]}`,
          'CASES = [{"record_id": "OPS-31", "reply_channel": "C0ONE"}, {"record_id": "ENG-4", "reply_channel": "C0TWO"}]',
        ].join('\n'),
      );

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('case 1 supplies <reply-channel> but no action argument carries it');
    });

    it('a tool the surface allows but SKILL.md never names', (): void => {
      const run = runHarnessed(smoke('return {"actions": [{"tool": "mcp.call", "args": {"surface": "linear", "tool": "delete_issue", "toolArgsJson": json.dumps({"id": inputs["record-id"]})}}]}'));

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('case 1 action 1 uses delete_issue, which SKILL.md never names');
    });

    it('a tool outside the surface allowlist, even when SKILL.md names it', (): void => {
      const run = runHarnessed(
        smoke('return {"actions": [{"tool": "mcp.call", "args": {"surface": "linear", "tool": "archive_issue", "toolArgsJson": json.dumps({"id": inputs["record-id"]})}}]}'),
        { ...CONTRACT, body: `${BODY}\n3. Then archive_issue.` },
      );

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('case 1 action 1 uses archive_issue, which is not in the allowlist of linear');
    });

    it('a surface the author was never shown as connected', (): void => {
      const run = runHarnessed(smoke('return {"actions": [{"tool": "mcp.call", "args": {"surface": "github", "tool": "save_comment", "toolArgsJson": json.dumps({"id": inputs["record-id"]})}}]}'));

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain("case 1 action 1 targets surface 'github', which is not a connected surface (connected: linear, slack)");
    });

    it('actions that never touch the surface the skill was approved for', (): void => {
      const run = runHarnessed(
        smoke('return {"actions": [{"tool": "http.request", "args": {"surface": "slack", "method": "POST", "path": "chat.postMessage", "headersJson": None, "body": json.dumps({"text": inputs["record-id"]})}}]}'),
      );

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr).toContain('no case emits an action on linear, the surface this skill was approved for');
    });

    it('a run() that outlasts the time the sandbox gives it, which no except clause survives', (): void => {
      const dir = mkdtempSync(join(tmpdir(), 'day0-harness-'));
      try {
        const sleeper = smoke('import time', 'try:', '    time.sleep(60)', 'except BaseException:', '    pass', `return {"actions": [${comment('inputs["record-id"]', '"n"')}]}`);
        writeFileSync(join(dir, 'smoke.py'), harnessedSmokeTest(sleeper, CONTRACT));
        const run = spawnSync('python3', ['smoke.py'], { cwd: dir, encoding: 'utf8', timeout: 1_500, killSignal: 'SIGKILL' });

        expect(run.status).toBeNull();
        const outcome = verdictFor('local', { sandboxId: 'local:test', exitCode: 137, stdout: run.stdout, stderr: run.stderr, timedOut: true });
        expect(outcome.ok).toBe(false);
        expect(outcome.failureReason).toBe('smoke test did not finish within the sandbox time limit');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('does not refuse a sound skill for what the rules above are not about', (): void => {
    it('a third case that shows the branch where the skill emits nothing', (): void => {
      const run = runHarnessed(
        [
          ...RUN.slice(0, 4),
          '    if not inputs.get("record-id"):',
          '        return {"notes": "no ticket named", "actions": []}',
          ...RUN.slice(4),
          '',
          ...CASES.slice(0, 3),
          '    {"requested-value": "nothing to file"},',
          ']',
        ].join('\n'),
      );

      expect(run.stderr).not.toContain('smoke harness: run()');
      expect(verdict(run).ok).toBe(true);
      expect(run.stdout).toContain('case 3: run() emitted 0 actions (none)');
    });

    it('a note with quotes, a line break and non-ASCII text carried inside toolArgsJson', (): void => {
      const run = runHarnessed(
        [
          'import json',
          'def run(inputs: dict) -> dict:',
          '    return {"actions": [{"tool": "mcp.call", "args": {"surface": "linear", "tool": "save_comment", "toolArgsJson": json.dumps({"body": inputs["requested-value"]})}}]}',
          'CASES = [{"requested-value": "She said \\"fermé\\"\\nthen left"}, {"requested-value": "Second \\\\ note"}]',
        ].join('\n'),
      );

      expect(run.stderr).not.toContain('carries a value');
      expect(verdict(run).ok).toBe(true);
    });

    it('the one live real-mode draft on record, against the surfaces its author was shown', (): void => {
      const now = Date.UTC(2026, 8, 19);
      const surface = (slug: string, path: SurfaceRecord['path'], toolAllowlist: string[], lastVerifiedAt: number): SurfaceRecord => ({
        slug,
        displayName: slug,
        class: 'ticket',
        verdict: 'connected',
        credentialLanded: true,
        lastVerifiedAt,
        path,
        toolAllowlist,
      });
      const contract = smokeHarnessContract(
        UNDECLARED_BODY_2026_09_19,
        [
          surface('linear', 'mcp', ['get_issue', 'list_issues', 'save_comment', 'save_issue'], now - 60_000),
          surface('slack', 'documented-api', ['chat.postMessage', 'conversations.history'], now - 60_000),
          surface('notion', 'mcp', ['search'], now - 7 * 60 * 60 * 1_000),
        ],
        'linear',
        now,
      );

      expect(contract.surfaces.map((entry): string => entry.slug)).toEqual(['linear', 'slack']);
      const run = runHarnessed(UNDECLARED_SMOKE_TEST_2026_09_19, contract);
      expect(run.stderr).not.toContain('smoke harness: case');
      expect(verdict(run).ok).toBe(true);
      expect(run.stdout).toContain('case 1: run() emitted 3 actions (mcp.call save_comment, mcp.call save_issue, http.request chat.postMessage)');
    });

    it('holds only inputs the executor binds by value from the candidate row to reaching an argument', (): void => {
      const bound = bindSkillInputs(
        ['## Inputs', '', ...CANDIDATE_BOUND_TARGET_INPUTS.map((name: string): string => `- \`<${name}>\`: bound.`)].join('\n'),
        { externalId: 'OPS-31', contentRefs: [], sourceSystem: 'Linear', replyTarget: { channel: 'C0ONE', threadTs: '1710000000.000101' } },
      );

      expect(bound.map((binding): string => binding.name)).toEqual([...CANDIDATE_BOUND_TARGET_INPUTS]);
      expect(bound.every((binding): boolean => binding.value !== undefined)).toBe(true);
    });
  });

  // Demo rehearsal 2, 19 Sep 2026, finding 1: a first authoring routed its
  // thread reply through <originating-surface>, and its own second case set
  // that to the ticket surface with a reply channel.
  describe('the surface that carries the reply', (): void => {
    /** A comment-and-close procedure written to the taught reply-surface input. */
    const REPLY_SURFACE_BODY = [
      '# kanban-comment-and-close',
      '',
      '## Inputs',
      '',
      '- `<record-id>`: the ticket.',
      '- `<requested-value>`: the note.',
      '- `<reply-channel>` and `<reply-thread>`: the Reply target line.',
      '- `<reply-surface>`: the connected chat surface the Reply target line names.',
      '- `<originating-surface>`: the surface the work came from.',
      '',
      '## Procedure',
      '',
      '1. Emit an `mcp.call` with tool `save_comment` on `<record-id>` carrying `<requested-value>`, then `save_issue`.',
      '2. When a reply is owed, emit an `http.request` POST to `chat.postMessage` on `<reply-surface>`.',
    ].join('\n');

    const replySmoke = (replySurfaceExpression: string): string =>
      [
        'import json',
        '',
        '',
        'def run(inputs: dict) -> dict:',
        '    record = inputs["record-id"]',
        '    ticket_surface = inputs["originating-surface"]',
        '    actions = [',
        '        {"tool": "mcp.call", "args": {"surface": ticket_surface, "tool": "save_comment", "toolArgsJson": json.dumps({"issueId": record, "body": inputs["requested-value"]})}},',
        '        {"tool": "mcp.call", "args": {"surface": ticket_surface, "tool": "save_issue", "toolArgsJson": json.dumps({"id": record, "state": "Done"})}},',
        '    ]',
        '    if inputs.get("reply-channel"):',
        '        actions.append({"tool": "http.request", "args": {',
        `            "surface": ${replySurfaceExpression},`,
        '            "method": "POST",',
        '            "path": "chat.postMessage",',
        '            "headersJson": json.dumps({"Authorization": "Bearer {{secret}}"}),',
        '            "body": json.dumps({"channel": inputs["reply-channel"], "thread_ts": inputs.get("reply-thread"), "text": "Closed " + record}),',
        '        }})',
        '    return {"actions": actions}',
        '',
        '',
        'CASES = [',
        '    {"record-id": "FIN-12", "requested-value": "matched to the cent", "originating-surface": "linear"},',
        '    {"record-id": "LOG-7", "requested-value": "carrier confirmed", "originating-surface": "linear",',
        '     "reply-surface": "slack", "reply-channel": "C0AAAAAAA2", "reply-thread": "1710000000.000200"},',
        ']',
      ].join('\n');

    const contract: SmokeHarnessContract = {
      ...CONTRACT,
      body: REPLY_SURFACE_BODY,
      surfaces: [...CONTRACT.surfaces, { slug: 'teams', path: 'documented-api', allowedTools: ['chat.postMessage'] }],
    };

    it('refuses the draft the rehearsal refused, for the reason the row kept', (): void => {
      const run = runHarnessed(REPLY_SURFACE_SMOKE_TEST_2026_09_19, { ...CONTRACT, body: REPLY_SURFACE_BODY_2026_09_19 });

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr.split('\n')[0]).toContain(REPLY_SURFACE_REASON_2026_09_19);
    });

    it('tells the retry which surface carries the reply when the refused action is the reply', (): void => {
      const run = runHarnessed(REPLY_SURFACE_SMOKE_TEST_2026_09_19, { ...CONTRACT, body: REPLY_SURFACE_BODY_2026_09_19 });

      expect(run.stderr.split('\n')[0]).toBe(
        `${REPLY_SURFACE_REASON_2026_09_19}; it carries the case's <reply-channel>, and a reply is an action on <reply-surface>, the connected chat surface, never on the surface the ticket is on`,
      );
    });

    it('keeps that sentence for a reply sent by HTTP, not for a wrong verb on the chat surface itself', (): void => {
      const smoke = replySmoke('inputs["reply-surface"]').replace('"tool": "http.request", "args": {', '"tool": "mcp.call", "args": {');
      const run = runHarnessed(smoke, contract);

      expect(run.stderr.split('\n')[0]).toBe('smoke harness: case 2 action 3 uses mcp.call on slack, whose path is documented-api');
    });

    it('passes a ticket-born case with a reply target when the reply goes to the reply surface', (): void => {
      const run = runHarnessed(replySmoke('inputs["reply-surface"]'), contract);

      expect(run.stderr).not.toContain('smoke harness: case');
      expect(verdict(run).ok).toBe(true);
      expect(run.stdout).toContain(
        'case 2: run() emitted 3 actions (mcp.call save_comment, mcp.call save_issue, http.request chat.postMessage)',
      );
    });

    it('refuses a reply sent on a surface other than the one the case gives as its reply surface', (): void => {
      const run = runHarnessed(replySmoke('"teams"'), contract);

      expect(verdict(run).ok).toBe(false);
      expect(run.stderr.split('\n')[0]).toBe(
        "smoke harness: case 2 action 3 sends the reply to <reply-channel> on teams, but the case gives <reply-surface> as slack; the executor binds <reply-surface> from the Reply target line, so the reply is an action on that surface",
      );
    });

    it('leaves a case that gives a reply surface and no reply channel alone', (): void => {
      const smoke = replySmoke('inputs["reply-surface"]').replace(
        '{"record-id": "FIN-12", "requested-value": "matched to the cent", "originating-surface": "linear"},',
        '{"record-id": "FIN-12", "requested-value": "matched to the cent", "originating-surface": "linear", "reply-surface": "slack"},',
      );

      expect(verdict(runHarnessed(smoke, contract)).ok).toBe(true);
    });

    it('names the reply surface input in the contract it builds', (): void => {
      expect(smokeHarnessContract(REPLY_SURFACE_BODY, [], 'linear', 0).replySurfaceInput).toBe('reply-surface');
    });
  });
});
