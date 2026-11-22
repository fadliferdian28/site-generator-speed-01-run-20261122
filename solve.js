// A faster drop-in for makefun-site 1.0.0.
//
// Re-implemented from the dialect spec in makefun-site's README and the reference program's
// observable behaviour: the same front matter, Markdown subset, template dialect, slug rule
// and build report, byte for byte. Nothing here is copied from the reference; the shape is
// different throughout:
//
//   * the Markdown body is walked line by line in one pass, straight into the output chunks,
//     with no token list and no per-block strings;
//   * inline markup is rendered by one regex scan per paragraph, with plain runs pushed
//     unescaped (a run holds no escapable character by construction) and escape characters
//     written as entities on the spot, so escapeHtml is never called per character;
//   * templates are compiled once per case into flat op lists run by a small iterative
//     interpreter (no recursive tree walk, no per-iteration scope closures);
//   * slugs and long dates are memoised per case, and reading time is counted once per
//     source instead of twice.
//
// Everything is deterministic: run() reads no clock, environment or randomness, and keeps
// no state from one case to the next (every cache below is built fresh inside run()).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */

// ------------------------------------------------------------------ text bits

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` with & < > " ' escaped. Fast when nothing needs escaping, which is most text. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`. Pure-ASCII text (the common case) never needs NFKD or the mark
 * strip, so it goes through one lower-case plus one collapse pass instead.
 */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (s.charCodeAt(0) === 45) s = s.slice(1);
    if (s.charCodeAt(s.length - 1) === 45) s = s.slice(0, -1);
    s = s.slice(0, SLUG_MAX);
    if (s.charCodeAt(s.length - 1) === 45) s = s.slice(0, -1);
    return s === '' ? 'untitled' : s;
  }
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
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

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s class). */
function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** How many words `text` holds, without building the word list. ASCII whitespace is
 * tested inline; only a character above 127 needs the full Unicode test. */
function countWords(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    let c = text.charCodeAt(i);
    while (i < len && (c <= 32 ? c === 32 || (c >= 9 && c <= 13) : c < 128 ? false : isWsCode(c))) {
      i++;
      c = text.charCodeAt(i);
    }
    if (i >= len) break;
    n++;
    while (i < len && !((c = text.charCodeAt(i)) <= 32 ? c === 32 || (c >= 9 && c <= 13) : c < 128 ? false : isWsCode(c))) i++;
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value, or why it is refused. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it
 * is refused. Walks the lines by index so the body is one slice, never split and rejoined.
 */
function parseFm(text) {
  const n = text.length;
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? n : firstNl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Collect the front-matter lines (start, end) while looking for the closing ---.
  const fmLines = [];
  let p = firstEnd === n ? n + 1 : firstEnd + 1;
  let close = -1;
  let bodyStart = -1;
  while (p <= n) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? n : nl;
    if (text.slice(p, end) === '---') {
      close = fmLines.length + 1;
      bodyStart = end === n ? n + 1 : end + 1;
      break;
    }
    fmLines.push([p, end]);
    p = end === n ? n + 1 : end + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const [s, e] = fmLines[k];
    const line = text.slice(s, e);
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: bodyStart > n ? '' : text.slice(bodyStart) };
}

// ------------------------------------------------------------------ Markdown

const SP = 32;
const TAB = 9;

/** A line of only spaces and tabs (or empty). */
function isBlankLine(line) {
  for (let j = 0; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === SP || line.charCodeAt(a) === TAB)) a++;
  while (b > a && (line.charCodeAt(b - 1) === SP || line.charCodeAt(b - 1) === TAB)) b--;
  return line.slice(a, b);
}

/** The fence language of a fence-opening line, or null when it is not one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== SP && c !== TAB) return null;
    j++;
  }
  return lang;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (i < 6 && line.charCodeAt(i) === 35) i++;
  if (i === 0) return null;
  const c = line.charCodeAt(i);
  if (c !== SP && c !== TAB) return null;
  let j = i;
  while (j < line.length && (line.charCodeAt(j) === SP || line.charCodeAt(j) === TAB)) j++;
  let k = line.length;
  while (k > j && (line.charCodeAt(k - 1) === SP || line.charCodeAt(k - 1) === TAB)) k--;
  if (k === j) return null;
  return { depth: i, text: line.slice(j, k) };
}

/** Whether a line is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  const mark = c0 === 45 ? 45 : c0 === 42 ? 42 : 0;
  if (mark === 0) return false;
  if (line.charCodeAt(1) !== mark || line.charCodeAt(2) !== mark) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}

/** A list marker on a line: { ordered, start, text } or null. */
function listMarker(line, ordered) {
  if (ordered) {
    let j = 0;
    let digits = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && digits < 9) {
      j++;
      digits++;
    }
    if (digits === 0) return null;
    if (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) return null;
    if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== SP) return null;
    return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
  }
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === SP) return { ordered: false, start: 1, text: line.slice(2) };
  return null;
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  return line.length > 2 && line.charCodeAt(0) === SP && line.charCodeAt(1) === SP && !isWsCode(line.charCodeAt(2));
}

