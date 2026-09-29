import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fileSize, WorkspacePanel } from '../../../../../app/agent/[agentId]/record/WorkspacePanel';

describe('WorkspacePanel', (): void => {
  it('writes sizes in bytes below a kilobyte and in kilobytes above', (): void => {
    expect(fileSize(35)).toBe('35 B');
    expect(fileSize(999)).toBe('999 B');
    expect(fileSize(4200)).toBe('4.2 kB');
  });

  it('puts the eight files behind one disclosure with their count and size together, each file behind its own', (): void => {
    const html = renderToStaticMarkup(
      <WorkspacePanel
        name="Mira"
        workspace={{ 'AGENTS.md': 'a'.repeat(4200), 'USER.md': 'é'.repeat(10), 'MEMORY.md': ' ' }}
      />,
    );
    expect(html).toContain('>Mira&#x27;s files</h2>');
    // UTF-8 bytes, not characters: ten e-acutes are twenty bytes.
    expect(html).toContain('Eight files, 4.2 kB');
    expect(html).toContain('20 B');
    expect(html.match(/<details/g)).toHaveLength(9);
    expect(html.match(/>empty</g)).toHaveLength(6);
    for (const file of ['AGENTS.md', 'IDENTITY.md', 'HEARTBEAT.md']) expect(html).toContain(file);
  });

  it('says the files are loading rather than listing eight empty ones', (): void => {
    const html = renderToStaticMarkup(<WorkspacePanel name="Mira" workspace={undefined} />);
    expect(html).toContain('Loading the files');
    expect(html).not.toContain('Eight files');
  });
});
