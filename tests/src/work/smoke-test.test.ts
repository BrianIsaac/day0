import { describe, expect, it } from 'vitest';
import {
  FENCE_REMOVED_NOTE,
  smokeTestPreflightReason,
  unwrapMarkdownFence,
} from '../../../src/work/smoke-test';

const program = [
  'def run(inputs: dict) -> dict:',
  '    return {"actions": [{"tool": "mcp.call", "args": {"value": inputs["requested_value"]}}]}',
  'print("ok", run({"requested_value": "61%"})["actions"][0]["args"]["value"])',
].join('\n');

describe('a smoke test wrapped in a markdown fence', (): void => {
  it('is unwrapped whether or not the fence names a language', (): void => {
    expect(unwrapMarkdownFence('```python\n' + program + '\n```')).toEqual({ source: program, unwrapped: true });
    expect(unwrapMarkdownFence('```\n' + program + '\n```\n')).toEqual({ source: program, unwrapped: true });
    expect(unwrapMarkdownFence('  ```py\n' + program + '\n```  ')).toEqual({ source: program, unwrapped: true });
  });

  it('leaves an unfenced program and a program that merely contains a fence alone', (): void => {
    expect(unwrapMarkdownFence(program)).toEqual({ source: program, unwrapped: false });
    const inner = 'print("```")\n' + program;
    expect(unwrapMarkdownFence(inner)).toEqual({ source: inner, unwrapped: false });
    expect(unwrapMarkdownFence('```python\n' + program)).toEqual({ source: '```python\n' + program, unwrapped: false });
  });

  it('names what was done for the log', (): void => {
    expect(FENCE_REMOVED_NOTE).toContain('markdown fence');
    expect(FENCE_REMOVED_NOTE).toContain('removed');
  });
});

describe('the smoke test preflight', (): void => {
  it('passes a program that parses and carries the landmarks', (): void => {
    expect(smokeTestPreflightReason(program)).toBeUndefined();
  });

  it('quotes the line and column of the first parse error and the offending line', (): void => {
    const broken = [
      'def run(inputs: dict) -> dict:',
      '    return {"actions": [}',
      'print(run({}))',
    ].join('\n');
    const reason = smokeTestPreflightReason(broken);
    expect(reason).toContain('not valid Python 3.12 source');
    expect(reason).toContain('does not parse at line 2, column');
    expect(reason).toContain('`    return {"actions": [}`');
  });

  it('redacts a token on the quoted line and bounds it', (): void => {
    const broken = [
      'def run(inputs: dict) -> dict:',
      '    token = "xoxb-1234567890-abcdefghijkl" +',
      'print(run({}))',
    ].join('\n');
    const reason = smokeTestPreflightReason(broken)!;
    expect(reason).toContain('line 2');
    expect(reason).not.toContain('xoxb-');
    expect(reason).toContain('<redacted>');
    const long = `def run(inputs: dict) -> dict:\n    x = [${'1, '.repeat(200)}}\nprint(run({}))`;
    const bounded = smokeTestPreflightReason(long)!;
    expect(bounded.length).toBeLessThan(400);
    expect(bounded).toContain('line 2');
    expect(bounded).toContain('…');
  });

  it('needs no printed line in real mode, where the harness prints one per case', (): void => {
    const cases = [
      'def run(inputs: dict) -> dict:',
      '    return {"actions": [{"tool": "mcp.call", "args": {"value": inputs["requested_value"]}}]}',
      'CASES = [{"requested_value": "61%"}, {"requested_value": "58%"}]',
    ].join('\n');
    expect(smokeTestPreflightReason(cases, 'real')).toBeUndefined();
    expect(smokeTestPreflightReason(cases, 'mock')).toContain('must print a success line');
    expect(smokeTestPreflightReason(cases)).toContain('must print a success line');
    expect(smokeTestPreflightReason('def main(inputs: dict) -> dict:\n    return {}\n', 'real')).toContain(
      'must define run(inputs: dict) -> dict',
    );
  });

  it('does not unwrap a fence itself: the caller decides and records it', (): void => {
    expect(smokeTestPreflightReason('```python\n' + program + '\n```')).toContain('does not parse at line 1, column 1');
  });
});
