'use strict';

/*
 * Find a browser to render with.
 *
 * The rendered suites and the document build all need Chromium. They used to
 * ask @sparticuz/chromium for a path and hand it straight to Playwright, which
 * works on Linux and fails on Windows with:
 *
 *   browserType.launch: Failed to launch:
 *   Error: spawn C:\Users\...\AppData\Local\Temp\chromium ENOENT
 *
 * That package ships a Linux binary built for AWS Lambda. On Windows it returns
 * a path it never populates, and the error names a temp directory rather than
 * the actual problem, which is that the wrong browser was installed for the
 * machine. Anyone reading it goes looking at Playwright.
 *
 * So the path is resolved rather than assumed, in this order:
 *
 *   1. LIMEN_CHROME, if somebody wants to point at a specific binary.
 *   2. @sparticuz/chromium, but only if the file it names actually exists.
 *   3. Chrome or Edge already installed on this machine.
 *   4. Playwright's own download, if the full `playwright` package is present.
 *
 * If none of those turn up, it says what to install for this platform instead
 * of failing inside a spawn call.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* Flags that make a software-rendered headless Chromium usable in a sandbox.
   Harmless on a normal desktop, and necessary where there is no GPU. */
const SANDBOX_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

const exists = (p) => {
  try { return !!p && fs.existsSync(p); } catch (_) { return false; }
};

function windowsCandidates() {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  const rel = [
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Google', 'Chrome Beta', 'Application', 'chrome.exe'],
    ['Chromium', 'Application', 'chrome.exe'],
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ];
  const out = [];
  for (const r of roots) for (const parts of rel) out.push(path.join(r, ...parts));
  return out;
}

function macCandidates() {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
}

function linuxCandidates() {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

/**
 * Resolve an executable path and the arguments to launch it with.
 *
 * @returns {{executablePath: string, args: string[], source: string}}
 * @throws  {Error} with installation instructions when nothing is found
 */
async function resolveBrowser() {
  // 1. An explicit override always wins, and says so if it is wrong.
  if (process.env.LIMEN_CHROME) {
    if (!exists(process.env.LIMEN_CHROME)) {
      throw new Error(`LIMEN_CHROME points at ${process.env.LIMEN_CHROME}, which does not exist.`);
    }
    return { executablePath: process.env.LIMEN_CHROME, args: SANDBOX_ARGS, source: 'LIMEN_CHROME' };
  }

  // 2. The Lambda build, but only if it produced a real file. On Windows it
  //    returns a path it never writes, which is the whole bug.
  try {
    let cp = require('@sparticuz/chromium');
    cp = cp.default || cp;
    const p = await cp.executablePath();
    if (exists(p)) {
      return { executablePath: p, args: [...new Set([...(cp.args || []), ...SANDBOX_ARGS])], source: '@sparticuz/chromium' };
    }
  } catch (_) { /* not installed, or not usable here */ }

  // 3. Whatever the person already has. Chrome and Edge are both Chromium and
  //    Playwright drives either one.
  const byPlatform = process.platform === 'win32' ? windowsCandidates()
    : process.platform === 'darwin' ? macCandidates()
      : linuxCandidates();
  for (const p of byPlatform) {
    if (exists(p)) return { executablePath: p, args: SANDBOX_ARGS, source: path.basename(p) };
  }

  // 4. Playwright's own download, if the full package rather than -core.
  try {
    const pw = require('playwright');
    const p = pw.chromium.executablePath();
    if (exists(p)) return { executablePath: p, args: SANDBOX_ARGS, source: 'playwright' };
  } catch (_) { /* playwright-core has no bundled browser */ }

  const install = process.platform === 'win32'
    ? 'Install Google Chrome, or run:  npm install --no-save playwright && npx playwright install chromium'
    : 'Install Chromium or Google Chrome, or run:  npm install --no-save playwright && npx playwright install chromium';
  throw new Error(
    `No Chromium build found for ${process.platform}.\n\n  ${install}\n\n` +
    '  Or set LIMEN_CHROME to the full path of a Chrome or Edge executable.\n'
  );
}

/** Launch, or exit with the instructions rather than a stack trace. */
async function launch(chromium, opts = {}) {
  let found;
  try {
    found = await resolveBrowser();
  } catch (e) {
    console.error(`\n  ${e.message}`);
    process.exitCode = 1;
    return null;
  }
  return chromium.launch({ executablePath: found.executablePath, args: found.args, ...opts });
}

module.exports = { resolveBrowser, launch, SANDBOX_ARGS };
