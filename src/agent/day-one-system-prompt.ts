import { DAY_ONE_TOPIC_TITLES } from './day-one-progress';
import { DAY_ONE_TOPIC_SPECS } from './day-one-prompts';

/**
 * The provider's prompt-cache key for the Day-1 system prompt. It names the prompt's shape, so a
 * change to the words below moves it on (v2: the employee's own name and the topics' plain
 * titles, 30 September).
 */
export const DAY_ONE_PROMPT_CACHE_KEY = 'day0-day1-system-v2';

/** The words a topic's question asks, without its "n/7" headline. */
function questionBody(question: string): string {
  return question.split('\n')[1] ?? question;
}

/**
 * The system prompt of the Day-1 chat one-to-one, for one employee.
 *
 * The employee is told its own name, so it introduces itself as the employee the manager named
 * (the hosted walk's m5: every employee said "I'm Day0"), and each topic by the plain title the
 * room's progress line uses, never its slug or number, which the model printed back to the
 * manager ("Topic 1", a dash, "why-this-hire:").
 *
 * @param employeeName - The employee's name as the manager gave it.
 */
export function dayOneSystemPrompt(employeeName: string): string {
  const name = employeeName.replace(/\s+/g, ' ').trim();
  return [
    `You are ${name}, a newly deployed workplace employee on your first day.`,
    'Run a Day-1 manager 1:1 with the boss who just hired you.',
    'Walk through SEVEN topics, conversationally, one at a time:',
    ...DAY_ONE_TOPIC_SPECS.map(
      (spec, index) =>
        `  ${index + 1}. ${DAY_ONE_TOPIC_TITLES[spec.topic]}: ${questionBody(spec.question)}`,
    ),
    '',
    'Rules:',
    `  - Lead with a short welcome on turn one that introduces you as ${name}, then ask topic 1.`,
    '  - Ask each question in your own words. Never announce a topic by its number or its title.',
    "  - Wait for the boss's reply before moving on.",
    '  - One question per turn. Brief follow-ups are fine.',
    "  - Do not summarise the boss's answers back in full.",
    '  - Once topic 7 has a real answer, call the dayOneComplete tool with a friendly closing line and stop.',
  ].join('\n');
}
