const { app, BrowserWindow, globalShortcut, ipcMain, screen, clipboard, nativeImage, dialog, desktopCapturer, systemPreferences, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
require('@electron/remote/main').initialize();

// ---- インメモリ検索インデックス ----
// Map<cap_id, {project_id, project_name, cap_name, memo, ocr_text, filename, created_at}>
const searchIndex = new Map();

function dbUpsert(row) {
  searchIndex.set(row.cap_id, row);
}

function dbDeleteCapture(cid) {
  searchIndex.delete(cid);
}

function dbDeleteProject(pid) {
  for (const [cid, row] of searchIndex) {
    if (row.project_id === pid) searchIndex.delete(cid);
  }
}

function dbUpdateCapName(cid, name) {
  const row = searchIndex.get(cid);
  if (row) row.cap_name = name;
}

function dbUpdateMemo(cid, memo) {
  const row = searchIndex.get(cid);
  if (row) row.memo = memo;
}

function dbUpdateProjectName(pid, name) {
  for (const row of searchIndex.values()) {
    if (row.project_id === pid) row.project_name = name;
  }
}

function dbUpdateOcrText(cid, ocrText) {
  const row = searchIndex.get(cid);
  if (row) row.ocr_text = ocrText;
}

function dbSearch(query) {
  const q = query.toLowerCase();
  const results = [];
  for (const row of searchIndex.values()) {
    if (
      row.cap_name.toLowerCase().includes(q) ||
      row.memo.toLowerCase().includes(q) ||
      row.project_name.toLowerCase().includes(q) ||
      (row.ocr_text || '').toLowerCase().includes(q)
    ) results.push(row);
  }
  results.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  return results.slice(0, 200);
}

async function rebuildIndex() {
  searchIndex.clear();
  const projects = await loadProjects();
  for (const proj of projects) {
    const captures = await loadCaptures(proj.id);
    for (const cap of captures) {
      searchIndex.set(cap.id, {
        cap_id: cap.id, project_id: proj.id, project_name: proj.name,
        cap_name: cap.name || '', memo: cap.memo || '',
        ocr_text: cap.ocrText || '',
        filename: cap.filename || '', created_at: cap.createdAt || '',
      });
    }
  }
  console.log(`[ScreenCap] Search index built: ${searchIndex.size} captures`);
}

let mainWindow = null;
let tray = null;
let searchWindow = null;
let selectorWindows = [];

// ---- OCR エンジン ----
let ocrWorker = null;
const ocrQueue = [];   // [{pid, cid, filePath}]
let ocrRunning = false;

async function initOcr() {
  const { createWorker } = require('tesseract.js');
  const tessDataPath = path.join(app.getPath('userData'), 'tessdata');
  await fs.promises.mkdir(tessDataPath, { recursive: true });
  ocrWorker = await createWorker('jpn+eng', 1, {
    langPath: tessDataPath,
    cachePath: tessDataPath,
    logger: () => {},   // ログ抑制
  });
  console.log('[ScreenCap] OCR worker ready');
  processOcrQueue();   // キューに積まれた未処理分を開始
}

function enqueueOcr(pid, cid, filePath) {
  ocrQueue.push({ pid, cid, filePath });
  processOcrQueue();
}

async function processOcrQueue() {
  if (ocrRunning || !ocrWorker || ocrQueue.length === 0) return;
  ocrRunning = true;
  while (ocrQueue.length > 0) {
    const { pid, cid, filePath } = ocrQueue.shift();
    try {
      const { data: { text } } = await ocrWorker.recognize(filePath);
      const ocrText = text.replace(/\s+/g, ' ').trim();

      // captures.json に保存
      const list = await loadCaptures(pid);
      const cap = list.find(c => c.id === cid);
      if (cap) {
        cap.ocrText = ocrText;
        await saveCaptures(pid, list);
        dbUpdateOcrText(cid, ocrText);
      }

      // プロジェクト管理画面に通知
      if (projectManagerWindow && !projectManagerWindow.isDestroyed()) {
        projectManagerWindow.webContents.send('pm-ocr-complete', { pid, cid, ocrText });
      }
    } catch (e) {
      console.error('[ScreenCap] OCR error:', e.message);
    }
  }
  ocrRunning = false;
}
let editorWindow = null;
let selectionStart = null;
let preCaptured = {};       // { displayId: nativeImage } セレクター表示前にキャッシュ
let preCaptureLayout = null;
let appWasHidden = false;   // macOS: app.hide() で隠したかどうか

function formatDatetime(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 260,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'ScreenCap',
  });
  require('@electron/remote/main').enable(mainWindow.webContents);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'main.html'));
  // 閉じるボタンでは終了せずトレイに隠す
  mainWindow.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerHotkeys() {
  globalShortcut.register('CommandOrControl+Shift+1', () => startAreaCapture());
  globalShortcut.register('CommandOrControl+Alt+W', () => {
    if (mainWindow) mainWindow.webContents.send('trigger-window-capture');
  });
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    showMainWindow();
    openProjectManager();
  });
  globalShortcut.register('CommandOrControl+Shift+F', () => openSearchWindow());
}

