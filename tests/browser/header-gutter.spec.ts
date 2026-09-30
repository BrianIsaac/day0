import { expect, test } from '@playwright/test';

/**
 * The sticky header over the scrollbar's room on a page that does not scroll (the second review's
 * x11): the page keeps the room (`scrollbar-gutter: stable`) and the header's box stops where it
 * begins. Chromium paints the room with the root's background colour alone (no element, shadow or
 * background image reaches it), so the header's tint, the same colour, reaches the window's edge
 * and its 1 px rule cannot; the rule's gap is the accepted rest. Measured on the pixels, where
 * only a browser with classic scrollbars draws the room.
 */

// Chromium's headless default hides scrollbars; the manager's browser draws them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('carries the header’s tint across the scrollbar’s room on a page that does not scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'a phone draws no scrollbar room');
  await page.route(/\.invalid\//, (route) => route.abort());
  await page.goto('/setup', { waitUntil: 'load' });
  // A page short enough not to scroll, whatever the page's own length: the room stays empty.
  await page.addStyleTag({ content: 'main { display: none !important; }' });
  const layout = await page.evaluate(() => {
    const header = document.querySelector('header')?.getBoundingClientRect();
    return {
      // The root's clientWidth leaves out a scrollbar, not an empty room kept for one: the
      // header's box shows where the room begins.
      gutter: window.innerWidth - Math.round(header?.right ?? window.innerWidth),
      scrolls: document.documentElement.scrollHeight > window.innerHeight,
      rule: Math.round((header?.bottom ?? 0) - 1),
      width: window.innerWidth,
    };
  });
  expect(layout.scrolls).toBe(false);
  expect(layout.gutter).toBeGreaterThan(0);

  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: layout.width, height: 80 } });
  // Read the shot's pixels in the page's own decoder: the rule's row inside the header and inside
  // the scrollbar's room, and the tint's row above it in both.
  const pixels = await page.evaluate(
    async ({ png, rule, width, gutter }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d canvas');
      context.drawImage(image, 0, 0);
      const at = (x: number, y: number): string =>
        [...context.getImageData(x, y, 1, 1).data.slice(0, 3)].join(',');
      const inRoom = width - Math.ceil(gutter / 2);
      return {
        ruleInHeader: at(200, rule),
        ruleInRoom: at(inRoom, rule),
        tintInHeader: at(200, rule - 20),
        tintInRoom: at(inRoom, rule - 20),
      };
    },
    { png: shot.toString('base64'), rule: layout.rule, width: layout.width, gutter: layout.gutter },
  );
  expect(pixels.tintInRoom).toBe(pixels.tintInHeader);
  // The rule stops at the room: nothing but the root's colour paints there. Should a browser
  // ever paint the rule on, this is the line to turn round.
  expect(pixels.ruleInRoom).toBe(pixels.tintInRoom);
  expect(pixels.ruleInHeader).not.toBe(pixels.tintInHeader);
});
