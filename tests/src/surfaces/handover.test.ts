import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { surfaceHandoverOf } from '../../../src/surfaces/handover';

/** A surface row's fields the decision reads, with no approval and no credential. */
function bareSurface(
  verdict: Doc<'surfaces'>['verdict'],
): Pick<Doc<'surfaces'>, 'verdict' | 'credentialId' | 'provisioning' | 'managerApprovedAt'> {
  return { verdict };
}

describe('the per-surface decision at a handover (D5 (a), A25)', (): void => {
  it("cuts a surface bound to the old owner's credential or a Slack app's client secret", (): void => {
    const credentialId = 'credential' as Id<'credentials'>;
    expect(surfaceHandoverOf({ ...bareSurface('declared'), credentialId }, [])).toBe('cut');
    expect(
      surfaceHandoverOf(
        {
          ...bareSurface('declared'),
          provisioning: {
            clientSecretCredentialId: credentialId,
          } as Doc<'surfaces'>['provisioning'],
        },
        [],
      ),
    ).toBe('cut');
  });

  it('cuts a surface the old manager approved even when no credential is bound yet', (): void => {
    expect(surfaceHandoverOf(bareSurface('approved'), [])).toBe('cut');
    expect(surfaceHandoverOf({ ...bareSurface('proposed'), managerApprovedAt: 5 }, [])).toBe('cut');
    for (const verdict of ['connected', 'ungranted', 'listed-dead'] as const) {
      expect(surfaceHandoverOf(bareSurface(verdict), [])).toBe('cut');
    }
  });

  it('cuts a surface whose bound credential row it is given, whatever its verdict says', (): void => {
    const credential = { _id: 'credential', userId: 'owner' } as unknown as Doc<'credentials'>;
    expect(surfaceHandoverOf(bareSurface('declared'), [credential])).toBe('cut');
  });

  it('carries a surface nothing of the old manager acts through', (): void => {
    for (const verdict of ['declared', 'proposed', 'absent'] as const) {
      expect(surfaceHandoverOf(bareSurface(verdict), [])).toBe('carry');
    }
  });
});
