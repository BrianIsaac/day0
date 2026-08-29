/** Pure system vocabulary shared with Convex isolate entrypoints. */
export const SYSTEM_CLASSES = [
  'kanban',
  'chat',
  'docs',
  'spreadsheet',
  'crm',
  'analytics',
  'social',
  'other',
] as const;

export type SystemClass = (typeof SYSTEM_CLASSES)[number];
