// ============================================================
// DBML Generator — converts SchemaIR into a valid DBML string
// ============================================================

import type {
  SchemaIR,
  TableDefinition,
  ColumnDef,
  IndexDef,
  FKDef,
  TriggerDef,
  ViewDef,
  ProcedureDef,
  EnumDef,
  DbsExtension,
  RecordData,
} from '../core/types.js';
import { formatDbsComment } from '../utils/comments.js';

// --- Public API ---

/** Optional metadata for the Project block. */
export interface DbmlWriterOptions {
  /** Project name */
  projectName?: string;
  /** Project note / description */
  projectNote?: string;
  /** Database type (e.g. 'MySQL', 'PostgreSQL', 'SQLite') */
  databaseType?: string;
}

/**
 * Convert a SchemaIR into a DBML-formatted string.
 * The output is a valid DBML document that can be round-tripped
 * through the Phase 3 parser.
 */
export function generateDbml(
  schema: SchemaIR,
  options?: DbmlWriterOptions,
): string {
  const lines: string[] = [];

  // 1. Project block (optional)
  if (options) {
    lines.push(...writeProject(options));
    if (lines.length > 0) lines.push('');
  }

  // 2. Top-level raw extensions (no table association)
  const topLevelRaw = schema.extensions.filter(
    (e) => e.type === 'raw',
  );
  for (const ext of topLevelRaw) {
    lines.push(...formatDbsComment(ext));
    lines.push('');
  }

  // 3. Enums
  for (const enumDef of schema.enums) {
    lines.push(...writeEnum(enumDef));
    lines.push('');
  }

  // 4. Tables
  const tableExtensions = schema.extensions.filter(
    (e) =>
      e.type !== 'raw' &&
      e.type !== 'view' &&
      e.type !== 'procedure' &&
      e.type !== 'trigger',
  );

  // Separate FKs for each table (we output them as top-level Refs)
  const allFks: Array<{ fk: FKDef; sourceTable: string }> = [];

  for (const table of schema.tables) {
    lines.push(...writeTable(table));
    lines.push('');

    // Triggers (from table.triggers, output as @dbs comments after the table)
    for (const trigger of table.triggers) {
      const ext: DbsExtension = {
        type: 'trigger',
        name: trigger.name,
        tableName: table.name,
        timing: trigger.timing,
        event: trigger.event,
        body: trigger.body,
      };
      lines.push(...formatDbsComment(ext));
      lines.push('');
    }

    // Table-specific extensions (check, engine, charset, collation)
    for (const ext of tableExtensions) {
      if ('tableName' in ext && ext.tableName === table.name) {
        lines.push(...formatDbsComment(ext));
        lines.push('');
      }
    }

    // Collect FKs for top-level Ref output
    for (const fk of table.foreignKeys) {
      allFks.push({ fk, sourceTable: table.name });
    }
  }

  // 5. Refs (foreign keys as top-level declarations)
  for (const { fk, sourceTable } of allFks) {
    lines.push(...writeRef(fk, sourceTable));
    lines.push('');
  }

  // 6. Views (as @dbs comments)
  for (const view of schema.views) {
    const ext: DbsExtension = {
      type: 'view',
      name: view.name,
      definition: view.definition,
    };
    lines.push(...formatDbsComment(ext));
    lines.push('');
  }

  // 7. Procedures (as @dbs comments)
  for (const proc of schema.procedures) {
    const ext: DbsExtension = {
      type: 'procedure',
      name: proc.name,
      body: proc.body,
    };
    lines.push(...formatDbsComment(ext));
    lines.push('');
  }

  // 8. Records
  for (const rec of schema.records) {
    lines.push(...writeRecords(rec));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

// --- Project block writer ---

function writeProject(options: DbmlWriterOptions): string[] {
  const lines: string[] = [];
  const hasContent =
    options.projectName || options.databaseType || options.projectNote;

  if (!hasContent) return lines;

  const name = options.projectName || 'default';
  lines.push(`Project ${escapeIdentifier(name)} {`);

  if (options.databaseType) {
    lines.push(`  database_type: '${escapeString(options.databaseType)}'`);
  }
  if (options.projectNote) {
    lines.push(`  Note: '${escapeString(options.projectNote)}'`);
  }

  lines.push('}');
  return lines;
}

// --- Enum writer ---

function writeEnum(enumDef: EnumDef): string[] {
  const lines: string[] = [];
  lines.push(`Enum ${escapeIdentifier(enumDef.name)} {`);
  for (const value of enumDef.values) {
    lines.push(`  ${escapeIdentifier(value)}`);
  }
  lines.push('}');
  return lines;
}

// --- Table writer ---

function writeTable(table: TableDefinition): string[] {
  const lines: string[] = [];
  lines.push(`Table ${escapeIdentifier(table.name)} {`);

  // Columns
  for (const col of table.columns) {
    lines.push(`  ${writeColumn(col)}`);
  }

  // Indexes block
  if (table.indexes.length > 0) {
    lines.push('');
    lines.push('  Indexes {');
    for (const idx of table.indexes) {
      lines.push(`    ${writeIndex(idx)}`);
    }
    lines.push('  }');
  }

  lines.push('}');
  return lines;
}

// --- Column writer ---

function writeColumn(col: ColumnDef): string {
  const parts: string[] = [];

  // Name and type
  const escapedName = escapeIdentifier(col.name);
  const typeStr = col.type ? col.type.toLowerCase() : 'varchar';
  parts.push(`${escapedName} ${typeStr}`);

  // Settings
  const settings = buildColumnSettings(col);
  if (settings.length > 0) {
    parts.push(`[${settings.join(', ')}]`);
  }

  return parts.join(' ');
}

function buildColumnSettings(col: ColumnDef): string[] {
  const settings: string[] = [];

  if (col.primaryKey) settings.push('pk');
  if (col.autoIncrement) settings.push('increment');
  if (!col.nullable) {
    settings.push('not null');
  } else {
    // Explicit [null] for nullable columns (consistent roundtrip)
    settings.push('null');
  }
  if (col.unique && !col.primaryKey) settings.push('unique');
  if (col.defaultValue !== undefined) {
    settings.push(`default: ${formatDefaultValue(col.defaultValue)}`);
  }
  if (col.comment) {
    settings.push(`note: '${escapeString(col.comment)}'`);
  }

  return settings;
}

/**
 * Format a ColumnDef default value for DBML.
 *
 * Rules:
 *   - `null` / `NULL` → `null`
 *   - Backtick-wrapped expression → as-is
 *   - Integer / float → as-is
 *   - Otherwise → single-quoted string
 */
function formatDefaultValue(dv: string): string {
  const trimmed = dv.trim();

  // NULL literal
  if (trimmed.toUpperCase() === 'NULL') {
    return 'null';
  }

  // Backtick-wrapped (SQL expressions like `now()`, `CURRENT_TIMESTAMP`)
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed;
  }

  // Already single-quoted string literal (as returned by SQLite PRAGMA table_info)
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed;
  }

  // Numeric literals
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  // Boolean literals
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed;
  }

  // Default: single-quoted string
  return `'${escapeString(trimmed)}'`;
}

