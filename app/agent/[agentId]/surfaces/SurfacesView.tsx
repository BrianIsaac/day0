'use client';

import dynamic from 'next/dynamic';
import { useEmployee } from '../employee-context';
import { ENVIRONMENT_FRAME, PanelLoading } from '../PanelLoading';

/*
 * The work environment is its own chunk, loaded when the tab mounts: the office's five surfaces
 * and the systems' cards are not needed to draw the page (U16).
 */
const MockEnvironment = dynamic(
  () => import('../MockEnvironment').then((module) => module.MockEnvironment),
  { loading: () => <PanelLoading label="the work environment" frame={ENVIRONMENT_FRAME} /> },
);

/**
 * The Surfaces tab: in real mode the systems the employee reads and writes, each a card with its
 * approval, credential and access end date, beside how a system is reached; in mock mode the
 * seeded office it works in, across the page's whole width.
 */
export function SurfacesView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  return <MockEnvironment agentId={agent._id} mode={surfaceMode} arriving={arriving} />;
}
