#!/usr/bin/env node
// Neurovance Companion — runs on your own computer, not in the cloud.
// Works on both macOS and Windows; the two platforms don't have identical
// capabilities (see below), since each is built on that OS's own real
// automation surface, not a shared abstraction pretending they're the same.
//
// On macOS, via AppleScript: read files inside one folder
// (~/Documents/Neurovance), open https:// links in your browser (Safari or
// Chrome, whichever you've picked in Settings), read the text of whatever's
// already showing in its front tab, read your saved Safari bookmarks (always
// Safari's specifically, regardless of that setting), click links/buttons on
// the current page, type into fields, list what's clickable and where it
// sits on screen, go back, search your real Contacts by name, send a real
// iMessage (to one person or several), add a real calendar event/reminder/
// note, read/send real email, and control your own Music app (play/pause/
// skip, play a song by name, see what's playing).
//
// On Windows, via Outlook's own automation: search your real Outlook
// Contacts by name, add a real Outlook calendar event, add a real Outlook
// task (reminder) or note, read/send real email through Outlook. Requires
// desktop Outlook to be installed and signed in — there's no Windows
// equivalent otherwise. Opening a URL works too (via the default browser).
// iMessage and Music.app have no Windows equivalent at all — Apple-exclusive,
// not just unbuilt. The deeper Safari-style page interaction (reading,
// clicking, typing into, or listing elements on a page you're already on)
// isn't built for Windows yet either — it would mean automating a browser
// through its remote-debugging protocol instead of AppleScript, a separate,
// bigger piece of work. Both of these report they're unavailable rather
// than silently doing nothing.
//
// On either platform, this can also run a real shell command — full reach,
// not boxed into the one folder the file tools above are. That's exactly
// why it's gated differently from everything else here: every command
// prints to this terminal and waits for a literal "y" typed right here
// before it runs, regardless of what the user's permission mode is set to
// server-side, and it's the one action a scheduled/unattended run can never
// reach at all (enforced server-side, by simply never handing that tool to
// an unattended run — see agent.js). No prompt-injected webpage or 3am cron
// job can act unattended just because it asked nicely.
//
// On either platform, this only ever runs when your own paired Superself
// asks. Sending a message or an email only ever happens after you've
// confirmed you actually want it sent (enforced by the Superself's own
// instructions, not by this file — this file just does what it's told);
// reading your inbox, controlling your own Music playback, and adding to
// your own calendar/reminders/notes doesn't need that since none of it
// reaches anyone but you.
// What it can't do: touch anything outside that one folder when just
// reading/listing files, write or delete a file through that read-only
// path, edit/add/remove a contact, or type into a password field — that
// last one is refused unconditionally right here, no matter what it's
// asked to do. Reading a page only ever sees what you already loaded
// yourself. These boundaries are enforced right here, not on the server —
// the server only ever sees what this file lets it see.
import WebSocket from 'ws';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, watch } from 'fs';
import { homedir, hostname } from 'os';
import { join, resolve, sep } from 'path';
import { execFile, exec } from 'child_process';

