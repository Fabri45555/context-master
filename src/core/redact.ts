/**
 * PRD 36 - secret redaction.
 *
 * Applied at the ingest boundary, before anything is written to L2 and before any bytes
 * leave for a worker. Redacting only on egress would still leave credentials sitting in
 * the local event store, which is the thing most likely to be copied or shared.
 */

export interface RedactRule {
  name: string;
  pattern: RegExp;
  /** Replacement; may use capture groups to keep a recognisable prefix. */
  replace: string;
}

const MASK = '[REDACTED]';

export const DEFAULT_RULES: RedactRule[] = [
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: `sk-ant-${MASK}` },
  { name: 'openai_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g, replace: `sk-${MASK}` },
  { name: 'github_token', pattern: /\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, replace: `$1${MASK}` },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: `xox?-${MASK}` },
  { name: 'google_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: `AIza${MASK}` },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: `AKIA${MASK}` },
  { name: 'stripe_key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: `sk_live_${MASK}` },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: MASK },
  {
    name: 'pem_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----`,
  },
  { name: 'bearer', pattern: /\b(Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1 ${MASK}` },
  {
    name: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: `$1$2:${MASK}@`,
  },
  {
    name: 'env_assignment',
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*("?)([^\s"']{6,})\2/g,
    replace: `$1=$2${MASK}$2`,
  },
];

export interface RedactResult {
  text: string;
  count: number;
  rules: string[];
}

export function redactText(input: string, rules: RedactRule[] = DEFAULT_RULES): RedactResult {
  let text = input;
  let count = 0;
  const hit: string[] = [];
  for (const rule of rules) {
    // Fresh regex per call: the /g rules carry lastIndex state otherwise.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let n = 0;
    text = text.replace(re, (...args) => {
      n += 1;
      // Expand $1/$2 manually so the replacement string works with the callback form.
      return rule.replace.replace(/\$(\d)/g, (_, d: string) => String(args[Number(d)] ?? ''));
    });
    if (n > 0) {
      count += n;
      hit.push(rule.name);
    }
  }
  return { text, count, rules: hit };
}

/**
 * Keys whose value is a secret whatever it looks like.
 *
 * Pattern matching alone misses these: a tool argument is `{"apiKey": "9f3c..."}`, where
 * the value carries no recognisable prefix and only the key says what it is.
 */
const SECRET_KEY =
  /(secret|password|passwd|^pwd$|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential|authorization|auth[_-]?token|session[_-]?id|cookie)/i;

/** Values short enough to be a flag or an enum rather than a credential. */
const MIN_SECRET_VALUE_LENGTH = 6;

/** Deep-redact every string in an arbitrary JSON-ish value. */
export function redactValue<T>(value: T, rules: RedactRule[] = DEFAULT_RULES): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown, keyHint: string | null): unknown => {
    if (typeof v === 'string') {
      if (keyHint && SECRET_KEY.test(keyHint) && v.length >= MIN_SECRET_VALUE_LENGTH) {
        count += 1;
        return MASK;
      }
      const r = redactText(v, rules);
      count += r.count;
      return r.text;
    }
    // An array inherits its key, so {"keys": ["...", "..."]} is covered too.
    if (Array.isArray(v)) return v.map((item) => walk(item, keyHint));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  return { value: walk(value, null) as T, count };
}

/** Paths whose contents should never be ingested at all (PRD 36). */
const SENSITIVE_PATH = /(^|\/)(\.env(\.[\w.-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.keystore|credentials(\.json)?|secrets?\.(ya?ml|json|toml))$/i;

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH.test(p.replace(/\\/g, '/'));
}
