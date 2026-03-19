#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHARED_SRC = path.resolve(__dirname, '../../shared');
const SHARED_DEST = path.resolve(__dirname, '../node_modules/@kora/shared');

async function bundleShared() {
  console.log('📦 Bundling @kora/shared into daemon node_modules...');
  console.log(`   Source: ${SHARED_SRC}`);
  console.log(`   Dest:   ${SHARED_DEST}`);

  // Check source exists
  if (!fs.existsSync(SHARED_SRC)) {
    console.error('❌ @kora/shared not found!');
    process.exit(1);
  }

  // Check if shared is built
  const sharedDistPath = path.join(SHARED_SRC, 'dist');
  if (!fs.existsSync(sharedDistPath)) {
    console.error('❌ @kora/shared not built!');
    console.error('   Run: npm run build:shared');
    process.exit(1);
  }

  // Create @kora directory if needed
  const koraDir = path.dirname(SHARED_DEST);
  if (!fs.existsSync(koraDir)) {
    fs.mkdirSync(koraDir, { recursive: true });
  }

  // Remove old bundle if exists
  if (fs.existsSync(SHARED_DEST)) {
    console.log('   Removing old bundle...');
    fs.removeSync(SHARED_DEST);
  }

  // Copy shared package (dist + package.json)
  fs.mkdirSync(SHARED_DEST, { recursive: true });
  fs.copySync(sharedDistPath, path.join(SHARED_DEST, 'dist'));
  fs.copySync(
    path.join(SHARED_SRC, 'package.json'),
    path.join(SHARED_DEST, 'package.json')
  );

  // Install @kora/shared dependencies in its own node_modules
  console.log('   Installing @kora/shared dependencies...');
  const { execSync } = await import('child_process');
  try {
    execSync('npm install --production --no-package-lock', {
      cwd: SHARED_DEST,
      stdio: 'ignore'
    });
    console.log('   Installed dependencies (ajv)');
  } catch (err) {
    console.error('   Failed to install dependencies:', err.message);
    process.exit(1);
  }

  // Verify copy
  const distExists = fs.existsSync(path.join(SHARED_DEST, 'dist'));
  const pkgExists = fs.existsSync(path.join(SHARED_DEST, 'package.json'));

  if (!distExists || !pkgExists) {
    console.error('❌ Bundle verification failed!');
    process.exit(1);
  }

  console.log(`✅ Bundled @kora/shared → node_modules/@kora/shared/`);

  // Calculate size
  const sizeKB = (getDirectorySize(SHARED_DEST) / 1024).toFixed(2);
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

bundleShared().catch(err => {
  console.error('❌ @kora/shared bundle failed:', err.message);
  process.exit(1);
});
