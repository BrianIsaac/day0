import { describe, expect, it } from 'vitest';

import {
  HOSTED_DEMO_SNAPSHOT,
  type HostedDemoSnapshot,
} from '../../../src/demo/hosted-demo-snapshot';

/**
 * The snapshot is the one tracked file in this repository built out of a private
 * export of the hosted demo, and `/demo` serves it to anybody. Sanitisation is
 * therefore not a build-time courtesy that can be re-checked by hand later: it is
 * a property of the committed file, and this suite is what holds it.
 */

/** Every string in the snapshot, so a check cannot miss a nested field. */
function allText(value: unknown, path = '$'): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => allText(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => allText(v, `${path}.${k}`));
  }
  return [];
}

const text = allText(HOSTED_DEMO_SNAPSHOT);

describe('the committed hosted-demo snapshot', (): void => {
  it('publishes labelled summaries rather than private conversation quotations', () => {
    for (const evidence of HOSTED_DEMO_SNAPSHOT.charter.evidence) {
      expect(evidence.source).toContain('summary');
      expect(evidence.text).not.toMatch(/^"/);
    }
    expect(HOSTED_DEMO_SNAPSHOT.timeline.find((event) => event.type === 'charter.drafted')?.detail).toContain('summar');
  });

  it('carries no address that could reach a real person', (): void => {
    const addresses = text.flatMap(({ path, text: value }) =>
      [...value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => ({
        path,
        address: m[0],
      })),
    );
    expect(addresses.filter((a) => !a.address.endsWith('@example.invalid'))).toEqual([]);
  });

  it('carries no link, host, sandbox id or Clerk subject', (): void => {
    const forbidden = /https?:\/\/|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\buser_[A-Za-z0-9]{10,}|\bBearer\s/;
    expect(text.filter(({ text: value }) => forbidden.test(value)).map((t) => t.path)).toEqual([]);
  });

  it('names every row by a local alias and never by a backend id', (): void => {
    // Convex ids are 32 lower-case alphanumerics. An alias is `work-2`.
    const leaked = text.filter(({ text: value }) => /\b[a-z0-9]{32}\b/.test(value));
    expect(leaked.map((t) => t.path)).toEqual([]);
    expect(HOSTED_DEMO_SNAPSHOT.agent.id).toMatch(/^agent-\d+$/);
    for (const item of HOSTED_DEMO_SNAPSHOT.workItems) expect(item.id).toMatch(/^work-\d+$/);
    for (const skill of HOSTED_DEMO_SNAPSHOT.skills) expect(skill.id).toMatch(/^skill-\d+$/);
  });

  it('tells the recording in offsets, never on a wall clock', (): void => {
    expect(HOSTED_DEMO_SNAPSHOT.timeline.every((e) => /^\+\d{2}:\d{2}$/.test(e.at))).toBe(true);
    const instants = text.filter(({ text: value }) => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value));
    expect(instants.map((t) => t.path)).toEqual([]);
  });

  it('resolves every cross-reference it makes to a row it also carries', (): void => {
    const workIds = new Set(HOSTED_DEMO_SNAPSHOT.workItems.map((i) => i.id));
    const skillIds = new Set(HOSTED_DEMO_SNAPSHOT.skills.map((s) => s.id));
    for (const item of HOSTED_DEMO_SNAPSHOT.workItems) {
      if (item.skillUsed) expect(skillIds).toContain(item.skillUsed);
      if (item.proposedSkill) expect(skillIds).toContain(item.proposedSkill);
    }
    for (const skill of HOSTED_DEMO_SNAPSHOT.skills) {
      if (skill.proposedFor) expect(workIds).toContain(skill.proposedFor);
    }
  });

  it('keeps the honesty note phase 0 required about the authored skill', (): void => {
    const authored = HOSTED_DEMO_SNAPSHOT.skills.find((s) => s.sourceType === 'agent-authored');
    const builtin = HOSTED_DEMO_SNAPSHOT.skills.find((s) => s.sourceType === 'builtin');
    expect(authored?.state).toBe('registered');
    // The completed rows record the built-in skill. Nothing may redraw that.
    const completed = HOSTED_DEMO_SNAPSHOT.workItems.filter((i) => i.state === 'completed');
    expect(completed.length).toBeGreaterThan(0);
    for (const item of completed) expect(item.skillUsed).toBe(builtin?.id);
    expect(HOSTED_DEMO_SNAPSHOT.skillLoopNote).toContain('separate facts');
  });

  it('is typed as the walkthrough reads it', (): void => {
    const snapshot: HostedDemoSnapshot = HOSTED_DEMO_SNAPSHOT;
    expect(snapshot.charter.approved).toBe(true);
    expect(snapshot.office.channels.length).toBeGreaterThan(0);
  });
});
