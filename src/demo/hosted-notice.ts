import { REPOSITORY_URL } from '../setup/quickstart';

/**
 * What the hosted demo collects and who receives it (N6), said before anybody signs in: on the
 * sign-in page, and in the walkthrough's closing card that sends a visitor there. One constant
 * so the two places cannot say different things. Every recipient it names is one the README's
 * "Who receives what" sentence names for the hosted demo, and
 * `tests/src/demo/hosted-notice.test.ts` fails when the two lists part.
 */
export const HOSTED_DEMO_NOTICE = {
  heading: 'Before you sign in: what the hosted demo collects',
  paragraphs: [
    'The hosted office is a seeded mock: nothing your employee does reaches a real system.',
    "To run it, your sign-in email goes to Clerk, the pages are served by Vercel, and every row, your employee's included, is stored in Convex's cloud. Your one-to-one and the mock office's content go to the model provider the deployment names, a skill your employee writes is smoke-tested on Daytona, and a voice one-to-one, when you choose one, goes to ElevenLabs with your email address.",
  ],
  /** The closing sentence, whose middle links the README's disclosures. */
  link: {
    before: "The README's disclosures say ",
    label: 'who receives what, in full',
    after: '.',
    href: `${REPOSITORY_URL}#disclosures`,
  },
} as const satisfies {
  heading: string;
  paragraphs: readonly string[];
  link: { before: string; label: string; after: string; href: string };
};
