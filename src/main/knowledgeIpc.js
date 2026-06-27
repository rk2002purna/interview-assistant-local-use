'use strict';

/**
 * knowledgeIpc.js
 * -----------------------------------------------------------------------------
 * Registers all Knowledge-Base IPC handlers between the renderer and the main
 * process (Feature 10). The renderer never touches Node `fs` directly — every
 * filesystem operation happens here.
 *
 * Channels:
 *   knowledge:select-pdfs    dialog.showOpenDialog → copy PDFs into userData
 *   knowledge:list-pdfs      list copied PDFs with name/size/added date
 *   knowledge:rebuild-index  full rebuild (extract→chunk→embed→store)
 *   knowledge:delete         delete copied PDFs + vector DB (with confirm)
 *   knowledge:status         live status string for the UI
 *   knowledge:stats          durable stats { indexed, chunkCount, ... }
 *   knowledge:rag-search     retrieve context for a question (RAG answer flow)
 * -----------------------------------------------------------------------------
 */

const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let paths, statusService, indexing, ragAnswer, vectorStore;

try {
  console.log('[Knowledge] Loading knowledge service modules...');
  paths = require('../services/knowledge/knowledgePaths');
  statusService = require('../services/knowledge/knowledgeStatusService');
  indexing = require('../services/knowledge/ragIndexingService');
  ragAnswer = require('../services/knowledge/ragAnswerService');
  vectorStore = require('../services/knowledge/vectorStoreService');
  console.log('[Knowledge] All service modules loaded successfully');
} catch (e) {
  console.error('[Knowledge] FATAL: Failed to load service modules:', e.message);
  console.error('[Knowledge] Stack:', e.stack);
  // Set dummy modules so the app doesn't crash
  paths = { getSourcePdfDir: () => '', ensureDirectories: () => {} };
  statusService = { readStatus: () => ({}), describeStatus: () => 'Error', getProgress: () => ({}), resetStatus: () => {}, resetProgress: () => {} };
  indexing = { rebuildIndex: async () => ({ success: false, error: 'Service load failed' }) };
  ragAnswer = { retrieveContext: async () => ({ error: 'Service load failed' }) };
  vectorStore = { clearVectorStore: async () => {}, getIndexStats: async () => ({}) };
}

// ── Seed PDFs from dev folder (optional, dev-only convenience) ──
// If you place PDFs in src/knowledge-base-seed/ during development,
// they'll be copied to userData on first run. This is NOT for production.
function seedPdfsFromDevFolder() {
  try {
    const seedDir = path.join(__dirname, '..', '..', 'knowledge-base-seed');
    if (!fs.existsSync(seedDir)) return; // No seed folder → skip
    
    const files = fs.readdirSync(seedDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) return;

    console.log(`[Knowledge] Found ${files.length} seed PDFs in development folder`);
    const targetDir = paths.getSourcePdfDir();
    
    let copied = 0;
    for (const file of files) {
      const targetPath = path.join(targetDir, file);
      if (fs.existsSync(targetPath)) continue; // Already copied
      
      const sourcePath = path.join(seedDir, file);
      fs.copyFileSync(sourcePath, targetPath);
      copied++;
      console.log(`[Knowledge] Seeded: ${file}`);
    }
    
    if (copied > 0) {
      console.log(`[Knowledge] Copied ${copied} seed PDFs to userData (dev mode)`);
    }
  } catch (e) {
    console.error('[Knowledge] Seed PDFs failed (non-fatal):', e.message);
  }
}

// Seed PDFs on module load (first time only)
seedPdfsFromDevFolder();

let _registered = false;

