import type { Metadata } from 'next';
import { SkillsView } from './SkillsView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.skills };

/** The employee page's Skills tab. */
export default function SkillsPage() {
  return <SkillsView />;
}
