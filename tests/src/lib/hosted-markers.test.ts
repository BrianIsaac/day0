import { describe, expect, it } from 'vitest';
import {
  HOSTED_DEMO_PLATFORM,
  HOSTED_PLATFORM_MARKERS,
  presentHostedMarkers,
} from '../../../src/lib/hosted-markers';

/** An env reader over a plain record, as the callers build one. */
function reader(values: Record<string, string>): (name: string) => string | undefined {
  return (name: string): string | undefined => values[name];
}

describe('hosted-platform markers', (): void => {
  it('names every marker the three earlier lists named between them', (): void => {
    const names = HOSTED_PLATFORM_MARKERS.map((marker) => marker.name);
    for (const name of [
      'VERCEL',
      'VERCEL_ENV',
      'NEXT_PUBLIC_VERCEL_ENV',
      'AWS_REGION',
      'AWS_EXECUTION_ENV',
      'KUBERNETES_SERVICE_HOST',
      'FLY_APP_NAME',
      'RENDER',
      'DYNO',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('reports the markers present, in list order, ignoring empty values', (): void => {
    expect(presentHostedMarkers(reader({ DYNO: 'web.1', VERCEL: '1', RENDER: '' }))).toEqual([
      'VERCEL',
      'DYNO',
    ]);
    expect(presentHostedMarkers(reader({}))).toEqual([]);
  });

  it('narrows to the platforms asked about', (): void => {
    const values = reader({ AWS_REGION: 'ap-southeast-1', NEXT_PUBLIC_VERCEL_ENV: 'preview' });
    expect(presentHostedMarkers(values, [HOSTED_DEMO_PLATFORM])).toEqual([
      'NEXT_PUBLIC_VERCEL_ENV',
    ]);
    expect(presentHostedMarkers(values, ['aws'])).toEqual(['AWS_REGION']);
  });

  it('treats a reader that throws for an unset name as absent', (): void => {
    const throwing = (name: string): string | undefined => {
      if (name === 'FLY_APP_NAME') return 'day0';
      throw new Error(`missing ${name}`);
    };
    expect(presentHostedMarkers(throwing)).toEqual(['FLY_APP_NAME']);
  });
});
