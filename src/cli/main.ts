import {CompanionError} from '../core/diagnostics.js';
import {serveStdio} from '../mcp/server.js';
import {VERSION} from '../version.js';
import {formatDiagnostic, parseCli, usageError, type Context} from './io.js';
import {cmdInit, cmdSetup, cmdUninstall} from './setup.js';
import {
  cmdApply,
  cmdAudit,
  cmdBatch,
  cmdCheck,
  cmdDoctor,
  cmdImport,
  cmdPlan,
  cmdReview,
  cmdRunbook,
  cmdRunChecks,
  cmdStatus,
  cmdSync,
  cmdTranslate,
  cmdWatch,
} from './workflow.js';

export const HELP = `i18n-companion ${VERSION}
Localize a Next.js (App Router + next-intl) app with your coding assistant, and keep it correct.

Usage: i18n-companion <command> [options]

Getting started
  init         Set up config, the assistant skill/rule and the MCP entry
               --assistant claude|codex|cursor|runbook  --source <locale>  --targets <a,b>
               --mode assistant|provider  --no-rule  --no-mcp  --dry-run  --yes
  doctor       Is this project supported, and is the config valid?
  setup        Print the next-intl setup recipe (never edits next.config)
  audit        Read-only scan for hardcoded text; works without a config

Localizing
  plan         Find hardcoded text and translation work   --paths <p>  --no-code  --locales <a,b>
  batch        Next batch of messages to translate         --plan <id|latest>  --size <n>
  import       Submit translations for a batch            --plan <id|latest>  --input <file|->
  check        Check a plan (--plan) or the whole project  --changed [--base <ref>]  --files <f>
  apply        Write a checked plan in one transaction     --plan <id|latest>
  translate    Provider mode: plan, translate and apply    --plan  --paths  --code  --no-apply
  run-checks   Run the package.json scripts named in the config

Keeping it correct
  status       Translation state per message              [id|namespace]  --locales <a,b>
  review       Mark translations as checked by a person   <id|namespace>  --accept-proposal  --reject-proposal
  sync         Bring the registry in line with the catalogs
  watch        Re-check (or, in provider mode, translate) on every change  --debounce <ms>

Other
  runbook      The step-by-step procedure for assistants
  mcp          Run the MCP server over stdio
  uninstall    Remove what init installed (preview unless --yes)

Global: --json  --cwd <dir>  --help  --version
Exit codes: 0 ok, 1 validation failed, 2 usage or configuration error.
`;

type Command = (ctx: Context) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: cmdInit,
  doctor: cmdDoctor,
  setup: cmdSetup,
  audit: cmdAudit,
  plan: cmdPlan,
  batch: cmdBatch,
  import: cmdImport,
  check: cmdCheck,
  apply: cmdApply,
  status: cmdStatus,
  review: cmdReview,
  sync: cmdSync,
  translate: cmdTranslate,
  'run-checks': cmdRunChecks,
  watch: cmdWatch,
  runbook: cmdRunbook,
  uninstall: cmdUninstall,
};

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIO: CliIO = {out: (t) => process.stdout.write(t + '\n'), err: (t) => process.stderr.write(t + '\n')};

/**
 * Runs one CLI invocation and returns the exit code, or null when the command keeps running
 * (the MCP server), in which case the caller must not exit.
 */
export async function main(argv: string[], io: CliIO = defaultIO): Promise<number | null> {
  let json = argv.includes('--json');
  try {
    const ctx = parseCli(argv, io);
    json = ctx.json;
    if (ctx.flags.version) {
      io.out(VERSION);
      return 0;
    }
    if (!ctx.command || ctx.flags.help || ctx.command === 'help') {
      io.out(HELP);
      return ctx.command || ctx.flags.help ? 0 : 2;
    }
    if (ctx.command === 'mcp') {
      await serveStdio(ctx.root);
      return null;
    }
    const command = COMMANDS[ctx.command];
    if (!command) throw usageError(`Unknown command "${ctx.command}".`);
    return await command(ctx);
  } catch (error) {
    if (error instanceof CompanionError) {
      if (json) io.out(JSON.stringify({ok: false, error: error.diagnostic}, null, 2));
      else io.err(formatDiagnostic(error.diagnostic).trimStart());
      return error.exitCode;
    }
    io.err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 2;
  }
}
