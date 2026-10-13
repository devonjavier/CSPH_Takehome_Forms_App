import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const api = JSON.parse(
  await readFile(path.join(root, "apps/api/package.json")),
);
const consumer = JSON.parse(
  await readFile(path.join(root, "apps/webhook-consumer/package.json")),
);
assert.equal(api.scripts.dev, consumer.scripts.dev);
// Keep this probe coupled to the actual development command, not a parallel setup.
const command = api.scripts.dev
  .match(/"[^"]*"|\S+/g)
  .map((part) => part.replace(/^"|"$/g, ""));
assert.equal(command.shift(), "tsx");
const fixture = await mkdtemp(path.join(tmpdir(), "forms-watch-test-"));
let child;
try {
  await mkdir(path.join(fixture, "src"));
  await mkdir(path.join(fixture, "node_modules/probe"), { recursive: true });
  await writeFile(path.join(fixture, ".env"), "WATCH_PROBE=loaded\n");
  const dependency = path.join(fixture, "node_modules/probe/index.js");
  await writeFile(dependency, "module.exports = 1;\n");
  const source = path.join(fixture, "src/server.ts");
  const program = `import value from '../node_modules/probe/index.js';
console.log('WATCH_READY', process.env.WATCH_PROBE, value);
setInterval(() => {}, 1000);
`;
  await writeFile(source, program);
  child = spawn(process.execPath, [require.resolve("tsx/cli"), ...command], {
    cwd: fixture,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const readyCount = () => (output.match(/WATCH_READY loaded/g) ?? []).length;
  async function waitForCount(count) {
    const deadline = Date.now() + 15000;
    while (readyCount() < count && Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      await delay(100);
    }
    assert.equal(readyCount(), count, output);
  }
  await waitForCount(1);
  await delay(1000);
  await writeFile(dependency, "module.exports = 2;\n");
  await delay(1500);
  assert.equal(
    readyCount(),
    1,
    "Dependency edit restarted the process:\n" + output,
  );
  await writeFile(source, program + "// intentional application edit\n");
  await waitForCount(2);
  assert.match(output, /WATCH_READY loaded 2/);
  console.log(
    "PASS: environment loaded; dependency edit ignored; source edit restarted.",
  );
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    // tsx forwards shutdown to its watched child; stop only this owned process.
    child.kill("SIGTERM");
    await exited;
  }
  const relative = path.relative(tmpdir(), fixture);
  assert.ok(
    relative.startsWith("forms-watch-test-") && !relative.includes(path.sep),
  );
  await rm(fixture, { recursive: true, force: true });
}
