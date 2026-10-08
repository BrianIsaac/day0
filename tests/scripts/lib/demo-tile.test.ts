import { describe, expect, it } from 'vitest';
import { DEMO_TILE_HOST, listsDemoTile, withDemoTile } from '../../../scripts/lib/demo-tile';

describe('the demo tile in the private hosts list (14-D ruling 2)', (): void => {
  it('finds the tile as an entry, in any case and with a trailing dot, and not inside another name', (): void => {
    expect(listsDemoTile('mcp.linear.app, looker-tile')).toBe(true);
    expect(listsDemoTile('LOOKER-TILE.')).toBe(true);
    expect(listsDemoTile('looker-tile.corp.internal .looker-tile')).toBe(false);
    expect(listsDemoTile('')).toBe(false);
    expect(listsDemoTile(undefined)).toBe(false);
  });

  it('adds the tile after the operator’s own entries, and changes a list that names it not at all', (): void => {
    expect(withDemoTile(undefined)).toBe(DEMO_TILE_HOST);
    expect(withDemoTile('  ')).toBe(DEMO_TILE_HOST);
    expect(withDemoTile('mcp.linear.app,')).toBe('mcp.linear.app,looker-tile');
    expect(withDemoTile('mcp.linear.app 10.0.0.5')).toBe('mcp.linear.app 10.0.0.5,looker-tile');
    expect(withDemoTile('looker-tile mcp.linear.app')).toBe('looker-tile mcp.linear.app');
  });
});
