import { describe, expect, expectTypeOf, it } from 'vitest';
import { SYSTEM_CLASSES, type SystemClass } from '../../../src/agent/system-classes';

describe('the system classes', (): void => {
  it('name the eight classes orientation and the ladder know, with the two catch-alls last', (): void => {
    expect(SYSTEM_CLASSES).toEqual([
      'kanban',
      'chat',
      'docs',
      'spreadsheet',
      'crm',
      'analytics',
      'social',
      'other',
    ]);
    expect(new Set(SYSTEM_CLASSES).size).toBe(SYSTEM_CLASSES.length);
  });

  it('type a class as one of the tuple, not any string', (): void => {
    expectTypeOf<SystemClass>().toEqualTypeOf<(typeof SYSTEM_CLASSES)[number]>();
    expectTypeOf<string>().not.toMatchTypeOf<SystemClass>();
  });
});
