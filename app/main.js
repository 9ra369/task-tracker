// メインプロセス。fs / shell を扱うのはこのファイルだけに限定し、
// レンダラーには preload.js 経由で必要な操作だけを公開する（仕様書 6.18）。
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const BOARD_FILE = path.join(DATA_DIR, "board.json");
const BAK2_META_FILE = path.join(DATA_DIR, ".bak2meta.json");
const BEFORE_IMPORT_FILE = path.join(DATA_DIR, "board.before_import.json");
const LOG_FILE = path.join(DATA_DIR, "app.log");
const BAK2_INTERVAL_MS = 10 * 60 * 1000;

var sessionBak3Written = false;
var mainWindow = null;

function logToFile(line) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] " + line + "\n", "utf8");
  } catch (e) {}
}

// 既定の userData（%APPDATA%\task_tracker 等）が環境によっては書き込み権限の問題を起こし、
// GPU/ディスクキャッシュの作成失敗（Access is denied）からアプリが不安定になることがある。
// data フォルダ配下の、書き込みが確実にできるとわかっている場所を明示的に使う。
try {
  var userDataDir = path.join(DATA_DIR, ".electron-userdata");
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath("userData", userDataDir);
} catch (e) {}

// Windows の一部の環境（VM・リモートデスクトップ・特定のグラフィックドライバ等）では
// GPU プロセスや sandbox 化されたネットワークサービスが不安定になり、ウィンドウが
// 一瞬表示されて即終了することがある。ハードウェアアクセラレーションを切って回避する。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

process.on("uncaughtException", function (err) {
  logToFile("uncaughtException: " + (err && err.stack ? err.stack : err));
});
app.on("render-process-gone", function (event, webContents, details) {
  logToFile("render-process-gone: " + JSON.stringify(details));
});
app.on("child-process-gone", function (event, details) {
  logToFile("child-process-gone: " + JSON.stringify(details));
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

// 一時ファイルへ書き切ってから rename することで、書き込み中の強制終了で
// 本体ファイルが壊れる（末尾が欠けた不完全な JSON になる）ことを防ぐ（仕様書 6.17）。
function atomicWriteJson(filePath, data) {
  ensureDataDir();
  var tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function rotateBackups() {
  if (!fs.existsSync(BOARD_FILE)) return;
  var current = fs.readFileSync(BOARD_FILE, "utf8");

  // .bak3 = このセッション（アプリ起動）を開始した時点の状態。起動後の最初の保存で 1 回だけ書く。
  if (!sessionBak3Written) {
    try { fs.writeFileSync(path.join(DATA_DIR, "board.json.bak3"), current, "utf8"); } catch (e) {}
    sessionBak3Written = true;
  }

  // .bak2 = 10分以上前の状態。前回の更新から 10 分以上経過していれば更新する。
  var meta = readJsonSafe(BAK2_META_FILE) || { lastBak2At: 0 };
  if (Date.now() - (meta.lastBak2At || 0) >= BAK2_INTERVAL_MS) {
    try {
      fs.writeFileSync(path.join(DATA_DIR, "board.json.bak2"), current, "utf8");
      fs.writeFileSync(BAK2_META_FILE, JSON.stringify({ lastBak2At: Date.now() }), "utf8");
    } catch (e) {}
  }

  // .bak1 = 直前の保存内容。
  try { fs.writeFileSync(path.join(DATA_DIR, "board.json.bak1"), current, "utf8"); } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#10121a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.on("did-fail-load", function (event, errorCode, errorDescription) {
    logToFile("did-fail-load: " + errorCode + " " + errorDescription);
  });
  mainWindow.on("closed", function () {
    logToFile("window closed");
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.setMenuBarVisibility(false);
  logToFile("window created");
}

app.whenReady().then(function () {
  logToFile("app ready (electron " + process.versions.electron + ", node " + process.versions.node + ", platform " + process.platform + ")");
  ensureDataDir();
  createWindow();
  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(function (err) {
  logToFile("whenReady failed: " + (err && err.stack ? err.stack : err));
});

app.on("window-all-closed", function () {
  logToFile("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});

/* ================= IPC: ボードデータの読み書き ================= */

ipcMain.handle("board:load", function () {
  var data = readJsonSafe(BOARD_FILE);
  return { exists: !!data, data: data, defaultSavePath: DATA_DIR };
});

ipcMain.handle("board:save", function (event, state) {
  try {
    rotateBackups();
    atomicWriteJson(BOARD_FILE, state);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle("board:backupBeforeImport", function (event, state) {
  try {
    ensureDataDir();
    fs.writeFileSync(BEFORE_IMPORT_FILE, JSON.stringify(state, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle("board:exportJson", async function (event, state) {
  ensureDataDir();
  var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  var result = await dialog.showSaveDialog(mainWindow, {
    title: "JSONをエクスポート",
    defaultPath: path.join(DATA_DIR, "task_tracker_export_" + stamp + ".json"),
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(state, null, 2), "utf8");
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle("board:importJson", async function () {
  var result = await dialog.showOpenDialog(mainWindow, {
    title: "JSONをインポート",
    defaultPath: DATA_DIR,
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"]
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return { canceled: true };
  try {
    var raw = fs.readFileSync(result.filePaths[0], "utf8");
    var data = JSON.parse(raw);
    return { ok: true, data: data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ================= IPC: 保存先フォルダ ================= */

ipcMain.handle("settings:getDefaultSavePath", function () {
  return DATA_DIR;
});

ipcMain.handle("settings:chooseSaveFolder", async function (event, currentPath) {
  var result = await dialog.showOpenDialog(mainWindow, {
    title: "保存先フォルダを選択",
    defaultPath: (currentPath && fs.existsSync(currentPath)) ? currentPath : DATA_DIR,
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return { canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

/* ================= IPC: リンクを開く ================= */

var RISKY_EXTENSIONS = [".exe", ".bat", ".cmd", ".com", ".scr", ".lnk", ".ps1", ".vbs", ".msi"];

ipcMain.handle("link:open", async function (event, payload) {
  var url = (payload && payload.url) || "";
  var isRelative = !!(payload && payload.isRelative);
  var savePath = (payload && payload.savePath) || "";

  if (/^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return { ok: true };
  }

  var targetPath;
  if (isRelative) {
    if (!savePath) return { ok: false, error: "保存先が未設定のため、相対パスを解決できません。" };
    var base = path.resolve(savePath);
    targetPath = path.resolve(base, url);
    // ディレクトリトラバーサル対策: 解決結果が保存先フォルダの外に出ていないか検証する。
    if (targetPath !== base && !targetPath.startsWith(base + path.sep)) {
      return { ok: false, error: "保存先フォルダの外を指す相対パスは開けません。" };
    }
  } else {
    targetPath = path.resolve(url);
  }

  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: "ファイルが見つかりません: " + targetPath };
  }

  var ext = path.extname(targetPath).toLowerCase();
  if (RISKY_EXTENSIONS.indexOf(ext) !== -1) {
    var choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["キャンセル", "開く"],
      defaultId: 0,
      cancelId: 0,
      title: "実行可能ファイルを開こうとしています",
      message: "「" + path.basename(targetPath) + "」は実行可能ファイルです。本当に開きますか？"
    });
    if (choice !== 1) return { ok: false, canceled: true };
  }

  var openError = await shell.openPath(targetPath);
  if (openError) return { ok: false, error: openError };
  return { ok: true };
});
