import fs from 'node:fs';

/** A module specifier as it stands in the source. */
export interface Specifier {
  /** The text between the quotes. */
  text: string;
  /** Offsets of the literal, quotes included. */
  start: number;
  end: number;
}

/** Everything one source file says without a type checker being asked. */
export interface FileScan {
  /** The file could not be read; every other field is empty. */
  unreadable: boolean;
  /** A `norefs-ignore-file` mark stands in the file's leading comments. */
  fileSuppressed: boolean;
  /** Offset where each line begins; line N is at index N - 1. */
  lineStarts: number[];
  /** 1-based lines carrying a `norefs-ignore` mark. */
  suppressedLines: number[];
  /** 1-based lines whose first non-blank character opens a comment. */
  commentLines: number[];
  specifiers: Specifier[];
}

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

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

function isLineBreak(c: string): boolean {
  return c === '\n' || c === '\r';
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\r' || c === '\n';
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
  if (tokens.length === 0) return true;
  const previous = tokens[tokens.length - 1];
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
    const c = text[position];

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
        while (scan < length && isIdentPart(text[scan])) scan++;
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
      while (scan < length && isIdentPart(text[scan])) scan++;
      tokens.push({ kind: 'ident', punct: '', start: position, end: scan, innerStart: 0, innerEnd: 0 });
      position = scan;
      continue;
    }

    if (c >= '0' && c <= '9') {
      let scan = position;
      while (scan < length && (isIdentPart(text[scan]) || text[scan] === '.')) scan++;
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

function pushSpecifier(text: string, literal: Token, out: Specifier[]): void {
  out.push({ text: text.slice(literal.innerStart, literal.innerEnd), start: literal.start, end: literal.end });
}

/**
 * The specifier of the import or export clause starting at `index`, if it names
 * a module. Walks the clause grammar — bindings, commas, a brace group, `from`
 * — and stops at the first token no clause can contain, so a clause without a
 * specifier never runs into the statement that follows it.
 */
function scanClause(text: string, tokens: Token[], index: number, out: Specifier[]): number {
  let inBraces = false;
  let seenBraces = false;
  for (let j = index + 1; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.kind === 'str') {
      // `import 'x'` names a module; a string anywhere else needs `from`.
      if (j === index + 1 || (tokens[j - 1].kind === 'ident' && word(text, tokens[j - 1]) === 'from')) {
        pushSpecifier(text, token, out);
      }
      return j;
    }
    if (token.kind === 'ident') {
      if (!inBraces && DECLARATION_WORDS.has(word(text, token))) return j;
      continue;
    }
    if (token.kind !== 'punct') return j;
    if (token.punct === '{' && !inBraces && !seenBraces) {
      inBraces = true;
      seenBraces = true;
      continue;
    }
    if (token.punct === '}' && inBraces) {
      inBraces = false;
      continue;
    }
    if (token.punct === ',' || token.punct === '*') continue;
    return j;
  }
  return tokens.length;
}

function specifiersOf(text: string, tokens: Token[]): Specifier[] {
  const out: Specifier[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'ident') continue;

    const name = word(text, token);
    if (name === 'import' && i + 2 < tokens.length && tokens[i + 1].kind === 'punct' && tokens[i + 1].punct === '(') {
      if (tokens[i + 2].kind === 'str') pushSpecifier(text, tokens[i + 2], out);
      i += 2;
      continue;
    }
    if (name === 'import' || name === 'export') {
      i = scanClause(text, tokens, i, out);
      continue;
    }
    if (
      name === 'require' &&
      i + 2 < tokens.length &&
      tokens[i + 1].kind === 'punct' &&
      tokens[i + 1].punct === '(' &&
      tokens[i + 2].kind === 'str'
    ) {
      pushSpecifier(text, tokens[i + 2], out);
      i += 2;
    }
  }
  return out;
}

/** `norefs-ignore` after a comment opener, and not the `-file` form. */
function hasLineMark(line: string): boolean {
  const mark = 'norefs-ignore';
  for (let i = 0; i + 1 < line.length; i++) {
    if (line[i] !== '/' || (line[i + 1] !== '/' && line[i + 1] !== '*')) continue;
    let j = i + 2;
    while (j < line.length && isSpace(line[j])) j++;
    if (line.slice(j, j + mark.length) !== mark) continue;
    if (line[j + mark.length] === '-') continue;
    return true;
  }
  return false;
}

/** `norefs-ignore-file` after a comment opener, as a whole word. */
function hasFileMark(text: string): boolean {
  const mark = 'norefs-ignore-file';
  for (let i = 0; i + 1 < text.length; i++) {
    if (text[i] !== '/' || (text[i + 1] !== '/' && text[i + 1] !== '*')) continue;
    let j = i + 2;
    while (j < text.length && isSpace(text[j])) j++;
    if (text.slice(j, j + mark.length) !== mark) continue;
    const after = text[j + mark.length];
    if (after !== undefined && isIdentPart(after)) continue;
    return true;
  }
  return false;
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
  for (let line = 0; line < lineStarts.length; line++) {
    const start = lineStarts[line];
    const end = Math.max(start, line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length);
    const content = text.slice(start, end);
    if (hasLineMark(content)) suppressedLines.push(line + 1);
    if (opensWithComment(content)) commentLines.push(line + 1);
  }

  const { tokens, firstTokenStart } = tokenize(text);
  return {
    unreadable: false,
    fileSuppressed: hasFileMark(text.slice(0, firstTokenStart)),
    lineStarts,
    suppressedLines,
    commentLines,
    specifiers: specifiersOf(text, tokens),
  };
}

/** Read and scan these files. */
export function scanFiles(filePaths: string[]): FileScan[] {
  return filePaths.map(filePath => {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return {
        unreadable: true,
        fileSuppressed: false,
        lineStarts: [],
        suppressedLines: [],
        commentLines: [],
        specifiers: [],
      };
    }
    return scanText(text);
  });
}
