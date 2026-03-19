#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARD_SRC = path.resolve(__dirname, '../../dashboard/dist');
const DASHBOARD_DEST = path.resolve(__dirname, '../dist/dashboard');

async function bundle() {
  console.log('📦 Bundling dashboard into daemon dist...');
  console.log(`   Source: ${DASHBOARD_SRC}`);
  console.log(`   Dest:   ${DASHBOARD_DEST}`);

  // Check source exists
  if (!fs.existsSync(DASHBOARD_SRC)) {
    console.error('❌ Dashboard not built!');
    console.error('   Run: cd packages/dashboard && npm run build');
    process.exit(1);
  }

  // Check index.html exists (sanity check)
  if (!fs.existsSync(path.join(DASHBOARD_SRC, 'index.html'))) {
    console.error('❌ Dashboard build incomplete (index.html missing)!');
    process.exit(1);
  }

  // Remove old bundle if exists
  if (fs.existsSync(DASHBOARD_DEST)) {
    console.log('   Removing old bundle...');
    fs.removeSync(DASHBOARD_DEST);
  }

  // Copy dashboard dist → daemon dist/dashboard
  fs.copySync(DASHBOARD_SRC, DASHBOARD_DEST);

  // Verify copy
  const files = fs.readdirSync(DASHBOARD_DEST);
  const indexExists = fs.existsSync(path.join(DASHBOARD_DEST, 'index.html'));

  if (!indexExists) {
    console.error('❌ Bundle verification failed (index.html not found)!');
    process.exit(1);
  }

  console.log(`✅ Bundled ${files.length} dashboard files → dist/dashboard/`);
  console.log(`   Files: ${files.join(', ')}`);

  // Calculate size
  const sizeKB = (getDirectorySize(DASHBOARD_DEST) / 1024).toFixed(2);
  console.log(`   Size:  ${sizeKB} KB`);
}

function getDirectorySize(dirPath) {
  let size = 0;
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      size += getDirectorySize(filePath);
    } else {
      size += stats.size;
    }
  }

  return size;
}

bundle().catch(err => {
  console.error('❌ Dashboard bundle failed:', err.message);
  process.exit(1);
});