// ------------------------------------------------------------ inline rendering

const ESCAPABLE = '\\`*_[]()#+-.!>';
const WS_RE = /\s/;

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * A match is protected exactly when an odd run of backslashes stands right before it:
 * the scan from `from` consumes escape pairs greedily, and a run can only start at a
 * pair boundary (the character before a run is never a backslash).
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= 0 && s.charCodeAt(k) === 92) {
      n++;
      k--;
    }
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline, appended to `out`; `link(target)` resolves a link's href.
 * One regex scan finds the next character that matters (markup or escapable), so a run
 * of plain text is pushed as it stands: it holds no escapable character by construction.
 * The scan is shared and re-entrant: every walker sets its start before each match,
 * so a nested walk for strong, emphasis or a link leaves the outer walk intact.
 */
const INLINE_SCAN = /[\\`*\[&<>"']/g;

/** One string rendered inline into `out`; `link(target)` resolves a link's href. */
function inlineGo(str, link, out) {
  let i = 0;
  INLINE_SCAN.lastIndex = 0;
  let m;
  while ((m = INLINE_SCAN.exec(str)) !== null) {
    const j = m.index;
    if (j > i) out.push(str.slice(i, j));
    const c = str[j];
    if (c === '&') {
      out.push('&amp;');
      i = j + 1;
    } else if (c === '<') {
      out.push('&lt;');
      i = j + 1;
    } else if (c === '>') {
      out.push('&gt;');
      i = j + 1;
    } else if (c === '"') {
      out.push('&quot;');
      i = j + 1;
    } else if (c === "'") {
      out.push('&#39;');
      i = j + 1;
    } else if (c === '\\') {
      const nx = str[j + 1];
      if (nx !== undefined && ESCAPABLE.indexOf(nx) !== -1) {
        out.push(nx === '>' ? '&gt;' : nx);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = str.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', esc(str.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (str[j + 1] === '*') {
        const k = findUnescaped(str, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineGo(str.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(str, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineGo(str.slice(j + 1, k), link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else {
      // '['
      const k = findUnescaped(str, ']', j + 1);
      const mm = k !== -1 && str[k + 1] === '(' ? str.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : str.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', esc(link(target)), '">');
        inlineGo(str.slice(j + 1, k), link, out);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
    INLINE_SCAN.lastIndex = i;
  }
  if (i < str.length) out.push(str.slice(i));
}

/**
 * `s` rendered inline, appended to `out`; `link(target)` resolves a link's href.
 * One regex scan finds the next character that matters (markup or escapable), so a run
 * of plain text is pushed as it stands: it holds no escapable character by construction.
 * The scan is shared and re-entrant: every walk sets its start before each match, so a
 * nested walk for strong, emphasis or a link leaves the outer walk intact.
 */
function inlineInto(s, link, out) {
  inlineGo(s, link, out);
}

/**
 * `src` rendered in one pass: its HTML (each block followed by "\n"), its table of
 * contents and its excerpt (the first paragraph's inline HTML, or "").
 * `link` resolves a link's href; `slug` is the case's memoised slug function.
 *
 * One cursor walks the lines, each classified exactly once by its first character
 * (0 blank, 1 fence, 2 heading, 3 break, 4 quote, 5 list, 6 paragraph). A line that
 * ends a block stays pending, already classified, for the next block to dispatch on.
 * A paragraph takes the lines after it up to a blank line, a fence, a heading or a
 * break, so a quote or list line inside one is paragraph text, not a new block.
 */
function mdRender(src, link, slug) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let haveExcerpt = false;
  const n = src.length;
  let p = 0;
  let cur = '';
  let curKind = -1;
  let curLang = '';
  let curHead = null;
  let curMark = null;
  let hasCur = false;

  /** Read the next line into the cursor and classify it; false at the end. */
  const readLine = () => {
    if (p > n) {
      hasCur = false;
      return false;
    }
    const e = src.indexOf('\n', p);
    const le = e === -1 ? n : e;
    cur = src.slice(p, le);
    p = le === n ? n + 1 : le + 1;
    const c0 = cur.charCodeAt(0);
    if (c0 === SP || c0 === TAB) {
      curKind = isBlankLine(cur) ? 0 : 6;
    } else if (c0 === 96) {
      curLang = fenceLang(cur);
      curKind = curLang !== null ? 1 : 6;
    } else if (c0 === 35) {
      curHead = headingOf(cur);
      curKind = curHead !== null ? 2 : 6;
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(cur)) curKind = 3;
      else {
        curMark = listMarker(cur, false);
        curKind = curMark !== null ? 5 : 6;
      }
    } else if (c0 === 62) {
      curKind = 4;
    } else if (c0 >= 48 && c0 <= 57) {
      curMark = listMarker(cur, true);
      curKind = curMark !== null ? 5 : 6;
    } else {
      curKind = cur.length === 0 ? 0 : 6;
    }
    hasCur = true;
    return true;
  };

  readLine();
  while (hasCur) {
    if (curKind === 0) {
      readLine();
      continue;
    }
    if (curKind === 1) {
      out.push(`<pre><code${curLang === '' ? '' : ` class="language-${esc(curLang)}"`}>`);
      readLine();
      while (hasCur && !(curKind === 1 && curLang === '')) {
        out.push(esc(cur), '\n');
        readLine();
      }
      if (hasCur) readLine();
      out.push('</code></pre>\n');
      continue;
    }
    if (curKind === 2) {
      const id = uniqueSlug(slug(curHead.text), ids);
      const tmp = [];
      inlineInto(curHead.text, link, tmp);
      const html = tmp.join('');
      out.push(`<h${curHead.depth} id="${id}">${html}</h${curHead.depth}>\n`);
      if (curHead.depth === 2 || curHead.depth === 3) toc.push({ level: curHead.depth, id, html });
      readLine();
      continue;
    }
    if (curKind === 3) {
      out.push('<hr>\n');
      readLine();
      continue;
    }
    if (curKind === 4) {
      const parts = [];
      while (hasCur && curKind === 4) {
        const stripped = cur.charCodeAt(1) === SP ? cur.slice(2) : cur.slice(1);
        const t = trimLine(stripped);
        if (t !== '') parts.push(t);
        readLine();
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(parts.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (curKind === 5) {
      const isOrdered = curMark.ordered;
      const first = curMark;
      const items = [];
      let item = [trimLine(first.text)];
      items.push(item);
      readLine();
      while (hasCur) {
        if (curKind === 5 && curMark.ordered === isOrdered) {
          item = [trimLine(curMark.text)];
          items.push(item);
          readLine();
        } else if (isContinued(cur)) {
          item.push(trimLine(cur));
          readLine();
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && first.start !== 1 ? `<ol start="${first.start}">\n` : `<${tag}>\n`);
      for (const it of items) {
        out.push('<li>');
        inlineInto(it.join('\n'), link, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence, a
    // heading or a thematic break.
    const parts = [trimLine(cur)];
    readLine();
    while (hasCur && curKind >= 4) {
      parts.push(trimLine(cur));
      readLine();
    }
    const text = parts.join('\n');
    if (!haveExcerpt) {
      const tmp = [];
      inlineInto(text, link, tmp);
      const inner = tmp.join('');
      excerpt = inner;
      haveExcerpt = true;
      out.push('<p>', inner, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with
 * it. Mirrors the dialect: a {% %} tag alone on its line (only spaces or tabs beside
 * it) takes the whole line with it, its newline included.
 */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into a tree of nodes (a TemplateError when it does not parse). */
function parseTpl(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathParts(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathParts(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
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

/**
 * A node tree flattened into ops for the iterative renderer. Op kinds:
 * 0 text, 1 var/raw, 2 if (jump to `t` when the branch is not taken), 3 jump,
 * 4 for (skip to after `end` when the list is empty or not an array),
 * 5 endfor (advance the loop or leave it), 6 include.
 */
function flattenTpl(nodes, ops) {
  for (const n of nodes) {
    if (n.kind === 'text') ops.push({ k: 0, s: n.text });
    else if (n.kind === 'var' || n.kind === 'raw') ops.push({ k: 1, p: n.path, raw: n.kind === 'raw' });
    else if (n.kind === 'if') {
      const ifOp = { k: 2, p: n.path, not: n.not, t: 0 };
      ops.push(ifOp);
      flattenTpl(n.then, ops);
      if (n.else !== null) {
        const jumpOp = { k: 3, t: 0 };
        ops.push(jumpOp);
        ifOp.t = ops.length;
        flattenTpl(n.else, ops);
        jumpOp.t = ops.length;
      } else {
        ifOp.t = ops.length;
      }
    } else if (n.kind === 'for') {
      const forOp = { k: 4, name: n.name, p: n.path, end: 0 };
      ops.push(forOp);
      flattenTpl(n.body, ops);
      ops.push({ k: 5 });
      forOp.end = ops.length - 1;
    } else if (n.kind === 'include') ops.push({ k: 6, name: n.name });
  }
  return ops;
}

/**
 * `src` compiled to its op list for the iterative interpreter. A TemplateError when
 * it does not parse.
 */
function compileTpl(name, src) {
  return flattenTpl(parseTpl(name, src), []);
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupPath(frames, path) {
  const first = path[0];
  let v;
  let found = false;
  for (let f = frames.length - 1; f >= 0; f--) {
    const fr = frames[f];
    if (Object.hasOwn(fr, first)) {
      v = fr[first];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += valueText(v[i]);
    }
    return s;
  }
  return '';
}

/** A value as escaped text, for `{{ }}`: a string is tested in place, the rest go through valueText. */
function escValue(v) {
  if (typeof v === 'string') {
    if (!ESC_TEST.test(v)) return v;
    return v.replace(ESC_RE, (c) => ESC_MAP[c]);
  }
  return esc(valueText(v));
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `ops` rendered into `out`, in the scope chain `frames` (root first, innermost last).
 * Loops keep one scope object and one loop record each, mutated per iteration: the
 * body reads them synchronously, so no iteration can see another's values.
 */
function renderOps(ops, frames, out, depth, templates) {
  const ctrl = [];
  let pc = 0;
  while (pc < ops.length) {
    const op = ops[pc];
    switch (op.k) {
      case 0:
        out.push(op.s);
        pc++;
        break;
      case 1: {
        const v = lookupPath(frames, op.p);
        out.push(op.raw ? valueText(v) : escValue(v));
        pc++;
        break;
      }
      case 2: {
        const v = lookupPath(frames, op.p);
        pc = isTruthy(v) !== op.not ? pc + 1 : op.t;
        break;
      }
      case 3:
        pc = op.t;
        break;
      case 4: {
        const xs = lookupPath(frames, op.p);
        if (!Array.isArray(xs) || xs.length === 0) {
          pc = op.end + 1;
        } else {
          const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
          const scope = { [op.name]: xs[0], loop };
          frames.push(scope);
          ctrl.push({ forOp: pc, arr: xs, i: 0, name: op.name, scope, loop });
          pc++;
        }
        break;
      }
      case 5: {
        const c = ctrl[ctrl.length - 1];
        c.i++;
        if (c.i < c.arr.length) {
          c.scope[c.name] = c.arr[c.i];
          c.loop.index = c.i + 1;
          c.loop.first = c.i === 0;
          c.loop.last = c.i === c.arr.length - 1;
          pc = c.forOp + 1;
        } else {
          ctrl.pop();
          frames.pop();
          pc++;
        }
        break;
      }
      default: {
        const t = templates.get(op.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderOps(t, frames, out, depth + 1, templates);
        pc++;
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ the build

const RESERVED = ['posts', 'tags', 'page'];

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slug = (t) => {
    let v = slugCache.get(t);
    if (v === undefined) {
      v = slugify(t);
      slugCache.set(t, v);
    }
    return v;
  };
  const dateCache = new Map();
  const long = (d) => {
    let v = dateCache.get(d);
    if (v === undefined) {
      v = longDate(d);
      dateCache.set(d, v);
    }
    return v;
  };

  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const broken = new Set();

  // Templates, in code-unit order of their name. One that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of their path; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in order: refused, the generator's own directory, a post with no
  // date, a layout no template has, then a draft. The first failure is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFm(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
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
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const schemeTest = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (schemeTest.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = mdRender(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(countWords(s.body) / 200));
  }

  // Collections: the posts, newest date first, then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in collection
  // order, ordered by count then slug. A page's tags link to the posts' tag of the
  // same slug, or to nothing (url "") where no post has it.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const sl = slug(name);
      if (seen.has(sl)) return false;
      seen.add(sl);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      if (!bySlug.has(sl)) bySlug.set(sl, { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] });
      const tag = bySlug.get(sl);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages and links as templates read them.
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : long(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : long(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its layout, the index pages, the tag pages and the
  // tags page through theirs; then each static file at its own path, unless a built
  // page has that path.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    const out = [];
    renderOps(ops, [{ site, tags: allTags, recent, ...vars }], out, 0, templates);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
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

  // The report: every refusal, draft, broken link and template that did not parse,
  // sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
