import type { StructuredOutputDiagnostics } from '../src/lib/structured-repair';
import type { EvaluationEvidence } from './report';

/** Decode a quoted console argument, never evaluate provider-controlled log text. */
export function decodeConsoleString(message: string): string {
  const quote = message[0];
  if (!['"', "'", '`'].includes(quote) || message.at(-1) !== quote) return message;
  return message
    .slice(1, -1)
    .replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\\'"`$nrtbfv0])/g, (_, escaped: string) => {
      if (escaped.startsWith('u') || escaped.startsWith('x'))
        return String.fromCharCode(parseInt(escaped.slice(1), 16));
      return (
        (
          { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<
            string,
            string
          >
        )[escaped] ?? escaped
      );
    });
}

export function structuredOutputDiagnostics(jsonl: string): StructuredOutputDiagnostics[] {
  const calls = new Map<string, StructuredOutputDiagnostics>();
  for (const line of jsonl.split('\n')) {
    if (!line.includes('structured-output-call')) continue;
    const event = JSON.parse(line) as {
      logLines?: Array<{ messages?: string[]; isTruncated?: boolean }>;
    };
    for (const log of event.logLines ?? []) {
      for (const message of log.messages ?? []) {
        if (!message.includes('structured-output-call')) continue;
        if (log.isTruncated) throw new Error('structured-output diagnostic log was truncated');
        const entry = JSON.parse(decodeConsoleString(message)) as {
          msg?: string;
          diagnostics?: StructuredOutputDiagnostics;
        };
        if (entry.msg !== 'structured-output-call') continue;
        const call = entry.diagnostics;
        if (
          !call ||
          call.version !== 1 ||
          !call.id ||
          !Number.isInteger(call.repairAttempts) ||
          !Number.isInteger(call.coercions)
        )
          throw new Error('invalid structured-output diagnostic record');
        const previous = calls.get(call.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(call))
          throw new Error(`conflicting structured-output call ${call.id}`);
        calls.set(call.id, call);
      }
    }
  }
  return [...calls.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function counts(calls: StructuredOutputDiagnostics[]) {
  return {
    calls: calls.length,
    invalidFirstReplies: calls.filter((call) => call.firstReplyValid === false).length,
    validationFailures: calls.reduce((n, call) => n + call.validationFailures, 0),
    repairAttempts: calls.reduce((n, call) => n + call.repairAttempts, 0),
    coercions: calls.reduce((n, call) => n + call.coercions, 0),
    failedCalls: calls.filter((call) => call.outcome === 'failed').length,
  };
}

export function structuredOutputRecord(
  evidence: EvaluationEvidence,
  calls: StructuredOutputDiagnostics[],
) {
  const assigned = new Set<string>();
  const rows = evidence.runs.flatMap((run) =>
    run.tasks.map((task) => {
      const selected =
        run.arm === 'day0'
          ? calls.filter(
              (call) => call.startedAt >= task.startedAt && call.finishedAt <= task.finishedAt,
            )
          : [];
      selected.forEach((call) => assigned.add(call.id));
      return {
        runId: run.id,
        arm: run.arm,
        taskId: task.taskId,
        ...counts(selected),
        logicalStages: task.modelCalls.logicalStages,
        coverage:
          run.arm === 'baseline'
            ? 'not-used-by-tool-loop'
            : selected.length >= task.modelCalls.logicalStages
              ? 'complete'
              : 'incomplete',
        callIds: selected.map((call) => call.id),
      };
    }),
  );
  return {
    version: 1,
    evidenceGeneratedAt: evidence.generatedAt,
    definition:
      'First reply validity is Mastra schema validation after its JSON extraction. Repair attempts count additional schema-correction requests; existing semantic action-contract repairs are separate calls. No deterministic coercion is enabled.',
    totals: counts(calls),
    rows,
    outsideTaskWindows: calls.filter((call) => !assigned.has(call.id)).map((call) => call.id),
    calls,
  };
}
