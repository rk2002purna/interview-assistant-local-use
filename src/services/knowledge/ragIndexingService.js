'use strict';

/**
 * ragIndexingService.js
 * -----------------------------------------------------------------------------
 * Orchestrates a full index rebuild (Feature 7):
 *
 *   1. resolve local source-pdf + vector-db paths
 *   2. delete the existing vector index
 *   3. read all PDFs
 *   4. extract text (page-level)
 *   5. split into chunks
 *   6. generate embeddings (batched)
 *   7. store chunks + embeddings in the vector DB
 *   8. persist status.json
 *
 * Returns a result object (Feature 7):
 *   { success, pdfCount, pageCount, chunkCount, failedFiles, vectorDbPath, message }
 * -----------------------------------------------------------------------------
 */

const paths = require('./knowledgePaths');
const status = require('./knowledgeStatusService');
const ingestion = require('./pdfIngestionService');
const chunking = require('./chunkingService');
const embeddings = require('./embeddingService');
const vectorStore = require('./vectorStoreService');
const lexicalStore = require('./lexicalStoreService');
const { isNativeModuleError } = require('./nativeSupport');

/**
 * Rebuild the entire index from scratch.
 * @param {object} [opts]
 * @param {string} [opts.apiKey]  only needed if embedding provider = digitalocean
 * @param {boolean} [opts.requirePdfs=true]  if true and no PDFs, return failure
 * @returns {Promise<object>}
 */
