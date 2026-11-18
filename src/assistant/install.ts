import {existsSync} from 'node:fs';
import {readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {INSTALL_FILE} from '../core/config.js';
import {writeFileAtomic} from '../core/fsutil.js';
import {VERSION} from '../version.js';
import {ASSISTANTS, ruleBlock, RULE_END, RULE_START, skillMarkdown, type AssistantId} from './templates.js';

export interface InstallManifest {
  version: string;
  assistant: AssistantId;
  /** Files the installer created and owns outright. */
  owned: string[];
  /** Files where the installer added only a marked block. */
  blocks: string[];
  /** Files where the installer added only an MCP server entry. */
  mcpEntries: string[];
}

export interface FileChange {
  path: string;
  action: 'create' | 'update' | 'delete';
  description: string;
  content?: string;
}

const MCP_COMMAND = {command: 'npx', args: ['i18n-companion', 'mcp']};

function upsertRule(existing: string | undefined): string {
  const block = ruleBlock();
  if (!existing) return block + '\n';
  const start = existing.indexOf(RULE_START);
  const end = existing.indexOf(RULE_END);
  if (start !== -1 && end !== -1) return existing.slice(0, start) + block + existing.slice(end + RULE_END.length);
  return existing.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

function removeRule(existing: string): string {
  const start = existing.indexOf(RULE_START);
  const end = existing.indexOf(RULE_END);
  if (start === -1 || end === -1) return existing;
  return (existing.slice(0, start).replace(/\s*$/, '') + '\n' + existing.slice(end + RULE_END.length).replace(/^\s*/, '')).replace(/^\n$/, '');
}

const TOML_BLOCK = `[mcp_servers.i18n-companion]\ncommand = "npx"\nargs = ["i18n-companion", "mcp"]\n`;

function upsertMcp(existing: string | undefined, format: 'json-mcpServers' | 'toml'): string {
  if (format === 'toml') {
    const block = TOML_BLOCK;
    if (!existing) return block;
    if (existing.includes('[mcp_servers.i18n-companion]')) return existing;
    return existing.replace(/\s*$/, '') + '\n\n' + block;
  }
  const data = existing ? (JSON.parse(existing) as {mcpServers?: Record<string, unknown>}) : {};
  data.mcpServers = {...(data.mcpServers ?? {}), 'i18n-companion': MCP_COMMAND};
  return JSON.stringify(data, null, 2) + '\n';
}

function removeMcp(existing: string, format: 'json-mcpServers' | 'toml'): string {
  if (format === 'toml') {
    // Remove only the exact block we wrote; anything a person edited inside it stays.
    return existing.replace(TOML_BLOCK, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }
  const data = JSON.parse(existing) as {mcpServers?: Record<string, unknown>};
  if (data.mcpServers) delete data.mcpServers['i18n-companion'];
  return JSON.stringify(data, null, 2) + '\n';
}

async function read(root: string, rel: string): Promise<string | undefined> {
  const file = path.join(root, rel);
  return existsSync(file) ? readFile(file, 'utf8') : undefined;
}

/** Works out the assistant files to write. Nothing is written here. */
export async function planAssistantInstall(root: string, assistant: AssistantId, options: {rule: boolean; mcp: boolean}): Promise<{changes: FileChange[]; manifest: InstallManifest}> {
  const manifest: InstallManifest = {version: VERSION, assistant, owned: [], blocks: [], mcpEntries: []};
  const changes: FileChange[] = [];
  if (assistant === 'runbook') return {changes, manifest};
  const a = ASSISTANTS[assistant];
  const skillExists = existsSync(path.join(root, a.skillPath));
  changes.push({path: a.skillPath, action: skillExists ? 'update' : 'create', description: `skill v${VERSION}, owned by i18n-companion`, content: skillMarkdown()});
  manifest.owned.push(a.skillPath);
  if (options.rule) {
    const existing = await read(root, a.rulePath);
    const next = upsertRule(existing);
    if (next !== existing) changes.push({path: a.rulePath, action: existing ? 'update' : 'create', description: existing ? 'adds one marked block, nothing else touched' : 'new file with one marked block', content: next});
    manifest.blocks.push(a.rulePath);
  }
  if (options.mcp) {
    const existing = await read(root, a.mcp.path);
    const next = upsertMcp(existing, a.mcp.format);
    if (next !== existing) changes.push({path: a.mcp.path, action: existing ? 'update' : 'create', description: 'adds the i18n-companion MCP server entry only', content: next});
    manifest.mcpEntries.push(a.mcp.path);
  }
  return {changes, manifest};
}

export async function readManifest(root: string): Promise<InstallManifest | undefined> {
  const text = await read(root, INSTALL_FILE);
  return text ? (JSON.parse(text) as InstallManifest) : undefined;
}

export async function writeManifest(root: string, manifest: InstallManifest): Promise<void> {
  await writeFileAtomic(path.join(root, INSTALL_FILE), JSON.stringify(manifest, null, 2) + '\n');
}

/** What uninstall would remove: only files and blocks the installer recorded as its own. */
export async function planUninstall(root: string): Promise<FileChange[]> {
  const manifest = await readManifest(root);
  if (!manifest) return [];
  const changes: FileChange[] = [];
  for (const rel of manifest.owned) if (existsSync(path.join(root, rel))) changes.push({path: rel, action: 'delete', description: 'installed by i18n-companion'});
  for (const rel of manifest.blocks) {
    const text = await read(root, rel);
    if (!text || !text.includes(RULE_START)) continue;
    const next = removeRule(text);
    changes.push(next.trim() === '' ? {path: rel, action: 'delete', description: 'only contained the i18n-companion block'} : {path: rel, action: 'update', description: 'removes the i18n-companion block', content: next});
  }
  const mcpFormat = manifest.assistant === 'codex' ? 'toml' : 'json-mcpServers';
  for (const rel of manifest.mcpEntries) {
    const text = await read(root, rel);
    if (!text || !text.includes('i18n-companion')) continue;
    changes.push({path: rel, action: 'update', description: 'removes the i18n-companion MCP entry', content: removeMcp(text, mcpFormat)});
  }
  changes.push({path: INSTALL_FILE, action: 'delete', description: 'install record'});
  return changes;
}

export async function applyChanges(root: string, changes: FileChange[]): Promise<void> {
  for (const c of changes) {
    const file = path.join(root, c.path);
    if (c.action === 'delete') await rm(file, {force: true});
    else await writeFileAtomic(file, c.content ?? '');
  }
}
