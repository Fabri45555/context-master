import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MEMORY_CATEGORIES } from '../core/state.js';
import { EDGE_KINDS } from '../core/graph.js';
import { formatMetrics } from '../metrics/index.js';
import { RetrievalEngine } from '../store/retrieval.js';
import type { ContextManager } from '../daemon/manager.js';

/**
 * PRD 21 - context injection, done as pull rather than push.
 *
 * The PRD prefers that the manager not keep rewriting the agent's prompt, and an MCP server
 * is the cleanest way to honour that on agents that support it: the agent asks for exactly
 * the context it wants, when it wants it, and nothing is injected behind its back.
 */

const CategoryEnum = z.enum(MEMORY_CATEGORIES);

export function buildMcpServer(manager: ContextManager): McpServer {
  const server = new McpServer(
    { name: 'contextd', version: '0.1.0' },
    {
      instructions: [
        'Persistent project memory for this repository, maintained outside your context window.',
        '',
        'Call memory_bootstrap once at the start of a session to learn the current task,',
        'active constraints and decisions. Call memory_query before working on an area to pull',
        'only the memory relevant to it. Call memory_remember when the user states a constraint',
        'or you make a decision worth keeping - do not rely on your own context to hold it.',
        '',
        'memory_link records how two items relate, and memory_neighbours follows those',
        'relations. memory_conflicts reports contradictions: check it before acting on memory',
        'that seems to say two incompatible things.',
        '',
        'The repository is the source of truth for code; this memory holds intent, decisions,',
        'constraints and file purposes, never file contents.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'memory_bootstrap',
    {
      description:
        'The small always-on project context: current task, plan, active constraints, decisions, important files, open issues. Read this first in a new session.',
      inputSchema: {},
    },
    async () => {
      const built = manager.serveBootstrap(manager.store.activeSessionId());
      const text = built.text.length > 0 ? built.text : 'No project memory recorded yet.';
      return {
        content: [{ type: 'text' as const, text: `${text}\n\n(${built.tokens} tokens)` }],
      };
    },
  );

  server.registerTool(
    'memory_query',
    {
      description:
        'Retrieve project memory relevant to a topic, plus the always-on critical items. Use before starting work on an area, instead of re-deriving context.',
      inputSchema: {
        query: z.string().describe('What you are about to work on, in natural language.'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      const built = await manager.queryContextHybrid(query, {
        limit: limit ?? 12,
        sessionId: manager.store.activeSessionId(),
      });
      const text = built.text.length > 0 ? built.text : `No memory matched: ${query}`;
      return { content: [{ type: 'text' as const, text: `${text}\n\n(${built.tokens} tokens)` }] };
    },
  );

  server.registerTool(
    'memory_remember',
    {
      description:
        'Record a durable fact about the project: a user constraint, a decision and its reason, a discovery, an open question, or an important file. Use source "user" only for something the user actually said.',
      inputSchema: {
        category: CategoryEnum,
        text: z.string().min(1).describe('The statement, phrased so it stands alone.'),
        reason: z.string().optional().describe('Why this is true or why it was decided.'),
        importance: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        source: z.enum(['user', 'agent']).optional(),
        supersedes: z
          .array(z.string())
          .optional()
          .describe('Ids of memory items this replaces, if it contradicts them.'),
      },
    },
    async ({ category, text, reason, importance, source, supersedes }) => {
      const result = manager.remember({
        add: [
          {
            category,
            text,
            reason: reason ?? null,
            importance: importance ?? (source === 'user' ? 'critical' : 'medium'),
            source: source ?? 'agent',
            confidence: source === 'user' ? 1 : 0.85,
            supersedes: supersedes ?? [],
            ...(reason ? { fields: { reason } } : {}),
          },
        ],
        note: 'recorded via MCP memory_remember',
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`,
            },
          ],
        };
      }
      return {
        content: [
          { type: 'text' as const, text: `Recorded ${result.added.join(', ')} (state v${result.version}).` },
        ],
      };
    },
  );

  server.registerTool(
    'memory_retire',
    {
      description:
        'Retire memory items that are wrong, stale, or were never project state (harness noise, a stored measurement). To replace an item with a corrected version, use memory_remember with supersedes instead. User-critical items cannot be retired.',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('Ids of the items to retire.'),
        reason: z.string().min(1).describe('Why they are wrong. Kept in the patch log.'),
      },
    },
    async ({ ids, reason }) => {
      const result = manager.retire(ids, reason);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`,
            },
          ],
        };
      }
      return { content: [{ type: 'text' as const, text: `Retired ${ids.join(', ')} (state v${result.version}).` }] };
    },
  );

  server.registerTool(
    'memory_task',
    {
      description:
        'Set the current task in working memory: what is being done, its status, and the next action. Call it when the task changes or finishes, so the next session does not start from a stale one.',
      inputSchema: {
        task: z.string().optional().describe('The current task, in one line.'),
        status: z.enum(['unknown', 'planning', 'in_progress', 'blocked', 'review', 'done']).optional(),
        next_action: z.string().optional().describe('The next concrete step.'),
        state: z.string().optional().describe('Where things stand.'),
      },
    },
    async ({ task, status, next_action, state }) => {
      if (task == null && status == null && next_action == null && state == null) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Nothing to set: pass task, status, next_action or state.' }] };
      }
      const result = manager.setTask({
        ...(task != null ? { current_task: task } : {}),
        ...(status != null ? { task_status: status } : {}),
        ...(next_action != null ? { next_action } : {}),
        ...(state != null ? { current_state: state } : {}),
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Rejected: ${result.violations.map((v) => v.message).join('; ')}` }],
        };
      }
      return { content: [{ type: 'text' as const, text: `Task updated (state v${result.version}).` }] };
    },
  );

  server.registerTool(
    'memory_close',
    {
      description:
        'Mark goals as met, requirements as satisfied, open questions as answered or known issues as resolved. The items stay in memory and findable by query, but leave the always-on bootstrap. Use when the work is verifiably done; say what closed it.',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('Ids of the items to close.'),
        reason: z.string().min(1).describe('What closed them, e.g. "README.md written, 771 lines".'),
      },
    },
    async ({ ids, reason }) => {
      const result = manager.closeItems(ids, reason);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`,
            },
          ],
        };
      }
      return { content: [{ type: 'text' as const, text: `Closed ${ids.join(', ')} (state v${result.version}).` }] };
    },
  );

  server.registerTool(
    'memory_explain',
    {
      description:
        'Explain why a memory item is held: its source, reason, supporting evidence, confidence and validation history.',
      inputSchema: { id: z.string().describe('A memory item id, e.g. mem_....') },
    },
    async ({ id }) => {
      const item = manager.store.getItem(id);
      if (!item) {
        return { isError: true, content: [{ type: 'text' as const, text: `No such item: ${id}` }] };
      }
      const lines = [
        `${item.id} [${item.category}] ${item.status}`,
        `text: ${item.text}`,
        `importance: ${item.importance}   confidence: ${item.confidence.toFixed(2)}`,
        `source: ${item.source}`,
        `reason: ${item.reason ?? '(none recorded)'}`,
        `created: ${item.created_at}`,
        `last validated: ${item.last_validated_at ?? 'never'}`,
        `last used: ${item.last_used_at ?? 'never'}`,
        `evidence: ${item.evidence.length > 0 ? item.evidence.join(', ') : '(none)'}`,
      ];
      if (item.supersedes.length > 0) lines.push(`supersedes: ${item.supersedes.join(', ')}`);
      if (item.superseded_by) lines.push(`superseded by: ${item.superseded_by}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'memory_link',
    {
      description:
        'State a typed relation between two memory items, so retrieval can reach one from the other. Use when you notice that a constraint governs a decision, a reason motivates it, or a file implements it.',
      inputSchema: {
        from: z.string().describe('The id the relation starts at.'),
        to: z.string().describe('The id the relation points to.'),
        kind: z.enum(EDGE_KINDS),
        reason: z.string().optional(),
      },
    },
    async ({ from, to, kind, reason }) => {
      const result = manager.remember({
        link: [{ from, to, kind, reason: reason ?? null }],
        note: 'linked via MCP memory_link',
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Linked ${from} --${kind}--> ${to} (state v${result.version}).` }],
      };
    },
  );

  server.registerTool(
    'memory_neighbours',
    {
      description:
        'The memory items related to a given item, with the kind of relation. Use to follow the reasoning around something you already found.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const item = manager.store.getItem(id);
      if (!item) {
        return { isError: true, content: [{ type: 'text' as const, text: `No such item: ${id}` }] };
      }
      const neighbourhood = manager.graphOf(id);
      if (neighbourhood.length === 0) {
        return { content: [{ type: 'text' as const, text: `${id} has no recorded relations.` }] };
      }
      const lines = [`${item.id} [${item.category}] ${item.text}`, ''];
      for (const { edge, direction, other } of neighbourhood) {
        const arrow = direction === 'out' ? `--${edge.kind}-->` : `<--${edge.kind}--`;
        const target = direction === 'out' ? edge.to : edge.from;
        lines.push(`${arrow} ${target}: ${other?.text ?? '(missing)'}`);
        if (edge.reason) lines.push(`    why: ${edge.reason}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'memory_conflicts',
    {
      description:
        'Contradictions currently sitting in project memory. Use when memory seems to say two incompatible things, before acting on either.',
      inputSchema: {},
    },
    async () => {
      const conflicts = manager.conflicts({ maxPairs: 20 });
      if (conflicts.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No contradictions detected.' }] };
      }
      const lines = conflicts.flatMap((c, n) => [
        `${n + 1}. ${c.reason} (similarity ${c.similarity.toFixed(2)}) in ${c.a.category}`,
        `   ${c.a.id} [${c.a.importance}, src=${c.a.source}] ${c.a.text}`,
        `   ${c.b.id} [${c.b.importance}, src=${c.b.source}] ${c.b.text}`,
        `   newer: ${c.newer}`,
      ]);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'memory_status',
    {
      description: 'Context manager metrics: events, memory size, context reduction, worker cost.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text' as const, text: formatMetrics(manager.metrics(null)) }],
    }),
  );

  // A resource so an agent can browse a whole category without burning a tool call per item.
  server.registerResource(
    'memory-category',
    'contextd://memory/{category}',
    { description: 'All active memory items in one category.' },
    async (uri) => {
      const category = uri.pathname.replace(/^\/+/, '') || uri.hostname;
      const parsed = CategoryEnum.safeParse(category);
      if (!parsed.success) {
        return {
          contents: [
            {
              uri: uri.href,
              text: `Unknown category. Available: ${MEMORY_CATEGORIES.join(', ')}`,
            },
          ],
        };
      }
      const items = new RetrievalEngine(manager.store).byCategory(parsed.data, 200);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

export async function runMcpStdio(manager: ContextManager): Promise<void> {
  const server = buildMcpServer(manager);
  await server.connect(new StdioServerTransport());
}
