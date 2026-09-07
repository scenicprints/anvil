/**
 * STEP, read as a graph of entities.
 *
 * ISO 10303 Part 21 is a plain text format with a very small grammar: a header,
 * then a data section of numbered instances, each a type name and a list of
 * arguments. Arguments are numbers, quoted strings, enumerations in dots,
 * references to other instances by number, or nested lists of the same. That is
 * the whole of it, and it parses in one pass.
 *
 * What makes STEP worth reading is not the syntax but what it carries. An STL
 * is triangles and nothing else, so an imported model can only ever be a shape.
 * A STEP file carries the surfaces themselves: this face is a plane, that one is
 * a cylinder of radius five about this axis. A part that arrives that way is
 * editable because it was never facetted in the first place.
 *
 * This file does the reading. It deliberately knows nothing about geometry:
 * it hands back instances with their arguments resolved, and the interpretation
 * of what a CYLINDRICAL_SURFACE means lives with the geometry, not with the
 * parser. Keeping those apart is what makes each of them testable.
 */

/** A reference to another instance, so a resolved argument is never ambiguous. */
export class Ref {
  constructor(id) {
    this.id = id;
  }
}

/** An enumeration, `.T.` or `.CARTESIAN.`, kept apart from a plain string. */
export class Enum {
  constructor(name) {
    this.name = name;
  }
}

/** `*` and `$`: a value the schema derives, and a value that is absent. */
export const DERIVED = Symbol('derived');
export const UNSET = Symbol('unset');

/**
 * Strip comments and the header, and hand back the data section.
 *
 * Comments are the only place the grammar is not local: a slash-star can appear
 * anywhere, including inside what would otherwise look like a number, so it has
 * to go before anything else is read. Quoted strings are stepped over rather
 * than scanned, because a string is allowed to contain the comment opener.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      // A quote inside a string is written twice, so it never ends the string.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      out += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      // A comment separates tokens, so it cannot simply vanish.
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * A STEP string literal, unescaped.
 *
 * Doubled quotes are one quote. The X and X2 escapes carry characters outside
 * the file's own encoding, which is how a part with a degree sign or a name in
 * another script survives the trip.
 */
function decodeString(raw) {
  let s = raw.replace(/''/g, "'");
  s = s.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) =>
    (hex.match(/.{1,4}/g) || [])
      .map((h) => String.fromCharCode(parseInt(h, 16)))
      .join('')
  );
  s = s.replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) =>
    (hex.match(/.{1,8}/g) || [])
      .map((h) => String.fromCodePoint(parseInt(h, 16)))
      .join('')
  );
  s = s.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return s;
}

/**
 * One argument list, from an open bracket to its matching close.
 *
 * Written as a small hand cursor rather than a regular expression because the
 * lists nest, and because a comma inside a string is not a separator.
 */
function parseArgs(text, start) {
  const args = [];
  let i = start;

  const readOne = () => {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length) return { done: true };
    const c = text[i];

    if (c === ')') return { done: true };

    if (c === '(') {
      const nested = parseArgs(text, i + 1);
      i = nested.end;
      return { value: nested.args };
    }

    if (c === "'") {
      let j = i + 1;
      let raw = '';
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            raw += "''";
            j += 2;
            continue;
          }
          break;
        }
        raw += text[j];
        j++;
      }
      i = j + 1;
      return { value: decodeString(raw) };
    }

    if (c === '#') {
      let j = i + 1;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      const id = Number(text.slice(i + 1, j));
      i = j;
      return { value: new Ref(id) };
    }

    if (c === '.') {
      const end = text.indexOf('.', i + 1);
      if (end < 0) {
        i = text.length;
        return { done: true };
      }
      const name = text.slice(i + 1, end);
      i = end + 1;
      return { value: new Enum(name) };
    }

    if (c === '*') {
      i++;
      return { value: DERIVED };
    }
    if (c === '$') {
      i++;
      return { value: UNSET };
    }

    // A typed argument inside a select: NAME(...). Kept as its own instance so
    // the reader downstream sees the same shape whether a value was written
    // inline or referenced.
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const name = text.slice(i, j);
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '(') {
        const nested = parseArgs(text, j + 1);
        i = nested.end;
        return { value: { type: name.toUpperCase(), args: nested.args } };
      }
      i = j;
      return { value: new Enum(name) };
    }

    // A number, which is the only thing left.
    let j = i;
    while (j < text.length && /[-+0-9.eE]/.test(text[j])) j++;
    const raw = text.slice(i, j);
    i = j;
    const n = Number(raw);
    return { value: Number.isFinite(n) ? n : raw };
  };

  let guard = 0;
  while (i < text.length && guard++ < 1e7) {
    const got = readOne();
    if (got.done) break;
    args.push(got.value);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === ')') break;
  }
  return { args, end: (text[i] === ')' ? i + 1 : i) };
}

