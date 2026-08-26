import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import { decryptCredential, decryptCredentialRef } from '../../../src/surfaces/credentials';

describe('credential decryption contract', (): void => {
  it('names the credentials action the interface contract defines', (): void => {
    expect(getFunctionName(decryptCredentialRef)).toBe('credentials:decrypt');
  });

  it('runs the action with the credential id and returns its plaintext', async (): Promise<void> => {
    const runAction = vi.fn(async (): Promise<string> => 'plain-value');
    const ctx = { runAction } as unknown as ActionCtx;
    await expect(decryptCredential(ctx, 'cred-1')).resolves.toBe('plain-value');
    expect(runAction).toHaveBeenCalledTimes(1);
    const [reference, args] = runAction.mock.calls[0] as unknown as [
      typeof decryptCredentialRef,
      { credentialId: string },
    ];
    expect(getFunctionName(reference)).toBe('credentials:decrypt');
    expect(args).toEqual({ credentialId: 'cred-1' });
  });
});
