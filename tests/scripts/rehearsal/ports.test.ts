import { describe, expect, it } from 'vitest';
import {
  PORT_BASE_MAX,
  PORT_BASE_MIN,
  PORT_PICK_ATTEMPTS,
  pickFreePorts,
  portsFromBase,
  portsRefusal,
} from '../../../scripts/rehearsal/ports';

describe('the bed ports', (): void => {
  it('lays four consecutive ports out from one base', (): void => {
    expect(portsFromBase(45210)).toEqual({
      backend: 45210,
      site: 45211,
      dashboard: 45212,
      app: 45213,
    });
  });

  it('picks a block whose four ports are all free, from a random base above the well-known ones', async (): Promise<void> => {
    const probed: number[] = [];
    const isFree = async (port: number): Promise<boolean> => {
      probed.push(port);
      return port !== PORT_BASE_MIN + 1;
    };
    const draws = [0, 0.5];
    const ports = await pickFreePorts(isFree, () => draws.shift() ?? 0.5);
    const base = PORT_BASE_MIN + Math.floor(0.5 * (PORT_BASE_MAX - PORT_BASE_MIN));
    expect(ports).toEqual(portsFromBase(base));
    expect(probed.slice(0, 4)).toEqual([
      PORT_BASE_MIN,
      PORT_BASE_MIN + 1,
      PORT_BASE_MIN + 2,
      PORT_BASE_MIN + 3,
    ]);
  });

  it('gives up after the attempt ceiling when every block has a port in use', async (): Promise<void> => {
    let probes = 0;
    const isFree = async (): Promise<boolean> => {
      probes += 1;
      return false;
    };
    await expect(pickFreePorts(isFree, () => 0.25)).rejects.toThrow('no free block');
    expect(probes).toBe(PORT_PICK_ATTEMPTS * 4);
  });

  it('re-checks a block before up and names the port in use', async (): Promise<void> => {
    const ports = portsFromBase(30000);
    expect(await portsRefusal(ports, async () => true)).toBeUndefined();
    expect(await portsRefusal(ports, async (port: number) => port !== 30002)).toBe(
      'port 30002 (dashboard) is already in use.',
    );
  });
});
