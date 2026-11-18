import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {describe, expect, it} from 'vitest';
import {createServer} from '../src/mcp/server.js';
import {VERSION} from '../src/version.js';
import {loadProject, readState, saveRegistry} from '../src/core/project.js';
import {useFixture} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('package', () => {
  it('VERSION matches package.json', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {version: string};
    expect(VERSION).toBe(pkg.version);
  });
});

describe('MCP server', () => {
  async function connect(root: string) {
    const server = createServer(root);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: 'test', version: '0'});
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  const parse = (r: unknown) => JSON.parse((r as {content: {text: string}[]}).content[0]!.text);

  it('lists the six tools', async () => {
    const client = await connect(await useFixture('next-intl-existing'));
    const {tools} = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['i18n_apply', 'i18n_get_batch', 'i18n_inspect', 'i18n_plan', 'i18n_submit_batch', 'i18n_validate']);
  });

  it('runs inspect and plan against the project', async () => {
    const root = await useFixture('next-intl-existing');
    const project = await loadProject(root);
    await saveRegistry(project, (await readState(project)).registry);
    const client = await connect(root);
    const inspect = parse(await client.callTool({name: 'i18n_inspect', arguments: {}}));
    expect(inspect.detection.support).toBe('full');
    expect(inspect.config.valid).toBe(true);
    const plan = parse(await client.callTool({name: 'i18n_plan', arguments: {}}));
    expect(plan.filesToChange.length).toBe(2);
    const batch = parse(await client.callTool({name: 'i18n_get_batch', arguments: {plan: plan.planId, size: 5}}));
    // One locale per batch: French only has the four new messages to translate.
    expect(batch.targetLocale).toBe('fr');
    expect(batch.items.length).toBe(4);
  });

  it('refuses paths outside the project', async () => {
    const client = await connect(await useFixture('next-intl-existing'));
    const result = await client.callTool({name: 'i18n_plan', arguments: {paths: ['../elsewhere']}});
    expect(result.isError).toBe(true);
  });
});
