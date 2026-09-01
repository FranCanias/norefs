import fs from 'node:fs';
import { hasBlockMark, hasFileMark, hasLineMark } from './marks';
import { isSpace, isWordPart } from './text';

/** A module specifier as it stands in the source. */
export interface Specifier {
  /** The text between the quotes. */
  text: string;
  /** Offsets of the literal, quotes included. */
  start: number;
  end: number; // norefs-ignore: the test suite reads it, outside this tsconfig
  /**
   * True when the clause names types alone — `import type`, or braces whose
   * every binding is one. The compiler erases those, so nothing is left at run
   * time to need the package installed.
   */
  typeOnly: boolean;
  /**
   * The names the clause takes out of the module, as the module spells them:
   * `import { a as b }` takes `a`, a default import takes `default`. `*`
   * stands for the whole module — a namespace import, an `export *`, a
   * dynamic `import()` — which takes every name there is.
   */
  names: string[];
}

/** Everything one source file says without a type checker being asked. */
export interface FileScan {
  /** A `norefs-ignore-file` mark stands in the file's leading comments. */
  fileSuppressed: boolean;
  /** Offset where each line begins; line N is at index N - 1. */
  lineStarts: number[];
  /** 1-based lines carrying a `norefs-ignore` mark. */
  suppressedLines: number[];
  /** 1-based lines whose first non-blank character opens a comment. */
  commentLines: number[];
  specifiers: Specifier[];
  /** The packages the file's opening comments name. */
  namedInComments: Specifier[];
}

/** The name standing for every name a module has: `import * as`, `export *`, `import()`. */
export const WHOLE_MODULE = '*';

/** A triple-slash directive naming a types package, as TypeScript writes it. */
const TYPE_REFERENCE = /\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/g;

/**
 * A Jest docblock naming the environment to run this file in. The value can be
 * a short name — `node`, `jsdom` — or a package, and only a package matches
 * anything the manifest lists.
 */
const JEST_ENVIRONMENT = /@jest-environment\s+([@\w][\w./@-]*)/g;

type Kind = 'ident' | 'str' | 'punct' | 'number' | 'other';

interface Token {
  kind: Kind;
  punct: string;
  start: number;
  end: number;
  /** For a string, the text between the quotes. */
  innerStart: number;
  innerEnd: number;
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c > '\x7f';
}

function isLineBreak(c: string | undefined): boolean {
  return c === '\n' || c === '\r';
}

function word(text: string, token: Token): string {
  return text.slice(token.start, token.end);
}

const OPERATOR_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'do',
  'else',
  'case',
  'yield',
  'await',
  'void',
  'delete',
  'new',
  'throw',
  'default',
  'extends',
]);

/**
 * Whether a `/` here opens a regular expression rather than dividing. The
 * answer follows from the token before it: a value can be divided, an operator
 * or a keyword cannot. Guessing wrong is bounded — a regular expression may
 * not cross a line, so an unterminated one is re-read as division.
 */
function regexAllowed(text: string, tokens: Token[]): boolean {
  const previous = tokens.at(-1);
  if (!previous) return true;
  if (previous.kind === 'str' || previous.kind === 'number') return false;
  if (previous.kind === 'punct') return previous.punct !== ')' && previous.punct !== ']';
  if (previous.kind === 'ident') return OPERATOR_WORDS.has(word(text, previous));
  return true;
}

/** Read a string body, stopping at the closing quote or the end of the line. */
function scanQuoted(text: string, position: number, quote: string): number {
  while (position < text.length) {
    const c = text[position];
    if (c === '\\') {
      position += 2;
      continue;
    }
    if (c === quote || isLineBreak(c)) return position;
    position++;
  }
  return position;
}

/**
 * The token stream, with comments and whitespace dropped. Template literals
 * keep their substitutions tokenized, so an import inside one is still seen.
 */
