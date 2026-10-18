import { readFileSync } from 'node:fs';
import ts from 'typescript';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const TOOL = { name: 'apimigrate', version: pkg.version, parser: `typescript@${ts.version}` };
