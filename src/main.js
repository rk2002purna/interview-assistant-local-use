const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const { readActiveWindowText } = require('./screen-reader');

let mainWindow;
let settingsWindow;
let knowledgeBaseWindow;
let miniMode = false;
let savedBounds = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    x: 20,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js')
    },
    hasShadow: false,
  });

  if (process.platform === 'win32' || process.platform === 'darwin') {
    mainWindow.setContentProtection(true);
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Use 'floating' level on macOS for reliable always-on-top behavior
  // 'screen-saver' can conflict with fullscreen apps on macOS
  if (process.platform === 'darwin') {
    mainWindow.setAlwaysOnTop(true, 'floating', 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setFullScreenable(false);
    // Hide dock icon but keep window on top
    app.dock.hide();
  } else {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 500,
    height: 500,
    title: 'Settings',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => settingsWindow = null);
}

function createKnowledgeBaseWindow() {
  if (knowledgeBaseWindow) { knowledgeBaseWindow.focus(); return; }
  knowledgeBaseWindow = new BrowserWindow({
    width: 700,
    height: 600,
    title: 'Knowledge Base',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  knowledgeBaseWindow.loadFile(path.join(__dirname, 'renderer', 'knowledge.html'));
  // Open DevTools for debugging
  knowledgeBaseWindow.webContents.openDevTools();
  knowledgeBaseWindow.on('closed', () => knowledgeBaseWindow = null);
}

app.whenReady().then(() => { 
  createMainWindow(); 
  // Register Knowledge Base IPC handlers
  require('./main/knowledgeIpc');
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

ipcMain.on('open-settings', () => createSettingsWindow());
ipcMain.on('open-knowledge-base', () => createKnowledgeBaseWindow());
ipcMain.on('minimize-window', () => {
  if (!mainWindow) return;
  if (!miniMode) {
    savedBounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint(
      { x: savedBounds.x, y: savedBounds.y }
    );
    const { width: screenW, height: screenH, x: screenX, y: screenY } = display.workArea;
    const miniSize = 48;
    const margin = 20;
    mainWindow.setMinimumSize(miniSize, miniSize);
    mainWindow.setResizable(false);
    mainWindow.setBounds({
      x: screenX + screenW - miniSize - margin,
      y: screenY + screenH - miniSize - margin,
      width: miniSize,
      height: miniSize
    });
    miniMode = true;
    mainWindow.webContents.send('mini-mode', true);
  }
});

ipcMain.on('restore-window', () => {
  if (!mainWindow || !miniMode) return;
  if (savedBounds) {
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(200, 300);
    mainWindow.setBounds(savedBounds);
  }
  miniMode = false;
  mainWindow.webContents.send('mini-mode', false);
});
ipcMain.on('close-app', () => app.quit());

ipcMain.on('hide-for-screenshot', () => {
  if (mainWindow) {
    mainWindow.hide();
  }
});

ipcMain.on('show-after-screenshot', () => {
  if (mainWindow) {
    mainWindow.showInactive();
    // Re-apply ALL window protections after show (they get reset on hide/show cycle)
    if (process.platform === 'win32' || process.platform === 'darwin') {
      mainWindow.setContentProtection(true);
    }
    if (process.platform === 'darwin') {
      mainWindow.setAlwaysOnTop(true, 'floating', 1);
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }
});

ipcMain.on('save-config', (event, config) => {
  const configPath = path.join(os.homedir(), '.interview-assistant-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  event.reply('config-saved');
});

ipcMain.on('api-key-updated-broadcast', (event, key) => {
  mainWindow?.webContents.send('api-key-updated', key);
});

ipcMain.on('provider-updated-broadcast', (event, provider) => {
  mainWindow?.webContents.send('provider-updated', provider);
});

ipcMain.on('config-changed-broadcast', () => {
  mainWindow?.webContents.send('config-changed');
});

ipcMain.handle('load-config', () => {
  const configPath = path.join(os.homedir(), '.interview-assistant-config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return {};
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('call-ai-api', async (event, { apiKey, model, messages, systemPrompt }) => {
  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }
  allMessages.push(...messages);

  const requestBody = {
    model: model,
    max_tokens: 1500,
    temperature: 0.7,
    messages: allMessages
  };

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.groq.com',
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: json.error.message } });
          } else if (json.choices && json.choices[0] && json.choices[0].message) {
            // Track Groq usage from response
            if (json.usage) {
              event.sender.send('ai-usage-update', {
                provider: 'groq',
                model: model,
                usage: json.usage
              });
            }
            resolve({ content: [{ text: json.choices[0].message.content }] });
          } else {
            resolve({ error: { message: 'Unexpected response' } });
          }
        } catch (e) {
          resolve({ error: { message: 'Parse error' } });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
});

ipcMain.handle('call-deepseek-api', async (event, { apiKey, model, messages, systemPrompt }) => {
  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }
  allMessages.push(...messages);

  const requestBody = {
    model: model,
    max_tokens: 1500,
    temperature: 0.7,
    messages: allMessages
  };

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: json.error.message } });
          } else if (json.choices && json.choices[0] && json.choices[0].message) {
            // Track DeepSeek usage from response
            if (json.usage) {
              event.sender.send('ai-usage-update', {
                provider: 'deepseek',
                model: model,
                usage: json.usage
              });
            }
            resolve({ content: [{ text: json.choices[0].message.content }] });
          } else {
            resolve({ error: { message: 'Unexpected response' } });
          }
        } catch (e) {
          resolve({ error: { message: 'Parse error' } });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
});