function tokenize(text: string): { tokens: Token[]; firstTokenStart: number } {
  const length = text.length;
  const tokens: Token[] = [];
  let firstTokenStart = length;

  // One entry per template literal being read through a `${…}` substitution,
  // holding the brace depth at which that substitution closes.
  const templateStack: number[] = [];
  let braceDepth = 0;

  let position = 0;
  while (position < length) {
    const c = text[position]!;

    if (isSpace(c)) {
      position++;
      continue;
    }

    if (c === '/' && position + 1 < length) {
      if (text[position + 1] === '/') {
        while (position < length && !isLineBreak(text[position])) position++;
        continue;
      }
      if (text[position + 1] === '*') {
        position += 2;
        while (position + 1 < length && !(text[position] === '*' && text[position + 1] === '/')) position++;
        position = Math.min(position + 2, length);
        continue;
      }
    }

    if (firstTokenStart === length) firstTokenStart = position;

    if (c === '/' && regexAllowed(text, tokens)) {
      let scan = position + 1;
      let inClass = false;
      let closed = false;
      while (scan < length && !isLineBreak(text[scan])) {
        const r = text[scan];
        if (r === '\\') {
          scan += 2;
          continue;
        }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) {
          closed = true;
          break;
        }
        scan++;
      }
      if (closed) {
        while (scan < length && isWordPart(text[scan])) scan++;
        tokens.push({ kind: 'other', punct: '', start: position, end: scan + 1, innerStart: 0, innerEnd: 0 });
        position = scan + 1;
        continue;
      }
      // Unterminated: it was a division after all.
    }

    if (c === "'" || c === '"') {
      const inner = position + 1;
      const close = scanQuoted(text, inner, c);
      const end = Math.min(close + 1, length);
      tokens.push({ kind: 'str', punct: '', start: position, end, innerStart: inner, innerEnd: close });
      position = end;
      continue;
    }

    if (c === '`') {
      const inner = position + 1;
      let scan = inner;
      let substitution = false;
      while (scan < length) {
        if (text[scan] === '\\') {
          scan += 2;
          continue;
        }
        if (text[scan] === '`') break;
        if (text[scan] === '$' && scan + 1 < length && text[scan + 1] === '{') {
          substitution = true;
          break;
        }
        scan++;
      }
      tokens.push({
        kind: 'str',
        punct: '',
        start: position,
        end: Math.min(scan + 1, length),
        innerStart: inner,
        innerEnd: Math.min(scan, length),
      });
      if (substitution) {
        templateStack.push(braceDepth);
        braceDepth++;
        position = scan + 2;
      } else {
        position = Math.min(scan + 1, length);
      }
      continue;
    }

    if (isIdentStart(c)) {
      let scan = position;
      while (scan < length && isWordPart(text[scan])) scan++;
      tokens.push({ kind: 'ident', punct: '', start: position, end: scan, innerStart: 0, innerEnd: 0 });
      position = scan;
      continue;
    }

    if (c >= '0' && c <= '9') {
      let scan = position;
      while (scan < length && (isWordPart(text[scan]) || text[scan] === '.')) scan++;
      tokens.push({ kind: 'number', punct: '', start: position, end: scan, innerStart: 0, innerEnd: 0 });
      position = scan;
      continue;
    }

    if (c === '{') braceDepth++;
    if (c === '}') {
      braceDepth--;
      // The brace that closes a substitution hands the file back to the
      // template literal it interrupted.
      if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        let scan = position + 1;
        while (scan < length) {
          if (text[scan] === '\\') {
            scan += 2;
            continue;
          }
          if (text[scan] === '`') break;
          if (text[scan] === '$' && scan + 1 < length && text[scan + 1] === '{') {
            templateStack.push(braceDepth);
            braceDepth++;
            break;
          }
          scan++;
        }
        position = scan < length && text[scan] === '$' ? scan + 2 : Math.min(scan + 1, length);
        continue;
      }
    }

    tokens.push({ kind: 'punct', punct: c, start: position, end: position + 1, innerStart: 0, innerEnd: 0 });
    position++;
  }
  return { tokens, firstTokenStart };
}

