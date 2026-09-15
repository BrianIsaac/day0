import { describe, expect, it } from 'vitest';
import {
  parseComposeProjects,
  parseRehearsalArguments,
  projectRefusal,
  rehearsalProjectName,
  USAGE,
} from '../../../scripts/rehearsal/options';

describe('command line', (): void => {
  it('defaults to a live run with HEAD of this checkout and a forty-minute ceiling', (): void => {
    const options = parseRehearsalArguments(['--secrets', 'private.env']);
    expect(options).toMatchObject({
      secrets: 'private.env',
      ref: 'HEAD',
      dryRun: false,
      keep: false,
      timeoutMinutes: 40,
      help: false,
    });
    expect(options.project).toBeUndefined();
    expect(options.portBase).toBeUndefined();
  });

  it('reads every flag and drops the separator pnpm inserts', (): void => {
    const options = parseRehearsalArguments([
      '--',
      '--secrets',
      's.env',
      '--env-from',
      'base.env',
      '--primary',
      '/p',
      '--project',
      'day0-rehearsal-abc123',
      '--clone',
      '/tmp/c',
      '--ref',
      'main',
      '--source',
      '/src',
      '--out',
      '/out',
      '--warm-from',
      'day0-redactor-warm',
      '--port-base',
      '45210',
      '--timeout-minutes',
      '15',
      '--dry-run',
      '--keep',
    ]);
    expect(options).toEqual({
      secrets: 's.env',
      envFrom: 'base.env',
      primary: '/p',
      project: 'day0-rehearsal-abc123',
      clone: '/tmp/c',
      ref: 'main',
      source: '/src',
      out: '/out',
      warmFrom: 'day0-redactor-warm',
      portBase: 45210,
      timeoutMinutes: 15,
      dryRun: true,
      keep: true,
      help: false,
    });
  });

  it('refuses an unknown flag, a flag without a value and a bad number', (): void => {
    expect(() => parseRehearsalArguments(['--secret', 'x'])).toThrow('Unknown option "--secret"');
    expect(() => parseRehearsalArguments(['--secrets'])).toThrow('--secrets needs a value');
    expect(() => parseRehearsalArguments(['--port-base', 'high'])).toThrow('--port-base');
    expect(() => parseRehearsalArguments(['--timeout-minutes', '0'])).toThrow('--timeout-minutes');
  });

  it('prints usage on --help and names the dry-run boundary in it', (): void => {
    expect(parseRehearsalArguments(['--help']).help).toBe(true);
    expect(USAGE).toContain('--dry-run');
    expect(USAGE).toContain('provider write');
  });
});

describe('the compose project the bed runs as', (): void => {
  it('is derived from six hex characters and never a protected name', (): void => {
    expect(rehearsalProjectName('a1b2c3')).toBe('day0-rehearsal-a1b2c3');
  });

  it('reads project names out of docker compose ls JSON, including exited projects', (): void => {
    const stdout = JSON.stringify([
      { Name: 'day0-full-a73cb0', Status: 'exited(5)' },
      { Name: 'onecli', Status: 'running(2)' },
    ]);
    expect(parseComposeProjects(stdout)).toEqual(['day0-full-a73cb0', 'onecli']);
    expect(parseComposeProjects('')).toEqual([]);
    expect(parseComposeProjects('not json')).toEqual([]);
  });

  it('refuses a protected project, the primary project, and any project docker already knows', (): void => {
    const known = {
      primaryProject: 'day0',
      composeProjects: ['day0-full-a73cb0'],
      volumes: ['day0-loop-8de4f5_convex_data'],
      labelledContainers: ['day0-e2e-0901'],
    };
    expect(projectRefusal({ project: 'day0', ...known })).toContain('protected');
    expect(projectRefusal({ project: 'day0-demo-7c65e7', ...known })).toContain('protected');
    expect(projectRefusal({ project: 'day0-full-a73cb0', ...known })).toContain('already exists');
    expect(projectRefusal({ project: 'day0-loop-8de4f5', ...known })).toContain('volume');
    expect(projectRefusal({ project: 'day0-e2e-0901', ...known })).toContain('container');
    expect(projectRefusal({ project: 'day0-rehearsal-abc123', ...known })).toBeUndefined();
  });

  it('refuses the primary project name even when it is not a protected one', (): void => {
    expect(
      projectRefusal({
        project: 'day0-primary',
        primaryProject: 'day0-primary',
        composeProjects: [],
        volumes: [],
        labelledContainers: [],
      }),
    ).toContain("primary checkout's own project");
  });

  it('refuses a name compose would not accept', (): void => {
    expect(
      projectRefusal({
        project: 'Day0 Rehearsal',
        primaryProject: 'day0',
        composeProjects: [],
        volumes: [],
        labelledContainers: [],
      }),
    ).toContain('lowercase');
  });
});
