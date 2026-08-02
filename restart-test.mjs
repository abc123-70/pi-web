// 独立验证脚本：调用 /api/restart，验证优雅重启后服务能回来
// 运行方式：node restart-test.mjs（独立进程，不依赖服务器宿主）
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const out = join(process.cwd(), "restart-test-result.txt");
const log = (s) => appendFileSync(out, s + "\n");

const getPid = () => {
  try {
    const r = execSync('netstat -ano | findstr ":8765" | findstr "LISTENING"', { encoding: "utf8" });
    const parts = r.trim().split(/\s+/);
    return parts[parts.length - 1];
  } catch {
    return "无监听";
  }
};

try {
  const before = getPid();
  log(`[${new Date().toISOString()}] 重启前 PID: ${before}`);
  try {
    const res = execSync('curl -s -X POST http://127.0.0.1:8765/api/restart', {
      encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    log(`restart 响应: ${res.trim()}`);
  } catch (e) {
    log(`restart 调用异常: ${e.message}`);
  }
  // 最多等 12 秒，直到 PID 变化
  let after = getPid();
  for (let i = 0; i < 12; i++) {
    execSync("sleep 1", { stdio: "ignore" });
    after = getPid();
    if (after !== before && after !== "无监听") break;
  }
  log(`重启后 PID: ${after}`);
  try {
    const code = execSync('curl -s -o NUL -w "%{http_code}" --max-time 5 http://127.0.0.1:8765/', {
      encoding: "utf8", windowsHide: true,
    });
    log(`重启后首页 HTTP: ${code}`);
  } catch (e) {
    log(`首页检查异常: ${e.message}`);
  }
  // 页面版本端点（确认新进程带着新代码）
  try {
    const v = execSync('curl -s --max-time 5 http://127.0.0.1:8765/api/page-version', {
      encoding: "utf8", windowsHide: true,
    });
    log(`page-version: ${v.trim()}`);
  } catch (e) {
    log(`page-version 异常: ${e.message}`);
  }
  log("=== 验证完成 ===");
} catch (e) {
  log("脚本异常: " + e.message);
}
