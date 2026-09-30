import type { Metadata } from 'next';
import { ManageView } from './ManageView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.manage };

/** The employee page's Manage tab. */
export default function ManagePage() {
  return <ManageView />;
}
