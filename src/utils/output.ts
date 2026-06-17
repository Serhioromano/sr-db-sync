// ============================================================
// AI-friendly output functions for db-sync CLI
// ============================================================

import { DbsError, type DbsErrorCode } from './errors.js';

/**
 * Print success message and exit with code 0.
 * Format: EXIT OK [<details>]
 *
 * This is the AI-friendly contract — any agent can scan for this
 * exact prefix to determine success without parsing the full output.
 */
export function exitOk(details: string): never {
  console.log(`EXIT OK [${details}]`);
  process.exit(0);
}

/**
 * Print structured error to stderr and exit with the matching code.
 * Follows the format specified in SPEC.md §4.4:
 *
 *   ERROR [CODE] message
 *     engine: value
 *     dsn: value
 *     file: value
 *     cause: reason
 *     hint: suggestion
 *
 * Optional context fields are only printed when present.
 */
export function exitError(
  code: DbsErrorCode,
  message: string,
  meta?: {
    cause?: string;
    engine?: string;
    dsn?: string;
    hint?: string;
    file?: string;
    line?: number;
    operation?: string;
    table?: string;
    column?: string;
  }
): never {
  const error = new DbsError({
    code,
    message,
    cause: meta?.cause ?? message,
    engine: meta?.engine,
    dsn: meta?.dsn,
    hint: meta?.hint,
    file: meta?.file,
    line: meta?.line,
    operation: meta?.operation,
    table: meta?.table,
    column: meta?.column,
  });
  return error.exit();
}

/**
 * Print a warning message to stderr (does not exit).
 * Format: WARN [<code>] message
 */
export function warn(code: string, message: string): void {
  console.error(`WARN [${code}] ${message}`);
}
