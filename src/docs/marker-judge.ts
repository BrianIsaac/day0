import { agentJson, makeAgent } from '../lib/mastra';
import type { PageStatus } from './authority';
import {
  MARKER_JUDGEMENT_INSTRUCTIONS,
  judgedMarkerStatus,
  markerJudgementPrompt,
  markerJudgementSchema,
  type MarkerCandidate,
  type MarkerJudgement,
} from './status';

/*
 * The marker judgement's model call (wave 15, 15-A; N20, F16): one structured call for the top of
 * one page the pre-filter hit. Apart from `./status`, which is pure and read by the backend's
 * default runtime, because the model client is Node's.
 */

/** The agent's name, which the model-call record and a scripted test reply key on. */
export const MARKER_JUDGE_AGENT = 'day0-doc-marker';

/**
 * The most one judgement may take. A page's top is a few hundred characters and the reply two
 * short fields; a call that takes longer is cut and the page is judged at the next sync.
 */
export const MARKER_JUDGEMENT_TIMEOUT_MS = 30_000;

let agent: ReturnType<typeof makeAgent> | undefined;

/** The judgement's agent, made at the first call: a module load makes no model client. */
function markerAgent(): ReturnType<typeof makeAgent> {
  agent ??= makeAgent(MARKER_JUDGE_AGENT, MARKER_JUDGEMENT_INSTRUCTIONS);
  return agent;
}

/**
 * Ask the model what the top of one page says of the page's own status, and take its answer only
 * when it is grounded in the page (`judgedMarkerStatus`).
 *
 * @param candidate - The page's top, as the pre-filter cut it.
 * @returns The status the marker gives the page; `active` when it is no marker.
 * @throws Error when the model cannot be reached or its reply is not the schema's; the caller
 *   leaves the page unjudged.
 */
export async function judgeMarker(candidate: MarkerCandidate): Promise<PageStatus> {
  const judgement = await agentJson<MarkerJudgement>({
    agent: markerAgent(),
    user: markerJudgementPrompt(candidate),
    schema: markerJudgementSchema,
    timeoutMs: MARKER_JUDGEMENT_TIMEOUT_MS,
  });
  return judgedMarkerStatus(judgement, candidate);
}
