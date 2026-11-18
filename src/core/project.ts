import path from 'node:path';
import {loadConfig, REGISTRY_FILE, type CompanionConfig} from './config.js';
import {readCatalog, type Catalog, type CatalogTree} from './catalog.js';
import {readRegistry, serializeRegistry, syncRegistry, type Registry, type SyncChanges} from './registry.js';
import {writeFileAtomic} from './fsutil.js';

export interface Project {
  root: string;
  config: CompanionConfig;
  configFile: string;
}

export interface ProjectState {
  source: Catalog;
  targets: Record<string, Catalog>;
  registry: Registry;
  changes: SyncChanges;
}

export async function loadProject(root: string): Promise<Project> {
  const abs = path.resolve(root);
  const {config, file} = await loadConfig(abs);
  return {root: abs, config, configFile: file};
}

/** Reads catalogs and the registry and syncs them in memory. Nothing is written. */
export async function readState(project: Project): Promise<ProjectState> {
  const {root, config} = project;
  const source = await readCatalog(root, config.messagesDir, config.sourceLocale);
  const targets: Record<string, Catalog> = {};
  for (const locale of config.targetLocales) targets[locale] = await readCatalog(root, config.messagesDir, locale);
  const registry = await readRegistry(root, config.sourceLocale);
  const trees: Record<string, CatalogTree> = Object.fromEntries(Object.entries(targets).map(([l, c]) => [l, c.tree]));
  const changes = syncRegistry(registry, source.tree, trees);
  return {source, targets, registry, changes};
}

export async function saveRegistry(project: Project, registry: Registry): Promise<void> {
  await writeFileAtomic(path.join(project.root, REGISTRY_FILE), serializeRegistry(registry));
}

export function relative(project: Project, file: string): string {
  return path.relative(project.root, file).split(path.sep).join('/');
}
