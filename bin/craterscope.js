#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CRATERSCOPE_DIR = join(homedir(), '.craterscope');
const CONFIG_PATH = join(CRATERSCOPE_DIR, 'config.json');
const CACHE_DIR = join(CRATERSCOPE_DIR, 'cache');

const API_URL = 'https://tidy-buzzard-924.convex.site';
const DASHBOARD_URL = 'https://app.craterscope.com';
const MARKETPLACE = 'Crater-Scope/claude-plugins';
const PLUGIN_NAME = 'craterscope';

const command = process.argv[2];

switch (command) {
  case 'init':
    await init();
    break;
  case 'status':
    status();
    break;
  case 'logout':
    logout();
    break;
  default:
    printUsage();
    break;
}

async function init() {
  console.log('');
  console.log('  🔭 Crater Scope — Setup');
  console.log('  ─────────────────────────');
  console.log('');

  // Step 1: Check for Claude Code
  try {
    execSync('which claude', { stdio: 'pipe' });
  } catch {
    console.log('  ❌ Claude Code is not installed.');
    console.log('  Install it first: https://claude.ai/code');
    process.exit(1);
  }
  console.log('  ✓ Claude Code detected');

  // Step 2: Device code auth flow
  console.log('');
  console.log('  Requesting authorization...');

  let deviceCode, verificationUrl;
  try {
    const res = await fetch(`${API_URL}/api/cli/device-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    deviceCode = data.device_code;
    verificationUrl = data.verification_url;
  } catch (err) {
    console.log(`  ❌ Could not reach Crater Scope API: ${err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log(`  Your device code: ${deviceCode}`);
  console.log('');
  console.log('  Opening browser for authorization...');

  // Open browser
  try {
    const openCmd = process.platform === 'darwin' ? 'open' :
                    process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${openCmd} "${verificationUrl}"`, { stdio: 'pipe' });
  } catch {
    console.log(`  Could not open browser. Visit this URL manually:`);
    console.log(`  ${verificationUrl}`);
  }

  console.log('');
  console.log('  Waiting for authorization...');

  // Step 3: Poll for authorization
  const maxAttempts = 120; // 10 minutes at 5-second intervals
  let authorized = false;
  let apiKey, orgName, email;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);

    try {
      const res = await fetch(`${API_URL}/api/cli/poll?device_code=${deviceCode}`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();

      if (data.status === 'authorized') {
        apiKey = data.apiKey;
        orgName = data.orgName;
        email = data.email;
        authorized = true;
        break;
      }

      if (data.status === 'expired') {
        console.log('  ❌ Authorization timed out. Run `npx craterscope init` to try again.');
        process.exit(1);
      }

      if (data.status === 'error') {
        console.log(`  ❌ ${data.error}`);
        process.exit(1);
      }

      // Still pending — show a dot for progress
      process.stdout.write('.');
    } catch {
      // Network error — keep trying
      process.stdout.write('?');
    }
  }

  if (!authorized) {
    console.log('\n  ❌ Authorization timed out.');
    process.exit(1);
  }

  console.log('');
  console.log(`  ✓ Authorized — joined ${orgName}`);

  // Step 4: Save config
  const config = {
    apiUrl: API_URL,
    apiKey,
    email,
    orgName,
    installedAt: new Date().toISOString(),
  };

  mkdirSync(CRATERSCOPE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log('  ✓ Credentials saved');

  // Step 5: Install Claude Code plugin
  console.log('');
  console.log('  Installing Crater Scope plugin for Claude Code...');

  try {
    try {
      execSync(`claude plugin marketplace add ${MARKETPLACE}`, { stdio: 'pipe', encoding: 'utf-8' });
      console.log('  ✓ Marketplace added');
    } catch (e) {
      if (e.stderr?.includes('already')) {
        console.log('  ✓ Marketplace already configured');
      } else {
        console.log(`  ⚠ Marketplace: ${e.stderr || e.message}`);
      }
    }

    try {
      const slug = MARKETPLACE.replace('/', '-');
      execSync(`claude plugin install ${PLUGIN_NAME}@${slug}`, { stdio: 'pipe', encoding: 'utf-8' });
      console.log('  ✓ Plugin installed');
    } catch (e) {
      if (e.stderr?.includes('already')) {
        console.log('  ✓ Plugin already installed');
      } else {
        console.log(`  ⚠ Plugin install: ${e.stderr || e.message}`);
      }
    }
  } catch (e) {
    console.log(`  ⚠ Could not auto-install plugin: ${e.message}`);
    console.log('  You can install manually in Claude Code:');
    console.log(`    /plugin marketplace add ${MARKETPLACE}`);
    console.log(`    /plugin install ${PLUGIN_NAME}`);
  }

  // Step 6: Sync scopes if in a craterscope repo
  console.log('');
  try {
    let dir = process.cwd();
    let projectId = '';
    while (dir !== '/') {
      const f = join(dir, '.craterscope.json');
      if (existsSync(f)) {
        try {
          projectId = JSON.parse(readFileSync(f, 'utf-8')).project_id;
        } catch {}
        break;
      }
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }

    if (projectId) {
      console.log(`  Syncing scopes for project ${projectId}...`);
      try {
        const url = `${config.apiUrl}/api/plugin/scopes?project_id=${encodeURIComponent(projectId)}`;
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          const cachePath = join(CACHE_DIR, `scopes-${projectId}.json`);
          writeFileSync(cachePath, JSON.stringify({
            ...data,
            project_id: projectId,
            fetched_at: Date.now(),
          }, null, 2), { mode: 0o600 });
          console.log(`  ✓ Scopes synced (${(data.assigned_scopes || []).length} scopes assigned)`);
        } else {
          console.log(`  ⚠ Could not sync scopes (API returned ${res.status})`);
        }
      } catch {
        console.log('  ⚠ Could not reach API to sync scopes');
      }
    } else {
      console.log('  No .craterscope.json found in this repo.');
      console.log('  Scopes will sync automatically when you open Claude Code in a managed repo.');
    }
  } catch {}

  // Done
  console.log('');
  console.log('  ─────────────────────────');
  console.log('  ✓ Crater Scope is ready!');
  console.log('');
  console.log('  Open Claude Code in any Crater Scope-managed repo');
  console.log('  and your scope restrictions will be enforced automatically.');
  console.log('');
}

function status() {
  console.log('');
  console.log('  🔭 Crater Scope — Status');
  console.log('  ─────────────────────────');

  if (!existsSync(CONFIG_PATH)) {
    console.log('  Not configured. Run: npx craterscope init');
    process.exit(0);
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  console.log(`  Email: ${config.email || 'unknown'}`);
  console.log(`  Org: ${config.orgName || 'unknown'}`);
  console.log(`  API: ${config.apiUrl}`);
  console.log(`  Key: ${config.apiKey.slice(0, 8)}...`);
  console.log(`  Installed: ${config.installedAt}`);

  if (existsSync(CACHE_DIR)) {
    const files = readdirSync(CACHE_DIR).filter(f => f.startsWith('scopes-'));
    if (files.length > 0) {
      console.log(`  Cached projects: ${files.length}`);
      files.forEach(f => {
        try {
          const data = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf-8'));
          const age = Date.now() - (data.fetched_at || 0);
          const hours = Math.round(age / 3600000);
          console.log(`    ${data.project_id || f}: ${(data.assigned_scopes || []).length} scopes (${hours}h ago)`);
        } catch {}
      });
    }
  }
  console.log('');
}

function logout() {
  if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH);
    console.log('  Logged out. Run `npx craterscope init` to reconfigure.');
  } else {
    console.log('  Not configured.');
  }
}

function printUsage() {
  console.log('');
  console.log('  🔭 Crater Scope');
  console.log('');
  console.log('  Usage:');
  console.log('    npx craterscope init      Set up credentials and install plugin');
  console.log('    npx craterscope status    Show current configuration');
  console.log('    npx craterscope logout    Remove credentials');
  console.log('');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
