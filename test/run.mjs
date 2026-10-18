// Runs every test/*.test.js file. Node 20 does not expand globs passed to --test, and npm on Windows
// does not expand them in the shell, so the files are listed here and passed by name. Names are
// relative with forward slashes, because Node 21 and later read them as glob patterns, where a
// Windows backslash would be an escape.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
