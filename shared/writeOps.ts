/**
 * Recognising the writes in a piece of query code, so the app can warn about
 * them before they run. Both processes use this: the renderer to decide whether
 * to ask, the main process to decide whether to refuse.
 *
 * This is a text scan, not a parser — it is deliberately eager. Missing a write
 * would be worse than asking about one that turns out to be harmless, and the
 * main process enforces the read-only rule at execution time regardless.
 */

/** Collection methods that change data. */
export const COLLECTION_WRITE_METHODS = new Set([
  'insertOne',
  'insertMany',
  'insert',
  'save',
  'updateOne',
  'updateMany',
  'update',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'remove',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'bulkWrite',
  'createIndex',
  'createIndexes',
  'createSearchIndex',
  'dropIndex',
  'dropIndexes',
  'dropSearchIndex',
  'updateSearchIndex',
  'drop',
  'rename',
  'renameCollection'
]);

/** Database-level methods that change data. */
export const DB_WRITE_METHODS = new Set([
  'dropDatabase',
  'createCollection',
  'dropCollection',
  'renameCollection'
]);

/** Command names that write, for `db.runCommand({ … })`. */
export const WRITE_COMMANDS = new Set([
  'insert',
  'update',
  'delete',
  'findandmodify',
  'drop',
  'dropdatabase',
  'create',
  'createindexes',
  'dropindexes',
  'renamecollection',
  'collmod',
  'compact',
  'converttocapped',
  'setparameter',
  'profile',
  'killop',
  'createuser',
  'updateuser',
  'dropuser',
  'grantrolestouser',
  'revokerolesfromuser'
]);

export interface DetectedWrite {
  /** The method or command name as it appeared in the code. */
  method: string;
  /** The collection it applies to, when the code says so plainly. */
  collection: string | null;
}

/**
 * Blanks out string, template and comment contents while keeping the code the
 * same length, so a `deleteMany` inside a string is not mistaken for a call and
 * match positions still line up with the original text.
 */
function blankLiterals(code: string): string {
  const out = code.split('');
  let index = 0;

  const blankUntil = (end: number) => {
    for (let at = index; at < end && at < out.length; at += 1) {
      if (out[at] !== '\n') out[at] = ' ';
    }
  };

  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];

    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', index);
      blankUntil(end < 0 ? code.length : end);
      index = end < 0 ? code.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2);
      blankUntil(end < 0 ? code.length : end + 2);
      index = end < 0 ? code.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      let at = index + 1;
      while (at < code.length) {
        if (code[at] === '\\') {
          at += 2;
          continue;
        }
        if (code[at] === char) break;
        at += 1;
      }
      index += 1;
      blankUntil(at);
      index = Math.min(at + 1, code.length);
      continue;
    }
    index += 1;
  }

  return out.join('');
}

/** Reads the collection name out of the chain leading up to `at`. */
function collectionBefore(code: string, at: number): string | null {
  const lead = code.slice(Math.max(0, at - 160), at);
  const named = [...lead.matchAll(/getCollection\(\s*(\S+?)\s*\)/g)].pop();
  if (named) return named[1].replace(/^[\s'"`]+|[\s'"`]+$/g, '') || null;
  const direct = [...lead.matchAll(/\bdb\s*\.\s*([A-Za-z_$][\w$]*)\s*\./g)].pop();
  return direct ? direct[1] : null;
}

/**
 * Every write the code appears to perform. An empty result means the code reads
 * only — as far as a text scan can tell.
 */
export function detectWrites(code: string): DetectedWrite[] {
  // Collection names live in strings, which the blanked copy has emptied, so
  // names are read from the original text at the same offsets.
  const scannable = blankLiterals(code);
  const found: DetectedWrite[] = [];
  const seen = new Set<string>();

  const add = (method: string, collection: string | null) => {
    const key = `${method}:${collection ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ method, collection });
  };

  for (const match of scannable.matchAll(/\.\s*(\w+)\s*\(/g)) {
    const method = match[1];
    const at = match.index ?? 0;
    if (COLLECTION_WRITE_METHODS.has(method)) {
      add(method, collectionBefore(code, at));
    } else if (DB_WRITE_METHODS.has(method)) {
      add(method, null);
    }
  }

  for (const match of scannable.matchAll(/\b(?:runCommand|command)\s*\(\s*\{\s*(\w+)/g)) {
    const command = match[1];
    if (WRITE_COMMANDS.has(command.toLowerCase())) add(command, null);
  }

  // `$out` and `$merge` write the output of an aggregation, and they are
  // written as keys rather than calls.
  for (const stage of ['$out', '$merge']) {
    if (new RegExp(`['"\`]?\\${stage}['"\`]?\\s*:`).test(code)) add(stage, null);
  }

  return found;
}
