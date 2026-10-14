// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import {
  DAY0_MARK_URL,
  clerkAppearance,
  clerkSignInAppearance,
  headedClerkAppearance,
} from '../../app/clerk-appearance';

/**
 * RM40 (c), 17-FX's F1 and FX-4: Clerk draws `logoImageUrl` as an image, and WebKit answers that
 * image's `prefers-color-scheme` from the system, so where the viewer's theme differs from it the
 * head was the other set's accent (`#22d3ee` on a white card 1.81:1, `#0e7490` on the dark card
 * 3.31:1). The page colours the mark: Clerk's `logoImage` element style fills the image's box with
 * the page's accent through the mark's shape and moves the image's own pixels out of the box.
 * Here the style is set on an image as Clerk sets an element style and read back as the browser
 * holds it; `clerk-appearance.test.ts` holds the accent token in both sets.
 */

/** The mark's image, styled by an appearance's `logoImage`. */
function drawnMark(style: object): HTMLImageElement {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  act((): void => {
    // Clerk draws its logo as a plain image, so the test draws one: `next/image` is not Clerk's.
    // eslint-disable-next-line @next/next/no-img-element
    createRoot(host).render(<img alt="Day0" src={DAY0_MARK_URL} style={style} />);
  });
  const image = host.querySelector('img');
  if (image === null) throw new Error('the mark was not drawn');
  return image;
}

describe("the mark on Clerk's card (RM40 (c))", (): void => {
  it("fills the mark's head with the page's accent, the token each theme declares", (): void => {
    const image = drawnMark(clerkAppearance.elements.logoImage);
    // The page's accent, whichever set the viewer chose, never a value the image picks by a query.
    expect(image.style.backgroundColor).toBe('var(--color-accent)');
  });

  it("cuts the head and the eyes out of that fill by the mark's own shape, where the image sat", (): void => {
    const image = drawnMark(clerkAppearance.elements.logoImage);
    expect(image.style.getPropertyValue('mask-image')).toBe(`url("${DAY0_MARK_URL}")`);
    expect(image.style.getPropertyValue('mask-size')).toBe('contain');
    expect(image.style.getPropertyValue('mask-position')).toBe('center');
    expect(image.style.getPropertyValue('mask-repeat')).toBe('no-repeat');
  });

  it("moves the image's own pixels out of its box, so the system's colour is never drawn", (): void => {
    const image = drawnMark(clerkAppearance.elements.logoImage);
    expect(image.style.objectPosition).toBe('-10000px 0');
  });

  it('colours the mark the same way above the sign-in card and on its first step', (): void => {
    expect(clerkSignInAppearance.elements.logoImage).toBe(clerkAppearance.elements.logoImage);
    expect(
      (headedClerkAppearance(true).elements as typeof clerkAppearance.elements | undefined)
        ?.logoImage,
    ).toBe(clerkAppearance.elements.logoImage);
  });
});
