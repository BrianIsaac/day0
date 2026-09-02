import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const cursorState = vi.hoisted(() => ({ preference: 'on' as 'off' | 'on' }));

vi.mock('../../app/CursorToggle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/CursorToggle')>()),
  useCursorPreference: () => cursorState.preference,
}));

import {
  CURSOR_CHANGE_EVENT,
  CURSOR_STORAGE_KEY,
  handleCursorShortcut,
  readCursorPreference,
  toggleCursorPreference,
} from '../../app/CursorToggle';
import { WhipCursor } from '../../app/WhipCursor';

function createStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function createTarget(storage = createStorage()) {
  return Object.assign(new EventTarget(), { localStorage: storage });
}

describe('cursor preference', () => {
  it('defaults to on', () => {
    expect(readCursorPreference(createStorage())).toBe('on');
  });

  it('writes the toggled state and dispatches the change event', () => {
    const target = createTarget();
    const changes: string[] = [];
    target.addEventListener(CURSOR_CHANGE_EVENT, (event) => {
      changes.push((event as CustomEvent<string>).detail);
    });

    toggleCursorPreference(target);

    expect(target.localStorage.getItem(CURSOR_STORAGE_KEY)).toBe('off');
    expect(changes).toEqual(['off']);
  });

  it('renders no canvas when the stored preference is off', () => {
    const storage = createStorage();
    storage.setItem(CURSOR_STORAGE_KEY, 'off');
    cursorState.preference = readCursorPreference(storage);

    const markup = renderToStaticMarkup(<WhipCursor />);

    expect(markup).toBe('');
    expect(markup).not.toContain('day0-whip-cursor-suppress');
  });

  it('flips the preference with Shift+C', () => {
    const target = createTarget();
    const preventDefault = vi.fn();

    const handled = handleCursorShortcut(
      {
        altKey: false,
        ctrlKey: false,
        key: 'C',
        metaKey: false,
        preventDefault,
        repeat: false,
        shiftKey: true,
      },
      target,
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(target.localStorage.getItem(CURSOR_STORAGE_KEY)).toBe('off');
  });
});
