// ============================================================
// DBML Parser — converts DBML tokens into SchemaIR
// ============================================================

import { DbmlLexer, TokenType, type Token } from './dbml-lexer.js';
import { parseDbsComment } from '../utils/comments.js';
import type {
  SchemaIR,
  TableDefinition,
  ColumnDef,
  IndexDef,
  FKDef,
  EnumDef,
  ViewDef,
  ProcedureDef,
  DbsExtension,
  DbsViewExtension,
  DbsProcedureExtension,
} from '../core/types.js';
import { DbsError } from '../utils/errors.js';

// ============================================================
// Parser state
// ============================================================

class ParserState {
  tokens: Token[];
  pos: number;
  /** Accumulated DBS extensions (from // @dbs: comments). */
  extensions: DbsExtension[] = [];
  /** Ref relationships parsed from `Ref:` declarations. */
  foreignKeys: FKDef[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  current(): Token {
    return this.tokens[this.pos]!;
  }

  peek(offset = 1): Token {
    const idx = this.pos + offset;
    return idx < this.tokens.length
      ? this.tokens[idx]!
      : { type: TokenType.EOF, value: '', line: 0, col: 0 };
  }

  advance(): Token {
    const tok = this.current();
    if (tok.type !== TokenType.EOF) this.pos++;
    return tok;
  }

  isAtEnd(): boolean {
    return this.current().type === TokenType.EOF;
  }

  match(...types: TokenType[]): Token | null {
    if (!this.isAtEnd() && types.includes(this.current().type)) {
      return this.advance();
    }
    return null;
  }

  expect(type: TokenType, ctx: string): Token {
    const tok = this.match(type);
    if (!tok) {
      const cur = this.current();
      throw new DbsError({
        code: 'DBML_PARSE',
        message: `Expected ${type} but got ${cur.type} (${cur.value || 'EOF'})`,
        cause: ctx,
        line: cur.line,
      });
    }
    return tok;
  }

  skipComments(): void {
    while (!this.isAtEnd() && this.current().type === TokenType.LINE_COMMENT) {
      this.advance();
    }
  }

  /**
   * Collect consecutive DBS comment groups from LINE_COMMENT tokens.
   * A group is:
   *   1. A LINE_COMMENT starting with "@dbs:" (the header)
   *   2. Zero or more consecutive LINE_COMMENT lines (the body)
   *
   * This consumes tokens from the stream and pushes parsed extensions.
   */
  collectDbsComments(): void {
    while (!this.isAtEnd()) {
      // Skip regular comments
      while (
        !this.isAtEnd() &&
        this.current().type === TokenType.LINE_COMMENT &&
        !this.current().value.startsWith('@dbs:')
      ) {
        this.advance();
      }

      // Check if we're at a DBS comment
      if (
        this.isAtEnd() ||
        this.current().type !== TokenType.LINE_COMMENT
      ) {
        break;
      }

      // Collect the DBS comment group.
      // Stop when we hit a new @dbs: header (separate extension)
      // or a non-comment token, so consecutive extensions are
      // properly split into separate groups.
      const lines: string[] = [];
      while (
        !this.isAtEnd() &&
        this.current().type === TokenType.LINE_COMMENT
      ) {
        // If we already collected a header and this line also starts
        // with @dbs:, it's a new extension — stop here.
        if (
          lines.length > 0 &&
          this.current().value.startsWith('@dbs:')
        ) {
          break;
        }
        const tok = this.advance();
        lines.push(`// ${tok.value}`);
      }

      const ext = parseDbsComment(lines);
      if (ext) {
        this.extensions.push(ext);
      }
    }
  }
}

// ============================================================
// Parser entry point
// ============================================================

/**
 * Parse a DBML source string into a SchemaIR.
 * Throws DbsError on parse failures.
 */
export function parseDbml(source: string): SchemaIR {
  const lexer = new DbmlLexer(source);
  const tokens = lexer.tokenize();
  const state = new ParserState(tokens);

  const schema: SchemaIR = {
    tables: [],
    views: [],
    procedures: [],
    enums: [],
    extensions: [],
  };

  // Working array for unattached Ref results (FK + table name)
  const refResults: RefResult[] = [];

  while (!state.isAtEnd()) {
    // Collect DBS comments before each top-level declaration
    state.collectDbsComments();

    if (state.isAtEnd()) break;

    const tok = state.current();

    switch (tok.type) {
      case TokenType.PROJECT:
        parseProject(state);
        break;
      case TokenType.TABLE:
        schema.tables.push(parseTable(state));
        break;
      case TokenType.ENUM:
        schema.enums.push(parseEnum(state));
        break;
      case TokenType.REF:
        refResults.push(parseRef(state));
        break;
      case TokenType.TABLE_GROUP:
        parseTableGroup(state); // skip for now
        break;
      case TokenType.RECORDS:
        parseRecords(state); // skip for now
        break;
      case TokenType.LINE_COMMENT:
        // DBS comments were already collected; skip remaining
        state.advance();
        break;
      default:
        // Unknown top-level token — skip
        state.advance();
        break;
    }
  }

  // Attach Ref relationships to their tables, and collect extensions
  refResults.forEach((rr) => attachForeignKey(schema, rr));

  // Collect any remaining trailing DBS comments
  state.collectDbsComments();
  attachExtensions(schema, state.extensions);

  return schema;
}

// ============================================================
// Top-level parsers
// ============================================================

function parseProject(state: ParserState): void {
  state.advance(); // PROJECT keyword
  state.expect(TokenType.IDENTIFIER, 'project name');
  state.expect(TokenType.LBRACE, 'project {');

  // Skip project body (we don't need it for SchemaIR)
  let depth = 1;
  while (!state.isAtEnd() && depth > 0) {
    const tok = state.current();
    if (tok.type === TokenType.LBRACE) depth++;
    else if (tok.type === TokenType.RBRACE) depth--;
    if (depth > 0) state.advance();
  }
  state.match(TokenType.RBRACE); // skip closing brace
  state.skipComments();
}

function parseTable(state: ParserState): TableDefinition {
  state.advance(); // TABLE keyword
  const nameTok = state.expect(TokenType.IDENTIFIER, 'table name');
  const tableName = nameTok.value;

  state.skipComments();
  state.expect(TokenType.LBRACE, `table ${tableName} {`);

  const table: TableDefinition = {
    name: tableName,
    columns: [],
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };

  while (!state.isAtEnd()) {
    state.collectDbsComments();

    const tok = state.current();

    // End of table
    if (tok.type === TokenType.RBRACE) {
      state.advance();
      break;
    }

    // Indexes block
    if (tok.type === TokenType.INDEXES) {
      // Attach any pending DBS comments before Indexes block
      state.collectDbsComments();
      table.indexes = parseIndexesBlock(state);
      continue;
    }

    // Note block or multi-line string
    if (tok.type === TokenType.NOTE) {
      parseNote(state);
      continue;
    }

    // Column declaration: name type [settings]
    if (tok.type === TokenType.IDENTIFIER) {
      const col = parseColumn(state);
      table.columns.push(col);
      state.collectDbsComments();
      continue;
    }

    // Skip unknown inside table (but don't skip RBRACE)
    state.advance();
  }

  return table;
}

// ============================================================
// Column parser
// ============================================================

function parseColumn(state: ParserState): ColumnDef {
  const nameTok = state.advance(); // IDENTIFIER

  // Read type — can be an identifier, optionally followed by (params)
  let typeStr = '';

  // The type can include multiple tokens: varchar(255), decimal(10,2), etc.
  if (state.current().type === TokenType.IDENTIFIER) {
    typeStr = state.advance().value;
  }

  // Handle type parameters: type(255) or type(10, 2)
  if (state.current().type === TokenType.LPAREN) {
    typeStr += state.advance().value; // (
    while (!state.isAtEnd() && state.current().type !== TokenType.RPAREN) {
      typeStr += state.advance().value;
    }
    if (state.current().type === TokenType.RPAREN) {
      typeStr += state.advance().value; // )
    }
  }

  const col: ColumnDef = {
    name: nameTok.value,
    type: typeStr || 'varchar',
    nullable: true,
    primaryKey: false,
    unique: false,
    autoIncrement: false,
  };

  // Check for a second identifier (e.g., `integer` as type)
  // If we didn't get a type yet, try again
  if (!typeStr && state.current().type === TokenType.IDENTIFIER) {
    col.type = state.advance().value;
  }

  // Parse column settings: [pk, increment, not null, default: 'x', ...]
  if (state.current().type === TokenType.LBRACKET) {
    parseColumnSettings(state, col);
  }

  // Parse inline comment after settings
  state.skipComments();

  return col;
}

function parseColumnSettings(state: ParserState, col: ColumnDef): void {
  state.advance(); // LBRACKET

  while (!state.isAtEnd() && state.current().type !== TokenType.RBRACKET) {
    if (state.current().type === TokenType.COMMA) {
      state.advance();
      continue;
    }

    if (state.current().type !== TokenType.IDENTIFIER) {
      state.advance();
      continue;
    }

    const settingTok = state.advance();
    const setting = settingTok.value.toLowerCase();

    switch (setting) {
      case 'pk':
      case 'primary':
        // 'primary key' — consume 'key' if present
        if (state.current().type === TokenType.IDENTIFIER && state.current().value.toLowerCase() === 'key') {
          state.advance();
        }
        col.primaryKey = true;
        col.nullable = false;
        break;
      case 'null':
        col.nullable = true;
        break;
      case 'not':
        // 'not null' — consume 'null' if present
        if (state.current().type === TokenType.IDENTIFIER && state.current().value.toLowerCase() === 'null') {
          state.advance();
        }
        col.nullable = false;
        break;
      case 'unique':
        col.unique = true;
        break;
      case 'increment':
        col.autoIncrement = true;
        break;
      case 'default':
        // default: 'value'
        if (state.current().type === TokenType.COLON) {
          state.advance();
          if (
            state.current().type === TokenType.STRING ||
            state.current().type === TokenType.MULTILINE_STRING
          ) {
            col.defaultValue = state.advance().value;
          } else if (state.current().type === TokenType.IDENTIFIER) {
            col.defaultValue = state.advance().value;
          } else if (state.current().type === TokenType.NUMBER) {
            col.defaultValue = state.advance().value;
          }
        }
        break;
      case 'note':
        // note: 'description'
        if (state.current().type === TokenType.COLON) {
          state.advance();
          if (
            state.current().type === TokenType.STRING ||
            state.current().type === TokenType.MULTILINE_STRING
          ) {
            col.comment = state.advance().value;
          }
        }
        break;
      case 'ref':
        // ref: > other.col (inline reference) — skip, handled by dedicated Ref
        if (state.current().type === TokenType.COLON) {
          state.advance();
          // Consume the ref tokens: >, <, table, ., column
          while (
            !state.isAtEnd() &&
            state.current().type !== TokenType.COMMA &&
            state.current().type !== TokenType.RBRACKET
          ) {
            state.advance();
          }
        }
        break;
      default:
        // Unknown setting — skip
        break;
    }
  }

  if (state.current().type === TokenType.RBRACKET) {
    state.advance();
  }
}

// ============================================================
// Indexes block parser
// ============================================================

function parseIndexesBlock(state: ParserState): IndexDef[] {
  state.advance(); // INDEXES keyword
  state.expect(TokenType.LBRACE, 'Indexes {');

  const indexes: IndexDef[] = [];

  while (!state.isAtEnd() && state.current().type !== TokenType.RBRACE) {
    state.collectDbsComments();

    const tok = state.current();

    // Single column index: col_name [settings]
    if (tok.type === TokenType.IDENTIFIER) {
      const idx = parseSingleIndex(state);
      indexes.push(idx);
      continue;
    }

    // Composite index: (col1, col2, ...) [settings]
    if (tok.type === TokenType.LPAREN) {
      const idx = parseCompositeIndex(state);
      indexes.push(idx);
      continue;
    }

    // Skip unknown tokens inside Indexes
    state.advance();
  }

  state.match(TokenType.RBRACE);
  return indexes;
}

function parseSingleIndex(state: ParserState): IndexDef {
  const colName = state.advance().value;

  const idx: IndexDef = {
    name: '',
    columns: [colName],
    unique: false,
  };

  if (state.current().type === TokenType.LBRACKET) {
    parseIndexSettings(state, idx);
  }

  // Auto-generate name if not provided
  if (!idx.name) {
    idx.name = `idx_${colName}`;
  }

  return idx;
}

function parseCompositeIndex(state: ParserState): IndexDef {
  state.advance(); // LPAREN

  const columns: string[] = [];
  while (!state.isAtEnd() && state.current().type !== TokenType.RPAREN) {
    if (state.current().type === TokenType.COMMA) {
      state.advance();
      continue;
    }
    if (state.current().type === TokenType.IDENTIFIER) {
      columns.push(state.advance().value);
    } else {
      state.advance();
    }
  }

  state.match(TokenType.RPAREN);

  const idx: IndexDef = {
    name: '',
    columns,
    unique: false,
  };

  if (state.current().type === TokenType.LBRACKET) {
    parseIndexSettings(state, idx);
  }

  // Auto-generate name if not provided
  if (!idx.name) {
    idx.name = `idx_${columns.join('_')}`;
  }

  return idx;
}

function parseIndexSettings(state: ParserState, idx: IndexDef): void {
  state.advance(); // LBRACKET

  while (!state.isAtEnd() && state.current().type !== TokenType.RBRACKET) {
    if (state.current().type === TokenType.COMMA) {
      state.advance();
      continue;
    }

    if (state.current().type !== TokenType.IDENTIFIER) {
      state.advance();
      continue;
    }

    const setting = state.advance().value.toLowerCase();

    switch (setting) {
      case 'unique':
        idx.unique = true;
        break;
      case 'name':
        if (state.current().type === TokenType.COLON) {
          state.advance();
          if (
            state.current().type === TokenType.STRING ||
            state.current().type === TokenType.IDENTIFIER
          ) {
            idx.name = state.advance().value;
          }
        }
        break;
      case 'type':
        if (state.current().type === TokenType.COLON) {
          state.advance();
          if (state.current().type === TokenType.IDENTIFIER) {
            idx.type = state.advance().value;
          }
        }
        break;
      default:
        break;
    }
  }

  state.match(TokenType.RBRACKET);
}

// ============================================================
// Enum parser
// ============================================================

function parseEnum(state: ParserState): EnumDef {
  state.advance(); // ENUM keyword
  const nameTok = state.expect(TokenType.IDENTIFIER, 'enum name');
  state.expect(TokenType.LBRACE, `enum ${nameTok.value} {`);

  const values: string[] = [];

  while (!state.isAtEnd() && state.current().type !== TokenType.RBRACE) {
    state.collectDbsComments();

    if (state.current().type === TokenType.IDENTIFIER) {
      values.push(state.advance().value);
    } else {
      state.advance();
    }
  }

  state.match(TokenType.RBRACE);

  return { name: nameTok.value, values };
}

// ============================================================
// Ref parser
// ============================================================

/** Parsed Ref result: FK definition + the table that owns the FK. */
interface RefResult {
  fk: FKDef;
  tableName: string;
}

function parseRef(state: ParserState): RefResult {
  state.advance(); // REF keyword

  let refName = '';

  // Optional: Ref name { ... } or Ref: ... or Ref name: ...
  if (state.current().type === TokenType.IDENTIFIER) {
    const maybeName = state.current().value;

    // Check if next is LBRACE -> Ref name { ... }
    if (state.peek().type === TokenType.LBRACE) {
      refName = state.advance().value;
      state.advance(); // LBRACE
      const result = parseRefDefinition(state);
      result.fk.name = refName;

      // Parse optional ref settings: [delete: cascade, update: restrict]
      state.collectDbsComments();
      if (state.current().type === TokenType.LBRACKET) {
        parseRefSettings(state, result.fk);
      }

      state.expect(TokenType.RBRACE, 'closing Ref }');
      return result;
    }

    // Check if next is COLON -> Ref name: ...
    if (state.peek().type === TokenType.COLON) {
      refName = state.advance().value;
      state.advance(); // COLON
      const result = parseRefDefinition(state);
      result.fk.name = refName;
      state.collectDbsComments();
      // Parse optional ref settings: [delete: cascade, update: restrict]
      if (state.current().type === TokenType.LBRACKET) {
        parseRefSettings(state, result.fk);
      }
      return result;
    }
  }

  // Ref: ... (direct definition, no name)
  if (state.current().type === TokenType.COLON) {
    state.advance(); // COLON
    const result = parseRefDefinition(state);
    state.collectDbsComments();
    // Parse optional ref settings: [delete: cascade, update: restrict]
    if (state.current().type === TokenType.LBRACKET) {
      parseRefSettings(state, result.fk);
    }
    return result;
  }

  // Gracefully handle parse errors
  throw new DbsError({
    code: 'DBML_PARSE',
    message: `Invalid Ref syntax at line ${state.current().line}`,
    cause: 'Expected identifier or colon after Ref keyword',
    line: state.current().line,
  });
}

function parseRefDefinition(state: ParserState): RefResult {
  // source_table.source_col <op> target_table.target_col
  const sourceTable = state.expect(TokenType.IDENTIFIER, 'source table').value;
  state.expect(TokenType.DOT, 'dot after source table');
  const sourceCol = state.expect(TokenType.IDENTIFIER, 'source column').value;

  // Relationship operator: >, <, -, <>
  let relationOp = '';
  if (state.current().type === TokenType.GT) {
    relationOp = '>';
    state.advance();
  } else if (state.current().type === TokenType.LT) {
    relationOp = '<';
    state.advance();
  } else if (
    state.current().type === TokenType.NEQ ||
    (state.current().type === TokenType.LT && state.peek().type === TokenType.GT)
  ) {
    if (state.current().type === TokenType.NEQ) {
      relationOp = '<>';
      state.advance();
    } else {
      state.advance(); // <
      state.advance(); // >
      relationOp = '<>';
    }
  }

  const targetTable = state.expect(TokenType.IDENTIFIER, 'target table').value;
  state.expect(TokenType.DOT, 'dot after target table');
  const targetCol = state.expect(TokenType.IDENTIFIER, 'target column').value;

  // Determine FK direction based on operator
  let fkTable: string;
  let fkCols: string[];
  let refTable: string;
  let refCols: string[];

  if (relationOp === '>') {
    fkTable = sourceTable;
    fkCols = [sourceCol];
    refTable = targetTable;
    refCols = [targetCol];
  } else if (relationOp === '<') {
    fkTable = targetTable;
    fkCols = [targetCol];
    refTable = sourceTable;
    refCols = [sourceCol];
  } else {
    // default to '>'
    fkTable = sourceTable;
    fkCols = [sourceCol];
    refTable = targetTable;
    refCols = [targetCol];
  }

  return {
    tableName: fkTable,
    fk: {
      name: '',
      columns: fkCols,
      refTable,
      refColumns: refCols,
    },
  };
}

function parseRefSettings(state: ParserState, fk: FKDef): void {
  state.advance(); // LBRACKET

  while (!state.isAtEnd() && state.current().type !== TokenType.RBRACKET) {
    if (state.current().type === TokenType.COMMA) {
      state.advance();
      continue;
    }

    if (state.current().type !== TokenType.IDENTIFIER) {
      state.advance();
      continue;
    }

    const setting = state.advance().value.toLowerCase();

    if (setting === 'delete' || setting === 'update') {
      if (state.current().type === TokenType.COLON) {
        state.advance();
        if (state.current().type === TokenType.IDENTIFIER) {
          const action = state.advance().value.toLowerCase();
          const validActions = ['cascade', 'set', 'restrict', 'no'];
          if (validActions.includes(action)) {
            // Handle "set null" and "no action"
            let fullAction = action;
            if (action === 'set' || action === 'no') {
              if (state.current().type === TokenType.IDENTIFIER) {
                fullAction += ' ' + state.advance().value.toLowerCase();
              }
            }
            // Normalize
            const normalized = fullAction.replace('no action', 'no action') as
              | 'cascade'
              | 'set null'
              | 'restrict'
              | 'no action';
            if (setting === 'delete') fk.onDelete = normalized;
            else fk.onUpdate = normalized;
          }
        }
      }
    }
  }

  state.match(TokenType.RBRACKET);
}

// ============================================================
// Note parser
// ============================================================

function parseNote(state: ParserState): void {
  state.advance(); // NOTE keyword
  state.match(TokenType.COLON);
  // Consume the note value (string or multiline string)
  if (
    state.current().type === TokenType.STRING ||
    state.current().type === TokenType.MULTILINE_STRING
  ) {
    state.advance();
  }
}

// ============================================================
// TableGroup parser (skip for now)
// ============================================================

function parseTableGroup(state: ParserState): void {
  state.advance(); // TABLE_GROUP keyword
  if (state.current().type === TokenType.IDENTIFIER) state.advance();
  state.match(TokenType.LBRACE);

  let depth = 1;
  while (!state.isAtEnd() && depth > 0) {
    const tok = state.current();
    if (tok.type === TokenType.LBRACE) depth++;
    else if (tok.type === TokenType.RBRACE) depth--;
    if (depth > 0) state.advance();
  }
  state.match(TokenType.RBRACE);
  state.skipComments();
}

// ============================================================
// Records parser (skip for now — Phase 3 doesn't handle data)
// ============================================================

function parseRecords(state: ParserState): void {
  state.advance(); // RECORDS keyword
  // Skip table name
  if (state.current().type === TokenType.IDENTIFIER) state.advance();
  // Skip column list in parens
  if (state.current().type === TokenType.LPAREN) {
    state.advance();
    while (!state.isAtEnd() && state.current().type !== TokenType.RPAREN) {
      state.advance();
    }
    state.match(TokenType.RPAREN);
  }
  // Skip body
  state.match(TokenType.LBRACE);
  let depth = 1;
  while (!state.isAtEnd() && depth > 0) {
    const tok = state.current();
    if (tok.type === TokenType.LBRACE) depth++;
    else if (tok.type === TokenType.RBRACE) depth--;
    if (depth > 0) state.advance();
  }
  state.match(TokenType.RBRACE);
  state.skipComments();
}

// ============================================================
// Post-processing: attach FK and extensions to SchemaIR
// ============================================================

function attachForeignKey(schema: SchemaIR, ref: RefResult): void {
  const table = schema.tables.find((t) => t.name === ref.tableName);
  if (table) {
    table.foreignKeys.push(ref.fk);
  }
}

function attachExtensions(schema: SchemaIR, extensions: DbsExtension[]): void {
  for (const ext of extensions) {
    switch (ext.type) {
      case 'trigger': {
        // Attach trigger to its table
        const table = schema.tables.find((t) => t.name === ext.tableName);
        if (table) {
          table.triggers.push({
            name: ext.name,
            timing: ext.timing.toLowerCase() as 'before' | 'after' | 'instead of',
            event: ext.event.toLowerCase() as 'insert' | 'update' | 'delete',
            body: ext.body,
          });
        }
        break;
      }
      case 'view': {
        schema.views.push({
          name: ext.name,
          definition: ext.definition,
        });
        break;
      }
      case 'procedure': {
        schema.procedures.push({
          name: ext.name,
          body: ext.body,
        });
        break;
      }
      default: {
        // engine, charset, collation, check, raw — store as extensions
        schema.extensions.push(ext);
        break;
      }
    }
  }
}
