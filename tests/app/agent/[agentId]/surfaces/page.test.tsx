import { describe, expect, it } from 'vitest';
import SurfacesPage from '../../../../../app/agent/[agentId]/surfaces/page';
import { SurfacesView } from '../../../../../app/agent/[agentId]/surfaces/SurfacesView';

describe('the Surfaces tab', () => {
  it('renders its view inside the employee page', () => {
    expect(SurfacesPage().type).toBe(SurfacesView);
  });
});
