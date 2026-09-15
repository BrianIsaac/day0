import { describe, expect, it } from 'vitest';
import {
  namedSurfacesFor,
  skillNameFor,
  skillOperationLabel,
  skillShapeFor,
  skillSurfacePhrase,
  targetSurfaceFor,
  type ShapeSurface,
} from '../../../src/work/skill-shape';
import type { WorkCandidate } from '../../../src/work/types';

const linear: ShapeSurface = { slug: 'linear', displayName: 'Linear', class: 'kanban' };
const slack: ShapeSurface = { slug: 'slack', displayName: 'Slack', class: 'chat' };
const tile: ShapeSurface = {
  slug: 'looker-pipeline-tile',
  displayName: 'Looker pipeline tile',
  class: 'analytics',
};
const sheet: ShapeSurface = {
  slug: 'close-tracker',
  displayName: 'Close tracker',
  class: 'spreadsheet',
};

function candidate(overrides: Partial<WorkCandidate> = {}): WorkCandidate {
  return {
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: 'REVOPS-7',
    title: 'Refresh the Looker pipeline tile',
    contentSummary: 'Set the pipeline coverage figure to 74% as the Friday standup states.',
    contentRefs: ['ticket://REVOPS-7'],
    observedAt: new Date('2026-09-14T12:00:00.000Z'),
    ...overrides,
  };
}

describe('the shape of the skill a candidate needs', (): void => {
  it('does not select a write procedure for an explicitly read-only request', () => {
    const readOnly = candidate({
      title: 'Read the Looker pipeline tile',
      contentSummary: 'Report the current coverage figure. Do not change anything.',
    });
    expect(skillShapeFor(readOnly, [linear, tile], 'real')).toEqual({
      surfaceClass: 'analytics', operation: 'read',
    });
    expect(skillShapeFor(candidate({
      sourceSystem: 'close-tracker', title: 'Read the Close tracker',
      contentSummary: 'List the rows. Do not write to the spreadsheet.',
    }), [sheet], 'real')).toEqual({ surfaceClass: 'spreadsheet', operation: 'read' });
  });

  it('maps every mock source system to its surface class and documented operation', (): void => {
    const shapes = ['ticket', 'slack', 'spreadsheet', 'social', 'docs', 'calendar'].map(
      (sourceSystem) => skillShapeFor(candidate({ sourceSystem }), [], 'mock'),
    );
    expect(shapes).toEqual([
      { surfaceClass: 'kanban', operation: 'comment-and-close' },
      { surfaceClass: 'chat', operation: 'thread-reply' },
      { surfaceClass: 'spreadsheet', operation: 'append-row' },
      { surfaceClass: 'social', operation: 'reply' },
      { surfaceClass: 'docs', operation: 'answer-from-docs' },
      { surfaceClass: 'other', operation: 'action' },
    ]);
  });

  it('never reads a surface record in mock mode', (): void => {
    expect(skillShapeFor(candidate({ sourceSystem: 'ticket' }), [tile], 'mock')).toEqual({
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
    });
  });

  it('takes the class of the surface the work names over the source in real mode', (): void => {
    expect(skillShapeFor(candidate(), [linear, slack, tile], 'real')).toEqual({
      surfaceClass: 'analytics',
      operation: 'refresh-value',
    });
    expect(targetSurfaceFor(candidate(), [linear, slack, tile])).toBe(tile);
  });

  it('falls back to the source surface when the work names no other system', (): void => {
    const audit = candidate({
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Add the audit note to the ticket.',
      contentRefs: ['ticket://REVOPS-1'],
    });
    expect(skillShapeFor(audit, [linear, slack, tile], 'real')).toEqual({
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
    });
    expect(targetSurfaceFor(audit, [linear, slack, tile])).toBe(linear);
  });

  it('gives a chat ask that names nothing else the chat shape, whatever its thread', (): void => {
    const asks = ['1789000000.000100', '1789000500.000200'].map((threadTs) =>
      candidate({
        sourceCategory: 'event-stream',
        sourceSystem: 'slack',
        externalId: `C0BSF04TZ19:${threadTs}`,
        title: 'Mention in #revops-asks',
        contentSummary: 'Can someone confirm the coverage figure we are quoting this week?',
        contentRefs: [],
        replyTarget: { channel: 'C0BSF04TZ19', threadTs },
      }),
    );
    for (const ask of asks) {
      expect(skillShapeFor(ask, [linear, slack, tile], 'real')).toEqual({
        surfaceClass: 'chat',
        operation: 'thread-reply',
      });
    }
  });

  it('matches a surface name only as a whole phrase', (): void => {
    const surfaces: ShapeSurface[] = [
      linear,
      { slug: 'looker', displayName: 'Looker', class: 'analytics' },
    ];
    expect(namedSurfacesFor(candidate({ title: 'Refresh the Lookerish tile' }), surfaces)).toEqual(
      [],
    );
    expect(namedSurfacesFor(candidate({ title: 'Refresh the Looker tile' }), surfaces)).toEqual([
      surfaces[1],
    ]);
  });

  it('keeps the source when the work names more than one other system', (): void => {
    const both = candidate({ title: 'Refresh the Looker pipeline tile and the Close tracker' });
    expect(namedSurfacesFor(both, [linear, tile, sheet]).map((surface) => surface.slug)).toEqual([
      'looker-pipeline-tile',
      'close-tracker',
    ]);
    expect(targetSurfaceFor(both, [linear, tile, sheet])).toBe(linear);
  });

  it('classes an unlisted real source by its name and otherwise as other', (): void => {
    expect(skillShapeFor(candidate({ sourceSystem: 'jira', title: 'Triage' }), [], 'real')).toEqual(
      { surfaceClass: 'kanban', operation: 'comment-and-close' },
    );
    expect(
      skillShapeFor(candidate({ sourceSystem: 'northstar', title: 'Triage' }), [], 'real'),
    ).toEqual({ surfaceClass: 'other', operation: 'action' });
  });

  it('names the skill after the shape and never after the work item', (): void => {
    const shape = skillShapeFor(candidate(), [linear, slack, tile], 'real');
    expect(skillNameFor(shape)).toBe('analytics-refresh-value');
    expect(skillNameFor(shape)).not.toContain('revops');
    expect(skillOperationLabel(shape)).toBe('value refresh');
    expect(skillSurfacePhrase(shape)).toBe('an analytics surface');
    expect(skillSurfacePhrase({ surfaceClass: 'kanban' })).toBe('a kanban surface');
    expect(skillSurfacePhrase({ surfaceClass: 'other' })).toBe('an unclassified surface');
    expect(skillNameFor({ surfaceClass: 'kanban', operation: 'comment-and-close' })).toBe(
      'kanban-comment-and-close',
    );
    expect(skillNameFor({ surfaceClass: 'chat', operation: 'thread-reply' })).toBe(
      'chat-thread-reply',
    );
  });
});
