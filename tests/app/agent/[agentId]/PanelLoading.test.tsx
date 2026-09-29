import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_FRAME,
  PanelLoading,
  ROOM_FRAME,
} from '../../../../app/agent/[agentId]/PanelLoading';

describe('PanelLoading', () => {
  it('says what is loading as a status, in the frame the panel will fill', () => {
    const html = renderToStaticMarkup(<PanelLoading label="the 1:1" frame={ROOM_FRAME} />);
    expect(html).toContain('role="status"');
    expect(html.replace(/<!-- -->/g, '')).toContain('>Loading the 1:1</p>');
    expect(html).toContain(ROOM_FRAME);
    expect(ENVIRONMENT_FRAME).toContain('min-h-[30rem]');
  });
});