/** The declaration keywords that end an import or export clause. */
const DECLARATION_WORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'enum',
  'abstract',
  'declare',
  'namespace',
  'module',
  'async',
  'interface',
]);

function pushSpecifier(text: string, literal: Token, typeOnly: boolean, names: string[], out: Specifier[]): void {
  out.push({
    text: text.slice(literal.innerStart, literal.innerEnd),
    start: literal.start,
    end: literal.end,
    typeOnly,
    names,
  });
}

/**
 * One binding inside the braces, as its words. `type X` and `type X as Y` are
 * erased; `{ type }` and `{ type as X }` bind a value that happens to be called
 * `type`.
 */
function isTypeBinding(words: string[]): boolean {
  if (words[0] !== 'type' || words.length < 2) return false;
  return !(words[1] === 'as' && words.length === 3);
}

/**
 * The specifier of the import or export clause starting at `index`, if it names
 * a module. Walks the clause grammar — bindings, commas, a brace group, `from`
 * — and stops at the first token no clause can contain, so a clause without a
 * specifier never runs into the statement that follows it.
 *
 * Along the way it reads whether the clause survives compilation. `import type`
 * is erased, and so are braces whose every binding is erased; a default or
 * namespace binding, a bare `import 'x'`, and `export *` all keep the module
 * present at run time.
 *
 * It reads the names the clause takes as well, spelled as the module spells
 * them. A namespace binding and an `export *` take the module whole, so they
 * take every name: `*` says so.
 */
function scanClause(text: string, tokens: Token[], index: number, out: Specifier[]): number {
  // `import type X from 'x'`, unless `type` is the binding itself, as in
  // `import type from 'x'`, `import type, { x } from 'x'`, `import type = …`.
  const keyword = tokens[index + 1];
  const after = tokens[index + 2];
  const typeKeyword =
    keyword?.kind === 'ident' &&
    word(text, keyword) === 'type' &&
    !(after?.kind === 'ident' && word(text, after) === 'from') &&
    !(after?.kind === 'punct' && (after.punct === ',' || after.punct === '='));

  let inBraces = false;
  let seenBraces = false;
  /** A binding the compiler keeps: a default, a namespace, a value in braces. */
  let valueBinding = false;
  let bindings = 0;
  let binding: string[] = [];
  const names: string[] = [];
  const endBinding = (): void => {
    if (binding.length === 0) return;
    bindings++;
    if (!isTypeBinding(binding)) valueBinding = true;
    // `{ a as b }` and `{ type a as b }` both take `a`; `{ type as b }` takes
    // a value called `type`.
    const source = isTypeBinding(binding) ? binding[1] : binding[0];
    if (source) names.push(source);
    binding = [];
  };

  for (let j = index + 1; j < tokens.length; j++) {
    const token = tokens[j];
    if (!token) break;
    if (token.kind === 'str') {
      // `import 'x'` names a module; a string anywhere else needs `from`.
      const before = tokens[j - 1];
      if (j === index + 1 || (before?.kind === 'ident' && word(text, before) === 'from')) {
        endBinding();
        // `import 'x'` runs the module for its side effects: nothing is erased.
        const typeOnly = j > index + 1 && (typeKeyword || (bindings > 0 && !valueBinding));
        pushSpecifier(text, token, typeOnly, names, out);
      }
      return j;
    }
    if (token.kind === 'ident') {
      const name = word(text, token);
      if (inBraces) {
        binding.push(name);
        continue;
      }
      if (DECLARATION_WORDS.has(name)) return j;
      // `import ns from`, `import * as ns from`: a binding that outlives the compile.
      if (name !== 'from' && name !== 'as' && !(j === index + 1 && typeKeyword)) {
        valueBinding = true;
        // The name of a namespace binding is the alias, not a name the module
        // has; the `*` before it already said the clause takes them all.
        if (!names.includes(WHOLE_MODULE)) names.push('default');
      }
      continue;
    }
    if (token.kind !== 'punct') return j;
    if (token.punct === '{' && !inBraces && !seenBraces) {
      inBraces = true;
      seenBraces = true;
      continue;
    }
    if (token.punct === '}' && inBraces) {
      endBinding();
      inBraces = false;
      continue;
    }
    if (token.punct === ',') {
      endBinding();
      continue;
    }
    if (token.punct === '*') {
      names.length = 0;
      names.push(WHOLE_MODULE);
      continue;
    }
    return j;
  }
  return tokens.length;
}