async function rebuildIndex(opts) {
  opts = opts || {};
  const apiKey = opts.apiKey || null;
  const requirePdfs = opts.requirePdfs !== false;

  paths.ensureDirectories();
  status.setProgress({ state: 'indexing', phase: 'Starting', message: '', currentPdf: 0, totalPdfs: 0, currentChunk: 0, totalChunks: 0 });

  const sourceDir = paths.getSourcePdfDir();
  const vectorDbDir = paths.getVectorDbDir();
  console.log('[Knowledge] Rebuild started. sourceDir=%s vectorDbDir=%s', sourceDir, vectorDbDir);

  const failedFiles = [];
  let pdfCount = 0, pageCount = 0, chunkCount = 0;

  try {
    // 1. Read all PDFs (list). Bail out cleanly if there are none.
    const files = ingestion.listPdfFiles();
    pdfCount = files.length;
    if (pdfCount === 0) {
      status.resetProgress();
      if (requirePdfs) {
        const msg = 'No PDFs uploaded. Add PDFs first, then rebuild the index.';
        status.writeStatus({ indexed: false, lastError: msg });
        status.setProgress({ state: 'error', message: msg });
        console.warn('[Knowledge] ' + msg);
        return { success: false, error: msg, pdfCount: 0, pageCount: 0, chunkCount: 0, failedFiles: [], vectorDbPath: vectorDbDir, message: msg };
      }
      // No PDFs but allowed: still produce an empty index (clears old one).
      await vectorStore.clearVectorStore();
      status.writeStatus({ indexed: false, pdfCount: 0, chunkCount: 0, lastIndexedAt: null, lastError: null, embeddingModel: embeddings.getModelId(), embeddingDimension: embeddings.getDimension() });
      status.resetProgress();
      return { success: true, pdfCount: 0, pageCount: 0, chunkCount: 0, failedFiles: [], vectorDbPath: vectorDbDir, message: 'No PDFs to index — cleared existing index.' };
    }

    // 2. Delete the old vector index.
    status.setProgress({ phase: 'Clearing old index', totalPdfs: pdfCount });
    console.log('[Knowledge] Clearing old vector index...');
    await vectorStore.clearVectorStore();

    // 3. Extract text from all PDFs.
    status.setProgress({ phase: 'Reading PDFs' });
    const { pages, failedFiles: ff, pageCount: pc } = await ingestion.extractAllPdfs({
      onProgress: (cur, total, fileName) => {
        console.log('[Knowledge] Extracting %d/%d: %s', cur, total, fileName);
        status.setProgress({ phase: 'Extracting text from PDFs', currentPdf: cur, totalPdfs: total });
      }
    });
    failedFiles.push(...ff);
    pageCount = pc;
    if (pages.length === 0) {
      const msg = 'No extractable text found in any PDF.' + (failedFiles.length ? ' Failed files: ' + failedFiles.join(', ') : '');
      status.writeStatus({ indexed: false, pdfCount, lastError: msg });
      status.setProgress({ state: 'error', message: msg });
      return { success: false, error: msg, pdfCount, pageCount: 0, chunkCount: 0, failedFiles, vectorDbPath: vectorDbDir, message: msg };
    }

    // 4. Chunk.
    status.setProgress({ phase: 'Creating chunks', currentPdf: pdfCount, totalPdfs: pdfCount });
    console.log('[Knowledge] Creating chunks from %d pages...', pages.length);
    const chunks = chunking.chunkPages(pages);
    chunkCount = chunks.length;
    status.setProgress({ phase: 'Creating chunks', totalChunks: chunkCount, currentChunk: 0 });
    console.log('[Knowledge] Created %d chunks.', chunkCount);

    // 5. Pick the retrieval mode ONCE, before indexing, so we never end up with
    //    a half-vector/half-keyword index.
    //
    //    'vector'  → embeddings (onnxruntime-node) + LanceDB. Best quality.
    //    'keyword' → pure-JS BM25. Used when either native module cannot load on
    //                this machine (e.g. missing MSVC runtime, no admin rights).
    let mode = 'vector';
    let nativeIssue = null;
    status.setProgress({ phase: 'Preparing index' });
    try {
      await embeddings.embedTexts(['knowledge base capability probe'], { apiKey });
      await vectorStore.initializeVectorStore();
    } catch (e) {
      if (!isNativeModuleError(e)) throw e; // a real error — surface it
      mode = 'keyword';
      nativeIssue = e.message;
      console.warn('[Knowledge] Native modules unavailable — falling back to keyword (BM25) index. Reason: %s', e.message);
      // Drop the unusable vector directory so status reflects reality.
      await vectorStore.clearVectorStore();
    }

    // 6. Build the index (batched) with progress.
    const phaseLabel = mode === 'vector' ? 'Generating embeddings' : 'Building keyword index';
    status.setProgress({ phase: phaseLabel, totalChunks: chunkCount, currentChunk: 0 });
    console.log('[Knowledge] %s for %d chunks (mode=%s)...', phaseLabel, chunkCount, mode);

    if (mode === 'keyword') {
      lexicalStore.clear();
      lexicalStore.beginBuild();
    }

    const texts = chunks.map(c => c.text);
    let done = 0;
    const BATCH = 32;
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const records = [];

      if (mode === 'vector') {
        const vecs = await embeddings.embedTexts(slice, { apiKey });
        for (let j = 0; j < slice.length; j++) {
          const c = chunks[i + j];
          records.push({
            id: c.id, text: c.text, embedding: vecs[j],
            sourceFile: c.sourceFile, pageNumber: c.pageNumber, chunkIndex: c.chunkIndex,
            createdAt: new Date().toISOString()
          });
        }
        await vectorStore.addChunks(records);
      } else {
        for (let j = 0; j < slice.length; j++) {
          const c = chunks[i + j];
          records.push({
            id: c.id, text: c.text,
            sourceFile: c.sourceFile, pageNumber: c.pageNumber, chunkIndex: c.chunkIndex,
            createdAt: new Date().toISOString()
          });
        }
        lexicalStore.addChunks(records);
      }

      done += slice.length;
      if (done % 64 === 0 || done === texts.length) {
        console.log('[Knowledge]   indexed %d/%d', done, texts.length);
      }
      status.setProgress({ phase: phaseLabel, currentChunk: done, totalChunks: chunkCount });
    }

    if (mode === 'keyword') {
      status.setProgress({ phase: 'Saving keyword index' });
      lexicalStore.finalizeBuild();
    } else {
      // A previous keyword index would otherwise shadow fresh vector results.
      lexicalStore.clear();
    }

    // 7. Persist status.json.
    status.writeStatus({
      indexed: true,
      pdfCount,
      pageCount,
      chunkCount,
      lastIndexedAt: new Date().toISOString(),
      embeddingModel: mode === 'vector' ? embeddings.getModelId() : 'keyword-bm25',
      embeddingDimension: mode === 'vector' ? embeddings.getDimension() : 0,
      vectorDbProvider: mode === 'vector' ? 'lancedb' : 'json-bm25',
      retrievalMode: mode,
      nativeUnavailableReason: nativeIssue,
      lastError: null
    });
    status.setProgress({ state: 'ready', phase: 'Knowledge base ready', currentChunk: chunkCount, totalChunks: chunkCount });

    let message = failedFiles.length
      ? `Knowledge base indexed with ${failedFiles.length} failed file(s): ${failedFiles.join(', ')}`
      : 'Knowledge base indexed successfully';
    if (mode === 'keyword') {
      message += ' (keyword search mode — the local AI embedding engine could not load on this machine, so documents are matched by keywords instead of meaning)';
    }
    console.log('[Knowledge] Rebuild complete: %d PDFs, %d pages, %d chunks, mode=%s.', pdfCount, pageCount, chunkCount, mode);
    return { success: true, pdfCount, pageCount, chunkCount, failedFiles, vectorDbPath: vectorDbDir, retrievalMode: mode, message };
  } catch (e) {
    console.error('[Knowledge] Rebuild FAILED:', e.message, e.stack);
    status.writeStatus({ indexed: false, pdfCount, chunkCount, lastError: e.message });
    status.setProgress({ state: 'error', message: e.message });
    return { success: false, error: e.message, pdfCount, pageCount, chunkCount, failedFiles, vectorDbPath: vectorDbDir, message: 'Indexing failed: ' + e.message };
  }
}

module.exports = { rebuildIndex };
