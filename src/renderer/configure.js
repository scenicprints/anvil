/**
 * Configurations: one document, several parts.
 *
 * A bracket that comes in three lengths is one design, not three. Drawing it
 * three times means three sets of everything to keep in step, and they will not
 * stay in step. A configuration table says what is different between them and
 * nothing else: a column per thing that varies, a row per part, and the model
 * built from whichever row is current.
 *
 * What can vary is deliberately a short list, and each entry names the one place
 * the value already lives rather than inventing a second one:
 *
 * - a **parameter** value, which is most of it
 * - whether a **feature** is suppressed, which is how a variant loses a hole
 * - whether a **body** is shown
 * - a body's **colour** and what it is **made of**
 * - the **sheet metal rule** in force
 * - a **joint** position, which is how one assembly shows open and shut
 *
 * Everything here is a plain read of the table. Nothing rebuilds, nothing
 * draws, and nothing writes to the document, so what a row means can be checked
 * against numbers rather than against a picture of the model.
 */

/** The kinds of thing a column can drive, and what each one needs to say. */
export const COLUMN_KINDS = {
  parameter: { label: 'Parameter', needs: 'the parameter name' },
  suppress: { label: 'Feature suppressed', needs: 'the feature' },
  visible: { label: 'Body shown', needs: 'the body' },
  colour: { label: 'Colour', needs: 'the body' },
  material: { label: 'Material', needs: 'the body' },
  rule: { label: 'Sheet metal rule', needs: 'nothing' },
  joint: { label: 'Joint position', needs: 'the joint' }
};

/** An empty table, which is what a document has until somebody makes one. */
export function newTable() {
  return { active: null, columns: [], rows: [] };
}

/** The row in force, or null when the table is off or empty. */
export function activeRow(table) {
  if (!table?.rows?.length) return null;
  if (!table.active) return null;
  return table.rows.find((r) => r.id === table.active) || null;
}

/** What a row says about one column, or nothing when it says nothing. */
export function valueOf(row, column) {
  if (!row || !column) return undefined;
  const v = row.values?.[column.id];
  return v === '' || v === undefined ? undefined : v;
}

/**
 * The parameter list a row asks for.
 *
 * A new list rather than an edit in place, because the document has to go on
 * holding what it was drawn with. Switching back to the first row must give the
 * first part again, and it cannot if the first row's values were written over.
 */
export function parametersFor(parameters, table, row) {
  const wanted = new Map();
  for (const col of table?.columns || []) {
    if (col.kind !== 'parameter') continue;
    const v = valueOf(row, col);
    if (v !== undefined) wanted.set(col.ref, String(v));
  }
  if (!wanted.size) return parameters || [];
  return (parameters || []).map((p) =>
    wanted.has(p.name) ? { ...p, expr: wanted.get(p.name) } : p
  );
}

/** The features a row turns off, on top of any that were suppressed by hand. */
export function suppressedBy(table, row) {
  const out = new Set();
  for (const col of table?.columns || []) {
    if (col.kind !== 'suppress') continue;
    const v = valueOf(row, col);
    // A column that says nothing leaves the feature as the timeline has it.
    if (v === undefined) continue;
    if (isYes(v)) out.add(col.ref);
  }
  return out;
}

/** The features a row turns back on, which is how a row undoes a hand suppress. */
export function unsuppressedBy(table, row) {
  const out = new Set();
  for (const col of table?.columns || []) {
    if (col.kind !== 'suppress') continue;
    const v = valueOf(row, col);
    if (v === undefined) continue;
    if (!isYes(v)) out.add(col.ref);
  }
  return out;
}

/** Everything a row says about one kind, as a map from what it points at. */
export function overridesFor(table, row, kind) {
  const out = new Map();
  for (const col of table?.columns || []) {
    if (col.kind !== kind) continue;
    const v = valueOf(row, col);
    if (v === undefined) continue;
    out.set(col.ref, v);
  }
  return out;
}

/**
 * Yes and no, read the way people write them.
 *
 * A table is typed into, so the same answer arrives as a tick, as "yes", as
 * "1", and as "true", and treating any of those as no is the sort of thing
 * nobody reports because they assume they typed it wrong.
 */
export function isYes(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1' || s === 'on';
}

/**
 * What is different between two rows, in words.
 *
 * The point of a table is telling variants apart, and a table of forty columns
 * where two rows differ in one of them is unreadable without this.
 */
export function differences(table, a, b) {
  const out = [];
  for (const col of table?.columns || []) {
    const va = valueOf(a, col);
    const vb = valueOf(b, col);
    if (String(va ?? '') === String(vb ?? '')) continue;
    out.push({ column: col, from: va, to: vb });
  }
  return out;
}

/** A column's own name, or one made from what it points at. */
export function columnLabel(col) {
  if (!col) return '';
  if (col.label) return col.label;
  const kind = COLUMN_KINDS[col.kind]?.label || col.kind;
  return col.ref ? `${kind}: ${col.ref}` : kind;
}

/**
 * A row that copies another, with a name that is not already taken.
 *
 * Copying rather than starting empty is what makes a table usable: variants
 * differ in one or two columns and agree about the rest, so the useful new row
 * is almost always the last one with one number changed.
 */
export function copyRow(table, from, name) {
  const used = new Set((table.rows || []).map((r) => r.name));
  let wanted = name || `${from?.name || 'Configuration'} copy`;
  let n = 2;
  while (used.has(wanted)) wanted = `${name || from?.name || 'Configuration'} ${n++}`;
  return {
    id: `cfg${Math.random().toString(36).slice(2, 9)}`,
    name: wanted,
    values: { ...(from?.values || {}) }
  };
}

/** Is this table complete enough to be worth applying? */
export function tableState(table) {
  const rows = table?.rows?.length || 0;
  const columns = table?.columns?.length || 0;
  const row = activeRow(table);
  const blanks = [];
  if (row) {
    for (const col of table.columns) {
      if (valueOf(row, col) === undefined) blanks.push(columnLabel(col));
    }
  }
  return { rows, columns, active: row, blanks };
}