function specifiersOf(text: string, tokens: Token[]): Specifier[] {
  const out: Specifier[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind !== 'ident') continue;

    const name = word(text, token);
    const next = tokens[i + 1];
    const argument = tokens[i + 2];
    if (name === 'import' && next?.kind === 'punct' && next.punct === '(' && argument) {
      if (argument.kind === 'str') pushSpecifier(text, argument, inTypePosition(text, tokens, i), [WHOLE_MODULE], out);
      i += 2;
      continue;
    }
    if (name === 'import' || name === 'export') {
      i = scanClause(text, tokens, i, out);
      continue;
    }
    if (name !== 'require') continue;
    if (next?.kind === 'punct' && next.punct === '(' && argument?.kind === 'str') {
      pushSpecifier(text, argument, false, [WHOLE_MODULE], out);
      i += 2;
      continue;
    }
    // `require.resolve('pkg')` names a package as plainly as loading it does.
    // A config that points a tool at a parser writes it this way and nothing
    // else in the project mentions the package.
    const open = tokens[i + 3];
    const resolved = tokens[i + 4];
    if (
      next?.kind === 'punct' &&
      next.punct === '.' &&
      argument?.kind === 'ident' &&
      word(text, argument) === 'resolve' &&
      open?.kind === 'punct' &&
      open.punct === '(' &&
      resolved?.kind === 'str'
    ) {
      pushSpecifier(text, resolved, false, [WHOLE_MODULE], out);
      i += 4;
    }
  }
  return out;
}

/** Words a type can follow: `typeof import('x')`, `T extends import('x').U`. */
const TYPE_WORDS = new Set(['typeof', 'keyof', 'extends', 'infer', 'is', 'as', 'satisfies', 'readonly']);

/** Punctuation a type can follow: an annotation, a union arm, a type argument. */
const TYPE_PUNCT = new Set([':', '|', '&', '<', '?']);

/** Punctuation that closes whatever came before it, so a statement starts after. */
const STATEMENT_EDGE = new Set([';', '{', '}', '(', '[', ',']);

/**
 * Whether the `import(` at `index` is written where a type goes.
 *
 * The two forms share every character. `import('pkg')` as an expression loads
 * the module and needs it installed; the same words in a type position are a
 * type query, erased before anything runs — and calling one the other puts a
 * package in the wrong section of the manifest. Without a checker, position is
 * the only thing left to read, so this reads the token before it.
 *
 * `=` is the one marker that says nothing on its own: `type Box = import('x')`
 * and `const load = import('x')` write it alike. There the word the statement
 * opens with decides, found by walking back to the start of the line.
 */
function inTypePosition(text: string, tokens: Token[], index: number): boolean {
  const previous = tokens[index - 1];
  if (!previous) return false;
  if (previous.kind === 'ident') return TYPE_WORDS.has(word(text, previous));
  if (previous.kind !== 'punct') return false;
  if (TYPE_PUNCT.has(previous.punct)) return true;
  return previous.punct === '=' && opensTypeAlias(text, tokens, index);
}

/**
 * True when the statement holding the token at `index` opens with `type`.
 *
 * The walk goes back to the first token of the line, and stops early at
 * punctuation that ends whatever stood before it — so a call argument or an
 * object member is read as its own thing rather than as the statement around
 * it. An `export` or a `declare` in front is skipped: both leave the next word
 * saying what the statement is.
 */
