/// <reference types="node" />
import { errorMessage } from '../src/lib/errors';
import { convexEnvironment, convexRun, redactSecrets } from './lib/convex-run';

interface McpProbeResult {
  toolNames: string[];
  elapsedMs: number;
}

/** Read the source id argument and print only non-secret discovery output. */
function main(): void {
  const docSourceId = process.argv[2];
  if (!docSourceId) throw new Error('Usage: pnpm probe:mcp <docSourceId>');
  const result = convexRun<McpProbeResult>(
    'probeActions:probeMcp',
    { docSourceId },
    convexEnvironment(),
  );
  process.stdout.write(
    `pass  MCP source ${docSourceId}: ${result.toolNames.join(', ')} (${result.elapsedMs}ms from the backend)\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAIL  ${redactSecrets(errorMessage(error))}\n`);
  process.exitCode = 1;
}
