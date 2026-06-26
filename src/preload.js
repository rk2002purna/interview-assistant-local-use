const { ipcRenderer } = require('electron');
window.ipcRenderer = ipcRenderer;

// Knowledge Base bridge — the renderer calls these instead of touching Node fs.
// (contextIsolation is off in this app, so we attach directly to window.)
window.knowledgeBase = {
  selectPdfs: () => ipcRenderer.invoke('knowledge:select-pdfs'),
  listPdfs: () => ipcRenderer.invoke('knowledge:list-pdfs'),
  rebuildIndex: () => ipcRenderer.invoke('knowledge:rebuild-index'),
  deleteKnowledgeBase: () => ipcRenderer.invoke('knowledge:delete'),
  getStatus: () => ipcRenderer.invoke('knowledge:status'),
  getStats: () => ipcRenderer.invoke('knowledge:stats'),
  ragSearch: (question) => ipcRenderer.invoke('knowledge:rag-search', { question })
};
