<!-- context-kernel-freshness
graph: 4828895ec2ab8c46292fc502e3c028e8b68915c679ff81f463cf9148983976a0
source-tree: c1f57670ef99a06391be1351ef85c353356a03fa89662b0a71ea38fc3d2dbb8d
materialized: 2026-05-27T21:03:14Z
-->

This scope provides a single utility script, `dump-sitedata.mjs`, which is a standalone tool for extracting and printing site data from the bot’s working directory. Its purpose is to support debugging and inspection by dumping the contents of a specific data file to standard output. The script is not a reusable module — it has no exports — and is intended to be run directly via Node.js.

The script uses `pathToFileURL` from `node:url` and `path` from `node:path` to resolve the target file path relative to the script’s own location. It defines three private constants: `target` (the filename to dump), `abs` (the absolute path to that file), and `mod` (the loaded module). The script reads the file using `require()` and prints the result, making it a simple, single-purpose debugging aid.

This scope has no dependencies beyond Node.js built-in modules and does not interact with any other part of the bot’s codebase. It is a leaf utility — isolated, self-contained, and trivial to understand or remove.
