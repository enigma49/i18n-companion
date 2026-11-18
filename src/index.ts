/**
 * Programmatic API. The CLI and the MCP server are thin layers over these functions.
 * Runtime translation of dynamic content lives in `i18n-companion/runtime`.
 */
export {VERSION} from './version.js';

export {loadConfig, parseConfig, renderConfigTs, configSchema} from './core/config.js';
export type {CompanionConfig, CompanionConfigInput} from './core/config.js';
export {detectProject} from './core/detect.js';
export type {Detection, Support} from './core/detect.js';
export {inspectProject} from './core/inspect.js';
export type {Inspection} from './core/inspect.js';
export {loadProject, readState, saveRegistry} from './core/project.js';
export type {Project, ProjectState} from './core/project.js';

export {createPlan, nextBatch, importResponse, checkPlan, applyPlan, readPlan, MAX_ATTEMPTS} from './core/plan.js';
export type {PlanFile, PlanOptions, BatchPayload, BatchResponse, ImportResult, PlanCheck, ApplyResult, WorkItem} from './core/plan.js';
export {summarizePlan} from './core/summary.js';
export type {PlanSummary} from './core/summary.js';
export {checkProject, changedFiles} from './core/check.js';
export type {CheckResult, CheckOptions, FailReason, LocaleSummary} from './core/check.js';
export {messageStatus, reviewTranslations} from './core/review.js';
export type {StatusRow, ReviewOptions} from './core/review.js';
export type {Registry, MessageRecord, TranslationRecord, TranslationStatus, Provenance} from './core/registry.js';

export {validateTranslation, validateMessage, parseIcu} from './core/icu.js';
export {DIAGNOSTIC_CODES, CompanionError} from './core/diagnostics.js';
export type {Diagnostic, DiagnosticCode, Severity} from './core/diagnostics.js';

export {planAssistantInstall, planUninstall, applyChanges} from './assistant/install.js';
export type {AssistantId} from './assistant/templates.js';

export {createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL} from './providers/anthropic.js';
export {translatePlanWithProvider} from './providers/run.js';
export type {TranslationProvider, ContentProvider} from './providers/types.js';

export {createServer as createMcpServer} from './mcp/server.js';