function registerKnowledgeIpc() {
  if (_registered) return;
  _registered = true;

  console.log('[Knowledge] Registering IPC handlers...');
  paths.ensureDirectories();

  // ---------------------------------------------------------------
  // Feature 2: Select & copy PDFs into local app storage.
  // ---------------------------------------------------------------
  ipcMain.handle('knowledge:select-pdfs', async (event) => {
    console.log('[Knowledge] select-pdfs handler called');
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      title: 'Select PDFs for the Guidewire Knowledge Base',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    };
    let result;
    try {
      console.log('[Knowledge] Showing file dialog...');
      result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      console.log('[Knowledge] Dialog result:', { canceled: result.canceled, fileCount: result.filePaths ? result.filePaths.length : 0 });
    } catch (e) {
      console.error('[Knowledge] showOpenDialog error:', e.message);
      console.error('[Knowledge] Stack:', e.stack);
      return { success: false, error: e.message, copied: [] };
    }

    // User cancelled the picker (Feature 12.1) — not an error.
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      console.log('[Knowledge] PDF selection cancelled by user.');
      return { success: true, cancelled: true, copied: [] };
    }

    console.log('[Knowledge] PDFs selected: %d file(s)', result.filePaths.length);
    console.log('[Knowledge] Selected paths:', result.filePaths);
    
    try {
      paths.ensureDirectories();
      const destDir = paths.getSourcePdfDir();
      console.log('[Knowledge] Destination directory:', destDir);
      
      const copied = [];
      const skipped = [];

      for (const src of result.filePaths) {
        try {
          console.log('[Knowledge] Copying:', src);
          const info = await copyPdfSafely(src, destDir);
          console.log('[Knowledge] Copied successfully:', info.fileName);
          copied.push(info);
        } catch (e) {
          console.error('[Knowledge] Failed to copy %s: %s', src, e.message);
          skipped.push({ originalPath: src, error: e.message });
        }
      }
      console.log('[Knowledge] Copied %d PDF(s), skipped %d.', copied.length, skipped.length);
      return { success: true, cancelled: false, copied, skipped };
    } catch (e) {
      console.error('[Knowledge] FATAL: Copy operation failed:', e.message);
      console.error('[Knowledge] Stack:', e.stack);
      return { success: false, error: e.message, copied: [] };
    }
  });

  // ---------------------------------------------------------------
  // Feature 1.2: List copied PDFs.
  // ---------------------------------------------------------------
  ipcMain.handle('knowledge:list-pdfs', async () => {
    return listCopiedPdfs();
  });

  // ---------------------------------------------------------------
  // Feature 1.3 / 7: Rebuild the index.
  // ---------------------------------------------------------------
  ipcMain.handle('knowledge:rebuild-index', async () => {
    const apiKey = loadDigitaloceanKey();
    const result = await indexing.rebuildIndex({ apiKey });
    return result;
  });

  // ---------------------------------------------------------------
  // Feature 1.4: Delete everything (PDFs + vector DB).
  // ---------------------------------------------------------------
  ipcMain.handle('knowledge:delete', async () => {
    try {
      // Delete copied PDFs.
      const dir = paths.getSourcePdfDir();
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.toLowerCase().endsWith('.pdf')) {
            try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* keep going */ }
          }
        }
      }
      // Delete the vector DB.
      await vectorStore.clearVectorStore();
      // Reset status.
      statusService.resetStatus();
      statusService.resetProgress();
      console.log('[Knowledge] Knowledge base deleted (PDFs + vector DB).');
      return { success: true };
    } catch (e) {
      console.error('[Knowledge] Delete failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  // ---------------------------------------------------------------
  // Feature 1.5 / 5: Status (human string + progress).
  // ---------------------------------------------------------------
  ipcMain.handle('knowledge:status', async () => {
    return {
      description: statusService.describeStatus(),
      progress: statusService.getProgress(),
      durable: statusService.readStatus()
    };
  });

  // ---------------------------------------------------------------
  // Feature 6 / 19: Stats from the vector store.
  // ---------------------------------------------------------------
  ipcMain.handle('knowledge:stats', async () => {
    const stats = await vectorStore.getIndexStats();
    const pdfs = await listCopiedPdfs();
    const durable = statusService.readStatus();
    return {
      indexed: !!stats.indexed,
      chunkCount: stats.chunkCount || 0,
      pdfCount: pdfs.length,
      embeddingModel: durable.embeddingModel,
      embeddingDimension: durable.embeddingDimension,
      vectorDbProvider: durable.vectorDbProvider,
      lastIndexedAt: durable.lastIndexedAt,
      lastError: durable.lastError
    };
  });

  // ---------------------------------------------------------------
  // Feature 8: RAG retrieval (returns context; renderer splices into prompt).
  // ---------------------------------------------------------------
  ipcMain.handle('knowledge:rag-search', async (event, payload) => {
    const question = (payload && payload.question) || '';
    const apiKey = loadDigitaloceanKey();
    const result = await ragAnswer.retrieveContext(question, { apiKey });
    return result;
  });

  console.log('[Knowledge] ✓ All 7 IPC handlers registered successfully');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copy a single PDF into the source-pdfs dir without overwriting an existing
 * file with the same name (Feature 2.5). If the name collides, append a short
 * timestamp+hash suffix before the extension.
 *
 * @returns {Promise<{fileName, originalPath, storedPath, sizeBytes, addedAt}>}
 */
function copyPdfSafely(src, destDir) {
  return new Promise((resolve, reject) => {
    const base = path.basename(src);
    let target = path.join(destDir, base);
    if (fs.existsSync(target)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      const stamp = Date.now().toString(36);
      const hash = crypto.createHash('sha1').update(src + String(process.hrtime.bigint())).digest('hex').slice(0, 6);
      target = path.join(destDir, stem + '_' + stamp + '_' + hash + ext);
    }
    fs.copyFile(src, target, (err) => {
      if (err) return reject(err);
      fs.stat(target, (sErr, st) => {
        if (sErr) return reject(sErr);
        resolve({
          fileName: path.basename(target),
          originalPath: src,
          storedPath: target,
          sizeBytes: st.size,
          addedAt: st.mtime.toISOString()
        });
      });
    });
  });
}

/** List all copied PDFs with metadata (Feature 1.2). */
function listCopiedPdfs() {
  const dir = paths.getSourcePdfDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.pdf')) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      out.push({ fileName: name, storedPath: full, sizeBytes: st.size, addedAt: st.mtime.toISOString() });
    } catch (e) { /* skip unreadable */ }
  }
  // newest first
  out.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  return out;
}

/**
 * Load the DigitalOcean key from the app config file (Feature 14 — RAG_ENABLED
 * auto when index exists; embedding provider currently defaults to "local", so
 * this key is only used if the provider is switched to "digitalocean").
 */
function loadDigitaloceanKey() {
  try {
    const os = require('os');
    const cfgPath = path.join(os.homedir(), '.interview-assistant-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return cfg.digitaloceanApiKey || '';
    }
  } catch (e) { /* ignore */ }
  return '';
}

module.exports = { registerKnowledgeIpc };
