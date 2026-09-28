/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AvatarPicker } from '../../../app/home/AvatarPicker';

describe('AvatarPicker', (): void => {
  const html = renderToStaticMarkup(
    <AvatarPicker selectedId="face-03" onSelect={vi.fn()} defaultOpen />,
  );

  it('labels the set with the gallery credit and names no group of people (N6)', (): void => {
    expect(html).toContain('Singapore Codex Pets · 29');
    expect(html).not.toContain('Singaporean AI Builders');
  });

  it('names each of the 29 faces by its number and carries no title at all', (): void => {
    const faces = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((match) => match[1]);
    expect(faces).toEqual(Array.from({ length: 29 }, (_, index) => `Face ${index + 1}`));
    expect(html).not.toContain('title=');
  });

  it('marks the chosen face as pressed and no other', (): void => {
    const pressed = [...html.matchAll(/aria-label="(Face \d+)"[^>]*aria-pressed="true"/g)].map(
      (match) => match[1],
    );
    expect(pressed).toEqual(['Face 3']);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(28);
  });

  it('sets no type below the 12 px floor', (): void => {
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
  });

  it('keeps the faces behind a disclosure, open only when asked to be', (): void => {
    expect(html).toMatch(/^<details\b[^>]*\bopen=""/);
    expect(html).toMatch(/<summary\b[^>]*>[\s\S]*Choose avatar[\s\S]*<\/summary>/);
    const closed = renderToStaticMarkup(<AvatarPicker selectedId="face-03" onSelect={vi.fn()} />);
    expect(closed).toMatch(/^<details\b/);
    expect(closed).not.toMatch(/^<details\b[^>]*\bopen/);
    expect(closed.match(/aria-label="Face \d+"/g)).toHaveLength(29);
  });

  it('hands the pressed face to the caller', (): void => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onSelect = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<AvatarPicker selectedId="face-01" onSelect={onSelect} defaultOpen />));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Face 7"]')?.click());
    expect(onSelect).toHaveBeenCalledWith('face-07');
    act(() => root.unmount());
  });
});
