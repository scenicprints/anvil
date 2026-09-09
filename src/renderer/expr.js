/**
 * Expression evaluation for model parameters and feature dimensions.
 *
 * Every numeric field in the document is stored as text so that "wall * 2" keeps
 * meaning "wall * 2" after the wall parameter changes. Parsing is a hand-written
 * shunting-yard rather than eval, so a saved file can never execute code.
 */

const FUNCS = {
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  asin: (v) => (Math.asin(v) * 180) / Math.PI,
  acos: (v) => (Math.acos(v) * 180) / Math.PI,
  atan: (v) => (Math.atan(v) * 180) / Math.PI,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log,
  exp: Math.exp
};

const CONSTS = { pi: Math.PI, e: Math.E };

/**
 * A number may carry a unit, which is a plain multiplier into what the document
 * counts in. Lengths are millimetres and angles are degrees, so `2in` is 50.8
 * and `1rad` is 57.29. Nothing checks that a length unit went into a length
 * field, because the evaluator only ever deals in bare numbers; putting `2in`
 * in an angle box gives 50.8 degrees, which is the answer to what was asked.
 */
const UNITS = {
  // Length, into millimetres.
  nm: 1e-6,
  um: 0.001,
  micron: 0.001,
  microns: 0.001,
  mm: 1,
  millimetre: 1,
  millimetres: 1,
  millimeter: 1,
  millimeters: 1,
  cm: 10,
  centimetre: 10,
  centimetres: 10,
  centimeter: 10,
  centimeters: 10,
  dm: 100,
  m: 1000,
  metre: 1000,
  metres: 1000,
  meter: 1000,
  meters: 1000,
  thou: 0.0254,
  mil: 0.0254,
  mils: 0.0254,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8,
  yd: 914.4,
  yard: 914.4,
  yards: 914.4,

  // Angle, into degrees.
  deg: 1,
  degree: 1,
  degrees: 1,
  rad: 180 / Math.PI,
  radian: 180 / Math.PI,
  radians: 180 / Math.PI,
  turn: 360,
  turns: 360
};

// The inch and foot marks, which are not letters and so need their own look-up.
const UNIT_MARKS = { '"': 25.4, '\u2033': 25.4, "'": 304.8, '\u2032': 304.8 };

/**
 * Read a unit sitting straight after a number, with or without a space between.
 * Returns the multiplier and where the source carries on, or null for no unit.
 *
 * A number followed by a name is not valid arithmetic otherwise, so reading it
 * as a unit cannot take a meaning away from anything that used to parse. It does
 * mean a parameter named `m` or `in` cannot be reached that way; write `1 * m`.
 */