// Helper: convert OpenAI-style messages to Gemini "contents" format
function messagesToGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (!m || !m.content) continue;
    // Gemini uses 'user' and 'model' roles (not 'assistant')
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      // Multimodal content array (text + images)
      parts = m.content.map(p => {
        if (p.type === 'text') return { text: p.text };
        if (p.type === 'image_url' && p.image_url && p.image_url.url) {
          // Convert "data:image/jpeg;base64,XXX" to inline_data
          const match = /^data:([^;]+);base64,(.+)$/.exec(p.image_url.url);
          if (match) {
            return { inline_data: { mime_type: match[1], data: match[2] } };
          }
        }
        return { text: '' };
      }).filter(p => p);
    } else {
      parts = [{ text: String(m.content) }];
    }
    contents.push({ role, parts });
  }
  return contents;
}

function buildGeminiGenerationConfig(model, maxOutputTokens, temperature) {
  const cfg = {
    temperature: (temperature !== undefined && temperature !== null) ? temperature : 0.25,
    maxOutputTokens: maxOutputTokens || 220
  };
  const m = (model || '').toLowerCase();
  // Flash variants benefit from disabled thinking. Pro keeps thinking enabled.
  if (m.includes('flash')) {
    cfg.thinkingConfig = { thinkingBudget: 0 };
  }
  return cfg;
}

ipcMain.handle('call-gemini-api', async (event, { apiKey, model, messages, systemPrompt }) => {
  const requestBody = {
    contents: messagesToGeminiContents(messages),
    generationConfig: buildGeminiGenerationConfig(model)
  };
  if (systemPrompt) {
    requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  return new Promise((resolve) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ': ' + (json.error.message || JSON.stringify(json.error)) } });
          } else if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
            const text = json.candidates[0].content.parts.map(p => p.text || '').join('');
            // Track Gemini usage from response metadata
            if (json.usageMetadata) {
              event.sender.send('ai-usage-update', {
                provider: 'gemini',
                model: model,
                usage: {
                  prompt_tokens: json.usageMetadata.promptTokenCount || 0,
                  completion_tokens: json.usageMetadata.candidatesTokenCount || 0,
                  total_tokens: json.usageMetadata.totalTokenCount || 0
                }
              });
            }
            resolve({ content: [{ text: text }] });
          } else if (json.promptFeedback && json.promptFeedback.blockReason) {
            resolve({ error: { message: 'Blocked by Gemini: ' + json.promptFeedback.blockReason } });
          } else {
            resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ' unexpected response: ' + data.substring(0, 300) } });
          }
        } catch (e) {
          resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ' parse error: ' + data.substring(0, 300) } });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
});

