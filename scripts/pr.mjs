#!/usr/bin/env node
// Helper for action.yml: prints data derived from the evidence bundle. Usage: pr.mjs <paths|branch|body> <evidence.json> [runId|rulesPath]
import { readFileSync } from 'node:fs';
import { branchName, changedPaths, prBody } from '../src/prbody.js';

const [cmd, file, extra] = process.argv.slice(2);
const evidence = JSON.parse(readFileSync(file, 'utf8'));
if (cmd === 'paths') process.stdout.write(changedPaths(evidence).join('\0'));
else if (cmd === 'branch') process.stdout.write(branchName(evidence, extra));
else if (cmd === 'body') process.stdout.write(prBody(evidence, { rulesPath: extra }));
else {
  console.error('usage: pr.mjs <paths|branch|body> <evidence.json> [runId|rulesPath]');
  process.exit(2);
}
