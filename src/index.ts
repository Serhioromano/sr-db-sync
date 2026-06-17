#!/usr/bin/env bun

/**
 * db-sync — CLI utility for bidirectional conversion between database and DBML
 *
 * Usage:
 *   dbs snash   [flags]    Make a snapshot of a database → DBML file
 *   dbs migrate [flags]    Apply DBML schema to a database
 *   dbs                    Interactive mode (select command + configure)
 *   dbs --help             Show usage
 *   dbs --version          Show version
 */

import { snashCommand } from './cli/snash.js';
import { migrateCommand } from './cli/migrate.js';
import { exitOk } from './utils/output.js';

const VERSION = '1.0.0';

const USAGE = `db-sync v${VERSION} — Database ↔ DBML bidirectional converter

Usage:
  dbs snash    Make a snapshot of a database → DBML file
  dbs migrate  Apply DBML schema to a database (smart migration)
  dbs          Interactive mode

Common flags:
  --dsn <string>             Data Source Name (connection string)
  --engine <string>          Database engine: sqlite | mysql
  --prefix <string>          Table name prefix (optional)
  --file <path>              DBML file path: snash writes to it, migrate reads from it
                             (default: ./migration/<dbname>.dbml — derived from DSN)

Profiles:
  --profile <name>           Use a named profile from .dbs.json
  --profiles-file <path>     Path to profiles JSON file (default: .dbs.json)

Migrate flags:
  --dry-run                  Preview SQL commands without executing them
  --insert                   Also check and insert Records from DBML

Other:
  --help                     Show this help message
  --version                  Show version number

Examples:
  dbs snash --dsn ./my.db --engine sqlite
  dbs snash --profile prod --file schema.dbml
  dbs migrate --profile prod --dry-run
  dbs migrate --dsn mysql://user:pass@localhost/db --engine mysql
`;

/**
 * Show usage and exit with OK.
 */
function showUsage(): void {
  console.log(USAGE.trim());
  exitOk('help');
}

/**
 * Show version and exit with OK.
 */
function showVersion(): void {
  console.log(`db-sync v${VERSION}`);
  exitOk('version');
}

/**
 * Launch interactive mode using @clack/prompts.
 * Guides the user through: command → engine → dsnFields → confirm.
 */
async function interactiveMode(): Promise<void> {
  // Dynamic import so @clack/prompts is only loaded when needed
  const prompts = await import('@clack/prompts');

  console.log(''); // visual spacing

  // Step 1: Choose command
  const command = await prompts.select({
    message: 'What would you like to do?',
    options: [
      {
        value: 'snash',
        label: '📸  Snash — save database schema to DBML file',
        hint: 'Extract the full schema from a database and write it to a .dbml file',
      },
      {
        value: 'migrate',
        label: '🚀  Migrate — apply DBML schema to a database',
        hint: 'Compare a DBML file with a database and apply minimal changes',
      },
    ],
  });

  if (prompts.isCancel(command)) {
    console.log('Cancelled.');
    process.exit(0);
  }

  // Step 2: Choose engine
  const engine = await prompts.select({
    message: 'Which database engine?',
    options: [
      { value: 'sqlite', label: 'SQLite', hint: 'File-based, zero-config' },
      { value: 'mysql', label: 'MySQL', hint: 'Popular open-source RDBMS' },
      {
        value: 'postgres',
        label: 'PostgreSQL',
        hint: 'Advanced open-source RDBMS (future support)',
      },
    ],
  });

  if (prompts.isCancel(engine)) {
    console.log('Cancelled.');
    process.exit(0);
  }

  // Note: full interactive DSN building (via adapter.dsnFields) will be
  // implemented in Phase 6 (snash) / Phase 9 (migrate) once adapters exist.
  console.log(
    `\nℹ️  Full interactive mode (DSN configuration) will be available in a future version.`
  );
  console.log(
    `   For now, use: dbs ${command} --engine ${engine} --dsn <connection-string>\n`
  );
  process.exit(0);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle --help and --version anywhere in the args
  if (args.length === 0) {
    // No arguments → interactive mode
    await interactiveMode();
    return;
  }

  // Check for --help or --version in any position
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      showUsage();
      return;
    }
    if (arg === '--version' || arg === '-v') {
      showVersion();
      return;
    }
  }

  // Extract subcommand (first non-flag argument)
  const command = args[0];

  // If first arg looks like a flag, assume interactive mode was intended
  if (command.startsWith('-')) {
    console.error(
      'ERROR [CONFIG] Unknown flag without subcommand. Use dbs snash or dbs migrate.'
    );
    console.error('  hint: Run "dbs" without arguments for interactive mode');
    console.error('  hint: Run "dbs --help" for usage information');
    process.exit(1);
  }

  const remainingArgs = args.slice(1);

  switch (command) {
    case 'snash':
      snashCommand(remainingArgs);
      break;

    case 'migrate':
      migrateCommand(remainingArgs);
      break;

    default:
      console.error(`EXIT ERROR [CONFIG] Unknown command: ${command}`);
      console.error('  hint: Use "dbs snash" or "dbs migrate"');
      console.error('  hint: Run "dbs --help" for usage information');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('EXIT ERROR [UNKNOWN] Unexpected error');
  console.error('  cause:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
