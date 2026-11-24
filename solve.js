// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly what
// makefun-site's build returns, byte for byte, but with hand-rolled scanners
// instead of regex passes, a single-pass Markdown renderer, memoized slugs and
// templates compiled to plain JavaScript functions once per case.
//
// The semantics are makefun-site's own (see its README in the kit): its front
// matter, template dialect, Markdown subset, slug rule and report. Wherever
// this file and that README differ, the reference code is the answer, so every
// branch below mirrors the reference implementation's decisions exactly,
// including its error strings and its edge cases (empty strong, unclosed
// fences, lists that swallow the next line, and so on).

// ------------------------------------------------------------------ text

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `s` with & < > " ' escaped, as one string (String.replace is native and
 * atomic, so no lastIndex bookkeeping is needed across the recursion). */
function escStr(s) {
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Whitespace code units (what /\s/ matches), as a table for fast scans. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

/** Whether a code unit is JavaScript whitespace (what /\s/ matches). */
function isWS(c) {
  return WS_TABLE[c] === 1;
}

/** The characters a backslash escapes in inline Markdown. */
function isEscapableCode(c) {
  return (
    c === 92 || // \
    c === 96 || // `
    c === 42 || // *
    c === 95 || // _
    c === 91 || // [
    c === 93 || // ]
    c === 40 || // (
    c === 41 || // )
    c === 35 || // #
    c === 43 || // +
    c === 45 || // -
    c === 46 || // .
    c === 33 || // !
    c === 62 // >
  );
}

/** The combining marks (Unicode general category M). */
const COMBINING = /\p{M}/gu;

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left. Pure ASCII text is slugified in a single pass; the first
 * non-ASCII character bails to the normalising path on the whole text.
 */
function slugifyRaw(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return slugifyWide(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** slugifyRaw for text holding a non-ASCII character (see slugifyRaw). */
function slugifyWide(text) {
  const plain = text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEYS_SET = new Set(KEYS);

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    // Fast path: no backslash and no quote before the closing one, so the
    // value is the inside as written (the two indexOf scans are native).
    if (raw.indexOf('\\', 1) === -1 && raw.indexOf('"', 1) === raw.length - 1) return { value: raw.slice(1, -1) };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a template name (a-z, 0-9 and -). */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug (a-z and 0-9, single - between). */
function isSlug(s) {
  if (s.length === 0) return false;
  let prevDash = true; // a leading dash is not allowed, so start "after a dash"
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
        if (ok) {
          y = Number(raw.slice(0, 4));
          mo = Number(raw.slice(5, 7));
          d = Number(raw.slice(8, 10));
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']'))
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Line numbers in
 * errors count from 1 at the opening `---`.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45)
    return { error: 'no front matter' };
  if (text.length > 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  // The close line: a line exactly `---` (a `\n---` followed by `\n` or end).
  // The search starts at the `\n` ending the opening line, so a close line
  // directly after it is found too.
  let closeStart = -1;
  let from = 3;
  for (;;) {
    const idx = text.indexOf('\n---', from);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = idx + 1;
      break;
    }
    from = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = 4;
  let lineNo = 2;
  while (lineStart < closeStart) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1 || lineEnd >= closeStart) lineEnd = closeStart - 1;
    const line = text.slice(lineStart, lineEnd);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let e = raw.length;
      while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
      raw = raw.slice(0, e);
      if (!KEYS_SET.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = closeStart + 3;
  const body = bodyStart < text.length && text.charCodeAt(bodyStart) === 10 ? text.slice(bodyStart + 1) : '';
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  // Fast path: most lines have no leading or trailing space or tab.
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(line.length - 1);
  if ((a !== 32 && a !== 9) && (b !== 32 && b !== 9)) return line;
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

/** A fence opening line: its language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    )
      j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < 6 && line.charCodeAt(d) === 35) d++;
  if (d === 0) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let j = d + 1;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end <= j) return null;
  return { depth: d, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (c0 === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet list item's text, or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 !== 45 && c0 !== 42) || line.charCodeAt(1) !== 32) return null;
  return trimLine(line.slice(2));
}

/** An ordered list item's start and text, or null. */
function orderedOf(line) {
  let d = 0;
  while (line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: trimLine(line.slice(d + 2)) };
}

/** Whether `line` continues a list item (two or more spaces, then non-space). */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (line.charCodeAt(j) === 32) j++;
  if (j >= line.length) return false;
  return !isWS(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1 || c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/** Whether `line` from `from` on holds only spaces and tabs. */
function trailingBlank(line, from) {
  for (let k = from; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * The first index from `from` where `s` holds `what` outside an escape, or
 * -1. Candidates come from indexOf; a candidate is escaped exactly when an
 * odd run of backslashes ends just before it (backslashes pair left to
 * right, and `what`'s first character is one a backslash escapes for both
 * callers, '*' and ']'), and the run cannot reach past `from`, whose
 * preceding character is the opening '*' or '['.
 */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let m = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) m++;
    if (m % 2 === 0) return k;
    j = k + 1;
  }
}

/**
 * The first single * from `from` (one whose run is not **), outside an
 * escape, or -1. Candidates come from indexOf; the escape test is the same
 * odd-backslash-run rule as findUnescaped.
 */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let m = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) m++;
    if (m % 2 === 1) {
      j = k + 1;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/** Whether `target` holds whitespace. */
function hasWS(target) {
  for (let i = 0; i < target.length; i++) if (isWS(target.charCodeAt(i))) return true;
  return false;
}

/** The characters that can start an inline construct or need escaping. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline into `out`; `link(target)` is a link's href. Plain
 * runs are pushed whole; only the constructs that change the text break a
 * run. The shared scanner regex is safe across the recursion below: every
 * branch that recurses sets lastIndex explicitly when it returns.
 */
function inlineInto(out, s, link) {
  let start = 0;
  INLINE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      const d = s[i + 1];
      if (d !== undefined && isEscapableCode(s.charCodeAt(i + 1))) {
        if (i > start) out.push(s.slice(start, i));
        out.push(d);
        INLINE_SPECIAL.lastIndex = i + 2;
        start = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<code>', escStr(s.slice(i + 1, j)), '</code>');
        INLINE_SPECIAL.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out.push(s.slice(start, i));
          out.push('<strong>');
          inlineInto(out, s.slice(i + 2, j), link);
          out.push('</strong>');
          INLINE_SPECIAL.lastIndex = j + 2;
          start = j + 2;
        } else {
          // No closer: both stars are literal, and the scan continues
          // after them, exactly as the reference's `i += 2` does.
          INLINE_SPECIAL.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<em>');
        inlineInto(out, s.slice(i + 1, j), link);
        out.push('</em>');
        INLINE_SPECIAL.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWS(target)) {
        if (i > start) out.push(s.slice(start, i));
        out.push('<a href="', escStr(link(target)), '">');
        inlineInto(out, s.slice(i + 1, k), link);
        out.push('</a>');
        INLINE_SPECIAL.lastIndex = mm + 1;
        start = mm + 1;
      }
      continue;
    }
    if (i > start) out.push(s.slice(start, i));
    out.push(ESCAPES[c]);
    start = i + 1;
  }
  if (start < s.length) out.push(s.slice(start));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). `slugify` is the case's
 * memoized slug function.
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      // Blank, or an indented line: only a blank line is a block of its own.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n) {
          const l = lines[i];
          if (l.charCodeAt(0) === 96 && l.charCodeAt(1) === 96 && l.charCodeAt(2) === 96 && trailingBlank(l, 3)) break;
          body.push(l);
          i++;
        }
        i++;
        out.push('<pre><code');
        if (lang !== '') {
          out.push(' class="language-', escStr(lang), '"');
        }
        out.push('>');
        if (body.length !== 0) out.push(escStr(body.join('\n')), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const inner = [];
        inlineInto(inner, h.text, link);
        const html = inner.join('');
        out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [[b]];
        i++;
        while (i < n) {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([m]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push('<ul>\n');
        for (const item of items) {
          out.push('<li>');
          inlineInto(out, item.join('\n'), link);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const rest = l.charAt(1) === ' ' ? l.slice(2) : l.slice(1);
        const t = trimLine(rest);
        if (t !== '') body.push(t);
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(out, body.join('\n'), link);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const items = [[o.text]];
        i++;
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([m.text]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push(o.start !== 1 ? `<ol start="${o.start}">\n` : '<ol>\n');
        for (const item of items) {
          out.push('<li>');
          inlineInto(out, item.join('\n'), link);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const inner = [];
      inlineInto(inner, text, link);
      excerpt = inner.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(out, text, link);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// --------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template rendering helpers -------------------------------------------
//
// Scopes are plain objects chained by prototype: the root scope holds the
// page's values on a null-prototype object, each `for` adds one child object
// holding its element and `loop`. A path's first name is then one property
// read; each next name is an own property of the value so far.

// Plain module functions, passed to the generated render functions as
// locals so V8 can inline them.

/** The value at `path` (2 segments) in scope `S`. */
function get2(S, a, b) {
  const v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  return v[b];
}

/** The value at `path` (3 segments) in scope `S`. */
function get3(S, a, b, c) {
  let v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  return v[c];
}

/** The value at `path` (4 segments) in scope `S`. */
function get4(S, a, b, c, d) {
  let v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  v = v[c];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, d)) return undefined;
  return v[d];
}

/** The value at `path` (any length) in scope `S`. */
function getN(S, p) {
  let v = S[p[0]];
  for (let k = 1; k < p.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p[k])) return undefined;
    v = v[p[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in its own digits, true or false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `v` as text, escaped, pushed into `O`. */
function escPush(O, v) {
  O.push(escStr(typeof v === 'string' ? v : textOf(v)));
}


/** Generated code for a path read in scope `scope`. */
function genPath(scope, path) {
  if (path.length === 1) return `${scope}[${JSON.stringify(path[0])}]`;
  if (path.length === 2) return `get2(${scope},${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
  if (path.length === 3)
    return `get3(${scope},${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
  if (path.length === 4)
    return `get4(${scope},${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])},${JSON.stringify(path[3])})`;
  return `getN(${scope},${JSON.stringify(path)})`;
}

/** Generated code for `nodes` rendered in scope `scope`. */
function genNodes(nodes, scope, ctx) {
  let code = '';
  for (const n of nodes) {
    if (n.kind === 'text') code += `O.push(${JSON.stringify(n.text)});`;
    else if (n.kind === 'var') code += `escPush(O,${genPath(scope, n.path)});`;
    else if (n.kind === 'raw') code += `{const V=${genPath(scope, n.path)};O.push(typeof V==='string'?V:textOf(V));}`;
    else if (n.kind === 'if') {
      code += `if(truthy(${genPath(scope, n.path)})!==${n.not}){${genNodes(n.then, scope, ctx)}}`;
      if (n.else !== null) code += `else{${genNodes(n.else, scope, ctx)}}`;
    } else if (n.kind === 'for') {
      const id = ctx.next++;
      const sv = `S${id}`;
      code += `{const X${id}=${genPath(scope, n.path)};if(Array.isArray(X${id})){const ${sv}=Object.create(${scope});const L${id}={index:0,first:false,last:false,length:X${id}.length};for(let K${id}=0;K${id}<X${id}.length;K${id}++){${sv}[${JSON.stringify(n.name)}]=X${id}[K${id}];${sv}.loop=L${id};L${id}.index=K${id}+1;L${id}.first=K${id}===0;L${id}.last=K${id}===X${id}.length-1;${genNodes(n.body, sv, ctx)}}}}`;
    } else if (n.kind === 'include') {
      const id = ctx.next++;
      // A memoized include: when the included template's output is fixed
      // by exactly one root that is not a case constant (site, tags and
      // recent are the same for every render of a case), a render of it
      // for that root value is reused. The cached string is a complete
      // render only while the callee's depth plus its longest include
      // chain fits the depth budget (the callee runs at D+1, so the caller
      // needs D + maxK <= 7); at a deeper caller depth the render is cut
      // short by the depth rule and is neither cached nor reused. A cycle
      // (maxK 99) or a template that reads `loop` never memoizes.
      const inf = ctx.info === undefined ? undefined : ctx.info.get(n.name);
      let memoRoot = null;
      if (inf !== undefined && inf.maxK < 99) {
        let count = 0;
        for (const r of inf.roots) {
          if (r === 'site' || r === 'tags' || r === 'recent' || r === 'loop') continue;
          count++;
          memoRoot = r;
        }
        if (count !== 1) memoRoot = null;
      }
      if (memoRoot === null) {
        code += `if(D<8){const F${id}=F[${JSON.stringify(n.name)}];if(F${id}!==undefined)F${id}(${scope},D+1,O);}`;
      } else {
        const nm = JSON.stringify(n.name);
        const rt = JSON.stringify(memoRoot);
        const mk = inf.maxK;
        code += `if(D<8){const F${id}=F[${nm}];if(F${id}!==undefined){const K${id}=${scope}[${rt}];let MM${id}=M[${nm}];if(MM${id}===undefined){MM${id}=new Map();M[${nm}]=MM${id};}let H${id}=MM${id}.get(K${id});if(H${id}!==undefined&&D+${mk}<=7){O.push(H${id});}else if(D+${mk}<=7){const A${id}=[];F${id}(${scope},D+1,A${id});H${id}=A${id}.join('');MM${id}.set(K${id},H${id});O.push(H${id});}else{F${id}(${scope},D+1,O);}}}`;
      }
    }
  }
  return code;
}

/** A template's nodes compiled to a render function (S, D, O). `info` is the
 * templates' root analysis (for the include memo) and `M` the case's memo
 * store, a plain object of template name to Map. */
function compileTemplate(body, F, info, M) {
  const src = genNodes(body, 'S', { next: 0, info });
  const maker = new Function(
    'textOf',
    'escPush',
    'truthy',
    'get2',
    'get3',
    'get4',
    'getN',
    'F',
    'M',
    `"use strict";return function(S,D,O){${src}}`,
  );
  return maker(textOf, escPush, truthy, get2, get3, get4, getN, F, M);
}

/**
 * For each parsed template, the root names its output reads (transitively
 * through includes, with a `for`'s bound names and `loop` not counted as
 * roots) and its longest include chain (a direct include is level 1).
 * A template whose roots are all among site, tags and recent renders the
 * same string for every page of a case, so it can be rendered once.
 * A cycle, or a root that cannot be named, marks the template non-constant.
 */
function analyzeTemplates(parsed) {
  const info = new Map();
  const visiting = new Set();
  function analyze(name) {
    if (info.has(name)) return info.get(name);
    if (visiting.has(name)) return { roots: new Set(['*']), maxK: 99 };
    const nodes = parsed.get(name);
    if (nodes === undefined) return { roots: new Set(), maxK: 0 };
    visiting.add(name);
    const roots = new Set();
    let maxK = 0;
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') {
          if (!bound.has(n.path[0])) roots.add(n.path[0]);
        }
        if (n.kind === 'for') {
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'if') {
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'include') {
          const sub = analyze(n.name);
          for (const r of sub.roots) if (!bound.has(r)) roots.add(r);
          if (sub.maxK + 1 > maxK) maxK = sub.maxK + 1;
        }
      }
    };
    walk(nodes, new Set());
    visiting.delete(name);
    const result = { roots, maxK };
    info.set(name, result);
    return result;
  }
  for (const name of parsed.keys()) analyze(name);
  return info;
}

// -------------------------------------------------------------------- build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Whether `target` is a link kept as written (a scheme, / or #). */
function isKeptLink(target) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return true;
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)
    )
      return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
function build(input) {
  const slugMemo = new Map();
  const slugify = (text) => {
    let r = slugMemo.get(text);
    if (r === undefined) {
      r = slugifyRaw(text);
      slugMemo.set(text, r);
    }
    return r;
  };

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templateInfo = analyzeTemplates(parsed);
  const F = Object.create(null);
  const templates = new Map();
  // One include-memo store per case: template name to Map, keyed by the one
  // root value that fixes the template's output (see genNodes). It is made
  // fresh here, so nothing is carried from one case to the next.
  const memo = Object.create(null);
  for (const [name, nodes] of parsed) {
    const fn = compileTemplate(nodes, F, templateInfo, memo);
    F[name] = fn;
    templates.set(name, fn);
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in the order the reference checks them: refused, the
  // generator's own directory, a post with no date, a missing layout, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each source's body rendered, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (isKeptLink(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: each post's tags, each slug once, in its own order.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        // One shared { name, slug, url } for every card that shows this
        // tag: the lists read those three fields and nothing else.
        tag.view = { name, slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const seen = new Set();
    const refs = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      refs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it; a page as its layout reads it.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => (t.view !== undefined ? t.view : { name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => {
    if (s.card === undefined) s.card = cardOf(s);
    // The page is its card with the page fields added in place: the card
    // object is this source's own (made above, or for a post in the cards
    // loop), and the lists that reuse it read only the card's own fields,
    // so the added ones change no list's output. The toc entries are
    // already { level, id, html }, exactly the shape the layout reads, so
    // no copy of the table is made.
    const c = s.card;
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc;
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };

  // Layouts: every page through its layout, the index and tag pages.
  const cards = new Map();
  for (const p of posts) {
    p.card = cardOf(p);
    cards.set(p, p.card);
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One root scope per case, its page variables reassigned per render: the
  // renders are synchronous, and a name left undefined reads exactly as a
  // name that is absent (undefined, and therefore false in an if).
  const scope = Object.create(null);
  scope.site = site;
  scope.tags = allTags;
  scope.recent = recent;
  // One output array per case, emptied per render: renders are synchronous,
  // and includes append into the same array.
  const O = [];
  // Templates that read only site, tags and recent render the same string
  // for every page of this case: render each once now, and answer every
  // later include of it with that string. The depth check keeps the
  // include-depth rule exact: a render at depth D of a template whose
  // longest include chain is maxK renders its level-k includes exactly when
  // D + k <= 8, as the precomputed render at depth 0 does, so the string
  // is used only while D + maxK <= 8, and the original render runs below it.
  const constRendered = Object.create(null);
  for (const name of parsed.keys()) {
    const inf = templateInfo.get(name);
    if (inf === undefined || inf.roots.has('*')) continue;
    let ok = true;
    for (const r of inf.roots) {
      if (r !== 'site' && r !== 'tags' && r !== 'recent') {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const arr = [];
    templates.get(name)(scope, 0, arr);
    constRendered[name] = arr.join('');
  }
  for (const name of Object.keys(constRendered)) {
    const orig = templates.get(name);
    const maxK = templateInfo.get(name).maxK;
    const text = constRendered[name];
    const wrapped = (S, D, O2) => {
      if (D + maxK <= 8) {
        O2.push(text);
        return;
      }
      orig(S, D, O2);
    };
    F[name] = wrapped;
    templates.set(name, wrapped);
  }
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    scope.page = vars.page;
    scope.posts = vars.posts;
    scope.pager = vars.pager;
    scope.tag = vars.tag;
    O.length = 0;
    fn(scope, 0, O);
    return O.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pages = kept.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  return build(input);
}


