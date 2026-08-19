#!/usr/bin/env node
// Neurovance Companion — runs on your own computer, not in the cloud.
//
// What it can do: read files inside one folder (~/Documents/Neurovance),
// open https:// links in Safari, read the text of whatever's already
// showing in Safari's front tab, read your saved Safari bookmarks, click
// links/buttons on the current page, and type into fields — only when your
// own paired Superself asks.
// What it can't do: touch anything outside that folder, write or delete a
// local file, run arbitrary commands, or type into a password field —
// that last one is refused unconditionally right here, no matter what it's
// asked to do. Reading a page only ever sees what you already loaded
// yourself. These boundaries are enforced right here, not on the server —
// the server only ever sees what this file lets it see.
import WebSocket from 'ws';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, watch } from 'fs';
import { homedir, hostname } from 'os';
import { join, resolve, sep } from 'path';
import { execFile } from 'child_process';

const CONFIG_DIR = join(homedir(), '.neurovance');
const CONFIG_PATH = join(CONFIG_DIR, 'companion-config.json');
const ALLOWED_ROOT = join(homedir(), 'Documents', 'Neurovance');
const SERVER_WS_URL = process.env.NEUROVANCE_WS_URL || 'wss://app.neurovance.dev/companion-ws';
const MAX_READ_BYTES = 200_000;

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ensureAllowedRoot() {
  if (!existsSync(ALLOWED_ROOT)) {
    mkdirSync(ALLOWED_ROOT, { recursive: true });
    writeFileSync(
      join(ALLOWED_ROOT, 'README.txt'),
      'This folder — and only this folder — is what your Neurovance Superself can read on this computer.\n' +
      'Nothing outside it is reachable. It can read, not write or delete.\n' +
      'Drop in whatever you want it to be able to see.\n'
    );
  }
}

// The one thing standing between "read files in a folder" and "read any
// file on this computer" — has to hold for every input, including
// "../../../etc/passwd" or an absolute path.
function resolveScoped(relativePath) {
  const target = resolve(ALLOWED_ROOT, relativePath || '.');
  if (target !== ALLOWED_ROOT && !target.startsWith(ALLOWED_ROOT + sep)) {
    throw new Error('That path is outside the allowed Neurovance folder.');
  }
  return target;
}

