import { UsageError } from './errors.js';

// Flags are declared per command, so a typo or a missing value is an error and never swallows the next argument.
export function parseArgs(argv, { bool = [], value = [], positional = 0 } = {}) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (bool.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
      flags[name] = true;
    } else if (value.includes(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new UsageError(`--${name} needs a value`);
      flags[name] = v;
    } else throw new UsageError(`unknown option --${name}`);
  }
  if (pos.length !== positional) throw new UsageError(`expected ${positional} argument${positional === 1 ? '' : 's'}, got ${pos.length}`);
  return { flags, pos };
}
