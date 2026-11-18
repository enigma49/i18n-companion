import {existsSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {diag, type Diagnostic} from './diagnostics.js';

export type Support = 'full' | 'setup-needed' | 'audit-only' | 'none';

export interface Detection {
  root: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  framework: {name: 'next' | 'unknown'; version?: string; appDir?: string; router?: 'app' | 'pages'};
  i18n: {library: 'next-intl' | 'i18next' | 'lingui' | 'formatjs' | 'none'; version?: string};
  messagesDir?: string;
  localesFound: string[];
  usesExtracted: boolean;
  support: Support;
  diagnostics: Diagnostic[];
}

type PackageJson = {dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>};

export async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}

function dep(pkg: PackageJson | undefined, name: string): string | undefined {
  return pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name];
}

function detectPackageManager(root: string): Detection['packageManager'] {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

async function localeFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((tag) => {
      try {
        return Intl.getCanonicalLocales(tag).length === 1;
      } catch {
        return false;
      }
    })
    .sort();
}

async function containsUseExtracted(root: string, appDir: string | undefined): Promise<boolean> {
  if (!appDir) return false;
  const dir = path.join(root, appDir);
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < 2000) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.(t|j)sx?$/.test(e.name)) {
        seen++;
        if ((await readFile(full, 'utf8')).includes('useExtracted')) return true;
      }
    }
  }
  return false;
}

/** Read-only look at a project: what it is and how much of it this tool can support. */
export async function detectProject(root: string): Promise<Detection> {
  const pkg = await readPackageJson(root);
  const diagnostics: Diagnostic[] = [];
  const nextVersion = dep(pkg, 'next');
  const appDir = ['src/app', 'app'].find((d) => existsSync(path.join(root, d)));
  const pagesDir = ['src/pages', 'pages'].find((d) => existsSync(path.join(root, d)));
  const framework: Detection['framework'] = nextVersion
    ? {name: 'next', version: nextVersion, appDir: appDir ?? pagesDir, router: appDir ? 'app' : pagesDir ? 'pages' : undefined}
    : {name: 'unknown'};

  let library: Detection['i18n']['library'] = 'none';
  let libVersion: string | undefined;
  for (const [name, lib] of [
    ['next-intl', 'next-intl'],
    ['i18next', 'i18next'],
    ['react-i18next', 'i18next'],
    ['next-i18next', 'i18next'],
    ['@lingui/core', 'lingui'],
    ['react-intl', 'formatjs'],
  ] as const) {
    const v = dep(pkg, name);
    if (v) {
      library = lib;
      libVersion = v;
      break;
    }
  }

  const messagesDir = ['messages', 'src/messages', 'locales', 'src/locales'].find((d) => existsSync(path.join(root, d)));
  const localesFound = messagesDir ? await localeFiles(path.join(root, messagesDir)) : [];
  const usesExtracted = library === 'next-intl' && (await containsUseExtracted(root, appDir));

  let support: Support;
  if (framework.name !== 'next') {
    support = 'none';
    diagnostics.push(diag('I18N_NO_FRAMEWORK', 'error', 'This does not look like a Next.js project (no "next" dependency in package.json).'));
  } else if (framework.router !== 'app') {
    support = 'audit-only';
    diagnostics.push(diag('I18N_NO_FRAMEWORK', 'warning', 'Only the Next.js App Router is supported so far; this project uses the Pages Router.'));
  } else if (library === 'next-intl') {
    support = 'full';
  } else if (library === 'none') {
    support = 'setup-needed';
    diagnostics.push(
      diag('I18N_NO_LIBRARY', 'warning', 'next-intl is not installed yet.', {
        hint: 'Run `npx i18n-companion setup` for the bounded next-intl setup recipe, then `init`.',
      }),
    );
  } else {
    support = 'audit-only';
    diagnostics.push(
      diag('I18N_UNSUPPORTED_LIBRARY', 'error', `This project uses ${library}, which has no adapter yet. Nothing will be changed.`, {
        hint: library === 'i18next' ? 'For this setup today, i18next-cli covers extraction and sync.' : undefined,
      }),
    );
  }
  if (usesExtracted) {
    diagnostics.push(
      diag('I18N_UNSUPPORTED_REGION', 'warning', 'Some files use next-intl\'s useExtracted; those files are audited but never rewritten.'),
    );
  }
  return {
    root,
    packageManager: detectPackageManager(root),
    framework,
    i18n: {library, version: libVersion},
    messagesDir,
    localesFound,
    usesExtracted,
    support,
    diagnostics,
  };
}

export function defaultIncludes(appDir: string | undefined): string[] {
  const base = appDir?.startsWith('src/') ? 'src/' : '';
  return [`${base}app/**/*.{js,jsx,ts,tsx}`, `${base}components/**/*.{js,jsx,ts,tsx}`];
}