/**
 * Read a STEP file into instances by id.
 *
 * A complex instance, written `#12=(A(...)B(...))`, is several types at once
 * describing one thing; it comes back with `parts` so the reader can look for
 * whichever of them it understands. Everything else is a plain type and args.
 */
export function parseSTEP(text) {
  const src = stripComments(String(text));
  const dataAt = src.search(/\bDATA\s*;/i);
  const body = dataAt >= 0 ? src.slice(dataAt) : src;

  const instances = new Map();
  const byType = new Map();
  const re = /#(\d+)\s*=\s*/g;
  let m;

  while ((m = re.exec(body))) {
    const id = Number(m[1]);
    let i = m.index + m[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;

    // A complex instance: a bare bracket, holding several typed records.
    if (body[i] === '(') {
      const parts = [];
      let j = i + 1;
      let guard = 0;
      while (j < body.length && guard++ < 1e5) {
        while (j < body.length && /\s/.test(body[j])) j++;
        if (body[j] === ')') {
          j++;
          break;
        }
        let k = j;
        while (k < body.length && /[A-Za-z0-9_]/.test(body[k])) k++;
        const name = body.slice(j, k).toUpperCase();
        while (k < body.length && /\s/.test(body[k])) k++;
        if (body[k] !== '(') break;
        const got = parseArgs(body, k + 1);
        parts.push({ type: name, args: got.args });
        j = got.end;
      }
      const inst = { id, type: parts[0]?.type || 'COMPLEX', args: parts[0]?.args || [], parts };
      instances.set(id, inst);
      for (const p of parts) {
        if (!byType.has(p.type)) byType.set(p.type, []);
        byType.get(p.type).push(inst);
      }
      re.lastIndex = j;
      continue;
    }

    let k = i;
    while (k < body.length && /[A-Za-z0-9_]/.test(body[k])) k++;
    const type = body.slice(i, k).toUpperCase();
    while (k < body.length && /\s/.test(body[k])) k++;
    if (body[k] !== '(') continue;
    const got = parseArgs(body, k + 1);
    const inst = { id, type, args: got.args };
    instances.set(id, inst);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(inst);
    re.lastIndex = got.end;
  }

  return {
    instances,
    byType,
    /** The instance a reference points at, or null. */
    get(v) {
      if (v instanceof Ref) return instances.get(v.id) || null;
      return null;
    },
    /** Every instance of a type, in file order. */
    all(type) {
      return byType.get(String(type).toUpperCase()) || [];
    }
  };
}

/** The header entries, which carry the file's name, units hint and authoring tool. */
export function stepHeader(text) {
  const src = stripComments(String(text));
  const start = src.search(/\bHEADER\s*;/i);
  const end = src.search(/\bENDSEC\s*;/i);
  if (start < 0 || end < 0) return {};
  const head = src.slice(start, end);
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(head))) {
    const name = m[1].toUpperCase();
    if (name === 'HEADER') continue;
    const got = parseArgs(head, m.index + m[0].length);
    out[name] = got.args;
    re.lastIndex = got.end;
  }
  return out;
}
