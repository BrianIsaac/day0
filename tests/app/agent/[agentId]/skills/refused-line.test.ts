import { describe, expect, it } from 'vitest';
import { refusedLineOf } from '../../../../../app/agent/[agentId]/skills/refused-line';

const smoke = ['def run(inputs: dict) -> dict:', '    return {"tile": inputs["tile-id"]', ''].join(
  '\n',
);

describe('refusedLineOf', (): void => {
  it('reads the syntax check’s line and column when the draft’s line is the one it quotes', (): void => {
    expect(
      refusedLineOf(
        'smoke test rejected before sandbox: smoke test is not valid Python 3.12 source: its syntax does not parse at line 2, column 12: `    return {"tile": inputs["tile-id"]`',
        smoke,
      ),
    ).toEqual({ line: 2, column: 12 });
  });

  it('reads the last frame of a sandbox traceback in the author’s file', (): void => {
    const log = [
      'verification in the local sandbox (local:1f2e) failed - smoke test exited 1',
      '',
      'stderr:',
      'Traceback (most recent call last):',
      '  File "/harness/smoke_harness.py", line 40, in main',
      '    out = run(case)',
      '  File "authored_smoke.py", line 1, in run',
      '    def run(inputs: dict) -> dict:',
      '  File "authored_smoke.py", line 2, in run',
      '    return {"tile": inputs["tile-id"]',
      "KeyError: 'tile-id'",
    ].join('\n');
    expect(refusedLineOf(log, smoke)).toEqual({ line: 2 });
  });

  it('marks nothing for a reason with no position, a line past the draft, or a quote the draft does not carry', (): void => {
    expect(
      refusedLineOf('the authored skill is not a reusable procedure: SKILL.md uses <x>', smoke),
    ).toBeUndefined();
    expect(
      refusedLineOf('its syntax does not parse at line 9, column 1: `x`', smoke),
    ).toBeUndefined();
    expect(
      refusedLineOf('its syntax does not parse at line 1, column 1: `import os`', smoke),
    ).toBeUndefined();
    expect(
      refusedLineOf('  File "authored_smoke.py", line 2, in run\n    print("elsewhere")', smoke),
    ).toBeUndefined();
  });
});
