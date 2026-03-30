#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const CRATERSCOPE_DIR = join(homedir(), '.craterscope');
const CONFIG_PATH = join(CRATERSCOPE_DIR, 'config.json');
const CACHE_DIR = join(CRATERSCOPE_DIR, 'cache');

const API_URL = 'https://affable-armadillo-43.convex.site';
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

  // Step 2: Authenticate with email + invite code
  console.log('');
  console.log('  Enter the credentials your team admin gave you.');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  const email = await ask('  Email: ');
  const code = await ask('  Invite code: ');
  rl.close();

  if (!email || !code) {
    console.log('  ❌ Email and invite code are required.');
    process.exit(1);
  }

  // Call the API to validate invite and get API key
  console.log('');
  console.log('  Authenticating...');

  let authResult;
  try {
    const res = await fetch(`${API_URL}/api/cli/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        code: code.trim(),
      }),
      signal: AbortSignal.timeout(15000),
    });

    authResult = await res.json();

    if (!res.ok || authResult.error) {
      console.log(`  ❌ ${authResult.error || 'Authentication failed'}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(`  ❌ Could not reach Crater Scope API: ${err.message}`);
    process.exit(1);
  }

  console.log(`  ✓ Authenticated — joined ${authResult.orgName}`);

  // Save config
  const config = {
    apiUrl: API_URL,
    apiKey: authResult.apiKey,
    email: email.trim().toLowerCase(),
    orgName: authResult.orgName,
    installedAt: new Date().toISOString(),
  };

  mkdirSync(CRATERSCOPE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log('  ✓ Credentials saved');

  // Step 3: Install the Claude Code plugin
  console.log('');
  console.log('  Installing Crater Scope plugin for Claude Code...');

  try {
    try {
      execSync(`claude plugin marketplace add ${MARKETPLACE}`, {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      console.log('  ✓ Marketplace added');
    } catch (e) {
      if (e.stderr && e.stderr.includes('already')) {
        console.log('  ✓ Marketplace already configured');
      } else {
        console.log(`  ⚠ Marketplace: ${e.stderr || e.message}`);
      }
    }

    try {
      const marketplaceSlug = MARKETPLACE.replace('/', '-');
      execSync(`claude plugin install ${PLUGIN_NAME}@${marketplaceSlug}`, {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      console.log('  ✓ Plugin installed');
    } catch (e) {
      if (e.stderr && e.stderr.includes('already')) {
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

  // Step 4: Sync scopes for current repo (if in one)
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
  } catch {
    // Not in a git repo
  }

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

  // List cached scopes
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