// --- Index writer ---

function writeIndex(idx: IndexDef): string {
  const parts: string[] = [];

  // Column(s): single column or composite (col1, col2)
  if (idx.columns.length === 1) {
    parts.push(escapeIdentifier(idx.columns[0]!));
  } else {
    const cols = idx.columns.map(escapeIdentifier).join(', ');
    parts.push(`(${cols})`);
  }

  // Settings
  const settings: string[] = [];
  if (idx.unique) settings.push('unique');
  settings.push(`name: '${escapeString(idx.name)}'`);
  if (idx.type && idx.type !== 'btree') {
    // btree is the default, only output non-btree types
    settings.push(`type: ${idx.type}`);
  }

  parts.push(`[${settings.join(', ')}]`);
  return parts.join(' ');
}

// --- Ref (foreign key) writer ---

function writeRef(fk: FKDef, sourceTable: string): string[] {
  const lines: string[] = [];
  const settings: string[] = [];

  if (fk.onDelete) {
    settings.push(`delete: ${fk.onDelete}`);
  }
  if (fk.onUpdate) {
    settings.push(`update: ${fk.onUpdate}`);
  }

  // Source columns
  const srcCols =
    fk.columns.length === 1
      ? escapeIdentifier(fk.columns[0]!)
      : `(${fk.columns.map(escapeIdentifier).join(', ')})`;

  // Target columns
  const tgtCols =
    fk.refColumns.length === 1
      ? escapeIdentifier(fk.refColumns[0]!)
      : `(${fk.refColumns.map(escapeIdentifier).join(', ')})`;

  const refBody = `${escapeIdentifier(sourceTable)}.${srcCols} > ${escapeIdentifier(fk.refTable)}.${tgtCols}`;

  if (settings.length > 0) {
    lines.push(`Ref: ${refBody} [${settings.join(', ')}]`);
  } else {
    lines.push(`Ref: ${refBody}`);
  }

  return lines;
}

// --- Records writer ---

function writeRecords(rec: RecordData): string[] {
  const lines: string[] = [];
  const cols = rec.columns.map(escapeIdentifier).join(', ');
  lines.push(`Records ${escapeIdentifier(rec.tableName)}(${cols}) {`);

  for (const row of rec.rows) {
    const values = row.values.map((v) => {
      if (v === null) return 'NULL';
      if (typeof v === 'number') return String(v);
      return `'${escapeString(String(v))}'`;
    });
    lines.push(`  ${values.join(', ')}`);
  }

  lines.push('}');
  return lines;
}

// --- String escaping helpers ---

/**
 * Escape a DBML identifier (table name, column name).
 * DBML identifiers can contain most characters, but spaces and special
 * chars need quoting. We quote when the name contains non-alphanumeric
 * characters (except underscore).
 */
function escapeIdentifier(name: string): string {
  // If already quoted, return as-is
  if (name.startsWith('"') || name.startsWith('`')) return name;

  // If simple (alphanumeric + underscore), no quoting needed
  if (/^[a-zA-Z_]\w*$/.test(name)) return name;

  // Otherwise, quote with double quotes
  return `"${name.replace(/"/g, '\\"')}"`;
}

/**
 * Escape a string value for use in single-quoted DBML strings.
 * Escapes backslashes, single quotes, and newlines.
 */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n');
}
