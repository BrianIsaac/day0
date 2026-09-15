/**
 * What the run has changed and how to undo it, run last-in first-out and
 * reported step by step: one failing undo never stops the others.
 */

export interface UndoResult {
  label: string;
  ok: boolean;
  error?: string;
}

interface UndoStep {
  label: string;
  run: () => Promise<void>;
}

export class UndoLedger {
  private readonly steps: UndoStep[] = [];

  /**
   * Register an undo for a change that has just succeeded.
   *
   * Args:
   *   label: What the step puts back, for the record.
   *   run: The undo itself.
   */
  register(label: string, run: () => Promise<void>): void {
    this.steps.push({ label, run });
  }

  /** Labels still to undo, newest first. */
  pending(): string[] {
    return [...this.steps].reverse().map((step: UndoStep): string => step.label);
  }

  /**
   * Run every registered undo, newest first, attempting each whatever the
   * others did.
   *
   * Returns:
   *   One result per step, in the order run.
   */
  async runAll(): Promise<UndoResult[]> {
    const results: UndoResult[] = [];
    while (this.steps.length > 0) {
      const step = this.steps.pop()!;
      try {
        await step.run();
        results.push({ label: step.label, ok: true });
      } catch (error) {
        results.push({ label: step.label, ok: false, error: (error as Error).message });
      }
    }
    return results;
  }
}
