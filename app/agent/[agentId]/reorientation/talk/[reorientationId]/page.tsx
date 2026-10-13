import type { Metadata } from 'next';
import { TalkView } from '../../TalkRoom';

/** The page's title, under the employee's name. */
export const metadata: Metadata = { title: 'Discuss' };

/** One reorientation card's Discuss talk, under the Needs you tab (16-D). */
export default async function TalkPage({
  params,
}: {
  params: Promise<{ reorientationId: string }>;
}) {
  const { reorientationId } = await params;
  return <TalkView reorientationId={reorientationId} />;
}