function getDisplayLayout() {
  const displays = screen.getAllDisplays();
  const xs  = displays.map(d => d.bounds.x);
  const ys  = displays.map(d => d.bounds.y);
  const x2s = displays.map(d => d.bounds.x + d.bounds.width);
  const y2s = displays.map(d => d.bounds.y + d.bounds.height);
  return {
    displays: displays.map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })),
    totalBounds: {
      x:      Math.min(...xs),
      y:      Math.min(...ys),
      width:  Math.max(...x2s) - Math.min(...xs),
      height: Math.max(...y2s) - Math.min(...ys),
    },
  };
}

function restoreApp() {
  if (appWasHidden) {
    app.show();
    appWasHidden = false;
  }
}

// ディスプレイごとにセレクターウィンドウを1枚ずつ作成
async function startAreaCapture() {
  if (selectorWindows.length > 0) return;
  selectionStart = null;
  const layout = getDisplayLayout();

  // getSources 前にアプリ全体を非表示
  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  console.log('[ScreenCap] Screen recording access:', screenStatus);

  if (process.platform === 'darwin') {
    app.hide();
    appWasHidden = true;
  } else {
    BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.isVisible()).forEach(w => w.hide());
  }
  await new Promise(r => setTimeout(r, 400));

  preCaptured = {};
  preCaptureLayout = layout;

  // 各ディスプレイを実サイズで一括取得（probe呼び出しを排除）
  try {
    for (const [i, d] of layout.displays.entries()) {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width:  Math.min(Math.round(d.bounds.width  * d.scaleFactor), 3840),
          height: Math.min(Math.round(d.bounds.height * d.scaleFactor), 2400),
        },
      });
      if (i === 0) console.log('[ScreenCap] getSources OK, sources:', sources.length);
      const src = sources.find(s => s.display_id === String(d.id))
               || sources[i]
               || sources[0];
      if (src) preCaptured[d.id] = src.thumbnail;
    }
  } catch (err) {
    console.error('[ScreenCap] getSources failed:', err.message, '| screen access:', screenStatus);
    restoreApp();
    if (screenStatus === 'denied' || screenStatus === 'not-determined') {
      dialog.showMessageBox({
        type: 'warning',
        title: '画面収録の権限が必要です',
        message: 'ScreenCap に画面収録の権限を許可してください。',
        detail: 'システム設定 → プライバシーとセキュリティ → 画面収録 で Electron をオンにしてください。\n設定変更後はアプリを再起動してください。',
        buttons: ['システム設定を開く', '閉じる'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        }
      });
    }
    return;
  }

  // セレクターを表示（ウィンドウは mouseup / cancel 時に復元）
  layout.displays.forEach((d, i) => {
    const win = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width:  d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true,
      },
    });
    require('@electron/remote/main').enable(win.webContents);
    win.loadFile(path.join(__dirname, 'renderer', 'selector.html'));
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('init', { layout, displayIndex: i });
    });
    win.on('closed', () => {
      selectorWindows = selectorWindows.filter(w => w !== win);
    });
    selectorWindows.push(win);
  });
}

function closeAllSelectors() {
  [...selectorWindows].forEach(w => { try { if (!w.isDestroyed()) w.close(); } catch (e) {} });
  selectorWindows = [];
}

function broadcastToSelectors(channel, data) {
  selectorWindows.forEach(w => {
    if (!w.isDestroyed()) w.webContents.send(channel, data);
  });
}

// ---- セレクターからのマウスイベント (グローバル座標) ----

ipcMain.on('selector-mousedown', (event, { gx, gy }) => {
  selectionStart = { x: gx, y: gy };
  broadcastToSelectors('selection-update', { start: selectionStart, end: selectionStart });
});

