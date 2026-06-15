/**
 * The MCP tool registry. `buildMcpServer` loops over this in order and registers
 * each enabled tool. Order is preserved from the original inline registrations;
 * env-gated factories (execute_bash, browser) return null when disabled and are
 * skipped without disturbing the order of the rest.
 */
import type { McpToolFactory } from './types.js';
import {
  spawnSubtaskTool,
  claimNextTaskTool,
  getTaskStatusTool,
  completeTaskTool,
  waitAllTasksTool,
  registerAgentTool,
  queryContextTool,
} from './core.js';
import { executeBashTool } from './exec.js';
import {
  askUserTool,
  askUserStatusTool,
  capabilitySearchTool,
  capabilityInstallTool,
  browserTool,
} from './autonomy.js';

export const TOOL_FACTORIES: readonly McpToolFactory[] = [
  spawnSubtaskTool,
  claimNextTaskTool,
  getTaskStatusTool,
  completeTaskTool,
  waitAllTasksTool,
  registerAgentTool,
  queryContextTool,
  executeBashTool, // env-gated: EXECUTE_BASH_ENABLED
  askUserTool,
  askUserStatusTool,
  capabilitySearchTool,
  capabilityInstallTool,
  browserTool, // env-gated: MEMEX_BROWSER_ENABLED
];

export type { McpToolDef, McpToolFactory } from './types.js';
