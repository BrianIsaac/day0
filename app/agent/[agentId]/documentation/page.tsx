import type { Metadata } from 'next';
import { DocumentationView } from './DocumentationView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.documentation };

/** The employee page's Documentation tab. */
export default function DocumentationPage() {
  return <DocumentationView />;
}
