import { describe, expect, it } from 'vitest';
import { CURATED_MODELS, defaultModel, modelMenu, unfitDefaultReason } from '../../scripts/models';

describe('the default the picker offers on this hardware', (): void => {
  it('records how much memory each curated model needs resident', (): void => {
    for (const model of CURATED_MODELS) expect(model.residentMiB).toBeGreaterThan(0);
  });

  it('offers no default that would be pulled and does not fit the GPU whole, or with no GPU at all', (): void => {
    const menu = modelMenu([]);
    expect(defaultModel(menu, { freeVramMiB: undefined })).toBeUndefined();
    expect(defaultModel(menu, { freeVramMiB: 4096 })).toBeUndefined();
    expect(defaultModel(menu, { freeVramMiB: 12_000 })?.id).toBe('qwen3:8b');
    // Asked without the hardware, the menu's own order still decides.
    expect(defaultModel(menu)?.id).toBe('qwen3:8b');
  });

  it('keeps a model already present or already in .env.local as the default whatever the hardware', (): void => {
    expect(
      defaultModel(modelMenu([{ id: 'qwen3:8b', sizeLabel: '5.2 GB' }]), { freeVramMiB: undefined })
        ?.id,
    ).toBe('qwen3:8b');
    expect(defaultModel(modelMenu([], 'qwen3:8b'), { freeVramMiB: undefined })?.id).toBe(
      'qwen3:8b',
    );
  });

  it('says why the tested model is no default here, in the terms of the machine', (): void => {
    const [curated] = modelMenu([]);
    expect(unfitDefaultReason(curated, undefined)).toBe(
      'No NVIDIA GPU answered, and qwen3:8b (about 5.2 GB to pull, about 6 GB resident) would run on the CPU: the 1:1 answers, and the charter and every plan take many minutes.',
    );
    expect(unfitDefaultReason(curated, 4096)).toContain('4096 MiB is free on the GPU');
    expect(unfitDefaultReason(curated, 4096)).toContain('partly on the CPU');
    expect(unfitDefaultReason(curated, 12_000)).toBeUndefined();
  });
});
