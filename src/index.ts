#!/usr/bin/env bun

/**
 * db-sync — CLI utility for bidirectional conversion between database and DBML
 *
 * Usage:
 *   dbs snash [--dsn <dsn>] [--engine <engine>] [--prefix <prefix>] [--output <path>]
 *   dbs snash --profile <name> [--profiles-file <path>] [--output <path>]
 *   dbs migrate [--dsn <dsn>] [--engine <engine>] [--input <path>] [--dry-run] [--insert]
 *   dbs migrate --profile <name> [--profiles-file <path>] [--input <path>] [--dry-run] [--insert]
 *   dbs --help
 *   dbs --version
 */

const USAGE = `
db-sync v1.0.0 — Database ↔ DBML bidirectional converter

Usage:
  dbs snash   Make a snapshot of a database → DBML file
  dbs migrate Apply DBML schema to a database (smart migration)

Subcommands:
  snash     Extract schema from database and save as DBML
  migrate   Compare DBML with database and apply minimal changes

Common flags:
  --dsn <string>           Data Source Name (connection string)
  --engine <string>        Database engine: sqlite | mysql
  --prefix <string>        Table name prefix (optional)

Profiles:
  --profile <name>         Use a named profile from .dbs.json
  --profiles-file <path>   Path to profiles JSON file (default: .dbs.json)

Snash flags:
  --output <path>          Output DBML file path (default: ./schema.dbml)

Migrate flags:
  --input <path>           Input DBML file path (default: ./schema.dbml)
  --dry-run                Preview SQL commands without executing them
  --insert                 Also check and insert Records from DBML

Other:
  --help                   Show this help message
  --version                Show version number

Examples:
  dbs snash --dsn ./my.db --engine sqlite
  dbs snash --profile prod --output schema.dbml
  dbs migrate --profile prod --dry-run
  dbs migrate --dsn mysql://user:pass@localhost/db --engine mysql
`.trim();

function showUsage(): void {
  console.log(USAGE);
  console.log("\nEXIT OK [help]");
}

function showVersion(): void {
  console.log("db-sync v1.0.0");
  console.log("EXIT OK [version]");
}

function showUnknown(command: string): void {
  console.error(`EXIT ERROR [CONFIG] Unknown command: ${command}`);
  console.error(`  hint: Use "dbs snash" or "dbs migrate"`);
  console.error(`  hint: Use "dbs --help" for usage information`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    showUsage();
    return;
  }

  if (args.includes("--version")) {
    showVersion();
    return;
  }

  const command = args[0];
  switch (command) {
    case "snash":
      console.log("EXIT OK [snash: not yet implemented]");
      break;
    case "migrate":
      console.log("EXIT OK [migrate: not yet implemented]");
      break;
    default:
      showUnknown(command);
  }
}

main();
