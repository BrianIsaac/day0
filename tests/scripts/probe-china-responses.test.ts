import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/probe-china-connectivity.sh');
function exercise(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), 'day0-probe-response-'));
  const executable = (name: string, body: string) =>
    writeFileSync(join(directory, name), body, { mode: 0o755 });
  executable('getent', '#!/bin/sh\necho "127.0.0.1 STREAM local"\n');
  executable('openssl', `#!/bin/sh
if [ "$1" = s_client ] && [ "$SCENARIO" = tls ]; then exec sleep 3; fi
exit 0
`);
  const shellEnvironment = join(directory, 'bash-env');
  writeFileSync(shellEnvironment, `
if [ "$SCENARIO" = cleanup-legacy ]; then unset BASHPID; fi
kill() {
  if [ "$1" = "\${deadline_pid:-}" ]; then
    # Cancellation can run the inherited trap before Bash updates BASH_SUBSHELL.
    ( BASH_SUBSHELL=0; eval "$(trap -p EXIT)"; exit 0 )
  fi
  builtin kill "$@"
}
`);
  executable('curl', `#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
def arg(k): return args[args.index(k)+1] if k in args else ''
url=args[-1]
if 'dns.google' in url:
 print('{"data":"127.0.0.1"}'); sys.exit(0)
code='200'; body={"id":"test-model"}
if '--data-binary' in args:
 request=json.loads(arg('--data-binary'))
 scenario=os.environ['SCENARIO']
 if scenario == 'fallback' and 'max_completion_tokens' in request:
  code='400'; body={"error":{"message":"unsupported max_completion_tokens"}}
 elif scenario in ('advisory', 'required') and (('response_format' in request) == (scenario == 'advisory')):
  code='000'; body={}
 else:
  message={"content":"ready"}
  if 'tools' in request:
   message={"tool_calls":[{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Hangzhou\\"}"}}]}
  elif 'response_format' in request:
   message={"content":"{\\"title\\":\\"Task\\",\\"priority\\":\\"low\\"}"}
  body={"choices":[{"message":message,"finish_reason":"stop"}]}
if arg('-o'):
 with open(arg('-o'),'w') as f: json.dump(body,f)
print(code,end='')
`);
  const start = Date.now();
  try {
    const result = spawnSync('bash', [script, '--model', 'test-model', '--timeout', '1', '--no-reference', '--no-catalogue'], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TMPDIR: directory,
        FEATHERLESS_API_KEY: scenario === 'tls' ? '' : 'synthetic',
        SCENARIO: scenario,
        ...(scenario.startsWith('cleanup') ? { BASH_ENV: shellEnvironment } : {}),
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      ...result,
      elapsed: Date.now() - start,
      remainingProbeDirectories: readdirSync(directory).filter((name) => name.startsWith('day0-probe.')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Each case runs the probe script in a child process that is allowed ten
// seconds, so the default five-second test bound fails first on a busy machine.
describe('arrival probe response paths', { timeout: 20_000 }, () => {
  it('bounds certificate inspection when TCP connects but TLS stalls', () => {
    const result = exercise('tls');
    expect(result.stdout).toContain('Summary');
    expect(result.elapsed).toBeLessThan(2500);
  });
  it('keeps timed-out JSON-format checks advisory', () => {
    const result = exercise('advisory');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tier 1:');
    expect(result.stdout).toMatch(/note\s+response_format json_schema\s+no HTTP response/);
  });
  it('still fails timed-out required completion checks', () => {
    const result = exercise('required');
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('tier 3:');
  });
  it('reports the token-field mismatch after a successful fallback', () => {
    const result = exercise('fallback');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('server rejected max_completion_tokens; retried with max_tokens');
  });
  it.each(['cleanup', 'cleanup-legacy'])('only lets the owning process clean up probe files (%s)', (scenario) => {
    const result = exercise(scenario);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Summary');
    expect(result.stdout).toContain('tier 1:');
    expect(result.remainingProbeDirectories).toEqual([]);
  });
});
