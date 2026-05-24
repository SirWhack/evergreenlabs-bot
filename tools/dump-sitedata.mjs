// One-shot: import the website's siteData.js and print JSON to stdout.
// Usage: node tools/dump-sitedata.mjs <absolute-path-to-siteData.js>

import { pathToFileURL } from "node:url";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: node dump-sitedata.mjs <absolute-path-to-siteData.js>");
  process.exit(2);
}

const abs = path.resolve(target);
const mod = await import(pathToFileURL(abs).href);
if (!mod.SITE) {
  console.error("siteData.js did not export SITE");
  process.exit(1);
}
process.stdout.write(JSON.stringify(mod.SITE, null, 2));
