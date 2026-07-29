'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1';
const MODEL_LIST_TIMEOUT_MS = 5000;
const COMPLETION_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function normalizeOmniRouteBaseUrl(value) {
  const raw = String(value || DEFAULT_OMNIROUTE_BASE_URL).trim();
  let parsed;

  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new Error('OmniRoute URL must be a valid URL, for example http://127.0.0.1:20128/v1.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OmniRoute URL must use http:// or https://.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new Error('For security, this app only connects to OmniRoute on localhost.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Do not put credentials in the OmniRoute URL; use the access-token field instead.');
  }

  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/v1';
  return parsed.toString().replace(/\/+$/, '');
}

function buildOmniRouteUrl(baseUrl, suffix) {
  const normalized = normalizeOmniRouteBaseUrl(baseUrl);
  return new URL(normalized + '/' + String(suffix || '').replace(/^\/+/, ''));
}

function getTransport(url) {
  return url.protocol === 'http:' ? http : https;
}

function getAgent(url) {
  return url.protocol === 'http:' ? httpAgent : httpsAgent;
}

function buildHeaders(apiKey, contentLength) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (contentLength !== undefined) headers['Content-Length'] = contentLength;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function parseApiError(rawBody, statusCode) {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && parsed.error) {
      return parsed.error.message || parsed.error.detail || String(parsed.error);
    }
    if (parsed && parsed.message) return parsed.message;
  } catch (_error) {}

  const summary = String(rawBody || '').trim().substring(0, 300);
  return summary || `HTTP ${statusCode || 'error'}`;
}

function listOmniRouteModels({ baseUrl, apiKey }) {
  let requestUrl;
  try {
    requestUrl = buildOmniRouteUrl(baseUrl, 'models');
  } catch (error) {
    return Promise.resolve({ error: { message: error.message }, models: [] });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = getTransport(requestUrl).request(requestUrl, {
      method: 'GET',
      agent: getAgent(requestUrl),
      headers: buildHeaders(apiKey)
    }, (res) => {
      let rawBody = '';
      let responseBytes = 0;

      res.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('OmniRoute model list is larger than 2 MB.'));
          return;
        }
        rawBody += chunk.toString('utf8');
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          finish({
            error: { message: `OmniRoute ${res.statusCode}: ${parseApiError(rawBody, res.statusCode)}` },
            models: []
          });
          return;
        }

        try {
          const parsed = JSON.parse(rawBody);
          const source = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : parsed.models);
          if (!Array.isArray(source)) {
            finish({ error: { message: 'OmniRoute /models returned an unexpected response.' }, models: [] });
            return;
          }

          const seen = new Set();
          const models = source.map((entry) => {
            if (typeof entry === 'string') return { id: entry, ownedBy: '' };
            return {
              id: entry && (entry.id || entry.name || entry.model),
              ownedBy: entry && (entry.owned_by || entry.provider || entry.owner) || ''
            };
          }).filter((entry) => {
            if (!entry.id || seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
          }).sort((a, b) => a.id.localeCompare(b.id));

          finish({ models, baseUrl: normalizeOmniRouteBaseUrl(baseUrl) });
        } catch (_error) {
          finish({ error: { message: 'Could not parse OmniRoute /models response.' }, models: [] });
        }
      });
    });

    req.on('error', (error) => {
      finish({
        error: {
          message: `Cannot reach OmniRoute at ${requestUrl.origin}: ${error.message}`
        },
        models: []
      });
    });

    req.setTimeout(MODEL_LIST_TIMEOUT_MS, () => {
      req.destroy(new Error(`connection timed out after ${MODEL_LIST_TIMEOUT_MS / 1000}s`));
    });
    req.end();
  });
}

function extractContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    return part && (part.text || part.content) || '';
  }).join('');
}

function sendRendererEvent(sender, channel, payload) {
  if (!sender || sender.isDestroyed()) return;
  sender.send(channel, payload);
}

