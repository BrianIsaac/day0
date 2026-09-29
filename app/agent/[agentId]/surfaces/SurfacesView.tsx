'use client';

import dynamic from 'next/dynamic';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { ENVIRONMENT_FRAME, PanelLoading } from '../PanelLoading';
import { PermissionsCard } from './PermissionsCard';

/*
 * The work environment is its own chunk, loaded when the tab mounts: its five mock tabs are not
 * needed to draw the page.
 */
const MockEnvironment = dynamic(
  () => import('../MockEnvironment').then((module) => module.MockEnvironment),
  { loading: () => <PanelLoading label="the work environment" frame={ENVIRONMENT_FRAME} /> },
);

/**
 * The Surfaces tab: in real mode the systems the employee reads and writes with the permissions
 * the manager granted, in mock mode the hosted office it works in. The environment takes the
 * page's whole width: five surfaces, a channel list and a conversation do not fit in a column.
 */
export function SurfacesView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  return (
    <Columns arriving={arriving}>
      {surfaceMode === 'real' ? <PermissionsCard agentId={agent._id} /> : null}
      <MockEnvironment agentId={agent._id} />
    </Columns>
  );
}
