'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';

/** How long a card takes to reach its new place in a list, as the rail's slide takes. */
export const LIST_MOVE_MS = 280;

/** `--ease-move` in `app/globals.css`: the curve for something moving on screen. */
export const LIST_MOVE_EASE = 'cubic-bezier(0.77, 0, 0.175, 1)';

/** Where each card of a list stood, by key, and in what order, for the list it belonged to. */
interface ListPlaces {
  readonly scope: string;
  readonly order: readonly string[];
  readonly tops: ReadonlyMap<string, number>;
}

/**
 * Animate the cards of a list to their new places when the list reorders, rather than cut: each
 * card whose place in the order changed starts where it stood and glides to where it now is (the
 * hosted walk's m21: a work item jumped down the list and back on each state change). A card that
 * kept its place in the order but shifted because another grew is left to the layout, a new card
 * arrives by its own rule, and under reduced motion nothing moves. `scope` names the list being
 * shown (a filter): a new scope is a new list drawn in place, not a reorder.
 *
 * The list's element must be positioned, so each card's `offsetTop` is measured from it and a
 * scroll of the page between two renders is no move.
 *
 * @param list - The element whose children are the cards, in `order`.
 * @param order - The cards' keys in the order they are drawn.
 * @param scope - What list is shown.
 */
export function useListMoves(
  list: RefObject<HTMLElement | null>,
  order: readonly string[],
  scope: string,
): void {
  const before = useRef<ListPlaces>({ scope, order: [], tops: new Map() });
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const cards = [...element.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    const tops = new Map(order.map((key, index) => [key, cards[index]?.offsetTop ?? 0]));
    const previous = before.current;
    before.current = { scope, order: [...order], tops };
    if (previous.scope !== scope) return;
    const moves = order.flatMap((key, index) => {
      const card = cards[index];
      const was = previous.tops.get(key);
      if (card === undefined || was === undefined || previous.order.indexOf(key) === index) {
        return [];
      }
      const offset = was - (tops.get(key) ?? was);
      return offset === 0 ? [] : [{ card, offset }];
    });
    // Asked only when something moved, as the stylesheet asks it.
    if (moves.length === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const { card, offset } of moves) {
      card.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], {
        duration: LIST_MOVE_MS,
        easing: LIST_MOVE_EASE,
      });
    }
  }, [list, order, scope]);
}
