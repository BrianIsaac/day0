import type { Metadata } from 'next';
import { SurfacesView } from './SurfacesView';
import { EMPLOYEE_TAB_LABELS } from '../employee-tabs';

/** The tab's title, under the employee's name. */
export const metadata: Metadata = { title: EMPLOYEE_TAB_LABELS.surfaces };

/** The employee page's Surfaces tab. */
export default function SurfacesPage() {
  return <SurfacesView />;
}
