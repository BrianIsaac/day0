import { describe, expect, it } from 'vitest';
import { landedNoteText } from '../../../src/work/manager-notes';
import { landedNoteRows } from '../../../src/work/stop';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import rehearsal from '../../fixtures/work/demo-rehearsal-2-2026-09-19.json';

/**
 * Demo rehearsal 2 (19 Sep 2026): the manager's completion DM quoted the
 * browser driver's echo ("### Ran Playwright code ```js await page...") and
 * a ticket's raw JSON, and said "5 changes landed" where the card said 7 (it
 * counted writes; the card counts every landed row). The rows and the DMs
 * here are that sitting's own.
 */

const surfaces = rehearsal.surfaces as unknown as SurfaceRecord[];
const priya = rehearsal.workItems.priyaCompleted;
const mateo = rehearsal.workItems.mateoCompleted;
const sent = (agentId: string): string => rehearsal.managerNotes.find((note) => note.agentId === agentId)!.text;

describe('the completion DM the rehearsal sent', (): void => {
  it('quoted the driver and counted five where the card counted seven', (): void => {
    expect(sent(priya.agentId)).toContain('5 changes landed.');
    expect(sent(priya.agentId)).toContain('### Ran Playwright code ```js await page.getByRole');
    expect(priya.output.applied.filter((row) => row.ok)).toHaveLength(7);
  });
});

describe('the completion DM, from the same rows', (): void => {
  it('says what was opened, what was set to what and what was saved, and what it counts', (): void => {
    const text = landedNoteText({
      agentName: 'Priya', title: priya.title, outcome: 'completed',
      rows: landedNoteRows(priya.output, surfaces, priya.replyTarget),
    });
    expect(text).toBe(
      [
        'Priya finished “Slack mention in #ops-requests”: 7 actions landed (5 writes, 2 reads).',
        '- Open http://looker-tile:8080/ on Looker pipeline tile',
        '- Set Username to "revops" and Password to "[credential]" on Looker pipeline tile',
        '- Press "Sign in" on Looker pipeline tile',
        '- Set Pipeline coverage to "74%" on Looker pipeline tile',
        '- Press "Save" on Looker pipeline tile',
        '- Read the page on Looker pipeline tile',
        '- Reply in #ops-requests thread: "Done — the pipeline tile now shows 74% (the approved figure from the Friday standup summary). Audit line: Last updated b…"',
      ].join('\n'),
    );
  });

  it('never carries the driver\'s echo or a provider\'s raw JSON', (): void => {
    for (const item of [priya, mateo, rehearsal.workItems.aikoCompleted]) {
      const text = landedNoteText({
        agentName: 'x', title: item.title, outcome: 'completed',
        rows: landedNoteRows(item.output, surfaces, undefined),
      });
      expect(text).not.toMatch(/Playwright|```|await page|\{"|###/);
    }
  });

  it('names a credential field without quoting it, and carries no token-shaped value an action holds', (): void => {
    const token = ['xoxb', '2847561930', '5529104736', 'aBcDeFgHiJkLmNoPqRsTuVwX'].join('-');
    const output = {
      actions: [
        { tool: 'mcp.call', args: { surface: 'looker-pipeline-tile', tool: 'browser_fill_form', toolArgsJson: JSON.stringify({ fields: [{ name: 'Password', value: 'hunter2-literal' }] }) } },
        { tool: 'mcp.call', args: { surface: 'looker-pipeline-tile', tool: 'browser_navigate', toolArgsJson: JSON.stringify({ url: `http://looker-tile:8080/?t=${token}` }) } },
      ],
      applied: [{ tool: 'mcp.call', ok: true }, { tool: 'mcp.call', ok: true }],
    };
    const text = landedNoteRows(output, surfaces, undefined).map((row) => row.line).join('\n');
    expect(text).toContain('Set Password to "[credential]"');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(token);
  });

  it('counts what the card counts: Mateo\'s two reads and two writes', (): void => {
    const text = landedNoteText({
      agentName: 'Mateo', title: mateo.title, outcome: 'completed',
      rows: landedNoteRows(mateo.output, surfaces, undefined),
    });
    expect(text.split('\n')[0]).toBe('Mateo finished “Post the September close status note”: 4 actions landed (2 writes, 2 reads).');
    expect(text).toContain('- Move FIN-1 to Done on Linear');
    expect(text.split('\n')).toHaveLength(5);
  });

  it('keeps the plain count when every landed row is a write', (): void => {
    const aiko = rehearsal.workItems.aikoCompleted;
    const text = landedNoteText({
      agentName: 'Aiko', title: aiko.title, outcome: 'completed',
      rows: landedNoteRows(aiko.output, surfaces, undefined),
    });
    expect(text.split('\n')[0]).toBe('Aiko finished “Exception: SH-4471 held at Port Klang, Meridian Freight, no revised ETA”: 2 changes landed.');
  });

  it('leaves the manager DM out of the work, and counts only writes on a stop that owes reconciliation', (): void => {
    const stopped = rehearsal.workItems.aikoStopped;
    const rows = landedNoteRows(stopped.output, surfaces, undefined);
    expect(rows).toEqual([]);
    const text = landedNoteText({
      agentName: 'Priya', title: priya.title, outcome: 'failed', reason: 'the reply was refused',
      rows: landedNoteRows(priya.output, surfaces, priya.replyTarget),
    });
    expect(text.split('\n')[0]).toBe(
      'Priya stopped on “Slack mention in #ops-requests” after 5 changes landed: the reply was refused. Reconcile the provider in day0 before a retry.',
    );
    expect(text.split('\n')).toHaveLength(6);
  });
});
