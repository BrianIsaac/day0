import { describe, expect, it } from 'vitest';
import { hasHostTool, hasHostTools } from './host-tools';

describe('hasHostTool', () => {
  it('finds a tool every POSIX machine has', () => {
    expect(hasHostTool('sh')).toBe(true);
  });

  it('does not find a tool no machine has', () => {
    expect(hasHostTool('day0-no-such-tool')).toBe(false);
  });
});

describe('hasHostTools', () => {
  it('is true only when every tool is present', () => {
    expect(hasHostTools('sh', 'sh')).toBe(true);
    expect(hasHostTools('sh', 'day0-no-such-tool')).toBe(false);
  });
});
