import { DAY_ONE_TOPIC_COUNT, DAY_ONE_TOPIC_TITLES, topicIndexOf } from './day-one-progress';
import { DAY_ONE_TOPIC_SPECS, questionBody } from './day-one-prompts';
import { clippedEmployeeName } from './employee-name';

/**
 * The provider's prompt-cache key for the Day-1 system prompt. It names the prompt's shape, so a
 * change to the words below moves it on (v2: the employee's own name and the topics' plain
 * titles, 30 September; v3: one question per turn, the one `dayOneTurnNote` names, 1 October;
 * v4: the close as the note says it, with no friendly line of its own, 2 October).
 */
export const DAY_ONE_PROMPT_CACHE_KEY = 'day0-day1-system-v4';

/**
 * The words of the tool the employee calls to end the one-to-one, said to the model with the
 * tool: when to call it, and what its closing line says. The line is drawn after the turn's own
 * text, so it only says the charter is next: a "friendly closing line" was a second thank-you on
 * the v0.12.0 walk.
 */
export const DAY_ONE_COMPLETE_TOOL = {
  description:
    'Call this once all seven questions are answered, in the closing turn, after its thanks ' +
    'and what was left open.',
  closingLine:
    'One short sentence saying you will now draft the charter for their review. It does not ' +
    'thank them again: the turn has already done so.',
} as const;

/**
 * The system prompt of the Day-1 chat one-to-one, for one employee.
 *
 * The employee is told its own name, so it introduces itself as the employee the manager named
 * (the hosted walk's m5: every employee said "I'm Day0"), and each topic by the plain title the
 * room's progress line uses, never its slug or number, which the model printed back to the
 * manager ("Topic 1", a dash, "why-this-hire:"). The prompt carries no em dash, and asks for none:
 * the employee wrote one to the manager in every turn (the round review's r2).
 *
 * Which question to ask is not left to the model. On the v0.11.0 hosted walk it asked its own
 * follow-ups and came back to "who should I meet" four times, while the counter and the "Noted so
 * far" labels moved one question per reply, so the labels held other questions' answers. Each
 * turn now ends with `dayOneTurnNote`, which names the one question to ask by the same count, and
 * the prompt asks for that question only, once, with no follow-up.
 *
 * The name is flattened to one line and held to 80 characters (`clippedEmployeeName`, the bound a
 * deploy holds a name to); a deploy may leave it empty, and then the employee is told no name
 * rather than an empty one.
 *
 * @param employeeName - The employee's name as the manager gave it.
 */
export function dayOneSystemPrompt(employeeName: string): string {
  const name = clippedEmployeeName(employeeName);
  return [
    name
      ? `You are ${name}, a newly deployed workplace employee on your first day.`
      : 'You are a newly deployed workplace employee on your first day.',
    'Run a Day-1 manager 1:1 with the boss who just hired you.',
    'Walk through SEVEN topics, conversationally, one at a time:',
    ...DAY_ONE_TOPIC_SPECS.map(
      (spec, index) =>
        `  ${index + 1}. ${DAY_ONE_TOPIC_TITLES[spec.topic]}: ${questionBody(spec.question)}`,
    ),
    '',
    'Rules:',
    name
      ? `  - Lead with a short welcome on turn one that introduces you as ${name}, then ask topic 1.`
      : '  - Lead with a short welcome on turn one, then ask topic 1.',
    '  - Ask each question in your own words. Never announce a topic by its number or its title.',
    '  - Write plain punctuation: a comma, a colon or a full stop, never a dash between clauses.',
    "  - Wait for the boss's reply before moving on.",
    '  - Ask only the question the note at the end of the conversation names, once, then stop. ' +
      'Never ask a follow-up, never go back to an earlier topic and never ask a later one early. ' +
      'An answer that leaves something out still stands: the boss can add to it at the last question.',
    "  - Do not summarise the boss's answers back in full.",
    '  - Once the note says all seven are answered, close as it says, call the dayOneComplete tool and stop.',
  ].join('\n');
}

