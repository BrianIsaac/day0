import { describe, expect, it } from 'vitest';
import {
  containerDialArguments,
  containerReachArguments,
  firstLine,
  readContainerDial,
  unreachableFix,
} from '../../scripts/model-reach';

describe('dialling the model address from inside the backend container', (): void => {
  it('asks curl inside the backend container for the models list, with no key and a bounded wait', (): void => {
    const args = containerDialArguments('http://10.1.2.3:8080/v1/');
    expect(args.slice(0, 4)).toEqual(['exec', '-T', 'backend', 'curl']);
    expect(args.at(-1)).toBe('http://10.1.2.3:8080/v1/models');
    expect(args).toContain('--max-time');
    expect(args.join(' ')).not.toMatch(/authorization|bearer|-H\b/i);
  });

  it("asks a vendor's address as it is given, with a GET, no credential and a bounded wait", (): void => {
    const args = containerReachArguments('https://slack.com/api/api.test');
    expect(args.slice(0, 4)).toEqual(['exec', '-T', 'backend', 'curl']);
    expect(args.at(-1)).toBe('https://slack.com/api/api.test');
    expect(args).toContain('--max-time');
    expect(args.join(' ')).not.toMatch(/authorization|bearer|-H\b|-X|--data/i);
  });

  it('counts any HTTP answer as reached, a refusal included', (): void => {
    expect(readContainerDial({ status: 0, stdout: '401', stderr: '' })).toEqual({
      reach: 'reached',
      detail: 'HTTP 401',
    });
  });

  it("keeps curl's own words when nothing answered", (): void => {
    expect(
      readContainerDial({
        status: 28,
        stdout: '000',
        stderr: 'curl: (28) Connection timed out after 10002 milliseconds\n',
      }),
    ).toEqual({
      reach: 'unreachable',
      detail: 'curl: (28) Connection timed out after 10002 milliseconds',
    });
    expect(
      readContainerDial({
        status: 6,
        stdout: '000',
        stderr: 'curl: (6) Could not resolve host: ollama\n',
      }),
    ).toEqual({ reach: 'unreachable', detail: 'curl: (6) Could not resolve host: ollama' });
  });

  it('says it does not know when the container did not run curl at all', (): void => {
    expect(
      readContainerDial({ status: 1, stdout: '', stderr: 'service "backend" is not running\n' }),
    ).toEqual({ reach: 'unknown', detail: 'service "backend" is not running' });
  });

  it('names the fix by the kind of address, with the port the reader gave', (): void => {
    expect(unreachableFix('http://ollama:11434/v1', 'day0-bed').join(' ')).toContain(
      'docker network connect day0-bed_default <its container>',
    );
    expect(unreachableFix('http://172.18.0.5:8080/v1', 'day0-bed').join(' ')).toContain(
      'http://host.docker.internal:8080/v1',
    );
    expect(unreachableFix('https://gateway.example.com/v1', 'day0-bed').join(' ')).toContain(
      'proxy or firewall',
    );
  });
});

describe('the first line a tool printed', (): void => {
  it('skips blank lines and trims, and is empty for nothing at all', (): void => {
    expect(firstLine('\n  \n  permission denied  \nmore\n')).toBe('permission denied');
    expect(firstLine('')).toBe('');
  });
});
