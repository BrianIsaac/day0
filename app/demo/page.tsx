import type { Metadata } from 'next';

import { HOSTED_DEMO_SNAPSHOT } from '@/demo/hosted-demo-snapshot';

import { DemoWalkthrough } from './DemoWalkthrough';

export const metadata: Metadata = {
  title: 'Day0 demo',
  description:
    'A read-only recording of one Day0 agent: its charter, the scopes it holds, the work it claimed, and the skill it had to ask for.',
};

/**
 * Public, static, and built entirely from `src/demo/hosted-demo-snapshot.json`.
 * The route reads no row and holds no session: a signed-out visitor gets the
 * same bytes as anybody else, and nothing they do here can write.
 */
export default function DemoPage() {
  return <DemoWalkthrough snapshot={HOSTED_DEMO_SNAPSHOT} />;
}