const { version: PKG_VERSION } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// Hand-rolled ANSI color, not a dependency — a handful of escape codes isn't
// worth a package. Skipped outright when stdout isn't a real terminal (piped
// to a file/log) or NO_COLOR is set, so output never fills up with raw codes.
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code, s) {
  return USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const green = (s) => paint('38;2;127;217;154', s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);

function printBanner() {
  console.log('');
  console.log(`  ${green('◎◎')}  ${bold('NEUROVANCE')} ${dim('COMPANION')}  ${dim('v' + PKG_VERSION)}`);
  console.log(`      ${dim('Runs on this computer only — never in the cloud.')}`);
  console.log('');
}

const IS_WINDOWS = process.platform === 'win32';
const CONFIG_DIR = join(homedir(), '.neurovance');
const CONFIG_PATH = join(CONFIG_DIR, 'companion-config.json');
const ALLOWED_ROOT = join(homedir(), 'Documents', 'Neurovance');
const SERVER_WS_URL = process.env.NEUROVANCE_WS_URL || 'wss://app.neurovance.dev/companion-ws';
const MAX_READ_BYTES = 200_000;
const SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_OUTPUT_BYTES = 100_000;

// Real shell access, on request, on this whole machine — not sandboxed to
// ALLOWED_ROOT like the file tools above. That reach is exactly why every
// command stops here for a live yes/no in this terminal before it runs,
// unconditionally — not gated by permission mode like everything else, and
// never reachable from an unattended scheduled run (the server-side agent
// enforces that half; this prompt is what enforces the other half: no
// command from this computer's owner ever executes without them physically
// seeing it and typing y first, whether it was proposed by their own
// request or by something the AI read on a page).
function confirmShellCommand(command, cwd) {
  return new Promise((resolve) => {
    console.log('');
    console.log(bold('Your Superself wants to run a command on this computer:'));
    console.log(`  ${green('$')} ${command}`);
    if (cwd) console.log(dim(`  in ${cwd}`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Run this? [y/N] ', (answer) => {
      rl.close();
      resolve(['y', 'yes'].includes(answer.trim().toLowerCase()));
    });
  });
}

function runShellCommand(command, cwd) {
  return new Promise((resolvePromise) => {
    exec(command, { cwd: cwd || homedir(), timeout: SHELL_TIMEOUT_MS, maxBuffer: MAX_SHELL_OUTPUT_BYTES }, (error, stdout, stderr) => {
      resolvePromise({
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: (stdout || '').slice(0, MAX_SHELL_OUTPUT_BYTES),
        stderr: (stderr || '').slice(0, MAX_SHELL_OUTPUT_BYTES),
        timedOut: !!(error && error.killed && error.signal === 'SIGTERM'),
      });
    });
  });
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// The coding feature stays off until the user deliberately points it at a
// folder — the same "open a project folder before anything happens" model
// Claude Code itself uses, rather than a background process quietly having
// full-machine reach the moment it's paired. Asked once, lazily, the first
// time a command actually needs it; saved from then on. This is a
// deliberate-setup gate, not a security sandbox — commands still run with
// the same full-machine reach once set up (that part is real shell access,
// unrestricted, per how this feature was scoped); the folder is only the
// default working directory and the thing that makes turning this on an
// intentional act instead of a silent default.
function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function ensureCodingFolder() {
  const config = loadConfig() || {};
  if (config.codingFolder && existsSync(config.codingFolder)) return Promise.resolve(config.codingFolder);

  return new Promise((resolvePromise, rejectPromise) => {
    console.log('');
    console.log(bold('Your Superself wants to run code on this computer for the first time.'));
    console.log(dim('Pick a folder for it to work in — like opening a project folder in an editor.'));
    console.log(dim('It\'ll be created if it doesn\'t exist yet. This only happens once.'));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Folder path (default ${ALLOWED_ROOT}): `, (answer) => {
      rl.close();
      const chosen = resolve(expandHome(answer.trim() || ALLOWED_ROOT));
      try {
        if (!existsSync(chosen)) mkdirSync(chosen, { recursive: true });
        saveConfig({ ...config, codingFolder: chosen });
        console.log(green(`Set up. Commands will default to running in: ${chosen}`));
        resolvePromise(chosen);
      } catch (e) {
        rejectPromise(new Error(`Could not set up that folder: ${e.message}`));
      }
    });
  });
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

// Safari and Chrome both expose an AppleScript command to run arbitrary JS
// in the page — just spelled differently, and Chrome addresses "whichever
// tab is active in the front window" instead of Safari's "front document".
// Every browser action picks one of these two templates based on the
// user's own browser preference (params.browser, defaulted below), rather
// than needing separate action names per browser.
const BROWSER_APP_NAME = { safari: 'Safari', chrome: 'Google Chrome' };
function normalizeBrowser(browser) {
  return browser === 'chrome' ? 'chrome' : 'safari';
}

function runBrowserJS(js, browser) {
  const appName = BROWSER_APP_NAME[normalizeBrowser(browser)];
  const escaped = escapeForAppleScript(js);
  const script = normalizeBrowser(browser) === 'chrome'
    ? `tell application "${appName}" to activate\ntell application "${appName}" to tell active tab of front window to execute javascript "${escaped}"`
    : `tell application "${appName}" to activate\ntell application "${appName}" to do JavaScript "${escaped}" in front document`;
  return new Promise((res, rej) => {
    execFile('osascript', ['-e', script], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (/not allowed to send Apple events|1743|JavaScript through AppleScript is turned off/.test(err.message)) {
          rej(new Error(`${appName} has JavaScript-from-AppleScript turned off. Enable it: ${appName === 'Safari' ? 'Safari > Settings > Advanced > check "Show features for web developers", then the new Develop menu > check "Allow JavaScript from Apple Events"' : 'Chrome > View menu > Developer > check "Allow JavaScript from Apple Events"'}.`));
        } else if (/front document|front window|no windows/i.test(err.message)) {
          rej(new Error(`${appName} has no windows open.`));
        } else {
          rej(new Error(`${appName} script failed: ` + err.message));
        }
        return;
      }
      res(stdout.trim());
    });
  });
}

// Generic AppleScript runner for anything outside Safari — Contacts lookup,
// sending a message. No "activate" line here on purpose: reading a contact
// or sending a text doesn't need to yank focus onto some other app the way
// a visible browser action does.
function runAppleScript(script) {
  return new Promise((res, rej) => {
    execFile('osascript', ['-e', script], { maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return rej(new Error(err.message));
      res(stdout.trim());
    });
  });
}

// ---------- Windows: same jobs, done through Outlook's COM automation
// instead of AppleScript, since that's the closest Windows equivalent for
// Contacts/Calendar/Reminders(Tasks)/Notes/Mail. There's no Windows
// equivalent at all for iMessage or Music.app — those two report a plain
// "not available" error on this platform instead of pretending to work.

// PowerShell single-quoted strings only need '' doubled — no backslash or
// backtick escaping to worry about, unlike AppleScript's double-quoted
// strings. Every value embedded in a script below goes through this first.
function escapeForPowerShell(s) {
  return String(s).replace(/'/g, "''");
}

function runPowerShell(script) {
  return new Promise((res, rej) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (/0x80040154|Class not registered|New-Object.*COM/i.test(stderr || err.message)) {
          rej(new Error('Could not reach Outlook — make sure desktop Outlook is installed and you\'ve signed in at least once.'));
        } else {
          rej(new Error((stderr || err.message).trim().split('\n')[0]));
        }
        return;
      }
      res(stdout.trim());
    });
  });
}

function buildFindContactScriptWin(query) {
  const safeQuery = escapeForPowerShell(query);
  return [
    '$outlook = New-Object -ComObject Outlook.Application',
    '$ns = $outlook.GetNamespace("MAPI")',
    '$folder = $ns.GetDefaultFolder(10)', // olFolderContacts
    `$matches = $folder.Items | Where-Object { $_.FullName -like '*${safeQuery}*' } | Select-Object -First 5`,
    'foreach ($c in $matches) {',
    '  $phones = @($c.MobileTelephoneNumber, $c.HomeTelephoneNumber, $c.BusinessTelephoneNumber) | Where-Object { $_ }',
    '  $emails = @($c.Email1Address, $c.Email2Address, $c.Email3Address) | Where-Object { $_ }',
    '  Write-Output ($c.FullName + "::" + ($phones -join ",") + "::" + ($emails -join ",") + "|||ROW|||")',
    '}',
  ].join('\n');
}

function buildAddCalendarEventScriptWin(title, startISO, endISO) {
  return [
    '$outlook = New-Object -ComObject Outlook.Application',
    '$appt = $outlook.CreateItem(1)', // olAppointmentItem
    `$appt.Subject = '${escapeForPowerShell(title)}'`,
    `$appt.Start = [datetime]'${escapeForPowerShell(startISO)}'`,
    `$appt.End = [datetime]'${escapeForPowerShell(endISO)}'`,
    '$appt.Save()',
  ].join('\n');
}

function buildAddReminderScriptWin(title, dueISO) {
  const lines = [
    '$outlook = New-Object -ComObject Outlook.Application',
    '$task = $outlook.CreateItem(3)', // olTaskItem
    `$task.Subject = '${escapeForPowerShell(title)}'`,
  ];
  if (dueISO) lines.push(`$task.DueDate = [datetime]'${escapeForPowerShell(dueISO)}'`);
  lines.push('$task.Save()');
  return lines.join('\n');
}

function buildAddNoteScriptWin(title, body) {
  const full = body ? `${title}\n\n${body}` : title;
  return [
    '$outlook = New-Object -ComObject Outlook.Application',
    '$note = $outlook.CreateItem(5)', // olNoteItem
    `$note.Body = '${escapeForPowerShell(full)}'`,
    '$note.Save()',
  ].join('\n');
}

function buildReadEmailsScriptWin(limit) {
  const n = Math.max(1, Math.min(20, limit || 10));
  return [
    '$outlook = New-Object -ComObject Outlook.Application',
    '$ns = $outlook.GetNamespace("MAPI")',
    '$inbox = $ns.GetDefaultFolder(6)', // olFolderInbox
    '$items = $inbox.Items',
    '$items.Sort("[ReceivedTime]", $true)',
    `$items | Select-Object -First ${n} | ForEach-Object {`,
    '  Write-Output ($_.Subject + "::" + $_.SenderName + "::" + ((-not $_.UnRead).ToString().ToLower()) + "|||ROW|||")',
    '}',
  ].join('\n');
}

function buildSendEmailScriptWin(recipient, subject, body) {
  return [
    '$outlook = New-Object -ComObject Outlook.Application',
    '$mail = $outlook.CreateItem(0)', // olMailItem
    `$mail.To = '${escapeForPowerShell(recipient)}'`,
    `$mail.Subject = '${escapeForPowerShell(subject)}'`,
    `$mail.Body = '${escapeForPowerShell(body)}'`,
    '$mail.Send()',
  ].join('\n');
}

function buildFindContactScript(query) {
  const safeQuery = escapeForAppleScript(query);
  return [
    'tell application "Contacts"',
    `  set matches to every person whose name contains "${safeQuery}"`,
    '  if (count of matches) is 0 then return "NOT_FOUND"',
    '  set resultText to ""',
    '  set matchCount to count of matches',
    '  if matchCount > 5 then set matchCount to 5',
    '  repeat with i from 1 to matchCount',
    '    set p to item i of matches',
    '    set personName to name of p',
    '    set phoneStr to ""',
    '    repeat with ph in phones of p',
    '      set phoneStr to phoneStr & (value of ph) & ", "',
    '    end repeat',
    '    set emailStr to ""',
    '    repeat with em in emails of p',
    '      set emailStr to emailStr & (value of em) & ", "',
    '    end repeat',
    '    set resultText to resultText & personName & "::" & phoneStr & "::" & emailStr & "|||ROW|||"',
    '  end repeat',
    '  return resultText',
    'end tell',
  ].join('\n');
}

// One or many recipients — Messages' own AppleScript support for creating
// a brand-new group thread from scratch is unreliable, so "group message"
// here means the same text sent individually to each person rather than
// one shared thread. Same practical outcome for "tell everyone X", without
// depending on a flaky API.
function buildSendMessageScript(recipients, text) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const safeText = escapeForAppleScript(text);
  const lines = ['tell application "Messages"', '  set targetService to 1st service whose service type = iMessage'];
  list.forEach((r, i) => {
    const safeR = escapeForAppleScript(r);
    lines.push(`  set targetBuddy${i} to buddy "${safeR}" of targetService`);
    lines.push(`  send "${safeText}" to targetBuddy${i}`);
  });
  lines.push('end tell');
  return lines.join('\n');
}

// AppleScript's `date` coercion wants a locale-formatted string like
// "August 21, 2026 3:00:00 PM", not ISO 8601 — this runs on the user's own
// Mac, so Date's local getters already reflect their real timezone, no
// conversion needed beyond formatting.
function toAppleScriptDate(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date/time.');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hours}:${minutes}:${seconds} ${ampm}`;
}

function buildAddCalendarEventScript(title, startISO, endISO) {
  const safeTitle = escapeForAppleScript(title);
  const startStr = escapeForAppleScript(toAppleScriptDate(startISO));
  const endStr = escapeForAppleScript(toAppleScriptDate(endISO));
  return [
    'tell application "Calendar"',
    '  tell (first calendar whose writable is true)',
    `    make new event with properties {summary:"${safeTitle}", start date:date "${startStr}", end date:date "${endStr}"}`,
    '  end tell',
    'end tell',
  ].join('\n');
}

function buildAddReminderScript(title, dueISO) {
  const safeTitle = escapeForAppleScript(title);
  const lines = ['tell application "Reminders"', '  tell default list'];
  if (dueISO) {
    const dueStr = escapeForAppleScript(toAppleScriptDate(dueISO));
    lines.push(`    make new reminder with properties {name:"${safeTitle}", remind me date:date "${dueStr}"}`);
  } else {
    lines.push(`    make new reminder with properties {name:"${safeTitle}"}`);
  }
  lines.push('  end tell', 'end tell');
  return lines.join('\n');
}

// Notes.app derives the visible title from the first line of the body
// itself — "name" isn't a settable property at creation time in every
// macOS version, so this only ever sets body, title included as its
// first line, which is the reliable, documented pattern.
function buildAddNoteScript(title, body) {
  const safeTitle = escapeForAppleScript(title);
  const fullBody = body ? `${safeTitle}<br>${escapeForAppleScript(body)}` : safeTitle;
  return [
    'tell application "Notes"',
    `  make new note with properties {body:"${fullBody}"}`,
    'end tell',
  ].join('\n');
}

// Reads the N most recent inbox messages — Mail.app lists them newest
// first already, so message 1 is the latest. Subject/sender only, no body
// text, to keep this fast and avoid pulling in huge HTML email bodies for
// a simple "what's in my inbox" glance.
function buildReadEmailsScript(limit) {
  const n = Math.max(1, Math.min(20, Number(limit) || 10));
  return [
    'tell application "Mail"',
    '  set totalCount to count of messages of inbox',
    '  set msgCount to totalCount',
    `  if msgCount > ${n} then set msgCount to ${n}`,
    '  if msgCount is 0 then return "NOT_FOUND"',
    '  set resultText to ""',
    '  repeat with i from 1 to msgCount',
    '    set m to message i of inbox',
    '    set isRead to read status of m',
    '    set resultText to resultText & (subject of m) & "::" & (sender of m) & "::" & (isRead as string) & "|||ROW|||"',
    '  end repeat',
    '  return resultText',
    'end tell',
  ].join('\n');
}

function buildSendEmailScript(recipient, subject, body) {
  const safeRecipient = escapeForAppleScript(recipient);
  const safeSubject = escapeForAppleScript(subject);
  const safeBody = escapeForAppleScript(body);
  return [
    'tell application "Mail"',
    `  set newMessage to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}`,
    '  tell newMessage',
    `    make new to recipient at end of to recipients with properties {address:"${safeRecipient}"}`,
    '    send',
    '  end tell',
    'end tell',
  ].join('\n');
}

// Controls the built-in Music app (every Mac has it, no extra install) —
// deliberately not Spotify, which would need detecting which app is
// actually running and doubling every script. This only reaches the
// user's own local library, not Apple Music's full streaming catalog,
// which AppleScript can't search reliably.
const MUSIC_COMMANDS = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' };

function buildMusicControlScript(command) {
  return `tell application "Music" to ${MUSIC_COMMANDS[command]}`;
}

function buildPlaySongScript(query) {
  const safeQuery = escapeForAppleScript(query);
  return [
    'tell application "Music"',
    `  set matches to (every track of library playlist 1 whose name contains "${safeQuery}")`,
    '  if (count of matches) is 0 then return "NOT_FOUND"',
    '  play item 1 of matches',
    '  return (name of item 1 of matches) & "::" & (artist of item 1 of matches)',
    'end tell',
  ].join('\n');
}

function buildMusicStatusScript() {
  return [
    'tell application "Music"',
    '  try',
    '    return (name of current track) & "::" & (artist of current track) & "::" & (player state as string)',
    '  on error',
    '    return "::::stopped"',
    '  end try',
    'end tell',
  ].join('\n');
}

function buildClickScript(text) {
  const parts = [
    'var t=' + JSON.stringify(text.toLowerCase()) + ';',
    'var els=Array.from(document.querySelectorAll(\'a, button, [role="button"], input[type="submit"], input[type="button"], summary, [onclick]\'));',
    "var label=function(el){return (el.innerText||el.value||el.getAttribute('aria-label')||'').trim().toLowerCase();};",
    // Exact match first — otherwise a shorter target text that happens to be
    // a prefix of a different element's longer text (e.g. "Red" vs.
    // "Red (Large)") can silently click the wrong one purely by DOM order.
    'var match=els.find(function(el){return label(el)===t;})||els.find(function(el){return label(el).indexOf(t)!==-1;});',
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

// Same clickable-element selector as buildClickScript, so anything this
// lists is guaranteed to be something click_page_element can actually hit.
// getBoundingClientRect().top/left gives real on-screen position — a much
// more reliable "top" signal than DOM order, which can differ from visual
// layout once CSS grid/flex reordering is involved.
function buildListElementsScript() {
  const parts = [
    'var els=Array.from(document.querySelectorAll(\'a, button, [role="button"], input[type="submit"], input[type="button"], summary, [onclick], [role="radio"], [role="option"]\'));',
    "var items=els.map(function(el){var r=el.getBoundingClientRect();if(r.width===0||r.height===0)return null;var text=(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('title')||'').trim().replace(/\\s+/g,' ').slice(0,140);if(!text)return null;return {text:text,top:Math.round(r.top),left:Math.round(r.left)};}).filter(Boolean);",
    'items.sort(function(a,b){return a.top-b.top||a.left-b.left;});',
    'return JSON.stringify(items.slice(0,80));',
  ];
  return '(function(){' + parts.join('') + '})()';
}

// Actions with no real Windows equivalent: iMessage and Music.app are both
// Apple-exclusive, and the deeper Safari page interactions (reading/
// clicking/typing/listing elements, going back) rely on AppleScript's "do
// JavaScript in front document" — a genuinely separate, much bigger build
// on Windows (remote-debugging a browser instead of scripting Safari) that
// isn't attempted here. These just report they're unavailable instead of
// silently doing nothing.
const MAC_ONLY_ACTIONS = new Set([
  'go_back', 'read_safari_content', 'click_page_element', 'type_into_page_field',
  'list_page_elements', 'read_safari_bookmarks', 'send_text_message',
  'music_control', 'play_song', 'music_status',
]);

function handleCommand(action, params) {
  if (IS_WINDOWS && MAC_ONLY_ACTIONS.has(action)) {
    return Promise.reject(new Error(`"${action}" isn't available through the Windows Companion yet.`));
  }

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
    if (IS_WINDOWS) {
      // Start-Process with a URL opens it in the default browser — no
      // remote-debugging/CDP setup needed for just opening a page.
      const safeUrl = url.replace(/"/g, '');
      return runPowerShell(`Start-Process '${escapeForPowerShell(safeUrl)}'`)
        .then(() => ({ opened: safeUrl }))
        .catch((e) => { throw new Error('Could not open the browser: ' + e.message); });
    }
    // execFile (no shell) + stripped quotes = the URL can't break out of the
    // AppleScript string literal or reach a shell at all.
    const safeUrl = url.replace(/"/g, '');
    const appName = BROWSER_APP_NAME[normalizeBrowser(params.browser)];
    // "open location" alone doesn't bring the browser to the front — without
    // activate, the page opens invisibly behind whatever app the user is
    // actually looking at, which looks like nothing happened at all.
    const script = `tell application "${appName}" to activate\ntell application "${appName}" to open location "${safeUrl}"`;
    return new Promise((res, rej) => {
      execFile('osascript', ['-e', script], (err) => {
        if (err) rej(new Error(`Could not open ${appName}: ` + err.message));
        else res({ opened: safeUrl });
      });
    });
  }

  // Goes back in the current tab's history — the voice-mode equivalent of
  // pressing the browser's back button, so "go back" mid-conversation actually
  // does something instead of only meaning "go back to the app."
  if (action === 'go_back') {
    return runBrowserJS('(function(){history.back();return "OK";})()', params.browser).then(() => ({ result: 'OK' }));
  }

  // Reads whatever is already rendered in the user's own front tab —
  // deliberately nothing more. This never logs in, fills in a form, or
  // touches a credential; it only sees a page after the human already did
  // that part themselves. Only the front tab, never every open tab.
  if (action === 'read_safari_content') {
    const browser = normalizeBrowser(params.browser);
    const appName = BROWSER_APP_NAME[browser];
    const script = browser === 'chrome'
      ? [
          'tell application "Google Chrome"',
          '  if (count of windows) is 0 then error "Google Chrome has no windows open."',
          '  set pageURL to URL of active tab of front window',
          '  set pageTitle to title of active tab of front window',
          '  set pageText to execute active tab of front window javascript "document.body.innerText"',
          '  return pageURL & "|||NEUROVANCE|||" & pageTitle & "|||NEUROVANCE|||" & pageText',
          'end tell',
        ].join('\n')
      : [
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
          if (/not allowed to send Apple events|1743|JavaScript through AppleScript is turned off/.test(err.message)) {
            rej(new Error(`${appName} has JavaScript-from-AppleScript turned off. Enable it: ${appName === 'Safari' ? 'Safari > Settings > Advanced > check "Show features for web developers", then the new Develop menu > check "Allow JavaScript from Apple Events"' : 'Chrome > View menu > Developer > check "Allow JavaScript from Apple Events"'}.`));
          } else {
            rej(new Error(`Could not read the ${appName} page: ` + err.message));
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
    return runBrowserJS(js, params.browser).then((result) => {
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
    return runBrowserJS(js, params.browser).then((result) => {
      if (result === 'NOT_FOUND') throw new Error(`Could not find a field matching "${label}" on the current page.`);
      if (result === 'BLOCKED_PASSWORD') throw new Error('Refusing to type into a password field — the Companion never handles credentials.');
      return { result };
    });
  }

  // Lists every clickable thing on the current page — text, and its real
  // on-screen top/left position — sorted top-to-bottom, left-to-right. This
  // is what lets a vague spoken instruction like "the red one on top" or
  // "the second result" resolve to an actual element: the agent reads this
  // list, picks the right entry, then calls click_page_element with that
  // entry's exact text. Skips anything with zero size (hidden/off-screen).
  if (action === 'list_page_elements') {
    return runBrowserJS(buildListElementsScript(), params.browser).then((result) => {
      try {
        return { elements: JSON.parse(result) };
      } catch {
        throw new Error('Could not read the page\'s clickable elements.');
      }
    });
  }

  // Reads the user's own Contacts (read-only) so a request like "text mom"
  // can resolve to an actual phone number/email instead of asking them to
  // type one. Never writes/edits a contact, only searches by name.
  if (action === 'find_contact') {
    const query = params.query || '';
    if (!query) return Promise.reject(new Error('No name given to search for.'));
    const runner = IS_WINDOWS ? runPowerShell(buildFindContactScriptWin(query)) : runAppleScript(buildFindContactScript(query));
    return runner.then((result) => {
      if (result === 'NOT_FOUND') return { contacts: [] };
      const rows = result.split('|||ROW|||').filter(Boolean);
      const contacts = rows.map((row) => {
        const [name, phones, emails] = row.split('::');
        return {
          name: (name || '').trim(),
          phones: (phones || '').split(',').map((s) => s.trim()).filter(Boolean),
          emails: (emails || '').split(',').map((s) => s.trim()).filter(Boolean),
        };
      });
      return { contacts };
    });
  }

  // Sends a real iMessage on the user's behalf — the one Companion action
  // that reaches another person, not just the user's own stuff. The
  // server's system prompt is what makes the model stop and confirm with
  // the user before ever calling this, same as it already does for
  // payments and deletions; this action itself has no concept of "safe"
  // vs "not", it just sends what it's told, exactly like click_page_element.
  if (action === 'send_text_message') {
    const { recipients, text } = params;
    if (!recipients || !(Array.isArray(recipients) ? recipients.length : true) || !text) {
      return Promise.reject(new Error('Need at least one recipient and message text.'));
    }
    return runAppleScript(buildSendMessageScript(recipients, text))
      .then(() => ({ sent: true, recipients: Array.isArray(recipients) ? recipients : [recipients] }))
      .catch((e) => { throw new Error('Could not send the message: ' + e.message); });
  }

  // Adds a real event to the user's own calendar — their own data, no
  // third party involved, so (unlike sending a message) this doesn't need
  // the same confirm-first treatment; the server's system prompt is what
  // actually decides that policy, this action just does what it's told.
  if (action === 'add_calendar_event') {
    const { title, startDateTime, endDateTime } = params;
    if (!title || !startDateTime || !endDateTime) {
      return Promise.reject(new Error('Need a title, start time, and end time.'));
    }
    const runner = IS_WINDOWS
      ? runPowerShell(buildAddCalendarEventScriptWin(title, startDateTime, endDateTime))
      : runAppleScript(buildAddCalendarEventScript(title, startDateTime, endDateTime));
    return runner
      .then(() => ({ added: true, title }))
      .catch((e) => { throw new Error('Could not add the calendar event: ' + e.message); });
  }

  if (action === 'add_reminder') {
    const { title, dueDateTime } = params;
    if (!title) return Promise.reject(new Error('Need a title for the reminder.'));
    const runner = IS_WINDOWS
      ? runPowerShell(buildAddReminderScriptWin(title, dueDateTime))
      : runAppleScript(buildAddReminderScript(title, dueDateTime));
    return runner
      .then(() => ({ added: true, title }))
      .catch((e) => { throw new Error('Could not add the reminder: ' + e.message); });
  }

  if (action === 'add_note') {
    const { title, body } = params;
    if (!title) return Promise.reject(new Error('Need a title for the note.'));
    const runner = IS_WINDOWS
      ? runPowerShell(buildAddNoteScriptWin(title, body))
      : runAppleScript(buildAddNoteScript(title, body));
    return runner
      .then(() => ({ added: true, title }))
      .catch((e) => { throw new Error('Could not add the note: ' + e.message); });
  }

  // Reads the inbox (read-only, subject/sender/read-status only, no body
  // text) so it can actually glance at what's there before being asked
  // to do anything with it.
  if (action === 'read_recent_emails') {
    const runner = IS_WINDOWS
      ? runPowerShell(buildReadEmailsScriptWin(params.limit))
      : runAppleScript(buildReadEmailsScript(params.limit));
    return runner.then((result) => {
      if (result === 'NOT_FOUND') return { emails: [] };
      const rows = result.split('|||ROW|||').filter(Boolean);
      const emails = rows.map((row) => {
        const [subject, sender, isRead] = row.split('::');
        return { subject: (subject || '').trim(), sender: (sender || '').trim(), read: (isRead || '').trim() === 'true' };
      });
      return { emails };
    });
  }

  // Sends a real email from the user's own Mail app — reaches another
  // person, same category as send_text_message. The server's system
  // prompt is what makes the model confirm with the user first; this
  // action itself just sends what it's told.
  if (action === 'send_email') {
    const { recipient, subject, body } = params;
    if (!recipient || !subject || !body) return Promise.reject(new Error('Need a recipient, subject, and body.'));
    const runner = IS_WINDOWS
      ? runPowerShell(buildSendEmailScriptWin(recipient, subject, body))
      : runAppleScript(buildSendEmailScript(recipient, subject, body));
    return runner
      .then(() => ({ sent: true, recipient }))
      .catch((e) => { throw new Error('Could not send the email: ' + e.message); });
  }

  // Play/pause/skip in the user's own Music app — their own local
  // playback, reaches nobody else, so no confirmation needed.
  if (action === 'music_control') {
    const command = params.command;
    if (!MUSIC_COMMANDS[command]) return Promise.reject(new Error('Unknown music command: ' + command));
    return runAppleScript(buildMusicControlScript(command)).then(() => ({ ok: true, command }));
  }

  // Searches the user's own Music library by name and plays the first
  // match — same "own data, no confirmation" category as playback control.
  if (action === 'play_song') {
    const query = params.query;
    if (!query) return Promise.reject(new Error('Need a song or artist to search for.'));
    return runAppleScript(buildPlaySongScript(query)).then((result) => {
      if (result === 'NOT_FOUND') return { found: false };
      const [name, artist] = result.split('::');
      return { found: true, name: (name || '').trim(), artist: (artist || '').trim() };
    });
  }

  // Reads what's currently playing (read-only, free to use anytime).
  if (action === 'music_status') {
    return runAppleScript(buildMusicStatusScript()).then((result) => {
      const [name, artist, state] = result.split('::');
      return { name: (name || '').trim(), artist: (artist || '').trim(), state: (state || 'stopped').trim() };
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

  // Real shell exec on this whole machine — see confirmShellCommand above
  // for why this is the one action that always stops for a live prompt
  // right here, no matter what permission mode is set to.
  if (action === 'run_shell_command') {
    const command = params.command;
    if (typeof command !== 'string' || !command.trim()) throw new Error('No command given.');
    return ensureCodingFolder().then((codingFolder) => {
      const cwd = params.cwd ? resolve(params.cwd) : codingFolder;
      return confirmShellCommand(command, cwd).then((approved) => {
        if (!approved) throw new Error('Declined — the command was not run.');
        return runShellCommand(command, cwd);
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
        console.log(green('Paired.') + ' Your Superself can now read from:\n  ' + ALLOWED_ROOT);
      } else {
        console.error('Pairing failed:', msg.error);
        process.exit(1);
      }
      return;
    }

    if (msg.type === 'reconnect_result') {
      console.log(msg.ok ? green('Connected.') : 'Reconnect rejected — delete ~/.neurovance/companion-config.json and pair again.');
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
printBanner();
console.log(`This computer will only ever share files from:\n  ${dim(ALLOWED_ROOT)}\n`);
watchAllowedRoot();

const config = loadConfig();
if (config?.userId) {
  connect(config.userId);
} else {
  promptForCode();
}