/** The end of every note before the close: the employee never promises a return it cannot keep. */
const NO_PROMISED_RETURN =
  ' Never promise to come back to a question or say you will circle back to it: anything the ' +
  'boss leaves open is named at the last question.';

/**
 * The close's note: one thanks, then what is still open after the last answer (question 7 asks
 * the boss to settle what was left open), named as the charter's open questions, then the tool, whose line drafts the charter and does not thank again. On the
 * v0.12.0 walk the close thanked twice (the turn, then the tool's "friendly closing line") and
 * named neither thread question 7 had noted. Which replies left something open is the model's
 * reading of the conversation, not a word list (N20).
 */
const CLOSE =
  'Where the one-to-one stands: the boss has answered all seven questions. In this turn, ' +
  'thank the boss once, in one short sentence. Then name, in one short sentence each, what ' +
  "is still open after the boss's last answer, saying it goes on the charter as an open " +
  'question: a question they asked back, an answer they were not sure of, something they ' +
  'asked to come back to, or anything they raised at the last question; name nothing that ' +
  'their last answer settled, and nothing when nothing is open. Ask nothing, and promise ' +
  'nothing but the charter. Then call the dayOneComplete ' +
  'tool: its closing line only says you will now draft the charter for their review, and ' +
  'does not thank them again.';

/** What the last question's note asks first: the open threads of the earlier replies, named. */
const LEFT_OPEN_FIRST =
  "before the last question, name in one short sentence each thing the boss's earlier replies " +
  'left open: a question they asked back, an answer they were not sure of, or something they ' +
  'asked to come back to; name nothing when nothing was left open.';

/**
 * Where the one-to-one stands, said to the model as the last message of every turn: the one
 * question this turn asks, or the close once all seven are answered.
 *
 * The question is the one at the manager's reply count (`topicIndexOf`), the count the progress
 * line, the stored turn's `topicIndex`, the "Noted so far" label and the close gate all read, so
 * the question asked and the question every one of them names are the same one. It is a message
 * of its own after the conversation rather than a line of the system prompt, which stays the same
 * on every turn of every one-to-one and keeps its cache.
 *
 * The one-to-one asks no follow-up (F-D5), so a reply that leaves a question open is not chased:
 * every note forbids promising to come back to it, which the employee did on the wave 9 review's
 * walk and never kept, and the last question's note has the employee name what the earlier
 * replies left open before asking it, so the boss can settle it there (decision 3); the close
 * names what is still open as it goes on the charter. Which replies left something open is the
 * model's reading of the conversation, not a word list (N20).
 *
 * @param replies - `managerReplies` of the history this turn answers.
 */
export function dayOneTurnNote(replies: number): string {
  const answered = Math.max(0, Math.floor(replies));
  if (answered >= DAY_ONE_TOPIC_COUNT) return CLOSE;
  const spec = DAY_ONE_TOPIC_SPECS[topicIndexOf(answered)];
  const question =
    `ask question ${answered + 1} (${DAY_ONE_TOPIC_TITLES[spec.topic]}) in your own words: ` +
    questionBody(spec.question);
  if (answered === 0) {
    return (
      'Where the one-to-one stands: the boss has answered none of the seven questions yet. ' +
      `In this turn, welcome the boss as the rules say, then ${question}${NO_PROMISED_RETURN}`
    );
  }
  const stands = `Where the one-to-one stands: the boss has answered ${answered} of the seven questions. `;
  const acknowledge =
    "In this turn, acknowledge the boss's last reply in at most one short sentence";
  if (answered === DAY_ONE_TOPIC_COUNT - 1) {
    return `${stands}${acknowledge}. Then, ${LEFT_OPEN_FIRST} Then ${question}${NO_PROMISED_RETURN}`;
  }
  return `${stands}${acknowledge}, then ${question}${NO_PROMISED_RETURN}`;
}
