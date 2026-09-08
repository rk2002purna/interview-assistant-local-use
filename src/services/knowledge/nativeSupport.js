'use strict';

/**
 * nativeSupport.js
 * -----------------------------------------------------------------------------
 * Detects "this machine cannot load our native modules" failures so the
 * knowledge base can degrade to the pure-JS keyword index instead of failing.
 *
 * The knowledge base optionally uses two compiled modules:
 *   - onnxruntime-node  (local embeddings)
 *   - @lancedb/lancedb  (vector store)
 *
 * Typical failures we must recognize:
 *   - Windows error 126: "The specified module could not be found" — raised both
 *     when the .node file is missing AND when a dependency of it is missing
 *     (e.g. onnxruntime.dll needs the MSVC runtime, which a user without admin
 *     rights cannot install).
 *   - "Cannot find module 'onnxruntime-node'" — optional dependency absent.
 *   - "is not a valid Win32 application" — architecture mismatch.
 *   - Linux/macOS equivalents from dlopen.
 * -----------------------------------------------------------------------------
 */

const NATIVE_ERROR_PATTERNS = [
  'specified module could not be found',
  'specified procedure could not be found',
  'not a valid win32 application',
  'cannot find module',
  'dlopen',
  'onnxruntime',
  'lancedb',
  '.node',
  '.dll',
  'libc++',
  'glibc',
  'symbol not found',
  'image not found'
];

/**
 * @param {unknown} err
 * @returns {boolean} true when the error looks like a native module that cannot
 *   be loaded on this machine (as opposed to a genuine logic/data error).
 */
function isNativeModuleError(err) {
  if (!err) return false;
  const message = String((err && err.message) || err).toLowerCase();
  if (err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_DLOPEN_FAILED')) return true;
  return NATIVE_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

module.exports = { isNativeModuleError };
