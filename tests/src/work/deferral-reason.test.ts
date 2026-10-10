import { describe, expect, it } from 'vitest';
import { permissionDeferralReason } from '../../../src/work/deferral-reason';

describe('the reason a deferral for a missing permission gives (RM12 (c))', (): void => {
  it('names the permission and the employee, and says what brings the work back', (): void => {
    expect(permissionDeferralReason({ missingPermissions: ['northstar:write'] }, 'Mira')).toBe(
      'Deferred: this work needs northstar:write, a permission Mira does not hold. It is evaluated again once you grant it.',
    );
  });

  it('names every missing permission once, in order', (): void => {
    expect(
      permissionDeferralReason(
        { missingPermissions: ['slack:write', 'linear:write', 'slack:write'] },
        'Mira',
      ),
    ).toBe(
      'Deferred: this work needs slack:write and linear:write, permissions Mira does not hold. It is evaluated again once you grant them.',
    );
  });

  it('gives none for a verdict that names no permission, whatever its shape', (): void => {
    expect(permissionDeferralReason({ missingPermissions: [] }, 'Mira')).toBeUndefined();
    expect(permissionDeferralReason({}, 'Mira')).toBeUndefined();
    expect(permissionDeferralReason({ missingPermissions: 'slack:write' }, 'Mira')).toBeUndefined();
    expect(permissionDeferralReason({ missingPermissions: [7, ''] }, 'Mira')).toBeUndefined();
  });
});
