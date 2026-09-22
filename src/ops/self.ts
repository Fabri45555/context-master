import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { HostEnv, Launch } from '../adapters/index.js';

/**
 * How this contextd is started, for anything that writes a command into an agent's config.
 *
 * Running from a checkout (`node <path>/dist/cli/index.js`) is the normal case before the package
 * is linked, and it is also the fragile one: a rebuild into another directory or a moved checkout
 * leaves every installed hook and MCP entry pointing at a file that no longer exists, and the
 * agent says nothing about it. `resolveCommand` is how `doctor` notices.
 */
export function selfLaunch(entry = process.argv[1]): Launch {
  if (entry && entry.endsWith('.js') && existsSync(entry)) return { command: 'node', args: [entry] };
  return { command: 'contextd', args: [] };
}

export function launchString(launch: Launch): string {
  return [launch.command, ...launch.args].join(' ');
}

export interface CommandResolution {
  binary: string;
  /** Where the binary was found; null when absent or when there was no way to look. */
  binaryPath: string | null;
  /** False only when we looked and it was not there. */
  binaryFound: boolean | null;
  script: string | null;
  scriptFound: boolean | null;
  problem: string | null;
}

const INTERPRETERS = /^(node|nodejs|tsx|bun)(\.exe)?$/;

/**
 * Check that a stored command can still start. Whitespace-split, which matches how contextd
 * writes them; a quoted path with spaces would not survive the hook command either.
 */
export function resolveCommand(cmd: string | { command: string; args: readonly string[] }, env: Pick<HostEnv, 'which'>): CommandResolution {
  const tokens = typeof cmd === 'string' ? cmd.trim().split(/\s+/) : [cmd.command, ...cmd.args];
  const binary = tokens[0] ?? '';
  let binaryPath: string | null = null;
  let binaryFound: boolean | null = null;
  if (binary.includes('/')) {
    binaryFound = existsSync(binary);
    binaryPath = binaryFound ? binary : null;
  } else if (env.which) {
    binaryPath = env.which(binary);
    binaryFound = binaryPath != null;
  }
  let script: string | null = null;
  let scriptFound: boolean | null = null;
  if (INTERPRETERS.test(basename(binary))) {
    script = tokens.slice(1).find((t) => !t.startsWith('-')) ?? null;
    if (script) scriptFound = existsSync(script);
  }
  const problem =
    binaryFound === false
      ? `\`${binary}\` is not on PATH`
      : scriptFound === false
        ? `${script} does not exist (moved, or not built)`
        : null;
  return { binary, binaryPath, binaryFound, script, scriptFound, problem };
}

/**
 * Whether a hook command is the one contextd installed for this project. The recorded command
 * wins; otherwise the shape `init` writes (`... -C <root> hook`) - which also recognises the
 * install of a build that has since moved, the case uninstall most needs to clean up.
 */
export function isOurHookCommand(command: string, projectRoot: string, recorded: string | null): boolean {
  if (recorded && command === recorded) return true;
  const m = command.match(/\s-C\s+(\S+)\s+hook\s*$/);
  return m?.[1] === projectRoot && /contextd|cli[/\\]index\.js/.test(command);
}
