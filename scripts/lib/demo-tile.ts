/*
 * The demo profile's tile (`looker-tile` in `docker-compose.yml`): a web UI over plain http on
 * the Compose network, which the browser rung and the URLs reader open only on a host
 * `DAY0_PRIVATE_HOSTS` lists (wave 14, 14-D's M20 and R9). Every builder that starts the demo
 * profile lists it (14-D's ruling 2, 8 October 2026); an install without the profile does not.
 */

/** The tile's host name on the Compose network. */
export const DEMO_TILE_HOST = 'looker-tile';

/**
 * Whether a `DAY0_PRIVATE_HOSTS` value names the tile: an entry of the list, in any case, with or
 * without a trailing dot. A `.suffix` entry cannot, since the tile's name has no dot.
 *
 * @param value - The list as the env file holds it: entries separated by commas or whitespace.
 */
export function listsDemoTile(value: string | undefined): boolean {
  return (value ?? '')
    .split(/[\s,]+/)
    .some((entry) => entry.trim().toLowerCase().replace(/\.$/, '') === DEMO_TILE_HOST);
}

/**
 * The list with the tile added after the operator's own entries, or the list as given when it
 * already names the tile.
 *
 * @param value - The list as the env file holds it.
 */
export function withDemoTile(value: string | undefined): string {
  if (listsDemoTile(value)) return value ?? '';
  const own = (value ?? '').trim().replace(/,\s*$/, '');
  return own === '' ? DEMO_TILE_HOST : `${own},${DEMO_TILE_HOST}`;
}