function opensTypeAlias(text: string, tokens: Token[], index: number): boolean {
  let start = index;
  for (let j = index - 1; j >= 0; j--) {
    const token = tokens[j];
    if (!token) break;
    if (token.kind === 'punct' && STATEMENT_EDGE.has(token.punct)) break;
    start = j;
    if (opensLine(text, tokens, j)) break;
  }
  for (let j = start; j < index; j++) {
    const token = tokens[j];
    if (token?.kind !== 'ident') return false;
    const name = word(text, token);
    if (name === 'export' || name === 'declare') continue;
    return name === 'type';
  }
  return false;
}

/** True when nothing but the line break and whitespace stands before this token. */
function opensLine(text: string, tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (!token) return false;
  const previous = tokens[index - 1];
  if (!previous) return true;
  return text.slice(previous.end, token.start).includes('\n');
}

/**
 * `norefs-ignore` or `norefs-ignore-block` on this line. The kinds this
 * pipeline reports — a file, a dependency, an import — have nothing nested
 * inside them, so the block form reaches exactly as far as the line form here.
 */
function isSuppressedLine(line: string): boolean {
  return hasLineMark(line) || hasBlockMark(line);
}

/** True when nothing but whitespace stands before the comment opening the line. */
function opensWithComment(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i + 1 < line.length && line[i] === '/' && (line[i + 1] === '/' || line[i + 1] === '*');
}

/** Scan text already in memory, for a file the caller has read or edited. */
export function scanText(text: string): FileScan {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }

  // The marks read whole lines, not comments, so a mark inside a string counts
  // exactly as it does in a line-by-line reading.
  const suppressedLines: number[] = [];
  const commentLines: number[] = [];
  for (const [line, start] of lineStarts.entries()) {
    const next = lineStarts[line + 1];
    const end = Math.max(start, next === undefined ? text.length : next - 1);
    const content = text.slice(start, end);
    if (isSuppressedLine(content)) suppressedLines.push(line + 1);
    if (opensWithComment(content)) commentLines.push(line + 1);
  }

  const { tokens, firstTokenStart } = tokenize(text);
  return {
    fileSuppressed: hasFileMark(text.slice(0, firstTokenStart)),
    lineStarts,
    suppressedLines,
    commentLines,
    specifiers: specifiersOf(text, tokens),
    namedInComments: namedInComments(text.slice(0, firstTokenStart)),
  };
}

/**
 * The packages a file's opening comments name.
 *
 * A comment is the one place the import graph never looks, and two of them
 * carry a package the run needs. `/// <reference types="pantry-types" />` says
 * the build needs that package; `@jest-environment @edge-runtime/jest-environment`
 * says the test run loads that one. Nothing imports either, no script runs
 * either, and the report used to call both dead. Neither survives compilation,
 * so what they name is needed to build and never at run time.
 *
 * Only the prologue is read — everything before the first token — because that
 * is the only place either one is honoured. The same words further down are
 * prose.
 */
