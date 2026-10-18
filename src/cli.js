import { EXIT, UsageError } from './errors.js';
import { TrustError } from './signing.js';
import { VERSION } from './version.js';
import { parseArgs } from './args.js';
import * as agentApply from './commands/agentApply.js';
import * as apply from './commands/apply.js';
import * as check from './commands/check.js';
import * as draft from './commands/draft.js';
import * as gate from './commands/gate.js';
import * as keygen from './commands/keygen.js';
import * as lint from './commands/lint.js';
import * as sign from './commands/sign.js';
import * as verify from './commands/verify.js';
import * as watch from './commands/watch.js';

const COMMANDS = [keygen, lint, sign, check, draft, apply, agentApply, verify, gate, watch];
const byName = Object.fromEntries(COMMANDS.map((c) => [c.spec.name, c]));

export function helpFor(name) {
  const c = byName[name];
  const lines = [`usage: apimigrate ${c.spec.usage}`, '', c.spec.summary];
  if (c.spec.options.length) lines.push('', 'options:', ...c.spec.options.map(([f, d]) => `  ${f.padEnd(34)}${d}`));
  return lines.join('\n');
}

export function help() {
  const width = Math.max(...COMMANDS.map((c) => c.spec.name.length)) + 2;
  return [
    `apimigrate ${VERSION}`,
    '',
    'usage: apimigrate <command> [options]',
    '',
    'commands:',
    ...COMMANDS.map((c) => `  ${c.spec.name.padEnd(width)}${c.spec.summary}`),
    '',
    'run "apimigrate <command> --help" for options',
    'exit codes: 0 ok, 1 gate, test or verify failure, 2 usage or config error, 3 trust failure',
  ].join('\n');
}

export async function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    if (rest[0] && byName[rest[0]]) io.out(helpFor(rest[0]));
    else io.out(help());
    return EXIT.ok;
  }
  if (name === '--version' || name === '-v') return io.out(VERSION), EXIT.ok;
  const command = byName[name];
  if (!command) {
    io.err(`unknown command "${name}"\n\n${help()}`);
    return EXIT.usage;
  }
  if (rest.includes('--help') || rest.includes('-h')) return io.out(helpFor(name)), EXIT.ok;
  try {
    const args = parseArgs(rest, command.spec);
    return (await command.run(args, io)) ?? EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\n\n${helpFor(name)}`);
      return EXIT.usage;
    }
    if (e instanceof TrustError) {
      io.err(`trust error: ${e.message}`);
      return EXIT.trust;
    }
    io.err(`error: ${e.message}`);
    return EXIT.failed;
  }
}
