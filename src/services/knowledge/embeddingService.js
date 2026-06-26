'use strict';

/**
 * embeddingService.js
 * -----------------------------------------------------------------------------
 * Generates embeddings for chunks (indexing) and for the user's question
 * (retrieval). The SAME model is used for both (Feature 5).
 *
 * DESIGN: provider-agnostic (Feature 5 / "keep abstract to switch to BGE-M3 or
 * local embeddings later"). Two backends ship:
 *
 *   1. "local"        — @xenova/transformers running all-MiniLM-L6-v2 fully
 *                       offline (384-dim). DEFAULT. Works out-of-the-box, no API
 *                       key, no network. ~23MB quantized model, cached after
 *                       first use.
 *   2. "digitalocean" — OpenAI-compatible /v1/embeddings on inference.do-ai.run.
 *                       Default model: "all-mini-lm-l6-v2" (384-dim). Requires
 *                       the embedding models to be enabled on your DO GenAI
 *                       agent (otherwise returns 403) and a DigitalOcean API key.
 *
 * To switch provider later (e.g. to BGE-M3 / local-onnx), change the
 * EMBEDDING_CONFIG below — no other code needs to change. The model name + dim
 * are stored in status.json so a model swap forces a rebuild automatically.
 *
 * NOTE: The Groq CHAT model is NOT used for embeddings (Feature 5 rule).
 * -----------------------------------------------------------------------------
 */

const https = require('https');

// ---------------------------------------------------------------------------
// Configuration. Change these values to switch embedding backends.
// ---------------------------------------------------------------------------
const EMBEDDING_CONFIG = {
  provider: 'local',        // 'local' | 'digitalocean'
  // local (@xenova/transformers)
  localModel: 'Xenova/all-MiniLM-L6-v2',
  localDimension: 384,
  // digitalocean (OpenAI-compatible)
  digitaloceanHost: 'inference.do-ai.run',
  digitaloceanModel: 'all-mini-lm-l6-v2',
  digitaloceanDimension: 384
};

// Batch size for embedding calls (avoid too many API calls / payload limits).
const BATCH_SIZE = 32;
// Retry config for transient HTTP failures.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

// ---------------------------------------------------------------------------
// Local backend (transformers.js) — lazy-loaded, model cached after first use.
// ---------------------------------------------------------------------------
let _localPipelinePromise = null;

async function getLocalPipeline() {
  if (!_localPipelinePromise) {
    const transformers = await import('@xenova/transformers');
    // Quantized model keeps the download small (~23MB) and CPU usage low.
    _localPipelinePromise = transformers.pipeline('feature-extraction', EMBEDDING_CONFIG.localModel, { quantized: true });
  }
  return _localPipelinePromise;
}

async function embedLocal(texts) {
  const extractor = await getLocalPipeline();
  // transformers.js expects a string[] and returns a Tensor per input.
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  // Normalize to plain number[] arrays.
  const result = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(Array.from(out[i].data));
  }
  return result;
}

// ---------------------------------------------------------------------------
// DigitalOcean backend (OpenAI-compatible /v1/embeddings).
// ---------------------------------------------------------------------------
function httpsJsonPost(hostname, apiPath, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(bodyObj));
    const opts = {
      hostname, port: 443, path: apiPath, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': buf.length }, headers || {})
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Embeddings request timed out')); });
    req.write(buf); req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function embedDigitalocean(texts, apiKey) {
  if (!apiKey) throw new Error('DigitalOcean embeddings selected but no DigitalOcean API key is configured.');
  // OpenAI embeddings accepts string OR string[]. Use array form with one call.
  const { status, json, raw } = await httpsJsonPost(
    EMBEDDING_CONFIG.digitaloceanHost,
    '/v1/embeddings',
    { model: EMBEDDING_CONFIG.digitaloceanModel, input: texts },
    { Authorization: 'Bearer ' + apiKey }
  );
  if (status === 403) {
    throw new Error('DigitalOcean returned 403 (Forbidden) for embeddings. Enable embedding models on your DO GenAI agent, or switch embedding provider to "local".');
  }
  if (status >= 400 || !json || !json.data) {
    throw new Error('DigitalOcean embeddings failed (' + status + '): ' + ((json && json.error && json.error.message) || raw || '').slice(0, 200));
  }
  // json.data is sorted by index already; map to plain number[].
  return json.data.map(d => d.embedding);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed an array of texts (batched), with retry on transient failures.
 * @param {string[]} texts
 * @param {object} [opts]
 * @param {string} [opts.apiKey]  required only for the digitalocean provider
 * @param {object} [opts.provider] override EMBEDDING_CONFIG.provider
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts, opts) {
  opts = opts || {};
  const provider = opts.provider || EMBEDDING_CONFIG.provider;
  const batch = Math.max(1, BATCH_SIZE);
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    let attempt = 0;
    // Retry loop (Feature 5.6)
    while (true) {
      try {
        const vecs = provider === 'digitalocean'
          ? await embedDigitalocean(slice, opts.apiKey)
          : await embedLocal(slice);
        out.push(...vecs);
        break;
      } catch (e) {
        attempt++;
        // Local errors are not retried (they will fail every time). Only retry
        // the network backend.
        if (provider !== 'digitalocean' || attempt >= MAX_RETRIES) throw e;
        console.warn(`[Knowledge] Embedding batch failed (attempt ${attempt}/${MAX_RETRIES}): ${e.message}. Retrying...`);
        await sleep(RETRY_BASE_MS * attempt);
      }
    }
  }
  return out;
}

/** Embed a single text (the user's question) at retrieval time. */
async function embedQuery(text, opts) {
  const vecs = await embedTexts([text], opts);
  return vecs[0];
}

/** A stable identifier for the active model (stored in status.json). */
function getModelId() {
  if (EMBEDDING_CONFIG.provider === 'digitalocean') {
    return 'digitalocean:' + EMBEDDING_CONFIG.digitaloceanModel;
  }
  return 'local:' + EMBEDDING_CONFIG.localModel;
}

function getDimension() {
  return EMBEDDING_CONFIG.provider === 'digitalocean'
    ? EMBEDDING_CONFIG.digitaloceanDimension
    : EMBEDDING_CONFIG.localDimension;
}

/** Read-only access to the active config (useful for UI/debugging). */
function getConfig() {
  return Object.assign({}, EMBEDDING_CONFIG);
}

module.exports = {
  embedTexts,
  embedQuery,
  getModelId,
  getDimension,
  getConfig
};
