#!/usr/bin/env node
// Helper for action.yml in watch mode: opens one draft pull request per upgrade in a watch plan.
// Usage: watch-prs.mjs <plan.json>. TEST_CMD, when set, runs after each upgrade is applied. INSTALL_CMD is
// empty for the package manager the lockfile names, none to install nothing, or a command to run instead.
import { spawnSync } from 'node:child_process';
import { openWatchPullRequests } from '../src/watchpr.js';

const [planPath] = process.argv.slice(2);
if (!planPath) {
  console.error('usage: watch-prs.mjs <plan.json>');
  process.exit(2);
}
const gh = (args) => {
  const r = spawnSync('gh', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed with exit code ${r.status ?? r.error?.message}`);
};
process.exitCode = await openWatchPullRequests({ root: process.cwd(), planPath, testCmd: process.env.TEST_CMD || null, install: process.env.INSTALL_CMD || 'auto', gh, out: (s) => console.log(s), err: (s) => console.error(s) });