// Streaming AI handler - emits tokens to renderer as they arrive
ipcMain.handle('call-ai-stream', async (event, { provider, apiKey, model, messages, systemPrompt, streamId, maxTokens, temperature }) => {
  const sender = event.sender;
  // Use caller-supplied values; fall back to safe defaults
  const resolvedMaxTokens = maxTokens || 220;
  const resolvedTemp = (temperature !== undefined && temperature !== null) ? temperature : 0.25;

  // Gemini has its own streaming format
  if (provider === 'gemini') {
    const requestBody = {
      contents: messagesToGeminiContents(messages),
      generationConfig: buildGeminiGenerationConfig(model, resolvedMaxTokens, resolvedTemp)
    };
    if (systemPrompt) {
      requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const body = JSON.stringify(requestBody);
    const bodyBuffer = Buffer.from(body);

    return new Promise((resolve) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
          'Content-Length': bodyBuffer.length
        }
      };

      const req = https.request(options, (res) => {
        let buffer = '';
        let fullText = '';
        let errorMsg = null;
        let rawData = ''; // accumulate raw response for error reporting
        let finishReason = null;

        res.on('data', chunk => {
          const text = chunk.toString('utf8');
          rawData += text;
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            try {
              const json = JSON.parse(data);
              if (json.error) {
                errorMsg = json.error.message || JSON.stringify(json.error);
                continue;
              }
              if (json.candidates && json.candidates[0]) {
                const cand = json.candidates[0];
                if (cand.content && cand.content.parts) {
                  for (const part of cand.content.parts) {
                    if (part.text) {
                      fullText += part.text;
                      sender.send('ai-stream-chunk', { streamId: streamId, delta: part.text });
                    }
                  }
                }
                // Track finishReason — MAX_TOKENS means budget too small / thinking ate it all
                if (cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
                  finishReason = cand.finishReason;
                }
              }
            } catch (e) {
              // ignore parse errors on partial chunks
            }
          }
        });

        res.on('end', () => {
          if (errorMsg) {
            resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ': ' + errorMsg } });
          } else if (res.statusCode && res.statusCode >= 400) {
            // Non-200 status with no streamed error — try parsing raw body
            let parsedErr = rawData.substring(0, 300);
            try {
              const json = JSON.parse(rawData);
              if (json.error && json.error.message) parsedErr = json.error.message;
            } catch(e) {}
            resolve({ error: { message: 'Gemini ' + res.statusCode + ': ' + parsedErr } });
          } else if (!fullText) {
            if (finishReason === 'MAX_TOKENS') {
              resolve({ error: { message: 'Gemini hit MAX_TOKENS before producing output (thinking tokens consumed the budget). Try a Flash model or raise maxOutputTokens.' } });
            } else if (finishReason) {
              resolve({ error: { message: 'Gemini stopped: ' + finishReason } });
            } else {
              resolve({ error: { message: 'Gemini returned empty response: ' + rawData.substring(0, 300) } });
            }
          } else {
            // Got partial text — append a hint if truncated
            if (finishReason === 'MAX_TOKENS') {
              const note = '\n\n[Response was truncated by token limit.]';
              sender.send('ai-stream-chunk', { streamId: streamId, delta: note });
              fullText += note;
            }
            // Estimate Gemini token usage (streaming doesn't return usage)
            const estPrompt = Math.ceil(JSON.stringify(messages).length / 4);
            const estComp = Math.ceil(fullText.length / 4);
            sender.send('ai-usage-update', {
              provider: 'gemini',
              model: model,
              usage: { prompt_tokens: estPrompt, completion_tokens: estComp, total_tokens: estPrompt + estComp, estimated: true }
            });
            resolve({ content: [{ text: fullText }] });
          }
        });
      });

      req.on('error', (e) => {
        sender.send('ai-usage-update', {
          provider: 'gemini', model: model, usage: {}, error: 'Network error: ' + e.message
        });
        resolve({ error: { message: 'Network error: ' + e.message } });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        sender.send('ai-usage-update', {
          provider: 'gemini', model: model, usage: {}, error: 'Request timed out'
        });
        resolve({ error: { message: 'Request timed out' } });
      });

      req.write(bodyBuffer);
      req.end();
    });
  }

  // Groq + DeepSeek (OpenAI-compatible streaming)
  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }
  allMessages.push(...messages);

  const requestBody = {
    model: model,
    max_tokens: resolvedMaxTokens,
    temperature: resolvedTemp,
    messages: allMessages,
    stream: true
  };

  // stream_options (include_usage) is supported by Groq and DeepSeek but NOT Cerebras or DigitalOcean
  if (provider !== 'cerebras' && provider !== 'digitalocean') {
    requestBody.stream_options = { include_usage: true };
  }

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  // OpenAI-compatible providers: Groq, DeepSeek, Cerebras, DigitalOcean
  let hostname, apiPath;
  if (provider === 'deepseek') {
    hostname = 'api.deepseek.com';
    apiPath = '/chat/completions';
  } else if (provider === 'cerebras') {
    hostname = 'api.cerebras.ai';
    apiPath = '/v1/chat/completions';
  } else if (provider === 'digitalocean') {
    hostname = 'inference.do-ai.run';
    apiPath = '/v1/chat/completions';
  } else {
    // Default to Groq
    hostname = 'api.groq.com';
    apiPath = '/openai/v1/chat/completions';
  }

  return new Promise((resolve) => {
    const options = {
      hostname: hostname,
      port: 443,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let sseBuffer = '';
      let fullText = '';
      let errorMsg = null;
      let streamUsage = null;
      let rawBody = '';

      res.on('data', chunk => {
        const text = chunk.toString('utf8');
        rawBody += text;
        sseBuffer += text;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop(); // last line may be incomplete

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            if (json.error) {
              errorMsg = json.error.message || 'API error';
              continue;
            }
            // Capture usage from the final chunk (stream_options: include_usage)
            if (json.usage) {
              streamUsage = json.usage;
              continue;
            }
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              fullText += delta.content;
              sender.send('ai-stream-chunk', { streamId: streamId, delta: delta.content });
            }
          } catch (e) {
            // ignore parse errors on partial chunks
          }
        }
      });

      res.on('end', () => {
        // Always treat HTTP 4xx/5xx as an error — even if partial text was streamed.
        // This ensures rate-limit (429), auth (401), etc. trigger the fallback in the renderer.
        if (res.statusCode && res.statusCode >= 400) {
          let parsedErr = 'HTTP ' + res.statusCode;
          try {
            const errJson = JSON.parse(rawBody);
            if (errJson.error && errJson.error.message) parsedErr = errJson.error.message;
          } catch(e) {
            parsedErr = 'HTTP ' + res.statusCode + ': ' + rawBody.substring(0, 200);
          }
          sender.send('ai-usage-update', {
            provider: provider, model: model, usage: {}, error: parsedErr
          });
          resolve({ error: { message: parsedErr } });
          return;
        }

        if (errorMsg) {
          sender.send('ai-usage-update', {
            provider: provider, model: model, usage: {}, error: errorMsg
          });
          resolve({ error: { message: errorMsg } });
        } else {
          // Always emit a usage update so every provider shows in the Usage panel.
          // Providers that support stream_options return real token counts;
          // others (DigitalOcean, Cerebras) get a character-based estimate.
          const usageToReport = streamUsage || {
            prompt_tokens: 0,
            completion_tokens: Math.ceil(fullText.length / 4),
            total_tokens: Math.ceil(fullText.length / 4),
            estimated: true
          };
          sender.send('ai-usage-update', {
            provider: provider, model: model, usage: usageToReport
          });
          const result = { content: [{ text: fullText }] };
          if (streamUsage) result.usage = streamUsage;
          resolve(result);
        }
      });
    });

    req.on('error', (e) => {
      sender.send('ai-usage-update', {
        provider: provider, model: model, usage: {}, error: 'Network error: ' + e.message
      });
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      sender.send('ai-usage-update', {
        provider: provider, model: model, usage: {}, error: 'Request timed out'
      });
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
});

