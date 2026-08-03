// preload スクリプト。contextIsolation 環境で、レンダラーに必要最小限の
// IPC 呼び出しだけを window.taskTrackerAPI として公開する（仕様書 6.18）。
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("taskTrackerAPI", {
  loadBoard: function () { return ipcRenderer.invoke("board:load"); },
  saveBoard: function (state) { return ipcRenderer.invoke("board:save", state); },
  backupBeforeImport: function (state) { return ipcRenderer.invoke("board:backupBeforeImport", state); },
  exportJson: function (state) { return ipcRenderer.invoke("board:exportJson", state); },
  importJson: function () { return ipcRenderer.invoke("board:importJson"); },
  getDefaultSavePath: function () { return ipcRenderer.invoke("settings:getDefaultSavePath"); },
  chooseSaveFolder: function (currentPath) { return ipcRenderer.invoke("settings:chooseSaveFolder", currentPath); },
  openLink: function (payload) { return ipcRenderer.invoke("link:open", payload); }
});