function readUnit(src, from) {
  let k = from;
  while (k < src.length && /[ \t]/.test(src[k])) k++;
  if (k >= src.length) return null;

  const mark = UNIT_MARKS[src[k]];
  if (mark !== undefined) return { scale: mark, next: k + 1 };

  let m = k;
  while (m < src.length && /[A-Za-z\u00b5]/.test(src[m])) m++;
  if (m === k) return null;
  const word = src.slice(k, m).toLowerCase().replace('\u00b5', 'u');
  if (!Object.prototype.hasOwnProperty.call(UNITS, word)) return null;
  return { scale: UNITS[word], next: m };
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if ((text.match(/\./g) || []).length > 1) throw new Error(`Bad number "${text}"`);
      let value = parseFloat(text);
      const unit = readUnit(src, j);
      if (unit) {
        value *= unit.scale;
        j = unit.next;
      }
      tokens.push({ t: 'num', v: value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^%(),'.includes(ch)) {
      tokens.push({ t: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected "${ch}"`);
  }
  return tokens;
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
const RIGHT = { '^': true };

function toRPN(tokens) {
  const out = [];
  const ops = [];
  let prev = null;

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];

    if (tk.t === 'num') {
      out.push(tk);
    } else if (tk.t === 'name') {
      if (tokens[i + 1] && tokens[i + 1].t === '(') {
        ops.push({ t: 'func', v: tk.v });
      } else {
        out.push(tk);
      }
    } else if (tk.t === ',') {
      while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
      if (!ops.length) throw new Error('Misplaced comma');
    } else if (tk.t in PREC) {
      // Distinguish unary minus/plus from the binary form.
      const unary =
        tk.t === '-' || tk.t === '+'
          ? prev === null || prev.t in PREC || prev.t === '(' || prev.t === ','
          : false;
      if (unary) {
        ops.push({ t: 'unary', v: tk.t });
      } else {
        while (ops.length) {
          const top = ops[ops.length - 1];
          if (top.t === 'func' || top.t === 'unary') {
            out.push(ops.pop());
            continue;
          }
          if (
            top.t in PREC &&
            (PREC[top.t] > PREC[tk.t] || (PREC[top.t] === PREC[tk.t] && !RIGHT[tk.t]))
          ) {
            out.push(ops.pop());
            continue;
          }
          break;
        }
        ops.push(tk);
      }
    } else if (tk.t === '(') {
      ops.push(tk);
    } else if (tk.t === ')') {
      while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
      if (!ops.length) throw new Error('Unbalanced parentheses');
      ops.pop();
      if (ops.length && ops[ops.length - 1].t === 'func') out.push(ops.pop());
    }
    prev = tk;
  }
  while (ops.length) {
    const op = ops.pop();
    if (op.t === '(') throw new Error('Unbalanced parentheses');
    out.push(op);
  }
  return out;
}

function evalRPN(rpn, scope) {
  const st = [];
  for (const tk of rpn) {
    if (tk.t === 'num') {
      st.push(tk.v);
    } else if (tk.t === 'name') {
      const key = tk.v;
      if (key in scope) st.push(scope[key]);
      else if (key.toLowerCase() in CONSTS) st.push(CONSTS[key.toLowerCase()]);
      else throw new Error(`Unknown parameter "${key}"`);
    } else if (tk.t === 'unary') {
      const a = st.pop();
      if (a === undefined) throw new Error('Missing operand');
      st.push(tk.v === '-' ? -a : a);
    } else if (tk.t === 'func') {
      const fn = FUNCS[tk.v];
      if (!fn) throw new Error(`Unknown function "${tk.v}"`);
      const arity = fn.length || 1;
      const args = [];
      for (let k = 0; k < arity; k++) args.unshift(st.pop());
      if (args.some((a) => a === undefined)) throw new Error(`Bad arguments to ${tk.v}`);
      st.push(fn(...args));
    } else {
      const b = st.pop();
      const a = st.pop();
      if (a === undefined || b === undefined) throw new Error('Missing operand');
      switch (tk.t) {
        case '+': st.push(a + b); break;
        case '-': st.push(a - b); break;
        case '*': st.push(a * b); break;
        case '/': st.push(a / b); break;
        case '%': st.push(a % b); break;
        case '^': st.push(Math.pow(a, b)); break;
        default: throw new Error(`Bad operator ${tk.t}`);
      }
    }
  }
  if (st.length !== 1) throw new Error('Malformed expression');
  const val = st[0];
  if (!Number.isFinite(val)) throw new Error('Result is not a number');
  return val;
}

/** Evaluate one expression against a scope of named numbers. */
export function evaluate(source, scope = {}) {
  const text = String(source ?? '').trim();
  if (text === '') throw new Error('Empty expression');
  return evalRPN(toRPN(tokenize(text)), scope);
}

/** Names referenced by an expression, for dependency ordering. */
export function referencedNames(source) {
  const names = new Set();
  let tokens;
  try {
    tokens = tokenize(String(source ?? ''));
  } catch {
    return names;
  }
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.t !== 'name') continue;
    if (tokens[i + 1] && tokens[i + 1].t === '(') continue;
    if (tk.v.toLowerCase() in CONSTS) continue;
    names.add(tk.v);
  }
  return names;
}

/**
 * Resolve a parameter table into a flat name -> value scope.
 * Parameters may reference each other in any order; cycles are reported.
 */
export function resolveParameters(params) {
  const scope = {};
  const errors = {};
  const byName = new Map(params.map((p) => [p.name, p]));
  const state = new Map();
  const cyclic = new Set();

  const visit = (name) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'busy') {
      // Re-entering a parameter still being resolved means it depends on
      // itself. Every name on the cycle is marked so that finishing the outer
      // call does not overwrite the diagnosis with a value.
      cyclic.add(name);
      scope[name] = 0;
      return;
    }
    const p = byName.get(name);
    if (!p) return;
    state.set(name, 'busy');
    for (const dep of referencedNames(p.expr)) {
      if (byName.has(dep)) visit(dep);
    }
    state.set(name, 'done');

    if (cyclic.has(name)) {
      errors[name] = 'Circular reference';
      scope[name] = 0;
      return;
    }
    try {
      scope[name] = evaluate(p.expr, scope);
      delete errors[name];
    } catch (err) {
      errors[name] = err.message;
      scope[name] = 0;
    }
  };

  for (const p of params) visit(p.name);

  // A parameter that reads a cyclic one cannot be trusted either.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of params) {
      if (errors[p.name]) continue;
      for (const dep of referencedNames(p.expr)) {
        if (errors[dep]) {
          errors[p.name] = `Depends on ${dep}`;
          scope[p.name] = 0;
          changed = true;
          break;
        }
      }
    }
  }
  return { scope, errors };
}

/** Evaluate a field, returning a fallback when the expression is broken. */
export function safeEval(source, scope, fallback = 0) {
  try {
    return evaluate(source, scope);
  } catch {
    return fallback;
  }
}

export const FUNCTION_NAMES = Object.keys(FUNCS);
export const UNIT_NAMES = Object.keys(UNITS);

/* ------------------------------------------------------------------ */
/* Parameters as a file                                                */
/* ------------------------------------------------------------------ */

/** One CSV field, quoted only when it has to be. */
function csvCell(text) {
  const s = String(text ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Split one CSV line, honouring quotes.
 *
 * An expression can hold a comma, `max(a, b)` being the obvious one, so a line
 * cannot simply be split on the character.
 */
function csvSplit(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * The parameter table as CSV.
 *
 * The expression is what is kept, not the number it works out to: a table
 * carried from one part to another is meant to carry the reasoning, and a
 * column of numbers would carry only the answers. The value goes in a fourth
 * column that nothing reads back, because a person opening the file in a
 * spreadsheet wants to see it.
 */
export function parametersToCsv(params) {
  const { scope, errors } = resolveParameters(params);
  const lines = ['name,expression,comment,value'];
  for (const p of params) {
    lines.push(
      [
        csvCell(p.name),
        csvCell(p.expr),
        csvCell(p.comment || ''),
        csvCell(errors[p.name] ? '' : scope[p.name])
      ].join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Read a parameter list out of CSV text.
 *
 * Returns the rows worth keeping and the ones that were not, so the caller can
 * say which lines were left rather than importing something that evaluates to
 * nothing. A name that is not a name, or a row with no expression, is not a
 * parameter.
 */
export function parametersFromCsv(text) {
  const rows = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(csvSplit);
  // A header row is optional, and is recognised rather than counted: a file
  // whose first line is a real parameter must not lose it.
  if (rows.length && /^name$/i.test(rows[0][0] || '')) rows.shift();

  const taken = [];
  const skipped = [];
  for (const cells of rows) {
    const name = String(cells[0] || '').replace(/[^A-Za-z0-9_]/g, '');
    const expr = String(cells[1] ?? '').trim();
    if (!name || /^[0-9]/.test(name) || !expr) {
      skipped.push(cells[0] || '(blank)');
      continue;
    }
    taken.push({ name, expr, comment: cells[2] || undefined });
  }
  return { taken, skipped };
}
