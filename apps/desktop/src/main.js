const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let localServer;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function isCareerRoot(candidate) {
  return Boolean(candidate)
    && fs.existsSync(path.join(candidate, 'scan.mjs'))
    && fs.existsSync(path.join(candidate, 'portals.yml'));
}

function isCompleteCareerRoot(candidate) {
  return isCareerRoot(candidate)
    && fs.existsSync(path.join(candidate, 'cv.md'))
    && fs.existsSync(path.join(candidate, 'portals.yml'))
    && fs.existsSync(path.join(candidate, 'config', 'profile.yml'))
    && fs.existsSync(path.join(candidate, 'data', 'applications.md'));
}

function configureRuntimePaths() {
  process.env.CAREER_OPS_USER_DATA ||= app.getPath('userData');
  process.env.CAREER_OPS_APP_DATA ||= app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.resolve(__dirname, '..', 'local-data');
  seedPackagedAppData();
  if (process.env.CAREER_OPS_ROOT && isCareerRoot(process.env.CAREER_OPS_ROOT)) return;

  const executableDir = path.dirname(app.getPath('exe'));
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
  const workingDir = process.cwd();
  const ancestors = (start) => Array.from({ length: 5 }, (_unused, depth) => (
    path.resolve(start, ...Array(depth).fill('..'))
  ));
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'classic'),
    ...ancestors(portableDir || executableDir).map((candidate) => path.join(candidate, 'classic')),
    ...ancestors(workingDir).map((candidate) => path.join(candidate, 'classic')),
    ...ancestors(executableDir).map((candidate) => path.join(candidate, 'classic')),
    ...ancestors(workingDir),
    ...ancestors(executableDir),
    ...ancestors(__dirname)
  ];
  const root = candidates.find(isCompleteCareerRoot) || candidates.find(isCareerRoot);
  if (root) process.env.CAREER_OPS_ROOT = root;
}

function seedPackagedAppData() {
  if (!app.isPackaged) return;
  const dataDir = process.env.CAREER_OPS_APP_DATA;
  const databasePath = path.join(dataDir, 'career-ops.sqlite');
  if (fs.existsSync(databasePath)) return;

  const seedDir = path.join(process.resourcesPath, 'seed-data');
  const seedDatabase = path.join(seedDir, 'career-ops.sqlite');
  if (!fs.existsSync(seedDatabase)) {
    throw new Error(`Packaged application data is missing: ${seedDatabase}`);
  }

  copyDirectory(seedDir, dataDir);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
  }
}

function registerDesktopHandlers() {
  ipcMain.handle('desktop:open-external', (_event, url) => shell.openExternal(String(url)));
  ipcMain.handle('desktop:open-path', (_event, targetPath) => shell.openPath(path.resolve(String(targetPath))));
  ipcMain.handle('desktop:pick-root', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the Career Ops folder',
      properties: ['openDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });
  ipcMain.handle('desktop:pick-folder', async (_event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: String(title || 'Choose a folder'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });
}

async function createWindow() {
  configureRuntimePaths();
  registerDesktopHandlers();

  const { startServer } = require('./server');
  // The desktop app owns an embedded server and must not collide with the
  // separately runnable localhost dashboard on port 3000.
  localServer = await startServer({ port: process.env.PORT ? Number(process.env.PORT) : 43119 });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#f3f0e8',
    title: 'Career Ops',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(localServer.url);
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Career Ops failed to start', error.stack || error.message || String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  localServer?.server?.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
