import type { Metadata } from 'next';
import { PeopleView } from './PeopleView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.people };

/** The employee page's People tab. */
export default function PeoplePage() {
  return <PeopleView />;
}