// Get desktop capturer sources for system audio loopback
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      fetchWindowIcons: false
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    return [];
  }
});

// Read active window text via UI Automation (primary method for Screen Analyzer)
ipcMain.handle('read-active-window', async () => {
  try {
    const result = await readActiveWindowText();
    return result;
  } catch (e) {
    return { error: 'Read failed: ' + e.message, title: '', text: '' };
  }
});

// Screen capture for Screen Analyzer mode (fallback when UI Automation fails)
ipcMain.handle('capture-screen-frame', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const scaleFactor = primaryDisplay.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.floor(width * scaleFactor),
        height: Math.floor(height * scaleFactor)
      }
    });

    if (!sources || sources.length === 0) {
      return { error: 'No screen source available' };
    }

    // Capture ALL screens (multi-monitor support)
    const images = sources.map((s, i) => ({
      index: i,
      name: s.name || ('Screen ' + (i + 1)),
      image: s.thumbnail.toJPEG(80).toString('base64')
    }));

    return {
      images: images,
      // Backward compatibility: keep `image` as the first/primary screen
      image: images[0].image
    };
  } catch (e) {
    return { error: 'Screen capture failed: ' + e.message };
  }
});

ipcMain.handle('transcribe-audio', async (event, { apiKey, audioData, mimeType }) => {
  // Derive file extension and content-type from the actual mimeType the recorder used.
  // Groq Whisper is strict: the declared type must match the actual container.
  const mime = mimeType || 'audio/webm;codecs=opus';
  let ext = 'webm';
  let contentType = 'audio/webm';
  if (mime.startsWith('audio/ogg')) { ext = 'ogg'; contentType = 'audio/ogg'; }
  else if (mime.startsWith('audio/mp4')) { ext = 'mp4'; contentType = 'audio/mp4'; }
  else if (mime.startsWith('audio/webm')) { ext = 'webm'; contentType = 'audio/webm'; }

  const tempPath = path.join(os.tmpdir(), 'interview-audio-' + Date.now() + '.' + ext);

  try {
    const audioBuffer = Buffer.from(audioData, 'base64');
    fs.writeFileSync(tempPath, audioBuffer);

    // Guard: reject tiny/corrupt files before hitting the API
    const fileSize = fs.statSync(tempPath).size;
    if (fileSize < 1024) {
      try { fs.unlinkSync(tempPath); } catch(e) {}
      return { error: { message: 'Audio too short or empty — please speak clearly and try again.' } };
    }

    return new Promise((resolve) => {
      const curl = spawn('curl', [
        '-s', 'https://api.groq.com/openai/v1/audio/transcriptions',
        '-X', 'POST',
        '-H', `Authorization: Bearer ${apiKey}`,
        '-F', `file=@${tempPath};type=${contentType}`,
        '-F', 'model=whisper-large-v3',
        '-F', 'response_format=json',
        '-F', 'language=en',
        '-F', 'temperature=0',
        '-F', 'prompt=Technical interview question about software engineering, coding, or behavioral topics.'
      ]);

      let data = '';
      let errorData = '';

      curl.stdout.on('data', (chunk) => { data += chunk; });
      curl.stderr.on('data', (chunk) => { errorData += chunk; });

      curl.on('close', (code) => {
        try { fs.unlinkSync(tempPath); } catch(e) {}

        if (code !== 0) {
          const errMsg = errorData ? errorData.trim() : 'curl exited with code ' + code;
          resolve({ error: { message: 'Transcription failed: ' + errMsg } });
          return;
        }

        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: json.error.message } });
          } else {
            resolve({ text: json.text });
          }
        } catch (e) {
          resolve({ error: { message: 'Parse error: ' + data.substring(0, 200) } });
        }
      });

      curl.on('error', (err) => {
        try { fs.unlinkSync(tempPath); } catch(e) {}
        resolve({ error: { message: 'curl not found — please install curl or check your PATH.' } });
      });
    });
  } catch (e) {
    try { fs.unlinkSync(tempPath); } catch(e) {}
    return { error: { message: 'Failed to process audio' } };
  }
});
