import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Round two section 4.2's floor, over every file the Surfaces tab draws: nothing is set under
 * 12 px (M's routed sweep). Read from the source, since the sizes are Tailwind classes.
 */
const PAGE = 'app/agent/[agentId]';
const FILES = [
  `${PAGE}/MockEnvironment.tsx`,
  ...['mock', 'surfaces'].flatMap((directory) =>
    readdirSync(`${PAGE}/${directory}`)
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => `${PAGE}/${directory}/${file}`),
  ),
];

describe('the Surfaces tab against the 12 px floor (round two section 4.2)', (): void => {
  it.each(FILES)('sets nothing in %s under 12 px', (file): void => {
    const source = readFileSync(file, 'utf8');
    expect(source.match(/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g) ?? []).toEqual([]);
  });
});
