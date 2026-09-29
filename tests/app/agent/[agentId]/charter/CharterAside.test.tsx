import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';

vi.mock('convex/react', () => ({ useMutation: () => async (): Promise<void> => undefined }));

import {
  CharterAside,
  CharterVersions,
  WhatYouSaid,
  exchangesOf,
} from '../../../../../app/agent/[agentId]/charter/CharterAside';
import { AgentZoneContext } from '../../../../../app/agent/[agentId]/time';
import { transcriptTurns } from '../../../../../src/agent/transcript-turns';

const TRANSCRIPT =
  'ASSISTANT: Why this hire?\n\nUSER: The close.\n\nASSISTANT: Who first?\n\nUSER: Priya.';

function row(fields: Partial<Doc<'charters'>>): Doc<'charters'> {
  return {
    _id: 'charter-1',
    _creationTime: 1,
    agentId: 'agent-1',
    version: '0.0',
    approved: false,
    createdAt: Date.UTC(2026, 8, 29, 14, 19),
    body: {},
    ...fields,
  } as unknown as Doc<'charters'>;
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<AgentZoneContext value="UTC">{node}</AgentZoneContext>);
}

describe('what sits beside the charter', (): void => {
  it('pairs each answer with the question it answered', (): void => {
    expect(exchangesOf(transcriptTurns(`USER: early\n\n${TRANSCRIPT}`))).toEqual([
      { question: null, answer: 'early' },
      { question: 'Why this hire?', answer: 'The close.' },
      { question: 'Who first?', answer: 'Priya.' },
    ]);
  });

  it('keeps the transcript beside the draft, or says none was kept', (): void => {
    const kept = render(<WhatYouSaid transcript={TRANSCRIPT} />);
    expect(kept).toContain('What you said');
    expect(kept).toContain('<span class="sr-only">You: </span>The close.');
    expect(kept).toMatch(/<ol tabindex="0" aria-label="Your answers in the one-to-one"/);
    expect(render(<WhatYouSaid transcript={null} />)).toContain('No transcript was kept');
    expect(render(<WhatYouSaid transcript={undefined} />)).toContain('Loading the one-to-one');
  });

  it("draws a stored question's emphasis bold, as the live room did, never its marks (m21)", (): void => {
    const kept = render(
      <WhatYouSaid
        transcript={'ASSISTANT: **Topic 1 - Why this hire:** what changed?\n\nUSER: The close.'}
      />,
    );
    expect(kept).toContain('<strong class="font-semibold">Topic 1 - Why this hire:</strong>');
    expect(kept).not.toContain('**');
  });

  it('lists every version newest first, with the approval and the rules it struck', (): void => {
    const first = row({
      approved: true,
      approvedAt: Date.UTC(2026, 8, 29, 14, 23),
      body: { constraints: [{ quote: 'x', struck: true }, { quote: 'y' }] },
    });
    const amended = row({
      _id: 'charter-2' as Doc<'charters'>['_id'],
      version: '0.1',
      approved: true,
      supersedes: first._id,
      createdAt: Date.UTC(2026, 8, 30, 9, 0),
    });
    const html = render(<CharterVersions versions={[amended, first]} current={amended} />);
    const lines = [...html.matchAll(/<\/span>(v0\.[^<]+)<\/div>/g)].map((m) => m[1]);
    expect(lines).toEqual([
      'v0.1 amended by you · in force',
      'v0.0 approved by you, 1 rule struck',
      'v0.0 drafted from your one-to-one',
    ]);
  });

  it('asks for changes beside a draft, and shows the versions beside the record', (): void => {
    const review = render(
      <CharterAside
        charter={row({})}
        name="Mira"
        transcript={TRANSCRIPT}
        versions={undefined}
        onSentBack={() => undefined}
      />,
    );
    expect(review).toContain('Ask Mira for changes');
    expect(review).not.toContain('Versions');
    const record = render(
      <CharterAside
        charter={row({ approved: true })}
        name="Mira"
        transcript={TRANSCRIPT}
        versions={[]}
        onSentBack={() => undefined}
      />,
    );
    expect(record).toContain('Versions');
    expect(record).toContain('Read what you said');
    expect(record).not.toContain('Ask Mira for changes');
  });
});
