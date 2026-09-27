/**
 * The four consecutive host ports a bed publishes on, picked free from a
 * random base so two rehearsals on one machine never collide with each other
 * or with the primary stack.
 */
import { connect } from 'node:net';
import type { BedPorts } from './env';

/** Lowest base a picked block may start at; below it sit the well-known day0 ports. */
export const PORT_BASE_MIN = 20_000;
/** Highest base, so the four ports stay under the ephemeral range's top. */
export const PORT_BASE_MAX = 60_000;
/** How many bases are tried before the pick gives up. */
export const PORT_PICK_ATTEMPTS = 20;

/**
 * The block laid out from one base: backend, site proxy, dashboard, app.
 *
 * Args:
 *   base: The first port.
 *
 * Returns:
 *   The four ports.
 */
export function portsFromBase(base: number): BedPorts {
  return { backend: base, site: base + 1, dashboard: base + 2, app: base + 3 };
}

/**
 * Whether nothing on loopback answers on a port.
 *
 * Args:
 *   port: The port.
 *
 * Returns:
 *   True when a connection is refused, false when something accepts it.
 */
export async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (free: boolean): void => {
      socket.destroy();
      resolvePromise(free);
    };
    socket.setTimeout(1_000, () => finish(true));
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
  });
}

/**
 * Pick a block whose four ports are all free.
 *
 * Args:
 *   isFree: The probe, injectable for a test.
 *   random: A source in [0, 1), injectable for a test.
 *
 * Returns:
 *   The first free block found.
 *
 * Raises:
 *   Error: When every attempt found a port in use.
 */
export async function pickFreePorts(
  isFree: (port: number) => Promise<boolean> = portIsFree,
  random: () => number = Math.random,
): Promise<BedPorts> {
  for (let attempt = 0; attempt < PORT_PICK_ATTEMPTS; attempt += 1) {
    const base = PORT_BASE_MIN + Math.floor(random() * (PORT_BASE_MAX - PORT_BASE_MIN));
    const ports = portsFromBase(base);
    const free = await Promise.all(Object.values(ports).map((port: number) => isFree(port)));
    if (free.every(Boolean)) return ports;
  }
  throw new Error(`no free block of four ports found in ${PORT_PICK_ATTEMPTS} attempts.`);
}

/**
 * Why a block cannot be used, if it cannot: checked again just before `up`,
 * because a pick and an `up` are not one step.
 *
 * Args:
 *   ports: The block.
 *   isFree: The probe.
 *
 * Returns:
 *   The refusal naming the port in use, or undefined.
 */
export async function portsRefusal(
  ports: BedPorts,
  isFree: (port: number) => Promise<boolean> = portIsFree,
): Promise<string | undefined> {
  for (const [name, port] of Object.entries(ports)) {
    if (!(await isFree(port))) return `port ${port} (${name}) is already in use.`;
  }
  return undefined;
}
