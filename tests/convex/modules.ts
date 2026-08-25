export const convexModules = {
  '../../convex/_generated/api.ts': (): Promise<typeof import('../../convex/_generated/api')> =>
    import('../../convex/_generated/api'),
  '../../convex/agents.ts': (): Promise<typeof import('../../convex/agents')> =>
    import('../../convex/agents'),
  '../../convex/config.ts': (): Promise<typeof import('../../convex/config')> =>
    import('../../convex/config'),
  '../../convex/docSources.ts': (): Promise<typeof import('../../convex/docSources')> =>
    import('../../convex/docSources'),
  '../../convex/docSyncActions.ts': (): Promise<typeof import('../../convex/docSyncActions')> =>
    import('../../convex/docSyncActions'),
  '../../convex/mock.ts': (): Promise<typeof import('../../convex/mock')> =>
    import('../../convex/mock'),
  '../../convex/reset.ts': (): Promise<typeof import('../../convex/reset')> =>
    import('../../convex/reset'),
  '../../convex/surfaces.ts': (): Promise<typeof import('../../convex/surfaces')> =>
    import('../../convex/surfaces'),
};
