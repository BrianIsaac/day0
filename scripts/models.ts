/**
 * The models the bundled model service can serve, as the real-mode setup lists
 * them before anything starts: what the service's volume already holds, then
 * what this project has run the whole loop on.
 *
 * The curated list is the one place a tested model is recorded. Adding one is
 * one line: the id `ollama pull` takes, what the pull downloads, and where it
 * was tested. Everything else here is pure: it reads what `ollama list` or the
 * volume's manifests printed and builds the numbered menu, so a test can drive
 * the whole picker without a daemon.
 */

export interface CuratedModel {
  /** The model id, as `ollama pull` takes it. */
  id: string;
  /** What the pull downloads, as the menu prints it. */
  downloadLabel: string;
  /** Where this project ran the whole loop on it. */
  tested: string;
}

/** The models this project has run the whole loop on, most recommended first. */
export const CURATED_MODELS: readonly CuratedModel[] = [
  {
    id: 'qwen3:8b',
    downloadLabel: 'about 5.2 GB',
    tested: 'the semi-final local bed, 2 September 2026',
  },
];

export interface PresentModel {
  id: string;
  /** The size as `ollama list` prints it, or the manifest's layers summed. */
  sizeLabel: string;
}

/**
 * Bytes as `ollama list` prints them: decimal units, one decimal place for GB.
 *
 * Args:
 *   bytes: A size.
 *
 * Returns:
 *   The label.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

/**
 * The models `ollama list` printed.
 *
 * Args:
 *   stdout: The listing, a header line then one model per line, columns
 *     separated by runs of spaces.
 *
 * Returns:
 *   Each model with its size column, in the order printed.
 */
export function parseOllamaList(stdout: string): PresentModel[] {
  const models: PresentModel[] = [];
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 3 || columns[0] === 'NAME') continue;
    models.push({ id: columns[0], sizeLabel: columns[2] });
  }
  return models;
}

/**
 * The model id a manifest path names.
 *
 * Ollama keeps one manifest per model under
 * `manifests/<registry>/<namespace>/<name>/<tag>`; its own registry and the
 * `library` namespace are the parts `ollama list` leaves out.
 *
 * Args:
 *   path: The path relative to the manifests directory.
 *
 * Returns:
 *   The id, or undefined for a path that is not a manifest's.
 */
export function modelIdFromManifestPath(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return undefined;
  const [registry, namespace, ...rest] = parts;
  const tag = rest.pop();
  const name = rest.join('/');
  if (!tag || !name) return undefined;
  const prefix =
    registry === 'registry.ollama.ai'
      ? namespace === 'library'
        ? ''
        : `${namespace}/`
      : `${registry}/${namespace}/`;
  return `${prefix}${name}:${tag}`;
}

/** Prints every manifest in a mounted model volume: the path, a tab, the JSON on one line. */
const MANIFEST_SCRIPT =
  'cd /ollama/models/manifests 2>/dev/null || exit 0; ' +
  'find . -type f | sort | while read -r f; do ' +
  'printf "%s\\t" "${f#./}"; tr -d "\\n" < "$f"; printf "\\n"; done';

/**
 * The `docker` arguments that list a model volume's manifests without the
 * service, through the pinned node image with the volume mounted read-only.
 *
 * Args:
 *   volume: The model volume.
 *   image: The pinned node image.
 *
 * Returns:
 *   Arguments to pass to `docker`.
 */
export function manifestListingCommand(volume: string, image: string): string[] {
  return ['run', '--rm', '-v', `${volume}:/ollama:ro`, image, 'sh', '-c', MANIFEST_SCRIPT];
}

/**
 * The models a manifest listing names, sized by their layers.
 *
 * Args:
 *   stdout: What `manifestListingCommand` printed.
 *
 * Returns:
 *   Each model with its layers' sizes summed, in the order printed.
 */
export function parseManifestListing(stdout: string): PresentModel[] {
  const models: PresentModel[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = modelIdFromManifestPath(line.slice(0, tab).trim());
    if (!id) continue;
    let bytes = 0;
    try {
      const manifest = JSON.parse(line.slice(tab + 1)) as { layers?: { size?: number }[] };
      bytes = (manifest.layers ?? []).reduce(
        (sum: number, layer): number => sum + (layer.size ?? 0),
        0,
      );
    } catch {
      continue;
    }
    models.push({ id, sizeLabel: formatBytes(bytes) });
  }
  return models;
}

