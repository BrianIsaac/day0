import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('public redaction setup contract', () => {
  it('describes the reviewed guards and cleanup without claiming a live pass', () => {
    const components = readFileSync('docs/running/components.md', 'utf8');
    const readme = readFileSync('README.md', 'utf8');
    const compliance = readFileSync('docs/submission/compliance.md', 'utf8');
    expect(components).not.toContain('the guard does not yet exempt');
    expect(readme).toContain('exclusive use of the demonstration ticket');
    expect(readme).toContain('a different approval identity');
    expect(readme).toContain('Only out-of-scope and quality-fit skips');
    expect(compliance).toContain('reviewed tree, 15 September 2026');
    expect(compliance).toContain('live rehearsal remains unverified');
  });

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