function streamOmniRouteCompletion({
  sender,
  apiKey,
  baseUrl,
  model,
  messages,
  systemPrompt,
  streamId,
  maxTokens,
  temperature
}) {
  let requestUrl;
  try {
    requestUrl = buildOmniRouteUrl(baseUrl, 'chat/completions');
  } catch (error) {
    return Promise.resolve({ error: { message: error.message } });
  }

  const allMessages = [];
  if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
  allMessages.push(...messages);

  const requestBody = {
    model,
    messages: allMessages,
    max_tokens: maxTokens || 220,
    temperature: temperature !== undefined && temperature !== null ? temperature : 0.25,
    stream: true
  };
  const bodyBuffer = Buffer.from(JSON.stringify(requestBody));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = getTransport(requestUrl).request(requestUrl, {
      method: 'POST',
      agent: getAgent(requestUrl),
      headers: buildHeaders(apiKey, bodyBuffer.length)
    }, (res) => {
      let sseBuffer = '';
      let rawBody = '';
      let responseBytes = 0;
      let fullText = '';
      let streamUsage = null;
      let streamError = null;

      const consumeEventLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            streamError = parsed.error.message || parsed.error.detail || 'OmniRoute upstream error';
            return;
          }
          if (parsed.usage) streamUsage = parsed.usage;

          const choice = parsed.choices && parsed.choices[0];
          if (!choice) return;
          const deltaText = extractContent(choice.delta && choice.delta.content);
          if (deltaText) {
            fullText += deltaText;
            sendRendererEvent(sender, 'ai-stream-chunk', { streamId, delta: deltaText });
          }
        } catch (_error) {
          // Ignore malformed partial SSE lines; a complete line will be handled later.
        }
      };

      res.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('OmniRoute response is larger than 2 MB.'));
          return;
        }

        const text = chunk.toString('utf8');
        rawBody += text;
        sseBuffer += text;
        const lines = sseBuffer.split(/\r?\n/);
        sseBuffer = lines.pop() || '';
        lines.forEach(consumeEventLine);
      });

      res.on('end', () => {
        if (sseBuffer) consumeEventLine(sseBuffer);

        if (res.statusCode && res.statusCode >= 400) {
          const message = `OmniRoute ${res.statusCode}: ${parseApiError(rawBody, res.statusCode)}`;
          sendRendererEvent(sender, 'ai-usage-update', {
            provider: 'omniroute', model, usage: {}, error: message
          });
          finish({ error: { message } });
          return;
        }

        if (streamError) {
          sendRendererEvent(sender, 'ai-usage-update', {
            provider: 'omniroute', model, usage: {}, error: streamError
          });
          finish({ error: { message: streamError } });
          return;
        }

        // Some OpenAI-compatible gateways ignore stream=true and return one JSON object.
        if (!fullText && rawBody && !rawBody.trimStart().startsWith('data:')) {
          try {
            const parsed = JSON.parse(rawBody);
            streamUsage = streamUsage || parsed.usage || null;
            const choice = parsed.choices && parsed.choices[0];
            fullText = extractContent(choice && choice.message && choice.message.content);
            if (fullText) {
              sendRendererEvent(sender, 'ai-stream-chunk', { streamId, delta: fullText });
            }
          } catch (_error) {}
        }

        if (!fullText) {
          const message = 'OmniRoute returned an empty response. Check the selected route/model in the OmniRoute dashboard.';
          sendRendererEvent(sender, 'ai-usage-update', {
            provider: 'omniroute', model, usage: {}, error: message
          });
          finish({ error: { message } });
          return;
        }

        const estimatedUsage = {
          prompt_tokens: Math.ceil(JSON.stringify(allMessages).length / 4),
          completion_tokens: Math.ceil(fullText.length / 4),
          total_tokens: Math.ceil((JSON.stringify(allMessages).length + fullText.length) / 4),
          estimated: true
        };
        const usage = streamUsage || estimatedUsage;
        sendRendererEvent(sender, 'ai-usage-update', {
          provider: 'omniroute', model, usage
        });

        const result = { content: [{ text: fullText }] };
        if (streamUsage) result.usage = streamUsage;
        finish(result);
      });
    });

    req.on('error', (error) => {
      const message = `Cannot reach OmniRoute at ${requestUrl.origin}: ${error.message}`;
      sendRendererEvent(sender, 'ai-usage-update', {
        provider: 'omniroute', model, usage: {}, error: message
      });
      finish({ error: { message } });
    });

    req.setTimeout(COMPLETION_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${COMPLETION_TIMEOUT_MS / 1000}s`));
    });
    req.write(bodyBuffer);
    req.end();
  });
}

module.exports = {
  DEFAULT_OMNIROUTE_BASE_URL,
  listOmniRouteModels,
  normalizeOmniRouteBaseUrl,
  streamOmniRouteCompletion
};