export interface ModelMenuEntry {
  id: string;
  /** Whether the volume already holds it. */
  present: boolean;
  /** `present, 5.2 GB` or `will pull (about 5.2 GB)`. */
  mark: string;
  /** Where this project tested it, for a curated model. */
  tested?: string;
  /** Whether `.env.local` already names it for this route. */
  configured: boolean;
}

/**
 * The numbered menu: present models first (the tested ones ahead of the rest,
 * which are sorted by id), then the curated models still to pull, then a model
 * the file names that is neither.
 *
 * Args:
 *   present: What the volume holds.
 *   configured: The model `.env.local` already names for the local route.
 *
 * Returns:
 *   One entry per model id, in menu order.
 */
export function modelMenu(present: readonly PresentModel[], configured?: string): ModelMenuEntry[] {
  const curated = new Map(CURATED_MODELS.map((model): [string, CuratedModel] => [model.id, model]));
  const presentById = new Map(present.map((model): [string, PresentModel] => [model.id, model]));
  const entries: ModelMenuEntry[] = [];
  const ordered = [
    ...CURATED_MODELS.filter((model): boolean => presentById.has(model.id)).map(
      (model): PresentModel => presentById.get(model.id) as PresentModel,
    ),
    ...present
      .filter((model): boolean => !curated.has(model.id))
      .sort((a: PresentModel, b: PresentModel): number => a.id.localeCompare(b.id)),
  ];
  for (const model of ordered) {
    if (entries.some((entry): boolean => entry.id === model.id)) continue;
    entries.push({
      id: model.id,
      present: true,
      mark: `present, ${model.sizeLabel}`,
      tested: curated.get(model.id)?.tested,
      configured: model.id === configured,
    });
  }
  for (const model of CURATED_MODELS) {
    if (presentById.has(model.id)) continue;
    entries.push({
      id: model.id,
      present: false,
      mark: `will pull (${model.downloadLabel})`,
      tested: model.tested,
      configured: model.id === configured,
    });
  }
  if (configured && !entries.some((entry): boolean => entry.id === configured)) {
    entries.push({ id: configured, present: false, mark: 'will pull', configured: true });
  }
  return entries;
}

/**
 * The entry `--yes` takes: the one the file already names, else the first
 * present, else the first curated.
 *
 * Args:
 *   menu: The menu.
 *
 * Returns:
 *   The default entry, or undefined for an empty menu.
 */
export function defaultModel(menu: readonly ModelMenuEntry[]): ModelMenuEntry | undefined {
  return (
    menu.find((entry): boolean => entry.configured) ??
    menu.find((entry): boolean => entry.present) ??
    menu[0]
  );
}

/**
 * The menu as the terminal prints it.
 *
 * Args:
 *   menu: The menu.
 *
 * Returns:
 *   One numbered line per entry.
 */
export function modelMenuLines(menu: readonly ModelMenuEntry[]): string[] {
  const width = Math.max(0, ...menu.map((entry): number => entry.id.length));
  return menu.map((entry, index): string => {
    const notes = [
      entry.tested ? `tested: ${entry.tested}` : '',
      entry.configured ? 'in .env.local' : '',
    ].filter(Boolean);
    return `  ${index + 1}  ${entry.id.padEnd(width)}  ${entry.mark}${notes.length > 0 ? `  (${notes.join('; ')})` : ''}`;
  });
}

/**
 * The entry an answer to the picker names.
 *
 * Args:
 *   menu: The menu.
 *   answer: What was typed: a number, a model id, or nothing for the default.
 *   fallback: The default entry.
 *
 * Returns:
 *   The chosen entry, or undefined when the answer names none.
 */
export function pickModel(
  menu: readonly ModelMenuEntry[],
  answer: string,
  fallback: ModelMenuEntry | undefined,
): ModelMenuEntry | undefined {
  const text = answer.trim();
  if (text === '') return fallback;
  const index = Number.parseInt(text, 10);
  if (String(index) === text && index >= 1 && index <= menu.length) return menu[index - 1];
  return menu.find((entry): boolean => entry.id === text);
}
