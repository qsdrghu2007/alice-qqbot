import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "src/index.js",
  "src/server.js",
  "src/config.js",
  "src/store.js",
  "src/engine.js",
  "src/message-batcher.js",
  "src/memory.js",
  "src/chat-exit.js",
  "src/chat-activity.js",
  "src/follow-up.js",
  "src/conversation-state.js",
  "src/conversation-style.js",
  "src/user-understanding.js",
  "src/delivery.js",
  "src/search.js",
  "src/web-search.js",
  "src/typing.js",
  "src/style.js",
  "src/ai.js",
  "src/autonomy.js",
  "src/weather.js",
  "src/qzone.js",
  "src/qzone-web.js",
  "src/qzone-links.js",
  "src/qzone-comments.js",
  "src/stickers.js",
  "src/adapters/qq.js",
  "src/adapters/onebot.js",
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "test/reply-flow.test.js",
  "docs/HUMANLIKE-CHECKLIST.md",
];

function fail(message) {
  console.error(`检查失败：${message}`);
  process.exitCode = 1;
}

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 22) {
  fail(`需要 Node.js >= 22，当前为 ${process.version}`);
} else {
  console.log(`Node.js ${process.version} 可用`);
}

let packageJson;
try {
  packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
} catch (error) {
  fail(`无法读取 package.json：${error.message}`);
}

if (packageJson?.type !== "module") fail("package.json 必须声明 type=module");
if (!packageJson?.dependencies?.ws) fail("缺少 ws 依赖声明");

try {
  await access(path.join(root, "node_modules", "ws", "package.json"));
  console.log("依赖 ws 已安装");
} catch {
  fail("依赖未安装，请运行 npm install");
}

for (const relative of requiredFiles) {
  try {
    await access(path.join(root, relative));
  } catch {
    fail(`缺少文件 ${relative}`);
  }
}

for (const relative of requiredFiles.filter((file) => file.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, relative)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`${relative} 语法检查失败\n${result.stderr.trim()}`);
  }
}

try {
  const checklist = await readFile(
    path.join(root, "docs", "HUMANLIKE-CHECKLIST.md"),
    "utf8",
  );
  for (let index = 1; index <= 15; index += 1) {
    const id = `HM-${String(index).padStart(2, "0")}`;
    if (!checklist.includes(`| ${id} |`)) {
      fail(`拟人化验收矩阵缺少 ${id}`);
    }
  }
  for (const testFile of [
    "test/message-batcher.test.js",
    "test/delivery.test.js",
    "test/reply-flow.test.js",
    "test/conversation-state.test.js",
    "test/follow-up.test.js",
    "test/chat-exit.test.js",
  ]) {
    if (!checklist.includes(testFile)) {
      fail(`拟人化验收矩阵缺少测试引用 ${testFile}`);
    }
  }
} catch (error) {
  fail(`无法检查拟人化验收矩阵：${error.message}`);
}

if (!process.exitCode) {
  console.log("项目结构、Node.js 版本和 JavaScript 语法检查通过");
  console.log("自动化测试请运行：npm test");
}
