#!/usr/bin/env node

/**
 * Post-install script for sr-db-sync.
 *
 * Downloads the pre-compiled standalone binary for the current platform
 * from GitHub Releases and saves it to bin/dbs.bin, making the `dbs` command
 * work immediately without requiring Bun to be installed.
 *
 * If the download fails, the bin/dbs shell wrapper falls back to Bun.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'Serhioromano/sr-db-sync';

// Resolve paths relative to this script (scripts/install.js → package root)
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PACKAGE_ROOT, 'bin');
const BIN_PATH = path.join(BIN_DIR, 'dbs.bin');

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// Map Node's process.platform + process.arch to our binary names
function getBinaryName() {
  const platform = process.platform;   // 'linux' | 'darwin' | 'win32'
  const arch = process.arch;           // 'x64' | 'arm64'

  const map = {
    'linux-x64':    'dbs-linux-x64',
    'linux-arm64':  'dbs-linux-arm64',
    'darwin-x64':   'dbs-darwin-x64',
    'darwin-arm64': 'dbs-darwin-arm64',
    'win32-x64':    'dbs-windows-x64.exe',
  };

  const key = `${platform}-${arch}`;
  const name = map[key];

  if (!name) {
    console.warn(`⚠️  sr-db-sync: no prebuilt binary for ${key}.`);
    console.warn(`   Falling back to Bun runtime. Install Bun: https://bun.sh`);
    return null;
  }

  return name;
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath, { mode: 0o755 });
    https.get(url, (response) => {
      // Follow redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        download(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        try { fs.chmodSync(destPath, 0o755); } catch {}
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

async function main() {
  const binaryName = getBinaryName();
  if (!binaryName) {
    process.exit(0); // Not an error — will use Bun fallback via shell wrapper
  }

  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${binaryName}`;

  // Ensure bin directory exists
  fs.mkdirSync(BIN_DIR, { recursive: true });

  console.log(`📥 sr-db-sync: downloading standalone binary for ${binaryName}...`);

  try {
    await download(url, BIN_PATH);
    const sizeMB = (fs.statSync(BIN_PATH).size / 1024 / 1024).toFixed(0);
    console.log(`✅ sr-db-sync: binary ready (${sizeMB} MB)`);
  } catch (err) {
    // Clean up partial download
    try { fs.unlinkSync(BIN_PATH); } catch {}
    console.warn(`⚠️  sr-db-sync: failed to download binary: ${err.message}`);
    console.warn(`   Falling back to Bun runtime. Install Bun: https://bun.sh`);
    // Not a fatal error — bin/dbs wrapper handles the fallback.
  }
}

main();
