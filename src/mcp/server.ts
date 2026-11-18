import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {checkProject} from '../core/check.js';
import {CompanionError} from '../core/diagnostics.js';
import {inspectProject} from '../core/inspect.js';
import {applyPlan, checkPlan, createPlan, importResponse, nextBatch, readPlan} from '../core/plan.js';
import {loadProject} from '../core/project.js';
import {summarizePlan} from '../core/summary.js';
import {VERSION} from '../version.js';

/**
 * The MCP server exposes the same core as the CLI, as typed tools. It works only inside the
 * project it was started in and never takes a shell command or a path outside it.
 */

type ToolResult = {content: {type: 'text'; text: string}[]; isError?: boolean};

function ok(value: unknown): ToolResult {
  return {content: [{type: 'text', text: JSON.stringify(value, null, 2)}]};
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof CompanionError) return {content: [{type: 'text', text: JSON.stringify({error: error.diagnostic}, null, 2)}], isError: true};
    return {content: [{type: 'text', text: JSON.stringify({error: {code: 'INTERNAL', message: String(error)}}, null, 2)}], isError: true};
  }
}

const planRef = z.string().regex(/^(latest|[\w-]+)$/, 'a plan id or "latest"').default('latest').describe('Plan id, or "latest".');
/** Paths stay inside the project: relative, no parent segments. */
const projectPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), 'must be a path inside the project');

export function createServer(root: string): McpServer {
  const server = new McpServer({name: 'i18n-companion', version: VERSION});

  server.registerTool(
    'i18n_inspect',
    {
      description: 'Read-only health report: framework, i18n library, support level, config, and translation state per locale. Call this first.',
      inputSchema: {},
    },
    () => run(() => inspectProject(root)),
  );

  server.registerTool(
    'i18n_plan',
    {
      description:
        'Find hardcoded UI text and translation work, and save a plan. Nothing is written to code or catalogs. Report every needsDecision item to the person.',
      inputSchema: {
        paths: z.array(projectPath).max(200).optional().describe('Files, folders or globs to work on. Omit for the whole project.'),
        code: z.boolean().default(true).describe('Rewrite hardcoded text in code. False only updates translations.'),
        locales: z.array(z.string()).optional().describe('Limit translation work to these target locales.'),
      },
    },
    ({paths, code, locales}) =>
      run(async () => {
        const project = await loadProject(root);
        return summarizePlan(await createPlan(project, {paths, code, locales}));
      }),
  );

  server.registerTool(
    'i18n_get_batch',
    {
      description:
        'Get the next batch of messages to translate, all for one target locale. Translate them and call i18n_submit_batch. An empty items list means translation is done.',
      inputSchema: {plan: planRef, size: z.number().int().min(1).max(100).default(25)},
    },
    ({plan, size}) =>
      run(async () => {
        const project = await loadProject(root);
        return nextBatch(project, await readPlan(project, plan), size);
      }),
  );

  server.registerTool(
    'i18n_submit_batch',
    {
      description:
        'Submit translations for a batch. Each one is validated (placeholders, tags, plural categories, glossary, source revision) and staged; nothing reaches a catalog until i18n_apply.',
      inputSchema: {
        plan: planRef,
        batchId: z.string(),
        translations: z
          .array(z.object({id: z.string(), locale: z.string(), sourceRevision: z.string(), text: z.string()}))
          .max(200),
      },
    },
    ({plan, batchId, translations}) =>
      run(async () => {
        const project = await loadProject(root);
        return importResponse(project, await readPlan(project, plan), {batchId, translations}, 'assistant');
      }),
  );

  server.registerTool(
    'i18n_validate',
    {
      description: 'With a plan: check it can be applied cleanly. Without: run the project check (catalogs valid, translations current, no hardcoded text).',
      inputSchema: {plan: z.string().regex(/^(latest|[\w-]+)$/).optional().describe('Plan id or "latest". Omit to check the whole project.')},
    },
    ({plan}) =>
      run(async () => {
        const project = await loadProject(root);
        return plan ? checkPlan(project, await readPlan(project, plan)) : checkProject(project);
      }),
  );

  server.registerTool(
    'i18n_apply',
    {
      description: 'Apply a validated plan: code, source catalog, target catalogs and the registry, in one transaction that restores everything if a write fails.',
      inputSchema: {plan: planRef},
    },
    ({plan}) =>
      run(async () => {
        const project = await loadProject(root);
        return applyPlan(project, await readPlan(project, plan));
      }),
  );

  return server;
}

/** Runs the server over stdio until the client disconnects. */
export async function serveStdio(root = process.cwd()): Promise<void> {
  const server = createServer(root);
  await server.connect(new StdioServerTransport());
}
