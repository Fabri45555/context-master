import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { jsonMcpRegistrar } from '../json-mcp.js';
import type { Adapter, AdapterSurface, HostEnv, InstructionFile, McpRegistrar, TranslateResult } from '../types.js';
import { nothingToTranslate, parseCommandArgs, unobservedSurface } from '../unobserved.js';

/**
 * Cursor. MCP servers live under `mcpServers` in `.cursor/mcp.json` (project) or
 * `~/.cursor/mcp.json` (user); standing instructions are rule files in `.cursor/rules/*.mdc`,
 * loaded on every request only when their frontmatter says `alwaysApply: true`.
 */
export const cursorMcp: McpRegistrar = jsonMcpRegistrar({
  description:
    'A "contextd" entry under mcpServers in .cursor/mcp.json (project, pinned with -C) or ~/.cursor/mcp.json (user, serves the project Cursor starts it in).',
  scopes: {
    project: { file: (env) => join(env.projectRoot, '.cursor', 'mcp.json'), pinned: true },
    user: { file: (env) => join(env.home, '.cursor', 'mcp.json'), pinned: false },
  },
  defaultScope: 'project',
  serversKey: 'mcpServers',
  render: (e) => ({ command: e.command, args: e.args }),
  parse: parseCommandArgs,
});

export class CursorAdapter implements Adapter {
  readonly name = 'cursor';
  readonly agent = 'Cursor';
  readonly surfaces: readonly AdapterSurface[] = [unobservedSurface('Cursor', 'in its application database')];
  readonly mcp = cursorMcp;
  readonly instructionFiles: readonly InstructionFile[] = [
    {
      target: 'cursor',
      path: '.cursor/rules/contextd.mdc',
      description: 'A Cursor rule file, created with `alwaysApply: true` so every request loads it',
      format: 'mdc',
      budget: 3000,
    },
  ];

  detect(env: HostEnv): boolean {
    return existsSync(join(env.projectRoot, '.cursor')) || existsSync(join(env.home, '.cursor'));
  }

  translate(): TranslateResult {
    return nothingToTranslate();
  }
}

export const cursorAdapter = new CursorAdapter();
