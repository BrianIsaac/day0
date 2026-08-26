import { describe, expect, it } from 'vitest';
import { ACTION_TOOLS, MOCK_ACTION_TOOLS, SURFACE_ACTION_TOOLS } from '../../../src/work/types';

describe('action verbs', (): void => {
  it('keeps the four mock verbs and adds exactly the two surface verbs', (): void => {
    expect(MOCK_ACTION_TOOLS).toEqual(['spreadsheet.appendRow', 'slack.postMessage', 'twitter.reply', 'ticket.update']);
    expect(SURFACE_ACTION_TOOLS).toEqual(['mcp.call', 'http.request']);
    expect(ACTION_TOOLS).toEqual([...MOCK_ACTION_TOOLS, ...SURFACE_ACTION_TOOLS]);
    expect(new Set(ACTION_TOOLS).size).toBe(ACTION_TOOLS.length);
  });
});
