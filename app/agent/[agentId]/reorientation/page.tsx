import type { Metadata } from 'next';
import { ReorientationView } from './ReorientationView';

/** The page's title, under the employee's name. */
export const metadata: Metadata = { title: 'Reorientation' };

/** The employee page's reorientation page, under the Needs you tab. */
export default function ReorientationPage() {
  return <ReorientationView />;
}
