// ============================================================
// DBS comment parser — encodes / decodes // @dbs: extensions
// ============================================================

import type {
  DbsExtension,
  DbsTriggerExtension,
  DbsViewExtension,
  DbsProcedureExtension,
  DbsCheckExtension,
  DbsEngineExtension,
  DbsCharsetExtension,
  DbsCollationExtension,
  DbsRawExtension,
} from '../core/types.js';

// --- FK name normalisation ---

/**
 * Ensure a foreign key name has the mandatory `fk_` prefix.
 *
 * If the name already starts with `fk_`, it's returned unchanged.
 * Otherwise, the prefix is prepended.
 *
 * Examples:
 *   ensureFkPrefix('posts_ibfk_1')  → 'fk_posts_ibfk_1'
 *   ensureFkPrefix('fk_users_id')    → 'fk_users_id'
 *   ensureFkPrefix('')               → ''
 */
export function ensureFkPrefix(name: string): string {
  if (!name) return name;
  if (name.startsWith('fk_')) return name;
  return `fk_${name}`;
}

// --- Parser: comment text → DbsExtension ---

/**
 * Parse a group of consecutive // @dbs: comment lines.
 *
 * The first line has the format:
 *   // @dbs:<type>:<arg1>:<arg2>:...
 *
 * Subsequent lines (if any) form the body (e.g. trigger/procedure/view SQL).
 * Each body line must start with `// ` — the prefix is stripped.
 *
 * Returns null if the first line doesn't match the @dbs pattern.
 */
export function parseDbsComment(lines: string[]): DbsExtension | null {
  if (lines.length === 0) return null;

  const header = lines[0].trimStart();
  const dbsMatch = header.match(/^\/\/\s*@dbs:(\w+)(?::(.*))?$/);
  if (!dbsMatch) return null;

  const type = dbsMatch[1];
  const args = dbsMatch[2] ?? '';

  // Body: subsequent lines, strip "// " prefix
  const body = lines
    .slice(1)
    .map((l) => l.replace(/^\/\/\s?/, ''))
    .join('\n')
    .trim();

  switch (type) {
    case 'trigger':
      return parseTrigger(args, body);
    case 'view':
      return parseView(args, body);
    case 'procedure':
      return parseProcedure(args, body);
    case 'check':
      return parseCheck(args);
    case 'engine':
      return parseEngine(args);
    case 'charset':
      return parseCharset(args);
    case 'collation':
      return parseCollation(args);
    case 'raw':
      return parseRaw(args, body);
    default:
      // Unknown @dbs type — store as raw
      return { type: 'raw', sql: `@dbs:${type}:${args}\n${body}` };
  }
}

// --- Individual type parsers ---

function parseTrigger(args: string, body: string): DbsTriggerExtension {
  const parts = args.split(':');
  // Format: name:table:timing:event
  return {
    type: 'trigger',
    name: parts[0] ?? '',
    tableName: parts[1] ?? '',
    timing: parts[2] ?? '',
    event: parts[3] ?? '',
    body,
  };
}

function parseView(args: string, body: string): DbsViewExtension {
  return {
    type: 'view',
    name: args,
    definition: body,
  };
}

function parseProcedure(args: string, body: string): DbsProcedureExtension {
  return {
    type: 'procedure',
    name: args,
    body,
  };
}

function parseCheck(args: string): DbsCheckExtension {
  const parts = args.split(':');
  // Format: tableName:checkName:condition
  return {
    type: 'check',
    tableName: parts[0] ?? '',
    name: parts[1] ?? '',
    condition: parts.slice(2).join(':') ?? '',
  };
}

function parseEngine(args: string): DbsEngineExtension {
  const parts = args.split(':');
  return {
    type: 'engine',
    tableName: parts[0] ?? '',
    engine: parts.slice(1).join(':') ?? '',
  };
}

function parseCharset(args: string): DbsCharsetExtension {
  const parts = args.split(':');
  return {
    type: 'charset',
    tableName: parts[0] ?? '',
    charset: parts.slice(1).join(':') ?? '',
  };
}

function parseCollation(args: string): DbsCollationExtension {
  const parts = args.split(':');
  return {
    type: 'collation',
    tableName: parts[0] ?? '',
    collation: parts.slice(1).join(':') ?? '',
  };
}

function parseRaw(args: string, body: string): DbsRawExtension {
  return {
    type: 'raw',
    sql: args ? `${args}\n${body}` : body,
  };
}

// --- Formatter: DbsExtension → comment text ---

/**
 * Format a DbsExtension back into `// @dbs:` comment lines.
 * Returns an array of lines (without trailing newline).
 */
export function formatDbsComment(ext: DbsExtension): string[] {
  switch (ext.type) {
    case 'trigger':
      return formatTrigger(ext);
    case 'view':
      return formatView(ext);
    case 'procedure':
      return formatProcedure(ext);
    case 'check':
      return formatCheck(ext);
    case 'engine':
      return formatEngine(ext);
    case 'charset':
      return formatCharset(ext);
    case 'collation':
      return formatCollation(ext);
    case 'raw':
      return formatRaw(ext);
    default:
      return [`// @dbs:raw:${(ext as DbsRawExtension).sql || ''}`];
  }
}

function formatTrigger(ext: DbsTriggerExtension): string[] {
  const header = `// @dbs:trigger:${ext.name}:${ext.tableName}:${ext.timing}:${ext.event}`;
  if (!ext.body) return [header];
  const bodyLines = ext.body.split('\n').map((l) => `// ${l}`);
  return [header, ...bodyLines];
}

function formatView(ext: DbsViewExtension): string[] {
  const header = `// @dbs:view:${ext.name}`;
  if (!ext.definition) return [header];
  const bodyLines = ext.definition.split('\n').map((l) => `// ${l}`);
  return [header, ...bodyLines];
}

function formatProcedure(ext: DbsProcedureExtension): string[] {
  const header = `// @dbs:procedure:${ext.name}`;
  if (!ext.body) return [header];
  const bodyLines = ext.body.split('\n').map((l) => `// ${l}`);
  return [header, ...bodyLines];
}

function formatCheck(ext: DbsCheckExtension): string[] {
  return [`// @dbs:check:${ext.tableName}:${ext.name}:${ext.condition}`];
}

function formatEngine(ext: DbsEngineExtension): string[] {
  return [`// @dbs:engine:${ext.tableName}:${ext.engine}`];
}

function formatCharset(ext: DbsCharsetExtension): string[] {
  return [`// @dbs:charset:${ext.tableName}:${ext.charset}`];
}

function formatCollation(ext: DbsCollationExtension): string[] {
  return [`// @dbs:collation:${ext.tableName}:${ext.collation}`];
}

function formatRaw(ext: DbsRawExtension): string[] {
  const lines = ext.sql.split('\n');
  if (lines.length === 0) return [];
  return [`// @dbs:raw:${lines[0]}`, ...lines.slice(1).map((l) => `// ${l}`)];
}
