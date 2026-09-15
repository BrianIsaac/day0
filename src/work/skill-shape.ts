import { SYSTEM_CLASSES, type SystemClass } from '../agent/system-classes';
import { surfaceSlug } from '../surfaces/slug';
import type { SurfaceMode } from '../surfaces/types';
import type { SkillShape, WorkCandidate } from './types';

/**
 * The shape of the skill a candidate needs: one operation on one surface
 * class. A skill is proposed, named, matched and authored by this shape, never
 * by the work item that first needed it, so one registered skill serves every
 * later item of the same shape with that item's own values.
 *
 * Kept free of model clients and Convex imports: the evaluator, the executor's
 * skill pick and the propose mutation all read it.
 */

/** The surface fields the shape reads; a structural subset of every surface row. */
export interface ShapeSurface {
  slug: string;
  displayName: string;
  class: string;
}

interface OperationSpec {
  operation: string;
  /** The human phrase used in verdict reasons, rationales and descriptions. */
  label: string;
}

/**
 * The documented write operation for each surface class. One per class today,
 * because each class has one runbook; a second documented operation on a class
 * is added here, and the skill name `<class>-<operation>` keeps the two apart.
 */
export const OPERATION_BY_CLASS: Readonly<Record<SystemClass, OperationSpec>> = {
  kanban: { operation: 'comment-and-close', label: 'ticket comment-and-close' },
  analytics: { operation: 'refresh-value', label: 'value refresh' },
  chat: { operation: 'thread-reply', label: 'threaded reply' },
  spreadsheet: { operation: 'append-row', label: 'row append' },
  social: { operation: 'reply', label: 'public reply' },
  crm: { operation: 'update-record', label: 'record update' },
  docs: { operation: 'answer-from-docs', label: 'documented answer' },
  other: { operation: 'action', label: 'documented action' },
};

/**
 * The class of a source system that has no surface record: the mock source
 * systems, and a real source named by a provider word before its surface row
 * is listed.
 */
const SOURCE_CLASS_BY_NAME: Readonly<Record<string, SystemClass>> = {
  ticket: 'kanban',
  tickets: 'kanban',
  linear: 'kanban',
  jira: 'kanban',
  kanban: 'kanban',
  slack: 'chat',
  chat: 'chat',
  spreadsheet: 'spreadsheet',
  sheet: 'spreadsheet',
  social: 'social',
  twitter: 'social',
  docs: 'docs',
};

function isSystemClass(value: string): value is SystemClass {
  return (SYSTEM_CLASSES as readonly string[]).includes(value);
}

/**
 * Normalise prose for whole-phrase surface matching.
 *
 * Args:
 *   value: Candidate prose or a surface label.
 *
 * Returns:
 *   Lowercase alphanumeric words separated by one space.
 */
export function comparableSurfaceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Check whether candidate prose names a surface as a whole phrase.
 *
 * Args:
 *   text: Candidate title and summary.
 *   surface: Declared surface metadata.
 *
 * Returns:
 *   True when the display name or slug is present as a complete phrase.
 */
export function candidateNamesSurface(
  text: string,
  surface: Pick<ShapeSurface, 'displayName' | 'slug'>,
): boolean {
  const haystack = ` ${comparableSurfaceText(text)} `;
  const names = [surface.displayName, surface.slug].map(comparableSurfaceText).filter(Boolean);
  return names.some((name: string): boolean => haystack.includes(` ${name} `));
}

function candidateText(candidate: Pick<WorkCandidate, 'title' | 'contentSummary'>): string {
  return `${candidate.title}\n${candidate.contentSummary}`;
}

/**
 * The listed surfaces the candidate names as whole phrases, in list order.
 *
 * Args:
 *   candidate: Work candidate title and summary.
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   Every surface whose display name or slug appears in the candidate text.
 */
export function namedSurfacesFor<T extends ShapeSurface>(
  candidate: Pick<WorkCandidate, 'title' | 'contentSummary'>,
  surfaces: readonly T[],
): T[] {
  const text = candidateText(candidate);
  return surfaces.filter((surface: T): boolean => candidateNamesSurface(text, surface));
}

/**
 * The surface a skill for this candidate acts on.
 *
 * The one other system the work names is the target ("Refresh the Looker
 * pipeline tile" from a Linear ticket acts on the tile). Otherwise the work is
 * done on the surface it came from. Naming several other systems settles
 * nothing, so the source stands.
 *
 * Args:
 *   candidate: Work candidate.
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   The target surface, or undefined when the source is not listed either.
 */
export function targetSurfaceFor<T extends ShapeSurface>(
  candidate: Pick<WorkCandidate, 'title' | 'contentSummary' | 'sourceSystem'>,
  surfaces: readonly T[],
): T | undefined {
  const sourceSlug = surfaceSlug(candidate.sourceSystem);
  const source = surfaces.find((surface: T): boolean => surface.slug === sourceSlug);
  const others = namedSurfacesFor(candidate, surfaces).filter(
    (surface: T): boolean => surface.slug !== sourceSlug,
  );
  const distinct = [...new Set(others.map((surface: T): string => surface.slug))];
  if (distinct.length === 1) return others[0];
  return source;
}

/**
 * The shape of the skill this candidate needs.
 *
 * Mock candidates come from seeded tables, so their class is read from the
 * source system name. Real candidates take the class of their target surface.
 *
 * Args:
 *   candidate: Work candidate.
 *   surfaces: The agent's surfaces; ignored in mock mode.
 *   mode: Deployment surface mode.
 *
 * Returns:
 *   The surface class and its documented operation.
 */
export function skillShapeFor(
  candidate: Pick<WorkCandidate, 'title' | 'contentSummary' | 'sourceSystem'>,
  surfaces: readonly ShapeSurface[],
  mode: SurfaceMode,
): SkillShape {
  const target = mode === 'real' ? targetSurfaceFor(candidate, surfaces) : undefined;
  const surfaceClass: SystemClass =
    target && isSystemClass(target.class)
      ? target.class
      : (SOURCE_CLASS_BY_NAME[candidate.sourceSystem.toLowerCase()] ?? 'other');
  return { surfaceClass, operation: OPERATION_BY_CLASS[surfaceClass].operation };
}

/**
 * The registry name of a shape: `<class>-<operation>`.
 *
 * Args:
 *   shape: Surface class and operation.
 *
 * Returns:
 *   The skill name.
 */
export function skillNameFor(shape: SkillShape): string {
  return `${shape.surfaceClass}-${shape.operation}`;
}

/**
 * The human phrase for a shape's operation, for reasons and rationales.
 *
 * Args:
 *   shape: Surface class and operation.
 *
 * Returns:
 *   The documented label, or the operation itself for a shape this table
 *   does not know.
 */
export function skillOperationLabel(shape: SkillShape): string {
  const spec = isSystemClass(shape.surfaceClass)
    ? OPERATION_BY_CLASS[shape.surfaceClass]
    : undefined;
  return spec && spec.operation === shape.operation ? spec.label : shape.operation;
}

/**
 * Whether two shapes are the same skill.
 *
 * Args:
 *   left: One shape.
 *   right: The other.
 *
 * Returns:
 *   True when class and operation both agree.
 */
export function sameSkillShape(left: SkillShape, right: SkillShape): boolean {
  return left.surfaceClass === right.surfaceClass && left.operation === right.operation;
}
