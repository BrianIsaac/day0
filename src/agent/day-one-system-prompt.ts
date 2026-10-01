import { DAY_ONE_TOPIC_COUNT, DAY_ONE_TOPIC_TITLES, topicIndexOf } from './day-one-progress';
import { DAY_ONE_TOPIC_SPECS, questionBody } from './day-one-prompts';
import { clippedEmployeeName } from './employee-name';

/**
 * The provider's prompt-cache key for the Day-1 system prompt. It names the prompt's shape, so a
 * change to the words below moves it on (v2: the employee's own name and the topics' plain
 * titles, 30 September; v3: one question per turn, the one `dayOneTurnNote` names, 1 October).
 */
export const DAY_ONE_PROMPT_CACHE_KEY = 'day0-day1-system-v3';

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
    '  - Once the note says all seven are answered, call the dayOneComplete tool with a friendly closing line and stop.',
  ].join('\n');
}

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
 * @param replies - `managerReplies` of the history this turn answers.
 */
export function dayOneTurnNote(replies: number): string {
  const answered = Math.max(0, Math.floor(replies));
  if (answered >= DAY_ONE_TOPIC_COUNT) {
    return (
      'Where the one-to-one stands: the boss has answered all seven questions. In this turn, ' +
      'thank the boss in a sentence or two, ask nothing, and call the dayOneComplete tool with a ' +
      'friendly closing line.'
    );
  }
  const spec = DAY_ONE_TOPIC_SPECS[topicIndexOf(answered)];
  const question =
    `ask question ${answered + 1} (${DAY_ONE_TOPIC_TITLES[spec.topic]}) in your own words: ` +
    questionBody(spec.question);
  return answered === 0
    ? 'Where the one-to-one stands: the boss has answered none of the seven questions yet. ' +
        `In this turn, welcome the boss as the rules say, then ${question}`
    : `Where the one-to-one stands: the boss has answered ${answered} of the seven questions. ` +
        `In this turn, acknowledge the boss's last reply in at most one short sentence, then ${question}`;
}
