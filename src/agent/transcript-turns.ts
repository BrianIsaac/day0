/** One turn of a stored one-to-one: who said it and what they said. */
export interface TranscriptTurn {
  readonly speaker: 'manager' | 'employee';
  readonly text: string;
}

/**
 * The labels each room writes on its lines: `ChatRoom` writes USER and ASSISTANT, the voice room
 * and the ElevenLabs webhook USER and AGENT.
 */
const SPEAKERS: Readonly<Record<string, TranscriptTurn['speaker']>> = {
  USER: 'manager',
  MANAGER: 'manager',
  BOSS: 'manager',
  ASSISTANT: 'employee',
  AGENT: 'employee',
  DAY0: 'employee',
};

const LABELLED = /^\s*([A-Za-z0-9_]+)\s*:\s?(.*)$/;

/**
 * Read a stored transcript back into its turns, for the page to show what was said.
 *
 * A labelled line starts a turn; an unlabelled line continues the turn above it, so a reply the
 * manager wrote over several lines reads as one. Text before any label has no speaker and is left
 * out rather than guessed at.
 *
 * @param transcript - The transcript as a room posted it, one labelled turn per paragraph.
 */
export function transcriptTurns(transcript: string): TranscriptTurn[] {
  const turns: Array<{ speaker: TranscriptTurn['speaker']; lines: string[] }> = [];
  for (const line of transcript.split('\n')) {
    const match = LABELLED.exec(line);
    const speaker = match ? SPEAKERS[match[1].toUpperCase()] : undefined;
    if (match && speaker) {
      turns.push({ speaker, lines: [match[2]] });
    } else if (turns.length > 0) {
      turns[turns.length - 1].lines.push(line);
    }
  }
  return turns
    .map((turn): TranscriptTurn => ({ speaker: turn.speaker, text: turn.lines.join('\n').trim() }))
    .filter((turn: TranscriptTurn): boolean => turn.text !== '');
}

/**
 * How many questions the manager answered: each manager turn that follows an employee turn, the
 * same count the close gate keeps on the live conversation (`managerReplies`).
 */
export function answeredCount(turns: readonly TranscriptTurn[]): number {
  return turns.filter(
    (turn: TranscriptTurn, index: number): boolean =>
      turn.speaker === 'manager' && turns[index - 1]?.speaker === 'employee',
  ).length;
}