ipcMain.on('selector-mousemove', (event, { gx, gy }) => {
  if (!selectionStart) return;
  broadcastToSelectors('selection-update', { start: selectionStart, end: { x: gx, y: gy } });
});

ipcMain.on('selector-mouseup', async (event, { gx, gy }) => {
  if (!selectionStart) return;
  const end = { x: gx, y: gy };
  const globalRect = {
    x:      Math.min(selectionStart.x, end.x),
    y:      Math.min(selectionStart.y, end.y),
    width:  Math.abs(end.x - selectionStart.x),
    height: Math.abs(end.y - selectionStart.y),
  };
  selectionStart = null;
  if (globalRect.width < 5 || globalRect.height < 5) {
    closeAllSelectors();
    return;
  }

  closeAllSelectors();
  restoreApp();

  // 事前キャプチャ済みの画像を切り取ってエディタを開く
  try {
    await cropAndOpen(globalRect, preCaptureLayout);
  } catch (err) {
    console.error('cropAndOpen failed:', err);
  } finally {
    preCaptured = {};
    preCaptureLayout = null;
  }
});

ipcMain.on('selector-cancel', () => {
  selectionStart = null;
  closeAllSelectors();
  restoreApp();
  preCaptured = {};
  preCaptureLayout = null;
});

// ---- キャプチャ & エディタ起動 ----

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

async function cropAndOpen(globalRect, layout) {
  if (!layout) return;
  const relevant = layout.displays.filter(d => rectsOverlap(globalRect, d.bounds));
  if (relevant.length === 0) return;

  // preCaptured キャッシュから各ディスプレイの画像を取得して切り取る
  const pieces = [];
  for (const d of relevant) {
    const img = preCaptured[d.id];
    if (!img) continue;
    const scale = d.scaleFactor;

    // globalRect とこのディスプレイの交差領域（CSS px）
    const ix  = Math.max(globalRect.x, d.bounds.x);
    const iy  = Math.max(globalRect.y, d.bounds.y);
    const ix2 = Math.min(globalRect.x + globalRect.width,  d.bounds.x + d.bounds.width);
    const iy2 = Math.min(globalRect.y + globalRect.height, d.bounds.y + d.bounds.height);
    if (ix2 <= ix || iy2 <= iy) continue;

    // 物理ピクセルでクロップ（ディスプレイ左上起点）
    const cropped = img.crop({
      x:      Math.round((ix  - d.bounds.x) * scale),
      y:      Math.round((iy  - d.bounds.y) * scale),
      width:  Math.round((ix2 - ix) * scale),
      height: Math.round((iy2 - iy) * scale),
    });

    pieces.push({
      dataUrl: cropped.toDataURL(),
      // 最終出力キャンバス上の配置位置（物理ピクセル）
      destX:  Math.round((ix - globalRect.x) * scale),
      destY:  Math.round((iy - globalRect.y) * scale),
      width:  Math.round((ix2 - ix) * scale),
      height: Math.round((iy2 - iy) * scale),
    });
  }

  if (pieces.length === 0) return;

  const scale = relevant[0].scaleFactor;
  openEditor({
    pieces,
    outW: Math.round(globalRect.width  * scale),
    outH: Math.round(globalRect.height * scale),
  });
}

function openEditor(payload) {
  editorWindow = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    title: 'ScreenCap - Editor',
  });
  require('@electron/remote/main').enable(editorWindow.webContents);
  editorWindow.loadFile(path.join(__dirname, 'renderer', 'editor.html'));
  editorWindow.webContents.once('did-finish-load', () => {
    editorWindow.webContents.send('load-image', payload);
  });
  editorWindow.on('closed', () => { editorWindow = null; });
}

// ---- プロジェクト管理 ----

let dataDir = null;
let projectManagerWindow = null;

// dataDir は app.whenReady() 内で初期化

function projectsFile() { return path.join(dataDir, 'projects.json'); }
function projectDir(id) { return path.join(dataDir, id); }
function capturesFile(id) { return path.join(projectDir(id), 'captures.json'); }

async function loadProjects() {
  try { return JSON.parse(await fs.promises.readFile(projectsFile(), 'utf8')); } catch { return []; }
}
async function saveProjectsMeta(list) {
  await fs.promises.writeFile(projectsFile(), JSON.stringify(list, null, 2));
}
async function loadCaptures(pid) {
  try { return JSON.parse(await fs.promises.readFile(capturesFile(pid), 'utf8')); } catch { return []; }
}
async function saveCaptures(pid, list) {
  await fs.promises.mkdir(projectDir(pid), { recursive: true });
  await fs.promises.writeFile(capturesFile(pid), JSON.stringify(list, null, 2));
}