// Minimal XML plist parser — just enough of Apple's plist grammar
// (dict/array/string/integer/real/true/false, everything else treated as
// opaque) to walk Safari's bookmarks structure. No dependency needed since
// Node has no built-in plist or XML parser.
function parsePlist(xml) {
  const tagRe = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g;

  function decodeEntities(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function parseValue(pos) {
    tagRe.lastIndex = pos;
    const m = tagRe.exec(xml);
    if (!m) throw new Error('Unexpected end of plist');
    const [full, closing, name, , selfCloseFlag] = m;
    if (closing) throw new Error('Unexpected closing tag: ' + name);
    const tagEnd = m.index + full.length;
    const isSelfClosing = selfCloseFlag === '/' || full.endsWith('/>');

    if (isSelfClosing) {
      if (name === 'true') return { value: true, nextPos: tagEnd };
      if (name === 'false') return { value: false, nextPos: tagEnd };
      return { value: null, nextPos: tagEnd };
    }

    if (name === 'dict') {
      const dict = {};
      let p = tagEnd;
      for (;;) {
        const closeMatch = /^\s*<\/dict>/.exec(xml.slice(p));
        if (closeMatch) { p += closeMatch[0].length; break; }
        const keyMatch = /^\s*<key>([\s\S]*?)<\/key>/.exec(xml.slice(p));
        if (!keyMatch) throw new Error('Expected <key> in dict at pos ' + p);
        const key = decodeEntities(keyMatch[1]);
        p += keyMatch[0].length;
        p += /^\s*/.exec(xml.slice(p))[0].length;
        const { value, nextPos } = parseValue(p);
        dict[key] = value;
        p = nextPos;
      }
      return { value: dict, nextPos: p };
    }

    if (name === 'array') {
      const arr = [];
      let p = tagEnd;
      for (;;) {
        p += /^\s*/.exec(xml.slice(p))[0].length;
        const closeMatch = /^<\/array>/.exec(xml.slice(p));
        if (closeMatch) { p += closeMatch[0].length; break; }
        const { value, nextPos } = parseValue(p);
        arr.push(value);
        p = nextPos;
      }
      return { value: arr, nextPos: p };
    }

    const closeTagRe = new RegExp('</' + name + '>');
    const closeMatch = closeTagRe.exec(xml.slice(tagEnd));
    if (!closeMatch) throw new Error('Missing closing tag for ' + name);
    const content = xml.slice(tagEnd, tagEnd + closeMatch.index);
    const nextPos = tagEnd + closeMatch.index + closeMatch[0].length;

    if (name === 'string') return { value: decodeEntities(content), nextPos };
    if (name === 'integer') return { value: parseInt(content, 10), nextPos };
    if (name === 'real') return { value: parseFloat(content), nextPos };
    return { value: content, nextPos };
  }

  const plistMatch = /<plist[^>]*>/.exec(xml);
  if (!plistMatch) throw new Error('Not a plist file');
  let p = plistMatch.index + plistMatch[0].length;
  p += /^\s*/.exec(xml.slice(p))[0].length;
  return parseValue(p).value;
}

// Embeds arbitrary JS source as the content of an AppleScript double-quoted
// string literal — the two escapes AppleScript string literals actually
// need. JSON.stringify already handles JS-string escaping one layer in;
// this is the outer layer for the AppleScript parser itself.
function escapeForAppleScript(js) {
  return js.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runSafariJS(js) {
  const script = `tell application "Safari" to do JavaScript "${escapeForAppleScript(js)}" in front document`;
  return new Promise((res, rej) => {
    execFile('osascript', ['-e', script], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (/not allowed to send Apple events|1743/.test(err.message)) {
          rej(new Error('Safari has JavaScript-from-AppleScript turned off. Enable it: Safari > Settings > Advanced > check "Show features for web developers", then the new Develop menu > check "Allow JavaScript from Apple Events".'));
        } else if (/front document|no windows/i.test(err.message)) {
          rej(new Error('Safari has no windows open.'));
        } else {
          rej(new Error('Safari script failed: ' + err.message));
        }
        return;
      }
      res(stdout.trim());
    });
  });
}

function buildClickScript(text) {
  const parts = [
    'var t=' + JSON.stringify(text.toLowerCase()) + ';',
    'var els=Array.from(document.querySelectorAll(\'a, button, [role="button"], input[type="submit"], input[type="button"], summary, [onclick]\'));',
    "var match=els.find(function(el){var label=(el.innerText||el.value||el.getAttribute('aria-label')||'').trim().toLowerCase();return label.indexOf(t)!==-1;});",
    "if(!match)return 'NOT_FOUND';",
    "match.scrollIntoView({block:'center'});",
    'match.click();',
    "return 'CLICKED: '+(match.innerText||match.value||match.getAttribute('aria-label')||'').trim().slice(0,120);",
  ];
  return '(function(){' + parts.join('') + '})()';
}

function buildTypeScript(label, text, submit) {
  const parts = [
    'var l=' + JSON.stringify(label.toLowerCase()) + ';',
    'var val=' + JSON.stringify(text) + ';',
    "var els=Array.from(document.querySelectorAll('input, textarea'));",
    "var match=els.find(function(el){var hay=((el.placeholder||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.name||'')+' '+(el.id||'')).toLowerCase();return hay.indexOf(l)!==-1;});",
    "if(!match)return 'NOT_FOUND';",
    "if(match.type==='password')return 'BLOCKED_PASSWORD';",
    'match.focus();',
    'match.value=val;',
    "match.dispatchEvent(new Event('input',{bubbles:true}));",
    "match.dispatchEvent(new Event('change',{bubbles:true}));",
  ];
  if (submit) {
    parts.push(
      "var down=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true});match.dispatchEvent(down);",
      "var up=new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true});match.dispatchEvent(up);",
      'if(match.form&&match.form.requestSubmit)match.form.requestSubmit();'
    );
  }
  parts.push("return 'TYPED';");
  return '(function(){' + parts.join('') + '})()';
}

