/**
 * The record of a question for the manager, and the pure rules that decide
 * when an open question in the charter is asked.
 *
 * The planning pane reads records of this shape from `managerQuestions` and
 * answers them; the charter pane writes them and turns each answer into a
 * charter amendment. No model dependency: this module is imported by Convex
 * mutations.
 */

import type { Charter } from './charter';

/** Which side of the plan approval touched the question. */
export type QuestionTouchedBy = 'plan' | 'candidate';

/** How an answer arrived. */
export type AnswerVia = 'dashboard' | 'plan-approval' | 'channel';

export interface ManagerQuestionContext {
  touchedBy: QuestionTouchedBy;
  /** The plan step or candidate text that touched the question. */
  text: string;
  /** The content words the two shared. */
  words: string[];
}

export interface ManagerQuestionAnswer {
  text: string;
  answeredAt: number;
  via: AnswerVia;
  /** The charter version that recorded the answer, once the amendment landed. */
  amendedCharterId?: string;
}

/** One question for the manager, as the planning pane reads it. */
export interface ManagerQuestionRecord {
  agentId: string;
  /** Stable across charter versions: the normalised question text. */
  key: string;
  question: string;
  context: ManagerQuestionContext;
  askedAt: number;
  workItemId: string;
  /** The charter version whose open question this was. */
  charterId: string;
  answer?: ManagerQuestionAnswer;
}

/**
 * How the evidence guard opens its note about a clause it dropped. Charters
 * drafted before `synthesisNotes` existed filed that note under the open
 * questions, and the planning pane asked it at plan approval on 16 September.
 */
const SYNTHESIS_NOTE = /^\s*evidence check:/i;

/**
 * Whether a charter row is the synthesis talking about its own drafting.
 *
 * Args:
 *   text: A row from the charter's open questions or notes.
 *
 * Returns:
 *   True for a note; false for a question the 1:1 left open.
 */
export function isSynthesisNote(text: string): boolean {
  return SYNTHESIS_NOTE.test(text);
}

/**
 * The questions the manager may be asked: what the 1:1 left open or could
 * not settle, without any note the synthesis filed among them.
 *
 * Args:
 *   charter: The charter, or the part of it that carries the questions.
 *
 * Returns:
 *   The open questions in charter order.
 */
export function managerOpenQuestions(charter: Pick<Charter, 'openQuestions'>): string[] {
  return (charter.openQuestions ?? []).filter((question: string): boolean => !isSynthesisNote(question));
}

/**
 * The synthesis's notes about its own drafting: the notes field first, then
 * any note an older charter recorded as an open question, each once.
 *
 * Args:
 *   charter: The charter, or the part of it that carries the questions and notes.
 *
 * Returns:
 *   The notes in order; empty when the draft needed none.
 */
export function synthesisNotes(
  charter: Pick<Charter, 'openQuestions'> & Partial<Pick<Charter, 'synthesisNotes'>>,
): string[] {
  const out: string[] = [];
  for (const note of [...(charter.synthesisNotes ?? []), ...(charter.openQuestions ?? []).filter(isSynthesisNote)]) {
    if (!out.includes(note)) out.push(note);
  }
  return out;
}

/**
 * The stable key of a question: its text lower-cased, punctuation removed,
 * whitespace collapsed. Rewording that changes no word keeps the key.
 *
 * Args:
 *   question: The question as the charter carries it.
 *
 * Returns:
 *   The key; empty for a question with no word in it.
 */
export function questionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words too common to say a plan touches a question.
 *
 * Function words, the verbs a question is built from and the words every plan
 * step carries. Only words of four letters and more are content words to
 * begin with, so the shorter function words need no listing.
 */
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'answer', 'before', 'being', 'between', 'both',
  'check', 'confirm', 'could', 'does', 'doing', 'draft', 'during', 'each', 'either',
  'else', 'every', 'from', 'granted', 'have', 'here', 'into', 'just', 'like', 'make',
  'more', 'most', 'much', 'need', 'needs', 'once', 'only', 'other', 'over', 'read',
  'same', 'should', 'since', 'some', 'still', 'such', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'very', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'will',
  'with', 'within', 'without', 'would', 'your', 'ticket', 'tickets', 'work', 'plan',
  'step', 'steps', 'open', 'question', 'questions', 'later', 'first', 'next',
  'agent', 'manager', 'team', 'access', 'owns', 'owner', 'owned',
]);

/**
 * The content words of a text: four letters and more, not a stop word.
 *
 * Args:
 *   text: Any prose.
 *
 * Returns:
 *   Distinct lower-case words in order of first appearance.
 */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 4 || STOP_WORDS.has(word) || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/**
 * The content words a question shares with a text.
 *
 * Args:
 *   question: An open question from the charter.
 *   text: A plan or a candidate, as prose.
 *
 * Returns:
 *   The shared words; empty when the text does not touch the question.
 */
export function sharedContentWords(question: string, text: string): string[] {
  const words = new Set(contentWords(text));
  return contentWords(question).filter((word: string): boolean => words.has(word));
}
