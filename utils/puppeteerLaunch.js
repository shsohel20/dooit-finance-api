const os = require("os");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// Chrome spawns chrome_crashpad_handler with a --database path derived from
// the user config dir ($XDG_CONFIG_HOME, falling back to $HOME/.config). In
// containers that run without a writable HOME that path resolves empty, the
// handler aborts with "--database is required", and the browser dies at
// startup. Point HOME/XDG at a writable tmp dir and disable crash reporting
// so every PDF endpoint launches the same hardened browser.
const chromeHomeDir = path.join(os.tmpdir(), "chrome-home");
const crashDumpsDir = path.join(chromeHomeDir, "crash-dumps");

const PDF_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // Docker's default /dev/shm (64MB) is too small for page rendering; use /tmp instead.
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-crash-reporter",
  "--disable-breakpad",
  `--crash-dumps-dir=${crashDumpsDir}`,
];

async function launchPdfBrowser(options = {}) {
  fs.mkdirSync(crashDumpsDir, { recursive: true });
  return puppeteer.launch({
    headless: true,
    args: PDF_LAUNCH_ARGS,
    env: {
      ...process.env,
      HOME: chromeHomeDir,
      XDG_CONFIG_HOME: path.join(chromeHomeDir, ".config"),
      XDG_CACHE_HOME: path.join(chromeHomeDir, ".cache"),
    },
    ...options,
  });
}

module.exports = { launchPdfBrowser, PDF_LAUNCH_ARGS };
