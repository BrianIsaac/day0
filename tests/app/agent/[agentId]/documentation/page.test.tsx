import { describe, expect, it } from 'vitest';
import DocumentationPage from '../../../../../app/agent/[agentId]/documentation/page';
import { DocumentationView } from '../../../../../app/agent/[agentId]/documentation/DocumentationView';

describe('the Documentation tab', () => {
  it('renders its view inside the employee page', () => {
    expect(DocumentationPage().type).toBe(DocumentationView);
  });
});
