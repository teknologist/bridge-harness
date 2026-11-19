#!/usr/bin/env node
// Builds dist/ when the package is installed from a git source.
// `npm install -g github:...` installs devDependencies before `prepare`, so tsc
// is available and dist/ gets built. Pi installs git packages with
// `--omit=dev`; it only loads the TypeScript Pi extension, so skip the build
// there instead of failing the install.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let tsc;
try {
  tsc = require.resolve("typescript/bin/tsc");
} catch {
  console.log("[bridge-harness] typescript not installed; skipping dist build");
  process.exit(0);
}
const { status } = spawnSync(process.execPath, [tsc], { stdio: "inherit" });
process.exit(status ?? 1);