export function namedInComments(prologue: string): Specifier[] {
  const found: Specifier[] = [];
  for (const pattern of [TYPE_REFERENCE, JEST_ENVIRONMENT]) {
    for (const match of prologue.matchAll(pattern)) {
      // Each pattern's one group is not optional: every match captures it.
      const name = match[1]!;
      const start = match[0].lastIndexOf(name) + match.index;
      found.push({ text: name, start, end: start + name.length, typeOnly: true, names: [] });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Every string a file writes, the module specifiers among them, and the bare
 * words it writes as object keys.
 *
 * A tool config is read for the strings in it, and reading them off the token
 * stream is what keeps a comment out of the answer. A path or a package name
 * inside a commented-out line is a line somebody turned off: counting it
 * cancels a real entry point, or keeps a dead dependency looking alive.
 *
 * The keys are for a short name written without quotes. ESLint's
 * `'import/resolver': { typescript: true }` names a resolver as a key, and
 * `plugins: { import: importPlugin }` names a plugin the same way. Only a key
 * is read — the word before a colon, after a brace or a comma — because every
 * other bare word in a file of code is the code. `import js from '@eslint/js'`
 * is not the import plugin, and a config with a `typescript` binding in it is
 * not using a resolver.
 */
export function configLiterals(text: string): { strings: string[]; specifiers: string[]; keys: string[] } {
  const { tokens } = tokenize(text);
  const strings: string[] = [];
  const keys: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'str') strings.push(text.slice(token.innerStart, token.innerEnd));
    else if (token.kind === 'ident' && isObjectKey(tokens, index)) keys.push(word(text, token));
  }
  return { strings, specifiers: specifiersOf(text, tokens).map(specifier => specifier.text), keys };
}

/** True when the identifier at `index` is written as an object literal's key. */
function isObjectKey(tokens: Token[], index: number): boolean {
  const before = tokens[index - 1];
  const after = tokens[index + 1];
  return (
    after?.kind === 'punct' &&
    after.punct === ':' &&
    before?.kind === 'punct' &&
    (before.punct === '{' || before.punct === ',')
  );
}

/** The key a bundler writes its "leave this to the run time" list under. */
const EXTERNAL_KEY = /^externals?$/;

/** An array literal as the token stream sees it: its strings, and the names in it. */
interface ArrayLiteral {
  strings: string[];
  /** Identifiers written inside — a spread, a reference — and '' for anything else. */
  names: string[];
}

/** Read an array literal, starting at its opening bracket. */
function readArray(text: string, tokens: Token[], open: number): ArrayLiteral {
  const strings: string[] = [];
  const names: string[] = [];
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.punct === '[') depth++;
    else if (token.punct === ']' && --depth === 0) break;
    else if (token.kind === 'str') strings.push(text.slice(token.innerStart, token.innerEnd));
    else if (token.kind === 'ident') names.push(word(text, token));
    else if (token.kind === 'other') names.push('');
  }
  return { strings, names };
}

/**
 * The packages a build file leaves for the run time to provide.
 *
 * A bundler is told what not to inline — `external: ['esbuild', 'drizzle-orm']`
 * — and everything else it is handed goes inside the output file. That answers
 * a question no manifest can: whether the published package really needs a
 * dependency installed, or carries it already.
 *
 * `known: false` comes back when the file writes such a list and builds it out
 * of something this cannot read: a call, an object, a spread of an array that
 * is not in the same file. The only use for the answer is withholding a
 * report, so an unreadable list has to say so rather than look empty.
 */
export function bundlerExternals(text: string): { known: true; names: Set<string> } | { known: false } | undefined {
  if (!/\bexternals?\s*:/.test(text)) return undefined;
  const { tokens } = tokenize(text);
  const arrays = new Map<string, ArrayLiteral>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i]!.kind !== 'ident' || tokens[i + 1]!.punct !== '=' || tokens[i + 2]!.punct !== '[') continue;
    arrays.set(word(text, tokens[i]!), readArray(text, tokens, i + 2));
  }

  const names = new Set<string>();
  let declared = false;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const key = tokens[i]!;
    if (key.kind !== 'ident' || tokens[i + 1]!.punct !== ':' || !EXTERNAL_KEY.test(word(text, key))) continue;
    declared = true;
    if (tokens[i + 2]!.punct !== '[') return { known: false };
    const list = readArray(text, tokens, i + 2);
    for (const name of list.strings) names.add(name);
    for (const reference of list.names) {
      const nested = arrays.get(reference);
      if (!nested || nested.names.length > 0) return { known: false };
      for (const name of nested.strings) names.add(name);
    }
  }
  return declared ? { known: true, names } : undefined;
}

/** Read and scan these files. */
export function scanFiles(filePaths: string[]): FileScan[] {
  return filePaths.map(filePath => {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      // Nothing to say about a file that would not open. An empty scan keeps
      // nothing alive and reports nothing, which is the safe reading of it.
      return {
        fileSuppressed: false,
        lineStarts: [],
        suppressedLines: [],
        commentLines: [],
        specifiers: [],
        namedInComments: [],
      };
    }
    return scanText(text);
  });
}
