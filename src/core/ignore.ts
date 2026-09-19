import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

/**
 * PRD 36 - respect .gitignore plus configured exclusions.
 *
 * A deliberately small gitignore subset (comments, negation, directory and leading-slash
 * anchoring, * and ** globs). Pulling in a full gitignore implementation would be the only
 * runtime dependency here that is not already justified, and the failure mode of being
 * slightly over-eager about excluding a path is the safe direction.
 */

interface Rule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

export class IgnoreMatcher {
  private rules: Rule[] = [];

  constructor(
    private root: string,
    patterns: string[] = [],
  ) {
    for (const p of patterns) this.add(p);
  }

  static fromProject(root: string, extra: string[] = [], useGitignore = true): IgnoreMatcher {
    const patterns: string[] = [];
    if (useGitignore) {
      for (const name of ['.gitignore', '.git/info/exclude']) {
        const p = join(root, name);
        if (existsSync(p)) patterns.push(...readFileSync(p, 'utf8').split(/\r?\n/));
      }
    }
    patterns.push(...extra);
    return new IgnoreMatcher(root, patterns);
  }

  add(raw: string): void {
    let pattern = raw.trim();
    if (pattern.length === 0 || pattern.startsWith('#')) return;

    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.slice(1);

    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);

    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);

    const body = globToRegexSource(pattern);
    // An unanchored pattern matches at any depth, the way git treats it.
    const source = anchored ? `^${body}(?:/.*)?$` : `(?:^|.*/)${body}(?:/.*)?$`;
    this.rules.push({ re: new RegExp(source), negated, dirOnly });
  }

  /** True when the path should be excluded. Accepts absolute or root-relative paths. */
  ignores(path: string): boolean {
    const rel = this.toRelative(path);
    if (rel === null) return false;
    let ignored = false;
    // Last matching rule wins, so a later negation can re-include a path.
    for (const rule of this.rules) {
      if (rule.re.test(rel)) ignored = !rule.negated;
    }
    return ignored;
  }

  private toRelative(path: string): string | null {
    const normalized = path.replace(/\\/g, '/');
    if (!isAbsolute(normalized)) return normalized.replace(/^\.\//, '');
    const rel = relative(this.root, normalized).replace(/\\/g, '/');
    // Outside the project: nothing to say about it.
    if (rel.startsWith('..')) return null;
    return rel;
  }
}

function globToRegexSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') i += 1;
        out += '(?:.*/)?';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}
