'use strict';

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const APP_URL = process.env.NEUROVANCE_DESKTOP_URL || 'https://app.neurovance.dev/';
const origin = new URL(APP_URL).origin;
if (!APP_URL.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(APP_URL)) {
  throw new Error('Use HTTPS or a localhost development URL.');
}
const authHosts = new Set(['accounts.google.com', 'github.com']);
let mainWindow;

function openExternal(url) {
  try {
    if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url).catch(console.error);
  } catch { /* Ignore malformed external links. */ }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width:1440, height:960, minWidth:1024, minHeight:700,
    title:'Neurovance', backgroundColor:'#101210', show:true,
    webPreferences:{ contextIsolation:true, sandbox:true, nodeIntegration:false, spellcheck:true },
  });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({url}) => {openExternal(url); return {action:'deny'};});
  contents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      if (target.origin === origin || (target.protocol === 'https:' && authHosts.has(target.hostname))) return;
    } catch {}
    event.preventDefault(); openExternal(url);
  });
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler(async (_webContents, permission, callback, details) => {
    if (permission !== 'media' || new URL(details.requestingUrl || APP_URL).origin !== origin || details.mediaTypes?.includes('video')) return callback(false);
    const result = await dialog.showMessageBox(mainWindow, {
      type:'question', title:'Enable voice', message:'Let Neurovance use your microphone?',
      detail:'Voice uses your microphone while the app is open. Spoken requests are sent to Neurovance.',
      buttons:['Keep microphone off', 'Enable microphone'], defaultId:0, cancelId:0,
    });
    callback(result.response === 1);
  });
  const loading = '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#101210;color:#f1f2e9;font:16px -apple-system,sans-serif;display:grid;place-content:center;height:100vh;text-align:center}h1{font-size:28px;font-weight:400}p{color:#a5afa0}a{color:#b9d58b}</style><h1>Neurovance</h1><p>Connecting to your workspace…</p>';
  contents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loading)).then(() => {
    return contents.loadURL(APP_URL);
  }).catch(error => {
    if (mainWindow.isDestroyed()) return;
    console.error('Workspace connection failed:', error.message);
    const retry = loading.replace('Connecting to your workspace…', 'Unable to connect. Check your internet connection, then try again.') + '<p><a href="' + APP_URL.replaceAll('&','&amp;').replaceAll('"','&quot;') + '">Try again →</a></p>';
    contents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(retry)).catch(console.error);
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();} });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'Neurovance',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},
      {role:'editMenu'},
      {label:'View',submenu:[{label:'Reload workspace',accelerator:'CmdOrCtrl+R',click:()=>mainWindow?.loadURL(APP_URL)},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
      {role:'windowMenu'},
    ]));
    createWindow();
    app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
  }).catch(error=>{dialog.showErrorBox('Neurovance could not start', error.message);app.quit();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
}
