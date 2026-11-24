// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers, and writes
// every change or none, printing what it changed or why it failed. SPEC.md is the contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when the path holds something in the tree as the edits left it (a file or a directory on disk). */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Line matching (SPEC.md section 5) ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Every 0-based position at or after `from` where O's lines match the file's lines at `tier`. */
function findOccurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  const want = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normLine(lines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/**
 * The first tier at which O occurs at or after `from`, with its positions; null when it
 * occurs at no tier. With --strict only tier 0 is tried. When `eofOnly`, only occurrences
 * that end at the file's last line count.
 */
function findFirstTier(
  O: string[],
  lines: string[],
  strict: boolean,
  from: number,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = findOccurrences(O, lines, t, from);
    if (eofOnly) pos = pos.filter((p) => p + O.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of an old or a new block; `ctx` lines are written as the file's own matched line. */
interface RLine {
  text: string;
  ctx: boolean;
}

/** N replaces O at `pos` in `lines`, following section 5 (context lines kept, tier-2 re-indent). */
function replaceAt(lines: string[], pos: number, O: RLine[], N: RLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  const ctxFile: string[] = [];
  for (let k = 0; k < O.length; k++) if (O[k]!.ctx) ctxFile.push(lines[pos + k]!);
  let ci = 0;
  const f = O.length > 0 ? leadingWs(lines[pos]!) : '';
  const p = O.length > 0 ? leadingWs(O[0]!.text) : '';
  for (const n of N) {
    if (n.ctx) {
      out.push(ctxFile[ci++]!);
      continue;
    }
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else out.push(n.text);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** N is inserted at `pos` in `lines` (an empty O); the lines are written as they are. */
function insertAt(lines: string[], pos: number, N: RLine[]): string[] {
  const out = lines.slice(0, pos);
  for (const n of N) out.push(n.text);
  out.push(...lines.slice(pos));
  return out;
}

// ---- Unified diffs (SPEC.md section 6) ----

type BodyEntry = { kind: 'ctx' | 'old' | 'new' | 'bslash'; text: string; rawEmpty: boolean };

function bodyEntry(line: string): BodyEntry | null {
  if (line === '') return { kind: 'ctx', text: '', rawEmpty: true };
  const c = line[0];
  if (c === ' ') return { kind: 'ctx', text: line.slice(1), rawEmpty: false };
  if (c === '-') return { kind: 'old', text: line.slice(1), rawEmpty: false };
  if (c === '+') return { kind: 'new', text: line.slice(1), rawEmpty: false };
  if (c === '\\') return { kind: 'bslash', text: line, rawEmpty: false };
  return null;
}

interface Hunk {
  a: number;
  body: BodyEntry[];
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at]!);
  if (!m) throw new Exit2(`error: parse ${at + 1}`);
  const body: BodyEntry[] = [];
  let i = at + 1;
  while (i < lines.length) {
    const b = lines[i]!;
    if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    const e = bodyEntry(b);
    if (e === null) break;
    body.push(e);
    i++;
  }
  while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
  return { hunk: { a: Number(m[1]), body }, next: i };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function noNewlineAtEnd(body: BodyEntry[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bslash';
}

/** The path a `--- ` or `+++ ` header line names (null: /dev/null). */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A section's hunks applied in order to a document. */
function applyHunks(doc: Doc, hunks: Hunk[], path: string, strict: boolean): Doc {
  let lines = doc.lines.slice();
  let fin = doc.final;
  let d = 0;
  for (const h of hunks) {
    const O: RLine[] = [];
    const N: RLine[] = [];
    for (const e of h.body) {
      if (e.kind === 'ctx') {
        O.push({ text: e.text, ctx: true });
        N.push({ text: e.text, ctx: true });
      } else if (e.kind === 'old') O.push({ text: e.text, ctx: false });
      else if (e.kind === 'new') N.push({ text: e.text, ctx: false });
    }
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      lines = insertAt(lines, pos, N);
      if (atEnd) fin = !noNewlineAtEnd(h.body);
      d += N.length;
    } else {
      const found = findFirstTier(
        O.map((o) => o.text),
        lines,
        strict,
        0,
      );
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + O.length === lines.length;
      lines = replaceAt(lines, best, O, N, found.tier);
      if (atEnd) fin = !noNewlineAtEnd(h.body);
      d += N.length - O.length;
    }
  }
  return { lines, br: doc.br, final: fin };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld !== undefined ? sec.diffOld : null;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew !== undefined ? sec.diffNew : null;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (tree.exists(newP)) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.body) if (e.kind === 'new') plus.push(e.text);
      let fin = true;
      let foundPlus = false;
      for (let hi = sec.hunks.length - 1; hi >= 0 && !foundPlus; hi--) {
        const b = sec.hunks[hi]!.body;
        for (let k = b.length - 1; k >= 0; k--) {
          if (b[k]!.kind === 'new') {
            fin = b[k + 1]?.kind !== 'bslash';
            foundPlus = true;
            break;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.exists(newP)) throw new Fail('exists', newP);
      const nd = applyHunks(parseDoc(tree.get(oldP)!), sec.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeDoc(nd));
      tree.recordMove(oldP, newP);
      return;
    }
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const nd = applyHunks(parseDoc(tree.get(oldP)!), sec.hunks, oldP, strict);
    tree.now.set(oldP, serializeDoc(nd));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: Section[] = [];
  const newSec = (): Section => {
    const s: Section = {
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      diffOld: undefined,
      diffNew: undefined,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    secs.push(s);
    return s;
  };
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSec();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = line.slice(10).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        inHeader = false;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSec();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i++;
  }
  return secs.map((s) => unifiedSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const doc = parseDoc(t);
    const found = findFirstTier(oldLines, doc.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const O: RLine[] = oldLines.map((l) => ({ text: l, ctx: false }));
    const N: RLine[] = newLines.map((l) => ({ text: l, ctx: false }));
    const out = replaceAt(doc.lines, found.positions[0]!, O, N, found.tier);
    tree.now.set(path, serializeDoc({ lines: out, br: doc.br, final: doc.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!;
        if (t.trim() === '') continue;
        if (t.trimStart().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let sep = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '=======') {
          sep = k;
          break;
        }
        if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
      let end = -1;
      for (let k = sep + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
        if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
      prevPath = path;
      prevEnd = end + 1;
      i = end + 1;
    } else i++;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  startLine: number;
  body: Array<{ text: string; lineNo: number }>;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: V4ASection['kind'] | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const body: Array<{ text: string; lineNo: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      body.push({ text: l, lineNo: i + 1 });
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    sections.push({ kind, path, startLine, body });
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const b of sec.body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.lineNo}`);
      }
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (sec.kind === 'delete') {
      for (const b of sec.body) {
        if (!blank(b.text)) throw new Exit2(`error: parse ${b.lineNo}`);
      }
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // update
    let idx = 0;
    while (idx < sec.body.length && blank(sec.body[idx]!.text)) idx++;
    let moveTo: string | null = null;
    if (idx < sec.body.length && sec.body[idx]!.text.startsWith('*** Move to: ')) {
      moveTo = sec.body[idx]!.text.slice(13).trim();
      idx++;
    }
    const chunks: V4AChunk[] = [];
    let cur: V4AChunk | null = null;
    let firstChunk = true;
    while (idx < sec.body.length) {
      const b = sec.body[idx]!;
      if (b.text.startsWith('@@')) {
        cur = { anchor: b.text.slice(2).trim(), eof: false, body: [] };
        chunks.push(cur);
        firstChunk = false;
        idx++;
        continue;
      }
      if (b.text === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${b.lineNo}`);
        cur.eof = true;
        cur = null;
        idx++;
        continue;
      }
      if (blank(b.text) && cur === null && !firstChunk) {
        idx++;
        continue;
      }
      if (b.text === '' || b.text.startsWith(' ') || b.text.startsWith('-') || b.text.startsWith('+')) {
        if (cur === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${b.lineNo}`);
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
          firstChunk = false;
        }
        const e = bodyEntry(b.text)!;
        cur.body.push(e);
        idx++;
        continue;
      }
      throw new Exit2(`error: parse ${b.lineNo}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.startLine}`);
    const p = sec.path;
    const mv = moveTo;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const t = tree.get(p);
      if (t === null) throw new Fail('missing', p);
      if (mv !== null && tree.exists(mv)) throw new Fail('exists', mv);
      let doc = parseDoc(t);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const a = findFirstTier([ch.anchor], doc.lines, strict, cursor);
          if (a === null) throw new Fail('no-match', p);
          cursor = a.positions[0]! + 1;
        }
        const O: RLine[] = [];
        const N: RLine[] = [];
        for (const e of ch.body) {
          if (e.kind === 'ctx') {
            O.push({ text: e.text, ctx: true });
            N.push({ text: e.text, ctx: true });
          } else if (e.kind === 'old') O.push({ text: e.text, ctx: false });
          else if (e.kind === 'new') N.push({ text: e.text, ctx: false });
        }
        if (O.length === 0) {
          const pos = ch.eof ? doc.lines.length : cursor;
          doc = { ...doc, lines: insertAt(doc.lines, pos, N) };
          cursor = pos + N.length;
        } else {
          const found = findFirstTier(
            O.map((o) => o.text),
            doc.lines,
            strict,
            cursor,
            ch.eof,
          );
          if (found === null) throw new Fail('no-match', p);
          const pos = found.positions[0]!;
          doc = { ...doc, lines: replaceAt(doc.lines, pos, O, N, found.tier) };
          cursor = pos + N.length;
        }
      }
      const out = serializeDoc(doc);
      if (mv !== null) {
        tree.now.set(p, null);
        tree.now.set(mv, out);
        tree.recordMove(p, mv);
      } else {
        tree.now.set(p, out);
      }
    });
  }
  return edits;
}

// ---- Running one invocation (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [o, n] of tree.moves) {
    const co = changed.get(o);
    const cn = changed.get(n);
    if (co && cn && co.now === null && cn.now !== null && co.was !== null && cn.was === null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const [p, { was, now }] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
