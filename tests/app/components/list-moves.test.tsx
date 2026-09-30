/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useRef } from 'react';
import { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_MOVE_EASE, LIST_MOVE_MS, useListMoves } from '../../../app/components/list-moves';
import { mount, unmountAll } from '../../fixtures/dom/press';

/** How tall each card is, for the layout jsdom does not do: cards stack with no gap. */
const HEIGHT: Record<string, number> = { a: 100, b: 50, c: 80 };

/** A list whose cards report the tops a browser would lay them out at. */
function List({ order, scope, grow = 0 }: { order: string[]; scope: string; grow?: number }) {
  const list = useRef<HTMLDivElement>(null);
  useListMoves(list, order, scope);
  const height = (key: string): number => (HEIGHT[key] ?? 0) + (key === 'a' ? grow : 0);
  const tops = order.map((_, index) =>
    order.slice(0, index).reduce((sum, key) => sum + height(key), 0),
  );
  return (
    <div ref={list}>
      {order.map((key, index) => (
        <div key={key} data-key={key} data-top={tops[index]} />
      ))}
    </div>
  );
}

const moves: Array<{ key: string; keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
let reduced = false;

// jsdom's own, put back after each test so no other file inherits the stand-ins (second review x10).
const ownOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
const ownAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

/** Put a prototype property back as jsdom had it, or take it off when jsdom had none. */
function restore(name: 'offsetTop' | 'animate', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, name);
}

beforeEach(() => {
  moves.length = 0;
  reduced = false;
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement): number {
      return Number(this.dataset.top ?? 0);
    },
  });
  HTMLElement.prototype.animate = function (
    this: HTMLElement,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ): Animation {
    moves.push({ key: this.dataset.key ?? '', keyframes, options });
    return {} as Animation;
  } as HTMLElement['animate'];
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('reduce'),
  }));
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  restore('offsetTop', ownOffsetTop);
  restore('animate', ownAnimate);
});

describe('a list whose cards glide to their new places (walk m21)', () => {
  it('moves each card whose place changed from where it stood, on the move curve', () => {
    const view = mount(<List order={['a', 'b', 'c']} scope="all" />);
    act((): void => view.root.render(<List order={['b', 'c', 'a']} scope="all" />));
    expect(moves).toEqual([
      {
        key: 'b',
        keyframes: [{ transform: 'translateY(100px)' }, { transform: 'none' }],
        options: { duration: LIST_MOVE_MS, easing: LIST_MOVE_EASE },
      },
      {
        key: 'c',
        keyframes: [{ transform: 'translateY(100px)' }, { transform: 'none' }],
        options: { duration: LIST_MOVE_MS, easing: LIST_MOVE_EASE },
      },
      {
        key: 'a',
        keyframes: [{ transform: 'translateY(-130px)' }, { transform: 'none' }],
        options: { duration: LIST_MOVE_MS, easing: LIST_MOVE_EASE },
      },
    ]);
  });

  it('leaves a card that kept its place but shifted because one above it grew', () => {
    const view = mount(<List order={['a', 'b', 'c']} scope="all" />);
    act((): void => view.root.render(<List order={['a', 'b', 'c']} scope="all" grow={40} />));
    expect(moves).toEqual([]);
  });

  it('draws a new list in place when the filter changes, and moves nothing under reduced motion', () => {
    const view = mount(<List order={['a', 'b', 'c']} scope="all" />);
    act((): void => view.root.render(<List order={['c', 'a']} scope="needs-you" />));
    expect(moves).toEqual([]);
    reduced = true;
    act((): void => view.root.render(<List order={['a', 'c']} scope="needs-you" />));
    expect(moves).toEqual([]);
  });

  it("moves on the stylesheet's own curve for something moving on screen", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../app/globals.css'),
      'utf8',
    );
    expect(css).toContain(`--ease-move: ${LIST_MOVE_EASE};`);
  });
});

// The last test's stand-ins are gone once its own afterEach has run.
afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')).toEqual(ownOffsetTop);
  expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')).toEqual(ownAnimate);
});
