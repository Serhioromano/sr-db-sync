// ============================================================
// Configuration types for .dbs.json profiles
// ============================================================

/**
 * A single profile configuration within .dbs.json.
 */
export interface ProfileConfig {
  dsn: string;
  engine: string; // 'sqlite' | 'mysql' | 'postgres'
  prefix?: string; // Table name prefix (optional)
  file?: string; // DBML file path (optional, auto-derived from DSN if omitted)
  records?: string; // Records filter: 'all' | 'table1,table2' | undefined (none)
}

/**
 * Map of profile name → profile configuration.
 * Example:
 * {
 *   "prod": { "dsn": "./my.db", "engine": "sqlite", "prefix": "mypref_" },
 *   "staging": { "dsn": "mysql://...", "engine": "mysql" }
 * }
 */
export interface DbsProfiles {
  [profileName: string]: ProfileConfig;
}

/**
 * Resolved DBS configuration after profile resolution and flag merging.
 * This is the final config used by both snash and migrate commands.
 */
export interface DbsConfig {
  /** Normalised engine name ('sqlite' | 'mysql' | 'postgres') */
  engine: string;
  /** Data Source Name (connection string) */
  dsn: string;
  /** Table name prefix (empty string if none) */
  prefix: string;
  /** Name of the resolved profile, or undefined if flags were used */
  profile?: string;
  /** Path to the profiles JSON file */
  profilesFile: string;
  /** Unified DBML file path: snash writes to it, migrate reads from it */
  file: string;
  /** Dry-run mode (migrate command) — preview without executing */
  dryRun: boolean;
  /** Records filter: 'all' | 'table1,table2' | undefined (no records processing) */
  records?: string;
}
