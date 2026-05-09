import type { DayOneTopic } from './charter';

/**
 * Day-1 manager 1:1 conversational protocol. Lifted from Protean's
 * `src/agent/day-one-prompts.ts` — the seven topics are load-bearing
 * for the charter synthesis prompt downstream.
 *
 * The agent leads the boss through seven topics, "conversational, like
 * a real new hire's first 1:1 — one question at a time, follow-ups
 * threaded, not a structured questionnaire to fill in."
 *
 * Used by both the chat-mode flow and the voice flow (the questions
 * become the agent's "if you have not yet covered topic X, ask Y"
 * instructions in the ElevenLabs system prompt).
 */

export interface DayOneTopicSpec {
  topic: DayOneTopic;
  question: string;
}

const AGENT_NAME = 'Day0';

export const DAY_ONE_WELCOME = (managerFirstName: string): string =>
  [
    `Hi ${managerFirstName} — I'm ${AGENT_NAME}, the agent you just deployed.`,
    `I'd love a few minutes to get a sense of the role you've brought me on for.`,
    `I'll ask seven short questions and then put together a draft charter for you to look over. Bullet points are fine if you're short on time.`,
  ].join('\n\n');

export const DAY_ONE_TOPIC_SPECS: readonly DayOneTopicSpec[] = [
  {
    topic: 'why-this-hire',
    question: [
      '1/7 — Why this hire?',
      "What triggered the decision to bring me on? What's the team trying to make easier?",
    ].join('\n'),
  },
  {
    topic: 'role-and-goals',
    question: [
      '2/7 — The role itself.',
      "What do you see me doing day-to-day? When you imagine looking back at month 1, month 2, and month 3 — what does each of those checkpoints look like if I'm doing this well?",
    ].join('\n'),
  },
  {
    topic: 'collaborators',
    question: [
      '3/7 — Who should I talk to?',
      '3-5 people on the team I should meet first. For each, would you prefer to introduce me, or would you like me to reach out directly?',
    ].join('\n'),
  },
  {
    topic: 'reading',
    question: [
      '4/7 — What should I read?',
      "Any wiki pages, docs, or onboarding material I should start with? I'll pick up more from observation later, but anything you point at first I'll prioritise.",
    ].join('\n'),
  },
  {
    topic: 'tools',
    question: [
      '5/7 — Where does work live?',
      'What tools does the team use day-to-day? Where does formal work track (tickets, dashboards, spreadsheets) and where do informal asks come in (chat, email)?',
    ].join('\n'),
  },
  {
    topic: 'immediate',
    question: [
      '6/7 — Anything immediate?',
      "Is there anything specific you'd like me to pick up in week 1, or is this more of a 'figure it out' deployment? Either is fine — I'd just rather know.",
    ].join('\n'),
  },
  {
    topic: 'open-questions',
    question: [
      '7/7 — Anything else?',
      "Anything you're unsure about, or things you'd like me to circle back on later? I'll capture them as open questions on the charter.",
    ].join('\n'),
  },
];

const TOPIC_LOOKUP = new Map(DAY_ONE_TOPIC_SPECS.map((s) => [s.topic, s]));

export function topicQuestion(topic: DayOneTopic): string {
  const spec = TOPIC_LOOKUP.get(topic);
  if (!spec) throw new Error(`day-one-prompts: unknown topic ${topic}`);
  return spec.question;
}

export function defaultSoul(): string {
  return [
    '# SOUL',
    '',
    'I am Day0, an autonomous agent recently joined to a team.',
    '',
    'Voice: friendly, direct, low-affect. I write the way a competent new hire would — bullet-pointed when useful, full sentences when nuance matters.',
    '',
    'Posture: I propose, the team disposes. I prefer to surface a draft and let humans correct than to ask open-ended questions.',
    '',
    'When I am uncertain I flag it; I do not invent. Idle is a first-class state.',
  ].join('\n');
}

export function day1Script(): string {
  return [
    '# BOOTSTRAP — Day 1',
    '',
    'On first deployment I lead a Day-1 manager 1:1 over voice or chat. The boss picks the channel.',
    '',
    'Seven topics:',
    '1. Why this hire',
    '2. The role + 30/60/90 success',
    '3. Named collaborators (3-5 people)',
    '4. Priority reading',
    '5. Where work lives (tools)',
    '6. Anything immediate',
    '7. Open questions',
    '',
    'After the conversation I synthesise a charter v0.0 with provenance tagging, write IDENTITY.md and TOOLS.md, kick off good-habits research, and surface the work queue.',
  ].join('\n');
}
