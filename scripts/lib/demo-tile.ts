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
  return withPrivateHosts(value, [DEMO_TILE_HOST]);
}

/** A list entry as it is compared: lower case, no trailing dot. */
function entryKey(entry: string): string {
  return entry.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * A `DAY0_PRIVATE_HOSTS` value with hosts added after the operator's own entries, each once: an
 * entry the list already names, in any case, is not added again, and a list that gains nothing is
 * returned as given (`--add-private-host`, W14-R36).
 *
 * @param value - The list as the env file holds it: entries separated by commas or whitespace.
 * @param hosts - The hosts to add, in order.
 */
export function withPrivateHosts(value: string | undefined, hosts: readonly string[]): string {
  const held = new Set(
    (value ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(entryKey),
  );
  const added: string[] = [];
  for (const host of hosts) {
    const key = entryKey(host);
    if (key === '' || held.has(key)) continue;
    held.add(key);
    added.push(host.trim());
  }
  if (added.length === 0) return value ?? '';
  const own = (value ?? '').trim().replace(/,\s*$/, '');
  return [...(own === '' ? [] : [own]), ...added].join(',');
}
