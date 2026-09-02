'use strict';

/**
 * Compatibility wrapper that routes requests through Electron's net module
 * (Chromium's network stack) while preserving the small subset of Node's
 * `https.request` API these call sites use.
 *
 * Why: Node's `https.request` validates TLS against Node's own bundled CA
 * list and ignores the OS proxy. On managed/corporate networks (HTTPS
 * interception with a company root cert, or a forced proxy) that fails —
 * even though the browser and curl succeed, because they use the OS
 * certificate store and proxy. Electron's `net.request` uses Chromium's
 * networking, which honors the OS cert store (including corporate roots) and
 * the system proxy, so the app connects on those networks.
 *
 * Supported surface (matches how main.js / embeddingService.js use it):
 *   const req = netHttpsRequest(options, (res) => { res.on('data'|'end') });
 *   req.on('error', cb); req.setTimeout(ms, cb); req.write(body); req.end();
 *   req.destroy();  // inside the timeout callback
 * `options` uses the Node style: { hostname, port, path, method, headers }.
 */

/**
 * @param {object} options Node-style request options.
 * @param {(res: any) => void} [responseCallback] Called with the response.
 * @returns {any} An Electron ClientRequest augmented with setTimeout/destroy.
 */
function netHttpsRequest(options, responseCallback) {
  // Lazy require so this module can be loaded before the electron runtime is
  // fully initialized; net.request itself is only invoked on user actions.
  const { net } = require('electron');

  // net.request is happiest with a full URL rather than Node's separate
  // hostname/port/path fields (passing those the Node way can throw
  // net::ERR_INVALID_ARGUMENT). Every caller used https on port 443.
  const protocol = options.protocol || 'https:';
  const host = options.hostname || options.host;
  const port = options.port;
  const path = options.path || '/';
  const url = `${protocol}//${host}${port ? ':' + port : ''}${path}`;

  const req = net.request({ method: options.method || 'GET', url });

  // Electron requires header VALUES to be strings and computes Content-Length
  // itself from the written body. Node tolerated a numeric Content-Length
  // (bodyBuffer.length), but passing a non-string header value to net.request
  // throws net::ERR_INVALID_ARGUMENT. So stringify every value and skip
  // Content-Length (Chromium sets it correctly for the body we write).
  if (options.headers) {
    for (const name of Object.keys(options.headers)) {
      if (name.toLowerCase() === 'content-length') continue;
      const value = options.headers[name];
      if (value !== undefined && value !== null) {
        req.setHeader(name, String(value));
      }
    }
  }

  if (typeof responseCallback === 'function') {
    req.on('response', responseCallback);
  }

  // Electron's ClientRequest has no setTimeout(). Emulate Node's inactivity
  // timeout: (re)arm on each response chunk so a long but healthy stream is
  // not aborted, while a stalled connection still fires the callback.
  req.setTimeout = function setTimeoutCompat(ms, cb) {
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (typeof cb === 'function') cb();
      }, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    const disarm = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    arm();
    req.on('response', (res) => {
      arm();
      res.on('data', arm);
      res.on('end', disarm);
      res.on('error', disarm);
    });
    req.on('error', disarm);
    req.on('close', disarm);
    req.on('abort', disarm);
    return req;
  };

  // Node's ClientRequest#destroy() → Electron uses abort().
  if (typeof req.destroy !== 'function') {
    req.destroy = function destroyCompat() {
      try {
        req.abort();
      } catch (_) {
        /* request already finished */
      }
    };
  }

  return req;
}

module.exports = { netHttpsRequest };
