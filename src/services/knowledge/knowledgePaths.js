'use strict';

/**
 * knowledgePaths.js
 * -----------------------------------------------------------------------------
 * Single source of truth for all Knowledge-Base filesystem locations.
 *
 * Everything is written under `app.getPath("userData")` so the app behaves
 * identically in development and when packaged into a Windows .exe. We NEVER
 * write inside app.asar or process.resourcesPath — both are read-only when
 * packaged. See Feature 13 / Feature 18 of the RAG spec.
 *
 * On Windows `userData` resolves to something like:
 *   C:\Users\<user>\AppData\Roaming\Interview Assistant\
 * and the knowledge base root becomes:
 *   ...\Interview Assistant\knowledge-base\
 *      ├── source-pdfs\   (copied PDFs)
 *      ├── vectordb\      (LanceDB files)
 *      └── status.json    (index metadata)
 * -----------------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');

// The Electron `app` object is only available in the main process. We resolve it
// lazily so this module can be required early without crashing, and so unit
// tests that run outside Electron can inject a custom userData path.
let _app = null;
let _overrideRoot = null; // for tests / non-electron contexts

function getElectronApp() {
  if (_app) return _app;
  try {
    // `electron` is an object in the main process; `app` lives on it.
    _app = require('electron').app || null;
  } catch (e) {
    _app = null;
  }
  return _app;
}

/**
 * Allow callers (e.g. tests) to force a specific knowledge-base root.
 * Pass null/undefined to clear the override and fall back to Electron userData.
 */
function setRootOverride(dir) {
  _overrideRoot = dir || null;
}

/** Root directory of the whole knowledge base. */
function getKnowledgeBaseRoot() {
  if (_overrideRoot) return _overrideRoot;
  const app = getElectronApp();
  if (!app || !app.getPath) {
    // Fallback for non-Electron contexts (should not happen in the app).
    throw new Error('knowledgePaths: Electron app is not available. Call setRootOverride() in tests.');
  }
  return path.join(app.getPath('userData'), 'knowledge-base');
}

/** Directory where uploaded source PDFs are copied. */
function getSourcePdfDir() {
  return path.join(getKnowledgeBaseRoot(), 'source-pdfs');
}

/** Directory where the LanceDB vector database lives. */
function getVectorDbDir() {
  return path.join(getKnowledgeBaseRoot(), 'vectordb');
}

/** Path to the status.json file (index metadata used by the UI). */
function getStatusPath() {
  return path.join(getKnowledgeBaseRoot(), 'status.json');
}

/**
 * Ensure all required knowledge-base directories exist.
 * Safe to call repeatedly. Returns the root dir.
 */
function ensureDirectories() {
  const root = getKnowledgeBaseRoot();
  for (const dir of [root, getSourcePdfDir(), getVectorDbDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return root;
}

module.exports = {
  setRootOverride,
  getKnowledgeBaseRoot,
  getSourcePdfDir,
  getVectorDbDir,
  getStatusPath,
  ensureDirectories
};
