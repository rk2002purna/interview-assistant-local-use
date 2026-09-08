'use strict';

/**
 * lexicalStoreService.js
 * -----------------------------------------------------------------------------
 * Pure-JavaScript keyword retrieval (Okapi BM25) used as the knowledge-base
 * fallback when the native modules are unavailable.
 *
 * WHY THIS EXISTS
 *   The default retrieval path needs two native modules:
 *     - onnxruntime-node  (local embeddings via @xenova/transformers)
 *     - @lancedb/lancedb  (vector store)
 *   Both are compiled binaries. On locked-down/managed Windows machines they can
 *   fail to load — e.g. onnxruntime.dll needs the Microsoft Visual C++
 *   Redistributable, which a user without admin rights cannot install. That
 *   surfaced as: "Indexing failed: The specified module could not be found ...
 *   onnxruntime_binding.node" (Windows error 126).
 *
 *   This store has ZERO native dependencies and needs no API key: chunks are
 *   persisted as JSON and ranked in JS with BM25. Retrieval quality is lower
 *   than vector search for paraphrased questions, but it works everywhere and
 *   is effective for documentation lookups where the question shares
 *   terminology with the source text.
 *
 * ON-DISK FORMAT (knowledge-base/lexical-index.json)
 *   { version, createdAt, chunkCount, avgLength, df:{term:docFreq},
 *     chunks:[ { id, text, sourceFile, pageNumber, chunkIndex, createdAt,
 *                length, tf:{term:count} } ] }
 *
 * Public API (mirrors vectorStoreService where it makes sense):
 *   beginBuild() / addChunks(records) / finalizeBuild() / clear()
 *   hasIndex() / search(question, topK) / getIndexStats()
 * -----------------------------------------------------------------------------
 */

const fs = require('fs');
const paths = require('./knowledgePaths');

// BM25 parameters. k1 controls term-frequency saturation, b the length
// normalization. 1.2-2.0 / 0.75 are the standard defaults.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Maps an unbounded BM25 score into (0,1) so callers can apply a single
// relevance floor regardless of retrieval mode. Tuned so a solid keyword match
// lands around 0.4-0.7 and incidental matches stay below ~0.15.
const SCORE_SATURATION = 5;

// Extremely common words carry no retrieval signal and would otherwise match
// every chunk. Deliberately short: domain terms must never be stripped.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'so',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'why',
  'will', 'with', 'you', 'your'
]);

/** In-memory index cache; loaded from disk on first use. */
let _index = null;
/** Accumulator used between beginBuild() and finalizeBuild(). */
let _building = null;

/**
 * Split text into normalized terms. Keeps alphanumerics (so identifiers like
 * "gw1" or "policycenter" survive) and applies a light plural strip so
 * "policies"/"policy" and "claims"/"claim" match.
 */
function tokenize(text) {
  if (!text) return [];
  const out = [];
  const raw = String(text).toLowerCase().split(/[^a-z0-9]+/);
  for (let token of raw) {
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    if (token.length > 4 && token.endsWith('ies')) token = token.slice(0, -3) + 'y';
    else if (token.length > 3 && token.endsWith('es')) token = token.slice(0, -2);
    else if (token.length > 3 && token.endsWith('s')) token = token.slice(0, -1);
    out.push(token);
  }
  return out;
}

function termFrequencies(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

/** Start a fresh build. Discards any half-built state. */
function beginBuild() {
  _building = { chunks: [], df: Object.create(null) };
}

/**
 * Add chunk records to the in-progress build. Embeddings are not required or
 * used; only the text is indexed.
 * @param {Array<{id,text,sourceFile,pageNumber,chunkIndex,createdAt}>} records
 */
function addChunks(records) {
  if (!records || records.length === 0) return;
  if (!_building) beginBuild();
  const now = new Date().toISOString();

  for (const r of records) {
    const tokens = tokenize(r.text);
    if (tokens.length === 0) continue;
    const tf = termFrequencies(tokens);
    for (const term of Object.keys(tf)) {
      _building.df[term] = (_building.df[term] || 0) + 1;
    }
    _building.chunks.push({
      id: r.id,
      text: r.text,
      sourceFile: r.sourceFile,
      pageNumber: r.pageNumber || 0,
      chunkIndex: typeof r.chunkIndex === 'number' ? r.chunkIndex : 0,
      createdAt: r.createdAt || now,
      length: tokens.length,
      tf
    });
  }
}

/** Persist the built index to disk and make it the active index. */
function finalizeBuild() {
  if (!_building) beginBuild();
  const chunks = _building.chunks;
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);

  const index = {
    version: 1,
    createdAt: new Date().toISOString(),
    chunkCount: chunks.length,
    avgLength: chunks.length ? totalLength / chunks.length : 0,
    df: _building.df,
    chunks
  };

  paths.ensureDirectories();
  fs.writeFileSync(paths.getLexicalIndexPath(), JSON.stringify(index), 'utf8');
  _index = index;
  _building = null;
  return { chunkCount: index.chunkCount };
}

/** Remove the on-disk keyword index and drop the cache. */
function clear() {
  _index = null;
  _building = null;
  const file = paths.getLexicalIndexPath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    /* best-effort: a stale index is overwritten by the next build anyway */
  }
}

/** Load the index from disk (cached). Returns null when absent/unreadable. */
function _load() {
  if (_index) return _index;
  const file = paths.getLexicalIndexPath();
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.chunks) || parsed.chunks.length === 0) return null;
    _index = parsed;
    return _index;
  } catch (e) {
    console.warn('[Knowledge] Keyword index unreadable:', e.message);
    return null;
  }
}

/** Is a usable keyword index present? */
function hasIndex() {
  return !!_load();
}

/**
 * BM25 search.
 * @param {string} question
 * @param {number} [topK=5]
 * @returns {Array<{id,text,sourceFile,pageNumber,chunkIndex,createdAt,score:number}>}
 *   `score` is normalized to (0,1), higher = better, for parity with the
 *   vector store's similarity score.
 */
function search(question, topK) {
  topK = topK || 5;
  const index = _load();
  if (!index) return [];

  const queryTerms = Object.keys(termFrequencies(tokenize(question)));
  if (queryTerms.length === 0) return [];

  const N = index.chunkCount;
  const avgLen = index.avgLength || 1;

  // Precompute IDF per query term (BM25 probabilistic form, floored at 0 so a
  // term appearing in most chunks cannot push scores negative).
  const idf = Object.create(null);
  for (const term of queryTerms) {
    const df = index.df[term] || 0;
    if (df === 0) continue;
    idf[term] = Math.max(0, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }

  const scored = [];
  for (const chunk of index.chunks) {
    let raw = 0;
    for (const term of queryTerms) {
      const termIdf = idf[term];
      if (!termIdf) continue;
      const freq = chunk.tf[term];
      if (!freq) continue;
      const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * (chunk.length / avgLen));
      raw += termIdf * ((freq * (BM25_K1 + 1)) / denom);
    }
    if (raw <= 0) continue;
    scored.push({
      id: chunk.id,
      text: chunk.text,
      sourceFile: chunk.sourceFile,
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      createdAt: chunk.createdAt,
      score: raw / (raw + SCORE_SATURATION)
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Summary stats for the status panel. */
function getIndexStats() {
  const index = _load();
  if (!index) return { indexed: false, chunkCount: 0 };
  return { indexed: true, chunkCount: index.chunkCount, mode: 'keyword' };
}

module.exports = {
  beginBuild,
  addChunks,
  finalizeBuild,
  clear,
  hasIndex,
  search,
  getIndexStats,
  // exported for tests
  tokenize
};
