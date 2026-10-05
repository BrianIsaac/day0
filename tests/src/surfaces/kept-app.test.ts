import { describe, expect, it } from 'vitest';
import { keptAppNotReinstalled } from '../../../src/surfaces/kept-app';

describe('keptAppNotReinstalled (13-FS, W12X-4)', (): void => {
  const ended = { class: 'chat', provisioning: { organisationConnectionId: 'conn-1' } };

  it('reads a chat card with no credential whose app a revoked connection created as ended', (): void => {
    expect(keptAppNotReinstalled(ended, true)).toBe(true);
  });

  it('reads a card that holds a credential, an app no connection created, a live creator or another class as not ended', (): void => {
    expect(keptAppNotReinstalled({ ...ended, credentialId: 'cred-1' }, true)).toBe(false);
    expect(keptAppNotReinstalled({ class: 'chat', provisioning: {} }, true)).toBe(false);
    expect(keptAppNotReinstalled(ended, false)).toBe(false);
    expect(keptAppNotReinstalled({ ...ended, class: 'kanban' }, true)).toBe(false);
  });
});
