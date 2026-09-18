import { describe, expect, it } from 'vitest';
import { BED_PROFILES } from '../../scripts/demo-bed';
import {
  bedComposeFlags,
  trialConfiguration,
  waitForDocumentationSync,
  SYNC_IDLE_MS,
  type DocSourceProgress,
} from '../../scripts/eval-revocation';
import { REDACTOR_TIMEOUT_MS } from '../../src/redaction/policy';

describe('what the revocation trial records about the stack it ran on', (): void => {
  it('names the redactor the demo-bed kit starts', (): void => {
    expect(trialConfiguration('day0-demo-7c65e7').profiles).toContain('redactor');
  });

  it('takes the profiles from the kit rather than keeping a second list', (): void => {
    expect(trialConfiguration('day0-demo-7c65e7').profiles).toEqual([...BED_PROFILES]);
  });

  it('records the compose project the trial was pointed at', (): void => {
    expect(trialConfiguration('day0-p11-a').composeProject).toBe('day0-p11-a');
  });

  it('still records the rest of the stack the trial is measured against', (): void => {
    expect(trialConfiguration('day0-demo-7c65e7')).toMatchObject({
      surfaceMode: 'real',
      folderDocumentation: 'docs-local/ mounted read-only at /docs',
      fakeProviders: ['fake-slack', 'looker-tile'],
      daytonaBlanked: true,
      onboardingTranscriptPath: 'evaluation/onboarding/day0.json',
    });
  });
});

describe('the commands the evidence tells a reader to repeat', (): void => {
  it('brings up every component the recorded stack names', (): void => {
    const flags = bedComposeFlags();
    for (const profile of trialConfiguration('day0-demo-7c65e7').profiles) {
      if (profile === 'real') continue;
      expect(flags).toContain(`--profile ${profile}`);
    }
    expect(flags).toContain('--profile redactor');
  });

  it('leaves out the base profile, which every compose invocation adds', (): void => {
    expect(bedComposeFlags()).not.toContain('--profile real');
  });
});

describe('waiting for the folder documentation sync', (): void => {
  /** A clock the test moves by hand: every sleep is instant and recorded. */
  function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; at: () => number } {
    let at = 0;
    return {
      now: (): number => at,
      sleep: async (ms: number): Promise<void> => {
        at += ms;
      },
      at: (): number => at,
    };
  }

  /** A source that reads one more page every poll until it has them all. */
  function syncing(pages: number): () => Promise<DocSourceProgress> {
    let read = 0;
    return async (): Promise<DocSourceProgress> => {
      read = Math.min(read + 1, pages);
      return read < pages
        ? { status: 'linking', pageCount: read }
        : { status: 'synced', pageCount: read };
    };
  }

  it('waits out a sync that is slower than the driver’s other steps', async (): Promise<void> => {
    const time = clock();
    // The 13 company-bed pages through the CPU redactor took 34.8 s on 18
    // September 2026, against the 30 s every other wait here allows.
    const source = await waitForDocumentationSync(syncing(13), time);
    expect(source).toEqual({ status: 'synced', pageCount: 13 });
    expect(time.at()).toBeGreaterThan(0);
  });

  it('gives up only when no page has been read for its idle window', async (): Promise<void> => {
    const time = clock();
    await expect(
      waitForDocumentationSync(async () => ({ status: 'linking', pageCount: 4 }), time),
    ).rejects.toThrow('timed out waiting for folder documentation sync');
    expect(time.at()).toBeGreaterThanOrEqual(SYNC_IDLE_MS);
  });

  it('allows several redactor calls to pass without a page before it does', (): void => {
    expect(SYNC_IDLE_MS).toBeGreaterThanOrEqual(REDACTOR_TIMEOUT_MS * 5);
  });

  it('stops at once when the source reports an error', async (): Promise<void> => {
    await expect(
      waitForDocumentationSync(
        async () => ({ status: 'error', pageCount: 0, lastError: 'redactor unreachable' }),
        clock(),
      ),
    ).rejects.toThrow('redactor unreachable');
  });
});