ipcMain.handle('pm-get-projects', async () => loadProjects());

ipcMain.handle('pm-create-project', async (e, name) => {
  const list = await loadProjects();
  const id = `proj_${Date.now()}`;
  list.push({ id, name, createdAt: new Date().toISOString() });
  await saveProjectsMeta(list);
  await fs.promises.mkdir(projectDir(id), { recursive: true });
  return id;
});

ipcMain.handle('pm-rename-project', async (e, { id, name }) => {
  const list = await loadProjects();
  const p = list.find(x => x.id === id);
  if (p) { p.name = name; await saveProjectsMeta(list); dbUpdateProjectName(id, name); }
});

ipcMain.handle('pm-delete-project', async (e, id) => {
  await saveProjectsMeta((await loadProjects()).filter(x => x.id !== id));
  const dir = projectDir(id);
  try { await fs.promises.rm(dir, { recursive: true }); } catch {}
  dbDeleteProject(id);
});

ipcMain.handle('pm-get-captures', async (e, pid) => {
  return (await loadCaptures(pid)).map(c => ({
    ...c,
    filePath: path.join(projectDir(pid), c.filename),
  }));
});

ipcMain.handle('pm-save-capture', async (e, { pid, dataUrl, name }) => {
  const projects = await loadProjects();
  const proj = projects.find(p => p.id === pid);
  const list = await loadCaptures(pid);
  const id = `cap_${Date.now()}`;
  const filename = `${id}.png`;
  const capName = name || `capture-${formatDatetime()}`;
  const createdAt = new Date().toISOString();
  const buf = Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  await fs.promises.mkdir(projectDir(pid), { recursive: true });
  await fs.promises.writeFile(path.join(projectDir(pid), filename), buf);
  list.push({ id, name: capName, filename, createdAt });
  await saveCaptures(pid, list);
  dbUpsert({ cap_id: id, project_id: pid, project_name: proj ? proj.name : '', cap_name: capName, memo: '', ocr_text: '', filename, created_at: createdAt });
  if (projectManagerWindow && !projectManagerWindow.isDestroyed()) {
    projectManagerWindow.webContents.send('pm-refresh');
  }
  // バックグラウンドでOCR
  enqueueOcr(pid, id, path.join(projectDir(pid), filename));
  return id;
});

ipcMain.handle('pm-delete-capture', async (e, { pid, cid }) => {
  const list = await loadCaptures(pid);
  const cap = list.find(c => c.id === cid);
  if (cap) {
    try { await fs.promises.unlink(path.join(projectDir(pid), cap.filename)); } catch {}
  }
  await saveCaptures(pid, list.filter(c => c.id !== cid));
  dbDeleteCapture(cid);
});

ipcMain.handle('pm-rename-capture', async (e, { pid, cid, name }) => {
  const list = await loadCaptures(pid);
  const cap = list.find(c => c.id === cid);
  if (cap) { cap.name = name; await saveCaptures(pid, list); dbUpdateCapName(cid, name); }
});

ipcMain.handle('pm-save-memo', async (e, { pid, cid, memo }) => {
  const list = await loadCaptures(pid);
  const cap = list.find(c => c.id === cid);
  if (cap) { cap.memo = memo; await saveCaptures(pid, list); dbUpdateMemo(cid, memo); }
});

function treeFile(pid) { return path.join(projectDir(pid), 'tree.json'); }
async function loadTree(pid) {
  try { return JSON.parse(await fs.promises.readFile(treeFile(pid), 'utf8')); }
  catch { return { nodes: {}, edges: [] }; }
}
async function saveTree(pid, data) {
  await fs.promises.mkdir(projectDir(pid), { recursive: true });
  await fs.promises.writeFile(treeFile(pid), JSON.stringify(data, null, 2));
}

ipcMain.handle('pm-get-tree', async (e, pid) => loadTree(pid));
ipcMain.handle('pm-save-tree', async (e, { pid, data }) => saveTree(pid, data));

