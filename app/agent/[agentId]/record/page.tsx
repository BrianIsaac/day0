import type { Metadata } from 'next';
import { RecordView } from './RecordView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.record };

/** The employee page's Record tab. */
export default function RecordPage() {
  return <RecordView />;
}
