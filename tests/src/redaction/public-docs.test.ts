import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('public redaction setup contract', () => {
  it('documents bootstrap downloads and the limits of fallback and export', () => {
    const readme = readFileSync('README.md', 'utf8');
    const components = readFileSync('docs/running/components.md', 'utf8');
    expect(readme).toContain('251 MB');
    expect(readme).toContain('1.16 GB');
    expect(components).toContain('Inference runs locally');
    expect(components).toContain('export is not a complete personal-data scrub');
    expect(components).not.toContain('Every text that is persisted');
    expect(components).not.toContain('under 200 ms on the CPU');
  });
});
