import ts from 'typescript';
import { walk } from './parse.js';

const TEST_FILE = /(?:\.|\/)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|(?:^|\/)(?:tests?|spec)\/.+\.[cm]?[jt]sx?$/;
const WEAK = new Set(['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'ok', 'anything', 'any']);
const SKIP_MODIFIERS = new Set(['skip', 'todo', 'only']);
const SKIP_NAMES = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe']);
const SUITE = new Set(['it', 'test', 'describe', 'context', 'suite']);
const COMMENTED = /\bexpect\s*\(|\bassert\w*\s*[.(]|\b(?:it|test|describe)\s*[.(]/;

export const isTestFile = (path) => TEST_FILE.test(path);

const rootName = (n) => {
  while (ts.isPropertyAccessExpression(n) || ts.isCallExpression(n)) n = n.expression;
  return ts.isIdentifier(n) ? n.text : null;
};

// Walks up from expect(...) to the matcher name, e.g. expect(x).not.toBe(y) gives toBe.
function matcherOf(expectCall) {
  let node = expectCall;
  let name = null;
  while (node.parent) {
    const p = node.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === node) { name = p.name.text; node = p; }
    else if (ts.isCallExpression(p) && p.expression === node) node = p;
    else break;
  }
  return name;
}

const isLiteral = (n) => n && (ts.isLiteralExpression(n) || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword);

// Structural facts about one test file. Comments never count as assertions.
export function scanTestFile(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true);
  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const out = { assertions: [], weak: [], noMatcher: [], tautologies: [], skips: [], commented: [] };

  walk(sf, (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'should') out.assertions.push(at(n));
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    const root = rootName(callee);
    const tail = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;

    if (ts.isIdentifier(callee) && callee.text === 'expect' || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'expect')) {
      out.assertions.push(at(n));
      const matcher = matcherOf(n);
      if (!matcher) out.noMatcher.push(at(n));
      if (WEAK.has(matcher)) out.weak.push(at(n));
      if (isLiteral(n.arguments[0])) out.tautologies.push(at(n));
    } else if (root === 'assert') {
      out.assertions.push(at(n));
      if (tail === 'ok' || ts.isIdentifier(callee)) out.weak.push(at(n));
      if ((tail === 'ok' || ts.isIdentifier(callee)) && isLiteral(n.arguments[0])) out.tautologies.push(at(n));
    } else if (root === 't' && ['is', 'true', 'false', 'deepEqual', 'equal', 'throws', 'truthy', 'falsy'].includes(tail)) {
      out.assertions.push(at(n));
      if (tail === 'truthy' || tail === 'falsy') out.weak.push(at(n));
    }
    if (root === 'expect' && (tail === 'anything' || tail === 'any')) out.weak.push(at(n));

    if (ts.isIdentifier(callee) && SKIP_NAMES.has(callee.text)) out.skips.push(at(n));
    if (ts.isPropertyAccessExpression(callee) && SKIP_MODIFIERS.has(callee.name.text) && SUITE.has(rootName(callee))) out.skips.push(at(n));
    if (root === 't' && tail === 'skip') out.skips.push(at(n));
    if (SUITE.has(root ?? '') || root === 'node:test') {
      for (const a of n.arguments) {
        if (!ts.isObjectLiteralExpression(a)) continue;
        for (const p of a.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && (p.name.text === 'skip' || p.name.text === 'todo') && p.initializer.kind !== ts.SyntaxKind.FalseKeyword) out.skips.push(at(p));
        }
      }
    }
  });

  // Every comment is leading trivia of some token, so walk tokens as well as nodes.
  const seen = new Set();
  const visit = (n) => {
    for (const r of ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      if (COMMENTED.test(sf.text.slice(r.pos, r.end))) out.commented.push(sf.getLineAndCharacterOfPosition(r.pos).line + 1);
    }
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a - b);
  return out;
}
