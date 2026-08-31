import { describe, expect, it } from 'vitest';
import { auditActionArguments } from '../../../evaluation/action-audit';

describe('evaluation action argument audit', (): void => {
  it('counts fields outside the selected adapter and identifies repeated consumed effects', (): void => {
    const result = auditActionArguments({
      actions: [
        {
          tool: 'slack.postMessage',
          args: {
            channelSlug: 'dm-manager',
            body: 'Please decide.',
            cells: [{ header: 'Account', value: 'Acme' }],
            slug: '',
          },
        },
        {
          tool: 'slack.postMessage',
          args: {
            channelSlug: 'dm-manager',
            body: 'Please decide.',
            cells: [{ header: 'Account', value: 'Beta Corp' }],
          },
        },
      ],
    });

    expect(result).toMatchObject({
      totalActions: 2,
      actionsWithIrrelevantArguments: 2,
      argumentCounts: [4, 3],
      actions: [
        {
          phase: 'output',
          index: 0,
          tool: 'slack.postMessage',
          argumentKeys: ['body', 'cells', 'channelSlug', 'slug'],
          irrelevantArgumentKeys: ['cells', 'slug'],
        },
        {
          phase: 'output',
          index: 1,
          tool: 'slack.postMessage',
          argumentKeys: ['body', 'cells', 'channelSlug'],
          irrelevantArgumentKeys: ['cells'],
        },
      ],
      duplicateEffects: [
        {
          tool: 'slack.postMessage',
          actions: [
            { phase: 'output', index: 0 },
            { phase: 'output', index: 1 },
          ],
        },
      ],
    });
    expect(result.actions[0]!.consumedEffectDigest).toBe(
      result.actions[1]!.consumedEffectDigest,
    );
  });

  it('normalises spreadsheet cells to the object the mock adapter writes', (): void => {
    const result = auditActionArguments({
      actions: [
        {
          tool: 'spreadsheet.appendRow',
          args: {
            sheetSlug: 'pipeline',
            tabName: 'rows',
            cells: [
              { header: 'Account', value: 'Acme' },
              { header: 'Owner', value: 'Sara' },
            ],
          },
        },
        {
          tool: 'spreadsheet.appendRow',
          args: {
            sheetSlug: 'pipeline',
            tabName: 'rows',
            cells: [
              { header: 'Owner', value: 'Sara' },
              { header: 'Account', value: 'Acme' },
            ],
          },
        },
      ],
    });

    expect(result.actionsWithIrrelevantArguments).toBe(0);
    expect(result.duplicateEffects).toHaveLength(1);
  });

  it('retains nested prerequisite and closing phases without exposing values', (): void => {
    const result = auditActionArguments({
      initial: {
        actions: [
          {
            tool: 'mcp.call',
            args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"iss-1"}' },
          },
        ],
      },
      actions: [
        {
          tool: 'ticket.update',
          args: { slug: 'REVOPS-1', status: 'done', comment: 'Closed.' },
        },
      ],
    });

    expect(result.actions.map(({ phase, tool }) => ({ phase, tool }))).toEqual([
      { phase: 'initial', tool: 'mcp.call' },
      { phase: 'output', tool: 'ticket.update' },
    ]);
    expect(JSON.stringify(result)).not.toContain('iss-1');
    expect(JSON.stringify(result)).not.toContain('Closed.');
  });
});
