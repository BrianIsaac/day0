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

    const handled = handleCursorShortcut(shiftC(preventDefault, null), target);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(target.localStorage.getItem(CURSOR_STORAGE_KEY)).toBe('off');
  });

  it.each([
    ['a focused input', focusedElement({ tagName: 'INPUT' })],
    ['a focused textarea', focusedElement({ tagName: 'TEXTAREA' })],
    ['a focused select', focusedElement({ tagName: 'SELECT' })],
    ['a contenteditable region', focusedElement({ tagName: 'DIV', isContentEditable: true })],
    ['a button inside a form', focusedElement({ tagName: 'BUTTON', insideForm: true })],
  ])('leaves a capital C typed into %s to the field', (_label, focused) => {
    const target = createTarget();
    const preventDefault = vi.fn();

    const handled = handleCursorShortcut(shiftC(preventDefault, focused), target);

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(readCursorPreference(target.localStorage)).toBe('on');
  });
});

function shiftC(preventDefault: () => void, focused: EventTarget | null) {
  return {
    altKey: false,
    ctrlKey: false,
    key: 'C',
    metaKey: false,
    preventDefault,
    repeat: false,
    shiftKey: true,
    target: focused,
  };
}

function focusedElement({
  tagName,
  isContentEditable = false,
  insideForm = false,
}: {
  tagName: string;
  isContentEditable?: boolean;
  insideForm?: boolean;
}): EventTarget {
  return Object.assign(new EventTarget(), {
    tagName,
    isContentEditable,
    closest: (selector: string) => (insideForm && selector.includes('form') ? {} : null),
  });
}
