import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { jsonMcpRegistrar } from '../json-mcp.js';
import type { Adapter, AdapterSurface, HostEnv, InstructionFile, McpRegistrar, TranslateResult } from '../types.js';
import { nothingToTranslate, parseCommandArgs, unobservedSurface } from '../unobserved.js';

/**
 * Gemini CLI. MCP servers live under `mcpServers` in `.gemini/settings.json` (project) or
 * `~/.gemini/settings.json` (user), next to the rest of its settings; its standing instructions
 * are `GEMINI.md`.
 */
export const geminiMcp: McpRegistrar = jsonMcpRegistrar({
  description:
    'A "contextd" entry under mcpServers in .gemini/settings.json (project, pinned with -C) or ~/.gemini/settings.json (user, serves the project Gemini starts in).',
  scopes: {
    project: { file: (env) => join(env.projectRoot, '.gemini', 'settings.json'), pinned: true },
    user: { file: (env) => join(env.home, '.gemini', 'settings.json'), pinned: false },
  },
  defaultScope: 'project',
  serversKey: 'mcpServers',
  render: (e) => ({ command: e.command, args: e.args }),
  parse: parseCommandArgs,
});

export class GeminiAdapter implements Adapter {
  readonly name = 'gemini';
  readonly agent = 'Gemini CLI';
  readonly surfaces: readonly AdapterSurface[] = [unobservedSurface('Gemini CLI', 'in its own checkpoint store')];
  readonly mcp = geminiMcp;
  readonly instructionFiles: readonly InstructionFile[] = [
    {
      target: 'gemini',
      path: 'GEMINI.md',
      description: 'Project context Gemini CLI loads every session; usually committed',
      format: 'markdown',
      budget: 3000,
    },
  ];

  detect(env: HostEnv): boolean {
    return existsSync(join(env.projectRoot, '.gemini')) || existsSync(join(env.home, '.gemini'));
  }

  translate(): TranslateResult {
    return nothingToTranslate();
  }
}

export const geminiAdapter = new GeminiAdapter();