function handleCommand(action, params) {
  if (action === 'list_files') {
    const dir = resolveScoped(params.subpath || '');
    if (!statSync(dir).isDirectory()) throw new Error('Not a folder.');
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'folder' : 'file',
    }));
  }

  if (action === 'read_file') {
    const filePath = resolveScoped(params.path);
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('Not a file.');
    if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large to read (limit ${MAX_READ_BYTES / 1000}KB).`);
    return readFileSync(filePath, 'utf-8');
  }

  if (action === 'open_url') {
    const url = params.url || '';
    if (!/^https:\/\//.test(url)) throw new Error('Only https:// URLs are allowed.');
    // execFile (no shell) + stripped quotes = the URL can't break out of the
    // AppleScript string literal or reach a shell at all.
    const safeUrl = url.replace(/"/g, '');
    return new Promise((res, rej) => {
      execFile('osascript', ['-e', `tell application "Safari" to open location "${safeUrl}"`], (err) => {
        if (err) rej(new Error('Could not open Safari: ' + err.message));
        else res({ opened: safeUrl });
      });
    });
  }

  // Reads whatever is already rendered in the user's own front Safari tab —
  // deliberately nothing more. This never logs in, fills in a form, or
  // touches a credential; it only sees a page after the human already did
  // that part themselves. Only the front tab, never every open tab.
  if (action === 'read_safari_content') {
    const script = [
      'tell application "Safari"',
      '  if (count of windows) is 0 then error "Safari has no windows open."',
      '  set pageURL to URL of front document',
      '  set pageTitle to name of front document',
      '  set pageText to do JavaScript "document.body.innerText" in front document',
      '  return pageURL & "|||NEUROVANCE|||" & pageTitle & "|||NEUROVANCE|||" & pageText',
      'end tell',
    ].join('\n');
    return new Promise((res, rej) => {
      execFile('osascript', ['-e', script], (err, stdout) => {
        if (err) {
          if (/not allowed to send Apple events|1743/.test(err.message)) {
            rej(new Error('Safari has JavaScript-from-AppleScript turned off. Enable it: Safari > Settings > Advanced > check "Show features for web developers", then the new Develop menu > check "Allow JavaScript from Apple Events".'));
          } else {
            rej(new Error('Could not read the Safari page: ' + err.message));
          }
          return;
        }
        const [url, title, ...rest] = stdout.trim().split('|||NEUROVANCE|||');
        const text = rest.join('|||NEUROVANCE|||'); // in case the delimiter-lookalike ever appears in real page text
        res({ url, title, text: text.slice(0, 8000) });
      });
    });
  }

  // Clicks a link/button on the current front-tab page, matched by its
  // visible text (not a CSS selector — the model only ever sees rendered
  // text via read_current_browser_page, never markup, so text is the only
  // thing it can reasonably target). Free to use for ordinary navigation;
  // the server's system prompt is what tells the model to pause and confirm
  // before clicking anything consequential — this action itself has no
  // concept of "safe" vs "not", it just clicks what it's told.
  if (action === 'click_page_element') {
    const text = params.text || '';
    if (!text) return Promise.reject(new Error('No text given to click.'));
    const js = buildClickScript(text);
    return runSafariJS(js).then((result) => {
      if (result === 'NOT_FOUND') throw new Error(`Could not find anything matching "${text}" to click on the current page.`);
      return { result };
    });
  }

  // Types into an input/textarea matched by its placeholder, aria-label,
  // name, or id. Hard-refuses password fields unconditionally — regardless
  // of what it's asked to type or why — since the Companion never handles
  // credentials, full stop.
  if (action === 'type_into_page_field') {
    const { label, text, submit } = params;
    if (!label || text === undefined) return Promise.reject(new Error('Need both a field label and text to type.'));
    const js = buildTypeScript(label, text, !!submit);
    return runSafariJS(js).then((result) => {
      if (result === 'NOT_FOUND') throw new Error(`Could not find a field matching "${label}" on the current page.`);
      if (result === 'BLOCKED_PASSWORD') throw new Error('Refusing to type into a password field — the Companion never handles credentials.');
      return { result };
    });
  }

  // Reads Safari's own saved bookmarks (read-only) so it can actually go
  // find a link the user already saved, instead of asking them to type a
  // URL it could have looked up itself. Recursively walks the bookmark
  // folder tree Safari stores on disk.
  //
  // Uses XML plist conversion, not `plutil -convert json` — Safari's
  // Bookmarks.plist commonly holds binary fields (favicon thumbnails, sync
  // UUIDs) that plutil's JSON converter refuses to represent at all,
  // failing the whole file with "Invalid object in plist for JSON format"
  // even though every bookmark itself is a plain title/URL string. XML
  // plist represents everything, so it never hits that wall; we parse it
  // ourselves below since Node has no built-in plist/XML parser.
  if (action === 'read_safari_bookmarks') {
    const plistPath = join(homedir(), 'Library', 'Safari', 'Bookmarks.plist');
    return new Promise((res, rej) => {
      execFile('plutil', ['-convert', 'xml1', '-o', '-', plistPath], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          if (/permission|Operation not permitted|couldn't be read|No such file/i.test(err.message)) {
            rej(new Error('Terminal needs Full Disk Access to read Safari bookmarks: System Settings > Privacy & Security > Full Disk Access > add your terminal app, then restart the Companion.'));
          } else {
            rej(new Error('Could not read Safari bookmarks: ' + err.message));
          }
          return;
        }
        try {
          const root = parsePlist(stdout);
          const bookmarks = [];
          const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (node.WebBookmarkType === 'WebBookmarkTypeLeaf' && node.URLString) {
              bookmarks.push({ title: node.URIDictionary?.title || node.URLString, url: node.URLString });
            }
            if (Array.isArray(node.Children)) node.Children.forEach(walk);
          };
          walk(root);
          res(bookmarks.slice(0, 300));
        } catch (e) {
          rej(new Error('Could not parse Safari bookmarks: ' + e.message));
        }
      });
    });
  }

  throw new Error(`Unknown action: ${action}`);
}

let activeWs = null;

function connect(userId) {
  const ws = new WebSocket(SERVER_WS_URL);

  ws.on('open', () => {
    activeWs = ws;
    if (userId) ws.send(JSON.stringify({ type: 'reconnect', userId }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'pair_result') {
      if (msg.ok) {
        saveConfig({ userId: msg.userId });
        console.log('Paired. Your Superself can now read from:\n  ' + ALLOWED_ROOT);
      } else {
        console.error('Pairing failed:', msg.error);
        process.exit(1);
      }
      return;
    }

    if (msg.type === 'reconnect_result') {
      console.log(msg.ok ? 'Connected.' : 'Reconnect rejected — delete ~/.neurovance/companion-config.json and pair again.');
      return;
    }

    if (msg.type === 'command') {
      try {
        const data = await handleCommand(msg.action, msg.params || {});
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: e.message }));
      }
    }
  });

  ws.on('close', () => {
    if (activeWs === ws) activeWs = null;
    console.log('Disconnected — retrying in 5s...');
    setTimeout(() => connect(userId), 5000);
  });

  ws.on('error', (e) => console.error('Connection error:', e.message));

  return ws;
}

// Ambient presence: notice when something changes in the shared folder and
// tell the server, so the Superself can bring it up on its own later —
// debounced per filename since a single save often fires several raw fs
// events, and skipping the very first tick avoids reporting the README.txt
// that ensureAllowedRoot() just created on a fresh folder.
const watchDebounce = new Map();
function watchAllowedRoot() {
  try {
    watch(ALLOWED_ROOT, { recursive: true }, (eventType, filename) => {
      if (!filename || filename === 'README.txt') return;
      clearTimeout(watchDebounce.get(filename));
      watchDebounce.set(filename, setTimeout(() => {
        watchDebounce.delete(filename);
        if (activeWs?.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({ type: 'event', name: 'file_changed', data: { filename } }));
        }
      }, 800));
    });
  } catch (e) {
    console.error('Could not watch the Neurovance folder for changes:', e.message);
  }
}

function promptForCode() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the pairing code shown on neurovance.dev: ', (code) => {
    rl.close();
    const ws = connect(null);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'pair', code: code.trim(), hostname: hostname() }));
    });
  });
}

ensureAllowedRoot();
console.log(`Neurovance Companion\nThis computer will only ever share files from:\n  ${ALLOWED_ROOT}\n`);
watchAllowedRoot();

const config = loadConfig();
if (config?.userId) {
  connect(config.userId);
} else {
  promptForCode();
}
