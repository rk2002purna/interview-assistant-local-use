'use strict';

/**
 * vectorStoreService.js
 * -----------------------------------------------------------------------------
 * Local vector database backed by LanceDB (embedded, no server) (Feature 6).
 *
 * The DB lives at:  userData/knowledge-base/vectordb
 *
 * Record shape stored per chunk:
 *   { id, text, embedding:number[], sourceFile, pageNumber?, chunkIndex, createdAt }
 *
 * Public functions:
 *   initializeVectorStore()
 *   clearVectorStore()
 *   addChunks(records)
 *   searchSimilar(questionEmbedding, topK)
 *   hasIndex()
 *   getIndexStats()
 * -----------------------------------------------------------------------------
 */

const fs = require('fs');
const lancedb = require('@lancedb/lancedb');
const paths = require('./knowledgePaths');

const TABLE = 'chunks';

let _db = null;
let _table = null;

/** Open (or create) the LanceDB connection. Safe to call repeatedly. */
async function _connect() {
  paths.ensureDirectories();
  if (!_db) {
    _db = await lancedb.connect(paths.getVectorDbDir());
  }
  return _db;
}

/**
 * Initialize the vector store. Ensures the table exists with the right schema.
 * Called at the start of a rebuild and before any search.
 */
async function initializeVectorStore() {
  const db = await _connect();
  const tables = await db.tableNames();
  if (!tables.includes(TABLE)) {
    // Create an empty table with the correct schema by adding a single
    // well-formed row, then deleting it.
    await db.createTable(TABLE, [_schemaSeedRow()], { mode: 'overwrite' });
    _table = await db.openTable(TABLE);
    try { await _table.delete('id = ' + JSON.stringify(_schemaSeedRow().id)); } catch (e) { /* ok */ }
  } else {
    _table = await db.openTable(TABLE);
  }
  return _table;
}

// A valid record used to seed the table so LanceDB infers the schema.
function _schemaSeedRow() {
  return {
    id: '__schema_seed__',
    text: '',
    embedding: new Array(384).fill(0), // matches default local model dim
    sourceFile: '',
    pageNumber: 0,
    chunkIndex: 0,
    createdAt: new Date().toISOString()
  };
}

/** Delete the entire table + drop connection cache (Feature 3 of rebuild). */
async function clearVectorStore() {
  _table = null;
  _db = null;
  // Wipe the on-disk LanceDB directory so the next index starts clean.
  const dir = paths.getVectorDbDir();
  if (fs.existsSync(dir)) {
    await _rmrf(dir);
  }
}

function _rmrf(target) {
  return new Promise((resolve, reject) => {
    // fs.rm with recursive + force handles files and non-empty dirs on Node 14+.
    fs.rm(target, { recursive: true, force: true }, (err) => {
      if (err && err.code !== 'ENOENT') reject(err); else resolve();
    });
  });
}

/**
 * Add chunk records (each must already include its embedding vector).
 * Embedding dimension is inferred from the first record's vector.
 * @param {Array<{id,text,embedding,sourceFile,pageNumber,chunkIndex,createdAt}>} records
 */
async function addChunks(records) {
  if (!records || records.length === 0) return;
  const db = await _connect();
  const now = new Date().toISOString();
  const rows = records.map(r => ({
    id: r.id,
    text: r.text,
    embedding: r.embedding,
    sourceFile: r.sourceFile,
    pageNumber: r.pageNumber || 0,
    chunkIndex: typeof r.chunkIndex === 'number' ? r.chunkIndex : 0,
    createdAt: r.createdAt || now
  }));
  const tables = await db.tableNames();
  if (!tables.includes(TABLE)) {
    await db.createTable(TABLE, rows, { mode: 'overwrite' });
    _table = await db.openTable(TABLE);
  } else {
    _table = await db.openTable(TABLE);
    await _table.add(rows);
  }
}

/**
 * Search the index for the chunks closest to `questionEmbedding`.
 * @param {number[]} questionEmbedding
 * @param {number} [topK=5]
 * @returns {Promise<Array<{id,text,sourceFile,pageNumber,chunkIndex,createdAt,score:number}>>}
 *   `score` is similarity in [0,1] (higher = better). Derived from LanceDB's
 *   L2 _distance (distance = 0 → identical → similarity 1).
 */
async function searchSimilar(questionEmbedding, topK) {
  topK = topK || 5;
  if (!questionEmbedding || questionEmbedding.length === 0) return [];
  if (!await hasIndex()) return [];
  if (!_table) await initializeVectorStore();
  const results = await _table.search(questionEmbedding).limit(topK).toArray();
  return results.map(r => ({
    id: r.id,
    text: r.text,
    sourceFile: r.sourceFile,
    pageNumber: r.pageNumber,
    chunkIndex: r.chunkIndex,
    createdAt: r.createdAt,
    score: _distanceToSimilarity(r._distance)
  }));
}

// Convert LanceDB squared-L2 distance to a 0..1 similarity score for display.
// Using a saturating transform so small distances map near 1.
function _distanceToSimilarity(distance) {
  if (distance === null || distance === undefined || isNaN(distance)) return 0;
  // 1 / (1 + distance) keeps it in (0,1] for non-negative distances.
  const s = 1 / (1 + distance);
  return Math.max(0, Math.min(1, s));
}

/** Does a usable index table currently exist on disk? */
async function hasIndex() {
  try {
    const db = await _connect();
    const tables = await db.tableNames();
    if (!tables.includes(TABLE)) return false;
    const t = await db.openTable(TABLE);
    const n = await t.countRows();
    // The seed row (deleted) leaves 0 rows; treat empty as "no index".
    return n > 0;
  } catch (e) {
    return false;
  }
}

/** Return summary stats for the UI / status panel. */
async function getIndexStats() {
  try {
    if (!await hasIndex()) return { indexed: false, chunkCount: 0 };
    const t = await (await _connect()).openTable(TABLE);
    const n = await t.countRows();
    return { indexed: n > 0, chunkCount: n };
  } catch (e) {
    return { indexed: false, chunkCount: 0, error: e.message };
  }
}

module.exports = {
  initializeVectorStore,
  clearVectorStore,
  addChunks,
  searchSimilar,
  hasIndex,
  getIndexStats
};
