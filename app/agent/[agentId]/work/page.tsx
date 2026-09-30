import type { Metadata } from 'next';
import { WorkView } from './WorkView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.work };

/** The employee page's Work tab. */
export default function WorkPage() {
  return <WorkView />;
}