// ---- Export ----
ipcMain.handle('pm-export-project', async (e, pid) => {
  const projects = await loadProjects();
  const proj = projects.find(p => p.id === pid);
  if (!proj) return { ok: false, error: 'プロジェクトが見つかりません' };

  const { filePath: destDir, canceled } = await dialog.showSaveDialog({
    title: 'エクスポート先を選択',
    defaultPath: proj.name,
    buttonLabel: 'エクスポート',
    properties: ['createDirectory'],
  });
  if (canceled || !destDir) return { ok: false, canceled: true };

  try {
    await fs.promises.mkdir(destDir, { recursive: true });

    // project.json
    await fs.promises.writeFile(
      path.join(destDir, 'project.json'),
      JSON.stringify({ name: proj.name, createdAt: proj.createdAt, exportedAt: new Date().toISOString() }, null, 2)
    );

    // captures.json（filePath は含めない）
    const captures = await loadCaptures(pid);
    await fs.promises.writeFile(
      path.join(destDir, 'captures.json'),
      JSON.stringify(captures, null, 2)
    );

    // tree.json
    const tree = await loadTree(pid);
    await fs.promises.writeFile(
      path.join(destDir, 'tree.json'),
      JSON.stringify(tree, null, 2)
    );

    // 画像ファイルをコピー
    await Promise.all(captures.map(async cap => {
      const src = path.join(projectDir(pid), cap.filename);
      try { await fs.promises.copyFile(src, path.join(destDir, cap.filename)); } catch {}
    }));

    return { ok: true, destDir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Import ----
ipcMain.handle('pm-import-project', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'エクスポートフォルダを選択',
    buttonLabel: 'インポート',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };

  const srcDir = filePaths[0];
  try {
    // project.json 読み込み
    let projMeta;
    try {
      projMeta = JSON.parse(await fs.promises.readFile(path.join(srcDir, 'project.json'), 'utf8'));
    } catch {
      return { ok: false, error: 'project.json が見つかりません。エクスポートフォルダを選択してください。' };
    }

    // captures.json 読み込み
    let captures = [];
    try {
      captures = JSON.parse(await fs.promises.readFile(path.join(srcDir, 'captures.json'), 'utf8'));
    } catch {}

    // tree.json 読み込み
    let tree = { nodes: {}, edges: [] };
    try {
      tree = JSON.parse(await fs.promises.readFile(path.join(srcDir, 'tree.json'), 'utf8'));
    } catch {}

    // 新しいプロジェクトを作成
    const projects = await loadProjects();
    const newId = `proj_${Date.now()}`;
    projects.push({ id: newId, name: projMeta.name, createdAt: projMeta.createdAt || new Date().toISOString() });
    await saveProjectsMeta(projects);
    await fs.promises.mkdir(projectDir(newId), { recursive: true });

    // 画像をコピー
    await Promise.all(captures.map(async cap => {
      const src = path.join(srcDir, cap.filename);
      try { await fs.promises.copyFile(src, path.join(projectDir(newId), cap.filename)); } catch {}
    }));

    // captures.json と tree.json を書き込み
    await saveCaptures(newId, captures);
    await saveTree(newId, tree);

    // 検索インデックスに追加・OCRキューへ
    captures.forEach(cap => {
      dbUpsert({
        cap_id: cap.id, project_id: newId, project_name: projMeta.name,
        cap_name: cap.name || '', memo: cap.memo || '',
        ocr_text: cap.ocrText || '',
        filename: cap.filename || '', created_at: cap.createdAt || '',
      });
      if (!cap.ocrText) {
        enqueueOcr(newId, cap.id, path.join(projectDir(newId), cap.filename));
      }
    });

    return { ok: true, id: newId, name: projMeta.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pm-read-image', async (e, filePath) => {
  try {
    const buf = await fs.promises.readFile(filePath);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch { return null; }
});

ipcMain.on('pm-open-in-editor', async (e, filePath) => {
  try {
    const buf = await fs.promises.readFile(filePath);
    openEditor({ simpleImage: `data:image/png;base64,${buf.toString('base64')}` });
  } catch {}
});

function openSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.focus();
    return;
  }
  searchWindow = new BrowserWindow({
    width: 640, height: 520, minWidth: 400, minHeight: 300,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: 'ScreenCap - 検索',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
  });
  searchWindow.loadFile(path.join(__dirname, 'renderer', 'search.html'));
  searchWindow.on('closed', () => { searchWindow = null; });
}

ipcMain.handle('search-captures', (e, query) => {
  return dbSearch(query).map(row => ({
    projectId:   row.project_id,
    projectName: row.project_name,
    capId:       row.cap_id,
    capName:     row.cap_name,
    memo:        row.memo,
    ocrText:     row.ocr_text || '',
    createdAt:   row.created_at,
    filePath:    path.join(projectDir(row.project_id), row.filename),
  }));
});

ipcMain.on('search-open-project', (e, { pid, cid }) => {
  openProjectManager();
  const send = () => {
    if (projectManagerWindow && !projectManagerWindow.isDestroyed()) {
      projectManagerWindow.webContents.send('select-project', { pid, cid });
    }
  };
  if (projectManagerWindow && !projectManagerWindow.isDestroyed()) {
    projectManagerWindow.focus();
    setTimeout(send, 100);
  } else {
    const onReady = () => { send(); projectManagerWindow.webContents.off('did-finish-load', onReady); };
    projectManagerWindow.webContents.on('did-finish-load', onReady);
  }
  if (searchWindow && !searchWindow.isDestroyed()) searchWindow.close();
});

function openProjectManager() {
  if (projectManagerWindow && !projectManagerWindow.isDestroyed()) {
    projectManagerWindow.focus(); return;
  }
  projectManagerWindow = new BrowserWindow({
    width: 1024, height: 768, minWidth: 600, minHeight: 400,
    webPreferences: { nodeIntegration: true, contextIsolation: false, enableRemoteModule: true },
    title: 'ScreenCap - プロジェクト管理',
  });
  require('@electron/remote/main').enable(projectManagerWindow.webContents);
  projectManagerWindow.loadFile(path.join(__dirname, 'renderer', 'project-manager.html'));
  projectManagerWindow.on('closed', () => { projectManagerWindow = null; });
}

ipcMain.on('open-project-manager', () => openProjectManager());
ipcMain.on('open-search-window', () => openSearchWindow());

// エディタからプロジェクトに保存した後、プロジェクトマネージャを更新
ipcMain.handle('pm-get-project-list-for-editor', async () => loadProjects());

// ---- ウィンドウキャプチャ ----

ipcMain.on('open-area-capture', () => startAreaCapture());

ipcMain.on('open-editor-with-image', (event, imgDataUrl) => {
  openEditor({ simpleImage: imgDataUrl });
});

ipcMain.handle('get-window-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 300, height: 200 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.handle('get-window-hd', async (event, sourceId) => {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 2560, height: 1600 } });
  const target = sources.find(s => s.id === sourceId);
  return target ? target.thumbnail.toDataURL() : null;
});

// ---- 保存 / クリップボード ----

ipcMain.on('save-image', (event, { dataUrl, format }) => {
  const ext = format === 'jpg' ? 'jpg' : 'png';
  dialog.showSaveDialog(editorWindow, {
    defaultPath: `ScreenCap-${formatDatetime()}.${ext}`,
    filters: [{ name: 'Image', extensions: [ext] }],
  }).then(({ filePath }) => {
    if (!filePath) return;
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    event.reply('save-done', filePath);
  });
});

ipcMain.on('copy-to-clipboard', (event, dataUrl) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
});

// ---- トレイ ----

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('ScreenCap');

  const menu = Menu.buildFromTemplate([
    {
      label: 'ScreenCap を表示',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '範囲選択キャプチャ',
      accelerator: 'CommandOrControl+Shift+1',
      click: () => startAreaCapture(),
    },
    {
      label: 'プロジェクト管理',
      accelerator: 'CommandOrControl+Shift+P',
      click: () => {
        showMainWindow();
        openProjectManager();
      },
    },
    {
      label: '検索',
      accelerator: 'CommandOrControl+Shift+F',
      click: () => openSearchWindow(),
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  // macOS: クリックでメインウィンドウ表示
  // Windows: ダブルクリックで表示
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (process.platform === 'darwin') app.dock.show();
  mainWindow.show();
  mainWindow.focus();
}

// ---- アプリライフサイクル ----

app.whenReady().then(async () => {
  dataDir = path.join(app.getPath('userData'), 'screencap');
  fs.mkdirSync(dataDir, { recursive: true });
  await rebuildIndex();
  initOcr().catch(e => console.error('[ScreenCap] OCR init failed:', e.message));
  createMainWindow();
  createTray();
  registerHotkeys();
  app.on('activate', () => {
    // macOS: Dock アイコンクリックで再表示
    showMainWindow();
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
// トレイ常駐のため window-all-closed では終了しない
app.on('window-all-closed', () => { /* トレイが生きている間は終了しない */ });
