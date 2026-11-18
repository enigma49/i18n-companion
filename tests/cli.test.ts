import {existsSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {main} from '../src/cli/main.js';
import {detectProject} from '../src/core/detect.js';
import {VERSION} from '../src/version.js';
import {snapshot, useFixture} from './helpers.js';

async function run(...argv: string[]): Promise<{code: number | null; out: string; err: string}> {
  let out = '';
  let err = '';
  const code = await main(argv, {out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n')});
  return {code, out, err};
}

describe('detect', () => {
  it('tells supported, setup-needed and unsupported projects apart', async () => {
    expect((await detectProject(await useFixture('next-intl-existing'))).support).toBe('full');
    expect((await detectProject(await useFixture('next-no-i18n'))).support).toBe('setup-needed');
    const i18next = await detectProject(await useFixture('unsupported-i18next'));
    expect(i18next.support).toBe('audit-only');
    expect(i18next.i18n.library).toBe('i18next');
  });
});

describe('CLI basics', () => {
  it('prints the version and rejects unknown commands with exit code 2', async () => {
    expect((await run('--version')).out.trim()).toBe(VERSION);
    expect((await run('frobnicate')).code).toBe(2);
    expect((await run('plan', '--no-such-flag')).code).toBe(2);
  });

  it('reports a missing config as a configuration error', async () => {
    const root = await useFixture('next-no-i18n');
    const result = await run('plan', '--json', '--cwd', root);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out).error.code).toBe('I18N_CONFIG_MISSING');
  });
});

describe('unsupported projects', () => {
  it('audits an i18next project and changes nothing, and init refuses', async () => {
    const root = await useFixture('unsupported-i18next');
    const before = await snapshot(root);
    const audit = await run('audit', '--json', '--cwd', root);
    expect(audit.code).not.toBe(2);
    const init = await run('init', '--yes', '--json', '--targets', 'fr', '--cwd', root);
    expect(init.code).toBe(2);
    expect(await snapshot(root)).toEqual(before);
  });

  it('setup prints a recipe and never edits the project', async () => {
    const root = await useFixture('next-no-i18n');
    const before = await snapshot(root);
    const result = await run('setup', '--json', '--cwd', root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).steps.length).toBeGreaterThan(3);
    expect(await snapshot(root)).toEqual(before);
  });
});

describe('install and uninstall', () => {
  const OTHER_SERVER = {mcpServers: {other: {command: 'other-tool'}}};

  it('round-trips for Claude Code, leaving the person\'s own content alone', async () => {
    const root = await useFixture('next-intl-existing');
    const claudeMd = '# My project\n\nOur own instructions.\n';
    const mcpJson = JSON.stringify(OTHER_SERVER, null, 2) + '\n';
    await writeFile(path.join(root, 'CLAUDE.md'), claudeMd);
    await writeFile(path.join(root, '.mcp.json'), mcpJson);
    const config = await readFile(path.join(root, 'i18n-companion.config.ts'), 'utf8');

    const init = await run('init', '--yes', '--json', '--assistant', 'claude', '--targets', 'fr,de', '--cwd', root);
    expect(init.code).toBe(0);
    expect(JSON.parse(init.out).keptExistingConfig).toBe('i18n-companion.config.ts');
    expect(existsSync(path.join(root, '.claude/skills/i18n-companion/SKILL.md'))).toBe(true);
    expect(await readFile(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('i18n-companion');
    expect(JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers['i18n-companion']).toBeDefined();
    expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toContain('.i18n-companion/work/');
    expect(existsSync(path.join(root, '.i18n-companion/registry.json'))).toBe(true);

    // A second init changes nothing it already installed.
    const again = await run('init', '--yes', '--json', '--assistant', 'claude', '--targets', 'fr,de', '--cwd', root);
    expect(JSON.parse(again.out).changes.map((c: {path: string}) => c.path)).toEqual(['.claude/skills/i18n-companion/SKILL.md']);

    const preview = await run('uninstall', '--json', '--cwd', root);
    expect(JSON.parse(preview.out).applied).toBe(false);
    expect(existsSync(path.join(root, '.claude/skills/i18n-companion/SKILL.md'))).toBe(true);

    expect((await run('uninstall', '--yes', '--json', '--cwd', root)).code).toBe(0);
    expect(existsSync(path.join(root, '.claude/skills/i18n-companion/SKILL.md'))).toBe(false);
    expect(existsSync(path.join(root, '.i18n-companion/install.json'))).toBe(false);
    expect(await readFile(path.join(root, 'CLAUDE.md'), 'utf8')).toBe(claudeMd);
    expect(await readFile(path.join(root, '.mcp.json'), 'utf8')).toBe(mcpJson);
    // Config, catalogs and registry are never touched by uninstall.
    expect(await readFile(path.join(root, 'i18n-companion.config.ts'), 'utf8')).toBe(config);
    expect(existsSync(path.join(root, '.i18n-companion/registry.json'))).toBe(true);
  });

  it('removes the Codex TOML entry and keeps other servers', async () => {
    const root = await useFixture('next-intl-existing');
    const toml = '[mcp_servers.other]\ncommand = "other-tool"\n';
    await writeFile(path.join(root, 'AGENTS.md'), '# Agents\n');
    const {mkdir} = await import('node:fs/promises');
    await mkdir(path.join(root, '.codex'));
    await writeFile(path.join(root, '.codex/config.toml'), toml);

    expect((await run('init', '--yes', '--json', '--assistant', 'codex', '--targets', 'fr,de', '--cwd', root)).code).toBe(0);
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.i18n-companion]');

    expect((await run('uninstall', '--yes', '--json', '--cwd', root)).code).toBe(0);
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).toBe(toml);
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# Agents\n');
  });
});
