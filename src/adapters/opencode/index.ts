import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jsonMcpRegistrar } from '../json-mcp.js';
import type { Adapter, AdapterSurface, HostEnv, McpRegistrar, TranslateResult } from '../types.js';
import { nothingToTranslate, unobservedSurface } from '../unobserved.js';

/**
 * opencode. Its config is `opencode.json` - `~/.config/opencode/opencode.json` for the user
 * (`$OPENCODE_CONFIG` names another file, `$XDG_CONFIG_HOME` moves the directory), or
 * `opencode.json` at the project root - and MCP servers sit under `mcp` in its own shape:
 * `{ "type": "local", "command": [bin, ...args], "enabled": true }`. It reads AGENTS.md, so the
 * `agents` mirror target already serves it and it declares no instruction file of its own.
 */

export function opencodeUserConfig(env: HostEnv): string {
  const explicit = env.vars?.OPENCODE_CONFIG?.trim();
  if (explicit) return explicit;
  const xdg = env.vars?.XDG_CONFIG_HOME?.trim();
  return join(xdg ? xdg : join(env.home, '.config'), 'opencode', 'opencode.json');
}

export const opencodeMcp: McpRegistrar = jsonMcpRegistrar({
  description:
    'A "contextd" entry under mcp in opencode.json at the project root (project, pinned with -C) or ~/.config/opencode/opencode.json (user, serves the project opencode starts in).',
  scopes: {
    project: { file: (env) => join(env.projectRoot, 'opencode.json'), pinned: true },
    user: { file: opencodeUserConfig, pinned: false },
  },
  defaultScope: 'user',
  serversKey: 'mcp',
  render: (e) => ({ type: 'local', command: [e.command, ...e.args], enabled: true }),
  parse: (raw) => {
    if (!Array.isArray(raw.command)) return null;
    const [command, ...args] = raw.command.filter((a): a is string => typeof a === 'string');
    return command ? { command, args } : null;
  },
});

export class OpencodeAdapter implements Adapter {
  readonly name = 'opencode';
  readonly agent = 'opencode';
  readonly surfaces: readonly AdapterSurface[] = [unobservedSurface('opencode', 'in its own session storage')];
  readonly mcp = opencodeMcp;

  detect(env: HostEnv): boolean {
    return existsSync(join(env.projectRoot, 'opencode.json')) || existsSync(dirname(opencodeUserConfig(env)));
  }

  translate(): TranslateResult {
    return nothingToTranslate();
  }
}

export const opencodeAdapter = new OpencodeAdapter();
