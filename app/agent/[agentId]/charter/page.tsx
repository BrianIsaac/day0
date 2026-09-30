import type { Metadata } from 'next';
import { CharterView } from './CharterView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.charter };

/** The employee page's Charter tab. */
export default function CharterPage() {
  return <CharterView />;
}
