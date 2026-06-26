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

    // 5. Embed (batched) with progress.
    status.setProgress({ phase: 'Generating embeddings', totalChunks: chunkCount, currentChunk: 0 });
    console.log('[Knowledge] Generating embeddings for %d chunks (model=%s)...', chunkCount, embeddings.getModelId());
    const texts = chunks.map(c => c.text);
    let done = 0;
    const BATCH = 32;
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const vecs = await embeddings.embedTexts(slice, { apiKey });
      const records = [];
      for (let j = 0; j < slice.length; j++) {
        const c = chunks[i + j];
        records.push({
          id: c.id, text: c.text, embedding: vecs[j],
          sourceFile: c.sourceFile, pageNumber: c.pageNumber, chunkIndex: c.chunkIndex,
          createdAt: new Date().toISOString()
        });
      }
      await vectorStore.addChunks(records);
      done += slice.length;
      if (done % 64 === 0 || done === texts.length) {
        console.log('[Knowledge]   embeddings %d/%d', done, texts.length);
      }
      status.setProgress({ phase: 'Generating embeddings', currentChunk: done, totalChunks: chunkCount });
    }

    // 6. Persist status.json.
    status.writeStatus({
      indexed: true,
      pdfCount,
      pageCount,
      chunkCount,
      lastIndexedAt: new Date().toISOString(),
      embeddingModel: embeddings.getModelId(),
      embeddingDimension: embeddings.getDimension(),
      vectorDbProvider: 'lancedb',
      lastError: null
    });
    status.setProgress({ state: 'ready', phase: 'Knowledge base ready', currentChunk: chunkCount, totalChunks: chunkCount });

    const message = failedFiles.length
      ? `Knowledge base indexed with ${failedFiles.length} failed file(s): ${failedFiles.join(', ')}`
      : 'Knowledge base indexed successfully';
    console.log('[Knowledge] Rebuild complete: %d PDFs, %d pages, %d chunks.', pdfCount, pageCount, chunkCount);
    return { success: true, pdfCount, pageCount, chunkCount, failedFiles, vectorDbPath: vectorDbDir, message };
  } catch (e) {
    console.error('[Knowledge] Rebuild FAILED:', e.message, e.stack);
    status.writeStatus({ indexed: false, pdfCount, chunkCount, lastError: e.message });
    status.setProgress({ state: 'error', message: e.message });
    return { success: false, error: e.message, pdfCount, pageCount, chunkCount, failedFiles, vectorDbPath: vectorDbDir, message: 'Indexing failed: ' + e.message };
  }
}

module.exports = { rebuildIndex };
