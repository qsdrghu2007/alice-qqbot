import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const major = Number(process.versions.node.split(".")[0]);

console.log(`小鱼运行环境检查`);
console.log(`Node.js：${process.version}`);
console.log(`项目目录：${root}`);

if (!Number.isInteger(major) || major < 22) {
  console.error("需要 Node.js 22 或更高版本。请先升级 Node.js。");
  process.exitCode = 1;
} else {
  console.log("Node.js 版本符合要求。");
}

try {
  await access(path.join(root, "node_modules", "ws", "package.json"));
  console.log("依赖 ws 已安装。");
} catch {
  console.error("依赖尚未安装，请在项目目录运行 npm install。");
  process.exitCode = 1;
}

if (!process.exitCode) {
  console.log("安装检查通过。运行 npm start 启动本地控制台。");
  console.log("需要个人号聊天、表情和空间扩展时，请另行安装并登录 NapCatQQ。");
}
