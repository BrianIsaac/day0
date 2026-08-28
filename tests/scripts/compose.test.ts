import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BASE_PROFILE,
  componentSummary,
  composeArguments,
  parseComposeArguments,
  PROFILES,
} from '../../scripts/compose';

const COMPOSE_FILE = readFileSync('docker-compose.yml', 'utf8');

describe('choosing components on the command line', (): void => {
  it('starts day0 itself when no component is named', (): void => {
    expect(parseComposeArguments(['up', '-d'])).toEqual({
      profiles: ['real'],
      rest: ['up', '-d'],
    });
  });

  it('adds each named component and keeps day0 first', (): void => {
    expect(
      parseComposeArguments(['--profile', 'browser', 'up', '-d', '--profile=docs-notion']),
    ).toEqual({
      profiles: ['real', 'browser', 'docs-notion'],
      rest: ['up', '-d'],
    });
  });

  it('never repeats a profile, however it was named', (): void => {
    expect(parseComposeArguments(['--profile', 'real', '--profile=browser', '--profile', 'browser']))
      .toEqual({ profiles: ['real', 'browser'], rest: [] });
  });

  it('refuses a profile the compose file does not define, rather than starting nothing', (): void => {
    expect(() => parseComposeArguments(['--profile', 'browers', 'up'])).toThrow('Unknown profile');
    expect(() => parseComposeArguments(['--profile', 'browers', 'up'])).toThrow('docs-notion');
    expect(() => parseComposeArguments(['--profile'])).toThrow('needs a profile name');
  });

  it('drops the argument separator pnpm inserts, which compose reads as a service', (): void => {
    expect(parseComposeArguments(['down', '--profile', 'browser', '--', '-v'])).toEqual({
      profiles: ['real', 'browser'],
      rest: ['down', '-v'],
    });
  });

  it('passes the environment file and every profile through to compose', (): void => {
    expect(composeArguments(['--profile', 'browser', 'up', '-d'], '.env.local')).toEqual([
      'compose',
      '--env-file',
      '.env.local',
      '--profile',
      'real',
      '--profile',
      'browser',
      'up',
      '-d',
    ]);
  });

  it('names what each selected component is for', (): void => {
    const summary = componentSummary(['real', 'docs-notion']);
    expect(summary).toContain("day0's backend");
    expect(summary).toContain('Notion');
  });
});

describe('the profile list and the compose file agree', (): void => {
  it('names every profile the compose file defines', (): void => {
    const defined = new Set(
      [...COMPOSE_FILE.matchAll(/^\s{4}profiles: \['([a-z-]+)'\]$/gm)].map(
        (match: RegExpMatchArray): string => match[1],
      ),
    );
    expect(defined.size).toBeGreaterThan(0);
    expect([...defined].sort()).toEqual(Object.keys(PROFILES).sort());
  });

  it('puts day0 itself, and nothing else, in the base profile', (): void => {
    const services = [...COMPOSE_FILE.matchAll(/^ {2}([a-z][a-z0-9-]*):\n {4}profiles: \['([a-z-]+)'\]$/gm)];
    const inBase = services
      .filter((match: RegExpMatchArray): boolean => match[2] === BASE_PROFILE)
      .map((match: RegExpMatchArray): string => match[1]);
    expect(inBase).toEqual(['backend']);
  });

  it('keeps each component on the profile the running instructions name', (): void => {
    const profileFor = new Map(
      [...COMPOSE_FILE.matchAll(/^ {2}([a-z][a-z0-9-]*):\n {4}profiles: \['([a-z-]+)'\]$/gm)].map(
        (match: RegExpMatchArray): [string, string] => [match[1], match[2]],
      ),
    );
    expect(profileFor.get('docs-notion-mcp')).toBe('docs-notion');
    expect(profileFor.get('playwright-mcp')).toBe('browser');
    expect(profileFor.get('looker-tile')).toBe('demo');
    expect(profileFor.get('fake-slack')).toBe('test');
    expect(profileFor.get('dashboard')).toBe('dev');
  });

  it('keeps notion-mcp reachable as an alias, so links made before the rename still sync', (): void => {
    expect(COMPOSE_FILE).toContain("aliases: ['notion-mcp']");
  });
});
