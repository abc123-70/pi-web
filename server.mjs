// pi-web - 多会话网页版 AI 助手（本地服务）
// 架构升级（借鉴 @agegr/pi-web 的 rpc-manager 模式）：
//   - 多会话注册表：多个 agent 会话可同时存活、并行工作
//   - 按会话 SSE 频道：GET /api/agent/[id]/events
//   - 懒恢复：事件连接时若会话不在内存，则从会话文件恢复（关网页不丢上下文）
//   - 事件过滤：剔除内部噪音事件（turn_start / tool_execution_update 等）
// 启动: node server.mjs [端口]

import { createServer } from "node:http";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve, sep, basename, dirname } from "node:path";
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, copyFileSync, readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PORT = Number(process.argv[2] || process.env.PI_WEB_PORT || 8765);
const DEFAULT_CWD = process.env.PI_WEB_CWD || homedir();

// ---------- 递归复制目录（技能同步用） ----------
function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyDirRecursive(s, d);
    else copyFileSync(s, d);
  }
}
const AGENT_DIR = join(homedir(), ".pi", "agent");
// ai-agent-skills CLI 路径：环境变量优先，找不到则禁用技能搜索/安装
const SKILLS_CLI = process.env.PI_SKILLS_CLI || join("C:\\nodejs\\node_modules\\ai-agent-skills", "cli.js");
const SKILLS_CLI_AVAILABLE = (() => {
  try {
    return existsSync(SKILLS_CLI);
  } catch {
    return false;
  }
})();
const HERE = join(fileURLToPath(import.meta.url), "..");
const PAGE_HTML_PATH = join(HERE, "page.html");

// ---------- 项目工作区存储（P0 #4）：按工作目录隔离，不同 cwd 的用户互不串数据 ----------
// 旧版本存在 ~/.pi/agent/pi-web-projects.json（全局），现改为随 cwd（.pi-web-projects.json），
// 首次启动时把旧全局数据迁移过来，避免老用户丢失项目列表。
const PROJECTS_FILE = join(DEFAULT_CWD, ".pi-web-projects.json");
const LEGACY_PROJECTS_FILE = join(AGENT_DIR, "pi-web-projects.json");
function loadProjects() {
  let target = PROJECTS_FILE;
  // 迁移条件：仅当使用默认工作目录（老用户升级场景）且新文件不存在时，
  // 把旧全局数据带过来；显式指定 cwd 的新用户（PI_WEB_CWD）不继承，保证隔离
  const isDefaultCwd = process.env.PI_WEB_CWD ? DEFAULT_CWD.toLowerCase() === homedir().toLowerCase() : true;
  if (!existsSync(target) && existsSync(LEGACY_PROJECTS_FILE) && isDefaultCwd) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(LEGACY_PROJECTS_FILE, target);
    } catch {
      /* ignore */
    }
  }
  try {
    const data = JSON.parse(readFileSync(target, "utf8"));
    if (Array.isArray(data.projects)) return data.projects;
  } catch {
    /* ignore */
  }
  return [];
}
function saveProjects(projects) {
  mkdirSync(dirname(PROJECTS_FILE), { recursive: true });
  const tmp = PROJECTS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2), "utf8");
  renameSync(tmp, PROJECTS_FILE);
}

// ---------- 配置可视化（P0 #7）：白名单 + 自动备份 + 原子写入 ----------
const CONFIG_FILES = {
  models: "models.json",
  auth: "auth.json",
  settings: "settings.json",
};
function configPath(name) {
  const file = CONFIG_FILES[name];
  return file ? join(AGENT_DIR, file) : null;
}
function configIndex() {
  const out = {};
  for (const [key, file] of Object.entries(CONFIG_FILES)) {
    const p = join(AGENT_DIR, file);
    try {
      const st = statSync(p);
      out[key] = { exists: true, size: st.size, mtime: st.mtimeMs };
    } catch {
      out[key] = { exists: false, size: 0, mtime: 0 };
    }
  }
  return out;
}
function writeConfigFile(name, content) {
  const p = configPath(name);
  if (!p) throw new Error("unknown config: " + name);
  if (typeof content !== "string" || !content.trim()) throw new Error("empty content");
  JSON.parse(content); // 先校验 JSON，非法直接抛错
  mkdirSync(AGENT_DIR, { recursive: true });
  if (existsSync(p)) {
    copyFileSync(p, p + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-"));
  }
  const tmp = p + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}
/** 简化配置：只写 API key 到 auth.json（保留原格式与注释无法保留，但结构安全） */
function writeApiKey(provider, key) {
  const p = join(AGENT_DIR, "auth.json");
  let auth = {};
  if (existsSync(p)) {
    try {
      auth = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      auth = {};
    }
  }
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) auth = {};
  const providerId = String(provider || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!providerId) throw new Error("missing provider");
  const keyValue = String(key || "").trim();
  if (!keyValue) throw new Error("missing API key");
  auth[providerId] = { type: "api_key", key: keyValue };
  const content = JSON.stringify(auth, null, 2) + "\n";
  mkdirSync(AGENT_DIR, { recursive: true });
  if (existsSync(p)) {
    copyFileSync(p, p + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-"));
  }
  const tmp = p + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
  return providerId;
}

// 所有活跃 SSE 连接（用于页面热更新广播：编辑 page.html 后自动刷新）
const sseConnections = new Set();
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseConnections) {
    try {
      res.write(data);
    } catch {
      /* ignore */
    }
  }
}

// 系统提示词（与 pi 本体保持一致）
const SYSTEM_PROMPT =
  "You are a capable AI assistant running locally on the user's computer.\n" +
  "Capabilities:\n" +
  "- Control the computer: use bash to run commands, read/edit/write files, manage folders.\n" +
  "- Search the web with web_search, read full pages with fetch_page.\n" +
  "- Use the installed skills (docx/pptx/pdf/xlsx) when the user asks for documents, slides, spreadsheets.\n" +
  "- Prefer actually doing things with tools over guessing or refusing.\n" +
  "- Be proactive, precise and concise. Reply in Chinese unless the user asks otherwise.";

// 激活的工具：默认编程工具 + 扩展工具（web_search / fetch_page）
const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "fetch_page"];
const MAX_SESSIONS = 8; // 注册表最多同时保留的会话数，超出淘汰最久未用的

// 页面读取：带 mtime 缓存 + 定时轮询，编辑 page.html 后所有页面自动刷新
let pageHtmlCache = null;
let pageHtmlMtime = 0;
function loadPageHtml() {
  try {
    const st = statSync(PAGE_HTML_PATH);
    pageHtmlMtime = st.mtimeMs;
    pageHtmlCache = readFileSync(PAGE_HTML_PATH, "utf8");
  } catch {
    pageHtmlCache = "<h1>page.html 缺失</h1>";
  }
}
function getPageHtml() {
  if (pageHtmlCache === null) loadPageHtml();
  return pageHtmlCache;
}
// 页面版本号：页面加载时和 SSE 重连时与服务器比对，不一致则自动刷新
function pageVersion() {
  if (pageHtmlCache === null) loadPageHtml();
  return pageHtmlMtime;
}

// 每秒检查一次 page.html 是否有改动，变了就通知所有已打开的页面自动刷新
setInterval(() => {
  try {
    const st = statSync(PAGE_HTML_PATH);
    if (st.mtimeMs !== pageHtmlMtime) {
      loadPageHtml();
      broadcast({ type: "reload" });
    }
  } catch {
    /* ignore */
  }
}, 1000);

// ---------- 事件过滤（借鉴 pi-web）：剔除内部噪音事件 ----------
const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end", "tool_execution_update"]);
/** 剥离消息内容里的 thinking（思考）块——前端完全看不到思考过程 */
function stripThinking(content) {
  if (!Array.isArray(content)) return content;
  return content.filter((c) => c && c.type !== "thinking");
}
function toClientEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  if (event.type === "message_update") {
    const c = { ...event };
    delete c.assistantMessageEvent; // 前端按 message.content 全量渲染，不需要增量事件
    if (c.message && Array.isArray(c.message.content)) {
      c.message = { ...c.message, content: stripThinking(c.message.content) };
    }
    return c;
  }
  if (event.type === "agent_end") return { type: "agent_end" };
  if ((event.type === "message_start" || event.type === "message_end") && event.message && Array.isArray(event.message.content)) {
    const c = { ...event };
    c.message = { ...event.message, content: stripThinking(event.message.content) };
    return c;
  }
  return event;
}

// ---------- 内容工具 ----------
function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("");
}
function msgText(m) {
  if (!m) return "";
  if (m.role === "user") return contentText(m.content);
  if (m.role === "assistant") {
    // 只取正文文本，不包含思考（thinking）内容
    return (Array.isArray(m.content) ? m.content : [])
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

// ---------- DeepSeek 余额 ----------


// ============================================================================
// DeepSeek 余额（开源版：优先读环境变量，其次读本机密钥文件，都没有则跳过）
const DEEPSEEK_API_KEY = (() => {
  try {
    // 1) 环境变量优先（开源部署推荐）
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
    // 2) 网页端配置的 auth.json（用户自己填写的 key，开源标准做法）
    const authPath = join(AGENT_DIR, "auth.json");
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      const ds = auth && auth["deepseek"];
      if (ds && typeof ds.key === "string" && ds.key) return ds.key;
    }
    return "";
  } catch {
    return "";
  }
})();
async function fetchBalance() {
  if (!DEEPSEEK_API_KEY) return null;
  try {
    const resp = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: "Bearer " + DEEPSEEK_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();
    if (!data || !Array.isArray(data.balance_infos)) return null;
    return data.balance_infos.map((i) => ({
      currency: i.currency || "CNY",
      total: parseFloat(i.total_balance || 0),
      granted: parseFloat(i.granted_balance || 0),
      toppedUp: parseFloat(i.topped_up_balance || 0),
    }));
  } catch {
    return null;
  }
}

// ============================================================================
// 多会话注册表（rpc-manager 模式）
// ============================================================================
const registry = new Map(); // sessionId -> RpcSession
const locks = new Map(); // key -> Promise（并发创建去重）
let lastActiveSessionId = null; // 旧 API 兼容：最近活跃的会话

class RpcSession {
  constructor({ session, services, sm }) {
    this.session = session;
    this.services = services;
    this.sm = sm;
    this.listeners = new Set();
    this.unsubscribe = null;
    this._alive = true;
    this.lastUsed = Date.now();
  }
  get id() {
    return this.session.sessionId;
  }
  get sessionFile() {
    return this.session.sessionFile;
  }
  get cwd() {
    return this.sm.getCwd();
  }
  isAlive() {
    return this._alive;
  }
  isRunning() {
    return (
      this._alive &&
      (this.session.isPromptRunning ||
        this.session.isStreaming ||
        this.session.isCompacting ||
        this.session.isBashRunning)
    );
  }
  touch() {
    this.lastUsed = Date.now();
  }
  start() {
    this.unsubscribe = this.session.subscribe((event) => {
      const clientEvt = toClientEvent(event);
      if (!clientEvt) return;
      if (event.type === "agent_end" || event.type === "agent_settled") {
        invalidateSessionListCache();
      }
      this.emit(clientEvt);
    });
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* ignore */
      }
    }
  }
  /** 命令分发（借鉴 pi-web 的 session.send 语义） */
  async send(command) {
    this.touch();
    switch (command.type) {
      case "prompt": {
        const text = String(command.text ?? "").trim();
        if (!text && !(command.images && command.images.length)) throw new Error("empty message");
        const queued = this.isRunning();
        // 图片附件：{ type: "image", data: base64, mimeType }
        const images = Array.isArray(command.images) ? command.images : undefined;
        try {
          if (this.session.isStreaming) {
            if (images && images.length) await this.session.followUp(text, images);
            else await this.session.followUp(text);
          } else {
            if (images && images.length) await this.session.prompt(text, { images });
            else await this.session.prompt(text);
          }
        } catch (err) {
          this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        return { ok: true, queued };
      }
      case "follow_up": {
        const text = String(command.text ?? "").trim();
        if (!text) throw new Error("empty message");
        await this.session.followUp(text);
        return { ok: true };
      }
      case "steer": {
        const text = String(command.text ?? "").trim();
        if (!text) throw new Error("empty message");
        await this.session.steer(text);
        return { ok: true };
      }
      case "abort": {
        await this.session.abort();
        return { ok: true };
      }
      case "set_model": {
        const provider = command.provider || "deepseek";
        const m = command.model;
        const target = this.services.modelRuntime.getModel(provider, m);
        if (!target) throw new Error("unknown model: " + provider + "/" + m);
        await this.session.setModel(target);
        return { ok: true, provider: target.provider, model: target.id };
      }
      case "set_thinking": {
        const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        if (!allowed.includes(command.level)) throw new Error("invalid thinking level: " + command.level);
        this.session.setThinkingLevel(command.level);
        return { ok: true, thinkingLevel: command.level };
      }
      case "get_state":
        return this.getState();
      case "get_context":
        return this.getContext();
      default:
        throw new Error("unknown command: " + command.type);
    }
  }
  getState() {
    const model = this.session.model;
    const cu = safeCall(() => this.session.getContextUsage());
    return {
      type: "state",
      sessionId: this.id,
      model: model ? `${model.provider}/${model.id}` : "unknown",
      thinkingLevel: this.session.thinkingLevel,
      streaming: this.isRunning(),
      sessionFile: this.sessionFile || null,
      cwd: this.cwd,
      tools: safeCall(() => this.session.getActiveToolNames().length) ?? 0,
      contextUsage: cu
        ? {
            percent: cu.percent ?? null,
            contextWindow: cu.contextWindow ?? null,
            tokens: cu.tokens ?? null,
          }
        : null,
    };
  }
  getContext() {
    const ctx = this.sm.buildSessionContext();
    const messages = (ctx.messages || [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        return { role: m.role, text: msgText(m) };
      })
      .filter((m) => m.role === "user" || m.text.trim().length > 0);
    const model = this.session.model;
    const cu = safeCall(() => this.session.getContextUsage());
    return {
      type: "context",
      sessionId: this.id,
      messages,
      model: model ? `${model.provider}/${model.id}` : "unknown",
      thinkingLevel: this.session.thinkingLevel,
      contextUsage: cu
        ? {
            percent: cu.percent ?? null,
            contextWindow: cu.contextWindow ?? null,
            tokens: cu.tokens ?? null,
          }
        : null,
    };
  }
  dispose() {
    if (!this._alive) return;
    this._alive = false;
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        /* ignore */
      }
    }
    try {
      this.session.dispose();
    } catch {
      /* ignore */
    }
    if (registry.get(this.id) === this) registry.delete(this.id);
    if (lastActiveSessionId === this.id) lastActiveSessionId = null;
  }
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * - key: 注册表/锁的键（真实 sessionId，或 "__new__<uuid>" 临时键）
 * - sessionFile: 已有会话文件路径（恢复场景）；为空则新建
 * - cwd: 新建会话的工作目录
 * 返回 { session, realSessionId }
 */
async function startRpcSession(key, sessionFile, cwd, options = {}) {
  const existing = registry.get(key);
  if (existing?.isAlive()) return { session: existing, realSessionId: key };

  if (locks.has(key)) return locks.get(key);

  const p = (async () => {
    const services = await createAgentSessionServices({
      cwd: cwd || DEFAULT_CWD,
      agentDir: AGENT_DIR,
      resourceLoaderOptions: { systemPromptOverride: () => SYSTEM_PROMPT },
    });
    let sm;
    if (sessionFile) {
      sm = SessionManager.open(sessionFile);
    } else {
      sm = SessionManager.create(cwd || DEFAULT_CWD);
    }
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: sm,
      tools: TOOLS,
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
    const rs = new RpcSession({ session: created.session, services, sm });
    registry.set(rs.id, rs);
    trimRegistry();
    rs.start();
    return { session: rs, realSessionId: rs.id };
  })();
  locks.set(key, p);
  try {
    return await p;
  } finally {
    locks.delete(key);
  }
}

/** 注册表容量控制：淘汰最久未使用且不在运行的会话 */
function trimRegistry() {
  if (registry.size <= MAX_SESSIONS) return;
  const entries = [...registry.values()]
    .filter((rs) => !rs.isRunning())
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (registry.size > MAX_SESSIONS && entries.length) {
    const rs = entries.shift();
    if (rs) rs.dispose();
  }
}

// ---------- 会话列表缓存（agent_end 时失效，避免频繁读盘） ----------
let sessionsListCache = null; // { cwd, data }
let sessionsListExpires = 0;
function invalidateSessionListCache() {
  sessionsListCache = null;
}
async function listSessions(cwd) {
  const now = Date.now();
  const base = cwd || DEFAULT_CWD;
  if (sessionsListCache && sessionsListCache.cwd === base && sessionsListExpires > now) {
    return sessionsListCache.data;
  }
  let infos = [];
  try {
    infos = await SessionManager.list(base);
  } catch {
    infos = [];
  }
  infos.sort((a, b) => b.modified - a.modified);
  const data = infos.map((i) => ({
    path: i.path,
    id: i.id,
    cwd: i.cwd,
    title:
      i.name ||
      (i.firstMessage || "").replace(/\s+/g, " ").trim().slice(0, 40) ||
      "空对话",
    count: i.messageCount,
    modified: i.modified.getTime(),
  }));
  sessionsListCache = { cwd: base, data };
  sessionsListExpires = now + 3000;
  return data;
}

/** 按 sessionId 找到对应的会话文件路径（恢复场景用） */
async function resolveSessionPath(id) {
  try {
    const list = await listSessions();
    const hit = list.find((c) => c.id === id);
    return hit ? hit.path : null;
  } catch {
    return null;
  }
}

// 启动时续接最近一次会话（这样服务器一启动就有可用的活跃会话）
let lastActiveSession = null;
async function initRecentSession() {
  try {
    const sm = SessionManager.continueRecent(DEFAULT_CWD);
    const file = sm.sessionFile;
    if (file) {
      const { session } = await startRpcSession(file, file, undefined);
      lastActiveSession = session;
      lastActiveSessionId = session.id;
    } else {
      const { session } = await startRpcSession(`__new__${randomUUID()}`, "", DEFAULT_CWD);
      lastActiveSession = session;
      lastActiveSessionId = session.id;
    }
  } catch (err) {
    console.error("initRecentSession failed:", err);
  }
}

/** 获取一个活跃会话（旧 API 兼容）：优先 lastActiveSessionId */
function activeSession() {
  if (lastActiveSessionId && registry.has(lastActiveSessionId)) {
    return registry.get(lastActiveSessionId);
  }
  const first = [...registry.values()].find((rs) => rs.isAlive());
  if (first) {
    lastActiveSessionId = first.id;
    return first;
  }
  return null;
}

// ============================================================================
// HTTP 服务
// ============================================================================
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const readBody = async () => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  };
  const p = url.pathname;
  const mEvents = p.match(/^\/api\/agent\/([^/]+)\/events$/);
  const mAgent = p.match(/^\/api\/agent\/([^/]+)$/);
  let mProj = null;
  let mConf = null;

  try {
    // ---- 页面版本号（热更新兑底：休眠标签页重连后自动刷新）----
    if (p === "/api/page-version" && req.method === "GET") {
      return json(200, { ok: true, version: pageVersion() });
    }
    // ---- 优雅重启（防自杀：AI 重启服务必须走这里，禁止 taskkill 强杀自身进程）----
    if (p === "/api/restart" && req.method === "POST") {
      // 先广播 reload，让所有已打开页面自动刷新（他们会在新进程起来后重连）
      const reloadPayload = `data: ${JSON.stringify({ type: "reload" })}\n\n`;
      for (const conn of sseConnections) {
        try {
          conn.write(reloadPayload);
        } catch {
          /* ignore */
        }
      }
      json(200, { ok: true, message: "服务将优雅重启" });
      // 延迟执行重启：确保上面的响应已发出，再释放会话并拉起新进程
      setTimeout(() => {
        try {
          for (const rs of registry.values()) rs.dispose();
          const args = process.argv.slice(1); // 保留原启动参数（含端口）
          const child = spawn(process.execPath, args, {
            detached: true,
            stdio: "ignore",
            cwd: HERE,
          });
          child.unref();
          console.log("\n  ♻  优雅重启：已拉起新进程，旧进程退出\n");
        } catch (err) {
          console.error("[pi-web] restart failed:", err);
        }
        process.exit(0);
      }, 300);
      return;
    }
    // ---- 新建会话（新架构入口，必须在 mAgent 之前匹配）----
    // body: { cwd?, message?, type?, thinkingLevel? }
    if (p === "/api/agent/new" && req.method === "POST") {
      const body = await readBody();
      const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : DEFAULT_CWD;
      if (!existsSync(cwd)) return json(400, { error: `Directory does not exist: ${cwd}` });
      // 每次请求用唯一临时键，避免并发创建互相合并
      const tempKey = `__new__${randomUUID()}`;
      const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
        ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel } : {}),
      });
      lastActiveSession = session;
      lastActiveSessionId = realSessionId;
      const state = session.getState();
      if (body.type === "ensure_session") {
        return json(200, { ok: true, sessionId: realSessionId, ...state });
      }
      if (typeof body.message === "string" && body.message.trim()) {
        await session.send({ type: "prompt", text: body.message });
      }
      return json(200, { ok: true, sessionId: realSessionId, ...session.getState() });
    }

    // ---- 按会话 SSE 事件流 ----
    if (mEvents && req.method === "GET") {
      const id = decodeURIComponent(mEvents[1]);
      let rs = registry.get(id);
      if (!rs || !rs.isAlive()) {
        const filePath = await resolveSessionPath(id);
        if (!filePath) return json(404, { error: "Session not found" });
        try {
          const { session } = await startRpcSession(id, filePath, undefined);
          rs = session;
        } catch (err) {
          return json(500, { error: `Failed to start agent: ${err}` });
        }
      }
      rs.touch();
      lastActiveSessionId = id;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ type: "connected", sessionId: id, pageVersion: pageVersion() });
      sseConnections.add(res);
      const unsubscribe = rs.onEvent(send);
      const hb = setInterval(() => {
        try {
          res.write(":\n\n"); // 30 秒心跳，防代理/服务器空闲超时
        } catch {
          /* closed */
        }
      }, 30000);
      req.on("close", () => {
        clearInterval(hb);
        unsubscribe();
        sseConnections.delete(res);
      });
      return;
    }

    // ---- 按会话命令 ----
    if (mAgent && req.method === "POST") {
      const id = decodeURIComponent(mAgent[1]);
      let rs = registry.get(id);
      if (!rs || !rs.isAlive()) {
        const filePath = await resolveSessionPath(id);
        if (!filePath) return json(404, { error: "Session not found" });
        const { session } = await startRpcSession(id, filePath, undefined);
        rs = session;
      }
      rs.touch();
      lastActiveSessionId = id;
      const command = await readBody();
      const result = await rs.send(command);
      return json(200, { ok: true, ...result });
    }


    if (p === "/api/conversations") {
      const cwdParam = url.searchParams.get("cwd");
      let cwd = DEFAULT_CWD;
      if (cwdParam) {
        const resolved = resolve(cwdParam);
        if (existsSync(resolved)) cwd = resolved;
      }
      return json(200, { ok: true, conversations: await listSessions(cwd) });
    }

    // ---- 简化配置：写入 API key（auth.json） ----
    if (p === "/api/apikey" && req.method === "POST") {
      const body = await readBody();
      try {
        const providerId = writeApiKey(body.provider, body.key);
        return json(200, { ok: true, provider: providerId, note: "重启服务后生效" });
      } catch (err) {
        return json(400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ---- 可用模型列表（只返回用户在 models.json 中实际配置的渠道） ----
    if (p === "/api/models" && req.method === "GET") {
      try {
        const modelsPath = join(AGENT_DIR, "models.json");
        const raw = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : {};
        const providers = [];
        for (const [pid, pconf] of Object.entries(raw.providers || {})) {
          const models = (pconf.models || []).map((m) => ({ id: m.id, name: m.name || m.id }));
          if (!models.length) continue;
          providers.push({ id: pid, models });
        }
        return json(200, { ok: true, providers });
      } catch (err) {
        return json(500, { error: `list models failed: ${err.message}` });
      }
    }

    // ---- 盘符列表（Windows 实际存在的盘，供项目浏览用） ----
    if (p === "/api/drives" && req.method === "GET") {
      const drives = [];
      try {
        for (const c of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
          if (existsSync(c + ":/")) drives.push(c + ":/");
        }
      } catch {
        /* ignore */
      }
      return json(200, { ok: true, drives });
    }

    // ---- 目录浏览（添加项目用，只读） ----
    if (p === "/api/browse" && req.method === "GET") {
      const dir = url.searchParams.get("path") || homedir();
      let resolved;
      try {
        resolved = resolve(dir);
      } catch {
        return json(400, { error: "invalid path" });
      }
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        return json(400, { error: `not a directory: ${resolved}` });
      }
      let entries = [];
      try {
        entries = readdirSync(resolved, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
          .sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
          );
      } catch {
        return json(500, { error: `read directory failed: ${resolved}` });
      }
      return json(200, { ok: true, path: resolved, parent: dirname(resolved), entries });
    }

    // ---- 项目工作区（P0 #4）----
    if (p === "/api/projects/quick-paths" && req.method === "GET") {
      const h = homedir();
      const cands = [
        { label: "家目录", path: h },
        { label: "桌面", path: join(h, "Desktop") },
        { label: "文档", path: join(h, "Documents") },
        { label: "桌面 (OneDrive)", path: join(h, "OneDrive", "Desktop") },
        { label: "文档 (OneDrive)", path: join(h, "OneDrive", "Documents") },
        { label: "pi-web", path: HERE },
      ];
      return json(200, {
        ok: true,
        paths: cands.map((c) => ({ ...c, exists: existsSync(c.path) && statSync(c.path).isDirectory() })),
      });
    }

    if (p === "/api/projects" && req.method === "GET") {
      const projects = loadProjects();
      // 附上每个项目的会话数与最近活跃时间
      const enriched = [];
      for (const pr of projects) {
        let count = 0;
        let last = pr.createdAt || 0;
        try {
          const sessions = await SessionManager.list(pr.path);
          count = sessions.length;
          if (sessions.length) last = Math.max(...sessions.map((s) => s.modified.getTime()));
        } catch {
          /* ignore */
        }
        enriched.push({ ...pr, sessionCount: count, lastActive: last, exists: existsSync(pr.path) });
      }
      return json(200, { ok: true, projects: enriched });
    }

    if (p === "/api/projects" && req.method === "POST") {
      const body = await readBody();
      const raw = String(body.path || "").trim();
      if (!raw) return json(400, { error: "missing path" });
      const resolved = resolve(raw);
      if (!existsSync(resolved)) return json(400, { error: `Path does not exist: ${resolved}` });
      // 项目可以是目录，也可以是单个文件（默认项目即文件）
      if (!statSync(resolved).isDirectory() && !statSync(resolved).isFile()) {
        return json(400, { error: `Not a file or directory: ${resolved}` });
      }
      const projects = loadProjects();
      if (projects.some((pr) => pr.path.toLowerCase() === resolved.toLowerCase())) {
        return json(409, { error: "Project already added" });
      }
      const pr = {
        id: randomUUID(),
        name: body.name || basename(resolved) || resolved,
        path: resolved,
        isFile: !statSync(resolved).isDirectory(),
        createdAt: Date.now(),
      };
      projects.unshift(pr);
      saveProjects(projects);
      return json(200, { ok: true, project: pr });
    }

    if (p === "/api/projects" && req.method === "DELETE") {
      const body = await readBody();
      const projects = loadProjects();
      const next = projects.filter((pr) => pr.id !== body.id);
      if (next.length === projects.length) return json(404, { error: "Project not found" });
      saveProjects(next);
      return json(200, { ok: true });
    }

    // ---- 更新项目配置（预留，当前无使用） ----
    if ((mProj = p.match(/^\/api\/projects\/([^/]+)\/sessions$/)) && req.method === "GET") {
      const id = decodeURIComponent(mProj[1]);
      const projects = loadProjects();
      const pr = projects.find((x) => x.id === id);
      if (!pr) return json(404, { error: "Project not found" });
      const conversations = await listSessions(pr.path);
      return json(200, { ok: true, project: pr, conversations });
    }

    // ---- 配置可视化（P0 #7）----
    if (p === "/api/config" && req.method === "GET") {
      return json(200, { ok: true, agentDir: AGENT_DIR, files: configIndex() });
    }
    if ((mConf = p.match(/^\/api\/config\/([^/]+)$/))) {
      const name = decodeURIComponent(mConf[1]);
      const fp = configPath(name);
      if (!fp) return json(404, { error: "unknown config: " + name });
      if (req.method === "GET") {
        try {
          const content = existsSync(fp) ? readFileSync(fp, "utf8") : "";
          return json(200, { ok: true, name, content });
        } catch (err) {
          return json(500, { error: `read failed: ${err.message}` });
        }
      }
      if (req.method === "POST") {
        const body = await readBody();
        try {
          writeConfigFile(name, body.content);
          return json(200, { ok: true, name });
        } catch (err) {
          return json(400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return json(405, { error: "method not allowed" });
    }

    // ---- 删除会话 ----
    if (p === "/api/conversations/delete" && req.method === "POST") {
      const { path } = await readBody();
      if (!path) return json(400, { error: "missing path" });
      const resolved = resolve(path);
      // 安全校验：只允许删除 ~/.pi/agent/sessions/ 下的会话文件（任意项目）
      const sessionsRoot = resolve(join(AGENT_DIR, "sessions")) + sep;
      const isJsonl = resolved.endsWith(".jsonl");
      if (!resolved.startsWith(sessionsRoot) || !isJsonl) {
        return json(400, { error: "invalid path" });
      }
      await unlink(resolved);
      // 若被删会话在注册表里，释放
      for (const rs of registry.values()) {
        if (rs.sessionFile === resolved) {
          rs.dispose();
          break;
        }
      }
      invalidateSessionListCache();
      return json(200, { ok: true });
    }

    // ---- 余额 ----
    if (p === "/api/balance") {
      const b = await fetchBalance();
      return json(200, { ok: true, balance: b, hasKey: !!DEEPSEEK_API_KEY });
    }

    // ---- 会话统计（usage）----
    if (p === "/api/usage") {
      const sid = url.searchParams.get("session") || lastActiveSessionId;
      const rs = sid ? registry.get(sid) : activeSession();
      if (!rs) return json(200, { ok: true, totalTokens: 0, cost: 0, percent: null });
      const stats = safeCall(() => rs.session.getSessionStats()) || {};
      const cu = safeCall(() => rs.session.getContextUsage());
      return json(200, {
        ok: true,
        totalTokens: stats.tokens?.total ?? 0,
        inputTokens: stats.tokens?.input ?? 0,
        outputTokens: stats.tokens?.output ?? 0,
        cacheRead: stats.tokens?.cacheRead ?? 0,
        cacheWrite: stats.tokens?.cacheWrite ?? 0,
        cost: stats.cost ?? 0,
        contextTokens: cu?.tokens ?? null,
        contextWindow: cu?.contextWindow ?? null,
        percent: cu?.percent ?? null,
        messages: stats.totalMessages ?? 0,
      });
    }

    // ---- 旧 API 兼容（操作最近活跃会话）----
    if (p === "/api/message" && req.method === "POST") {
      const { text } = await readBody();
      if (!text || !text.trim()) return json(400, { error: "empty message" });
      const rs = activeSession();
      if (!rs) return json(409, { error: "no active session" });
      const r = await rs.send({ type: "prompt", text });
      return json(200, { ok: true, ...r });
    }
    if (p === "/api/abort" && req.method === "POST") {
      const rs = activeSession();
      if (rs) await rs.send({ type: "abort" });
      return json(200, { ok: true });
    }
    // ---- 技能列表（~/.pi/agent/skills/） ----
    if (p === "/api/skills" && req.method === "GET") {
      // 技能来源：① 项目内置 .pi/skills/（随仓库发布）② 用户已安装 ~/.pi/agent/skills/
      const dirs = [join(HERE, ".pi", "skills"), join(AGENT_DIR, "skills")];
      const items = [];
      const seen = new Set();
      for (const dir of dirs) {
        try {
          for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (!statSync(full).isDirectory()) continue;
            const disabled = name.endsWith(".off");
            const realName = disabled ? name.slice(0, -4) : name;
            if (seen.has(realName)) continue; // 项目内置优先，用户目录同名不重复
            seen.add(realName);
            // 技能名：取 SKILL.md frontmatter 的 name，否则用目录名
            let skillName = realName, desc = "";
            try {
              const md = readFileSync(join(full, "SKILL.md"), "utf8").slice(0, 4000);
              const nm = md.match(/^name:\s*(.+)$/m);
              const ds = md.match(/^description:\s*(.+)$/m);
              if (nm) skillName = nm[1].trim();
              if (ds) desc = ds[1].trim().replace(/^["']|["']$/g, "");
            } catch {}
            items.push({
              id: realName, name: skillName, description: desc,
              enabled: !disabled, path: full, source: dir.includes(".pi") ? "builtin" : "user",
            });
          }
        } catch {}
      }
      items.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
      return json(200, { ok: true, skills: items });
    }

    // ---- 技能详情（SKILL.md 内容） ----
    if (p === "/api/skills/detail" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      if (!id) return json(400, { error: "missing id" });
      // 项目内置优先，用户已安装其次
      const dirs = [join(HERE, ".pi", "skills"), join(AGENT_DIR, "skills")];
      for (const dir of dirs) {
        const candidates = [join(dir, id), join(dir, id + ".off")];
        for (const full of candidates) {
          if (existsSync(full) && statSync(full).isDirectory()) {
            try {
              return json(200, { ok: true, content: readFileSync(join(full, "SKILL.md"), "utf8") });
            } catch {
              return json(200, { ok: true, content: "（无 SKILL.md）" });
            }
          }
        }
      }
      return json(404, { error: "skill not found" });
    }

    // ---- 技能启停（重命名目录加 .off 后缀） ----
    if (p === "/api/skills/toggle" && req.method === "POST") {
      const { id, enable } = await readBody();
      if (!id) return json(400, { error: "missing id" });
      const dir = join(AGENT_DIR, "skills");
      const on = join(dir, id);
      const off = join(dir, id + ".off");
      const src = enable ? off : on;
      const dst = enable ? on : off;
      if (!existsSync(src)) return json(400, { error: "skill not found" });
      if (existsSync(dst)) return json(400, { error: "target exists" });
      renameSync(src, dst);
      return json(200, { ok: true, id, enabled: enable });
    }

    // ---- 技能搜索（ai-agent-skills 本地库 + GitHub） ----
    if (p === "/api/skills/search" && req.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json(200, { ok: true, results: [] });
      if (!SKILLS_CLI_AVAILABLE) return json(200, { ok: true, results: [] });
      try {
        const out = execFileSync("node", [SKILLS_CLI, "search", q, "--format", "json"], {
          encoding: "utf8", timeout: 20000, windowsHide: true,
        });
        const results = out.split(/\r?\n/).filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((d) => d && d.data && d.data.kind === "item" && d.data.skill)
          .map((d) => {
            const s = d.data.skill;
            return {
              name: s.name, description: (s.description || "").slice(0, 160),
              tier: s.tier || "", workArea: s.workArea || "",
            };
          });
        return json(200, { ok: true, results });
      } catch (err) {
        return json(200, { ok: true, results: [], error: String(err.message || err).slice(0, 200) });
      }
    }

    // ---- 可安装技能源 ----
    if (p === "/api/skills/repos" && req.method === "GET") {
      return json(200, { ok: true, repos: [
        { id: "pdf", name: "pdf" },
        { id: "docx", name: "docx" },
        { id: "pptx", name: "pptx" },
        { id: "xlsx", name: "xlsx" },
        { id: "frontend-design", name: "frontend-design" },
        { id: "brand-guidelines", name: "brand-guidelines" },
        { id: "canvas-design", name: "canvas-design" },
        { id: "algorithmic-art", name: "algorithmic-art" },
        { id: "claude-api", name: "claude-api" },
        { id: "anthropics/skills", name: "anthropics/skills（Anthropic 官方，17 个）" },
        { id: "badlogic/pi-skills", name: "pi-skills（pi 官方，搜索/浏览器等）" },
      ] });
    }

    // ---- 安装技能（带 GitHub 镜像加速，国内可用） ----
    if (p === "/api/skills/install" && req.method === "POST") {
      const { source } = await readBody();
      if (!source) return json(400, { error: "missing source" });
      if (!SKILLS_CLI_AVAILABLE) return json(400, { error: "技能 CLI 未安装（可设置 PI_SKILLS_CLI 指向 ai-agent-skills 的 cli.js）" });
      const cli = SKILLS_CLI;
      // 提取要安装的技能名（支持 anthropics/skills 或单技能名）
      const want = source.split("/").pop().trim();
      // GitHub 加速镜像列表（国内可用，按优先级尝试；直连 GitHub 兜底）
      const MIRRORS = [
        "https://ghproxy.net/https://github.com/",
        "https://gh-proxy.com/https://github.com/",
        "https://github.com/",
      ];
      // 用首次可用的镜像生成 git 配置（临时注入，仅本次进程生效，不污染全局）
      let mirrorEnv = null;
      for (const m of MIRRORS) {
        try {
          execFileSync("git", ["ls-remote", m + "anthropics/skills.git", "HEAD"], {
            encoding: "utf8", timeout: 15000, windowsHide: true, stdio: "ignore",
          });
          mirrorEnv = {
            ...process.env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "url." + m + ".insteadOf",
            GIT_CONFIG_VALUE_0: "https://github.com/",
          };
          break;
        } catch {
          /* 该镜像不可用，换下一个 */
        }
      }
      if (!mirrorEnv) mirrorEnv = process.env; // 全部失败则直连
      try {
        // 1) 安装到 ai-agent-skills 的全局目录（~/.claude/skills），走镜像加速
        execFileSync("node", [cli, "install", source, "--yes", "--format", "json"], {
          encoding: "utf8", timeout: 300000, windowsHide: true, env: mirrorEnv,
        });
        // 2) 同步到 pi 技能目录
        const srcDir = join(homedir(), ".claude", "skills", want);
        const dstDir = join(AGENT_DIR, "skills", want);
        if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
          copyDirRecursive(srcDir, dstDir);
          return json(200, { ok: true, installed: want });
        }
        // 按目录名找不到时，扫描安装日志确定实际目录名
        const skillsDir = join(homedir(), ".claude", "skills");
        const candidates = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
        const found = candidates.find((c) => c.toLowerCase() === want.toLowerCase());
        if (found) {
          copyDirRecursive(join(skillsDir, found), join(AGENT_DIR, "skills", found));
          return json(200, { ok: true, installed: found });
        }
        return json(200, { ok: false, error: "安装完成但未找到技能目录: " + want });
      } catch (err) {
        return json(200, { ok: false, error: String(err.stderr || err.message || err).slice(0, 300) });
      }
    }

    if (p === "/api/status") {
      const rs = activeSession();
      if (!rs) return json(200, { ok: true, model: "unknown", streaming: false, sessionId: null });
      return json(200, { ok: true, ...rs.getState() });
    }
    if (p === "/api/model" && req.method === "POST") {
      const { model } = await readBody();
      const rs = activeSession();
      if (!rs) return json(409, { error: "no active session" });
      const r = await rs.send({ type: "set_model", model });
      return json(200, { ok: true, ...r });
    }
    if (p === "/api/conversations/new" && req.method === "POST") {
      const { session: rs, realSessionId } = await startRpcSession(
        `__new__${randomUUID()}`,
        "",
        DEFAULT_CWD
      );
      lastActiveSession = rs;
      lastActiveSessionId = realSessionId;
      return json(200, { ok: true, sessionId: realSessionId });
    }
    if (p === "/api/conversations/load" && req.method === "POST") {
      const { path } = await readBody();
      if (!path) return json(400, { error: "missing path" });
      const { session: rs, realSessionId } = await startRpcSession(path, path, undefined);
      lastActiveSession = rs;
      lastActiveSessionId = realSessionId;
      const ctx = rs.getContext();
      return json(200, { ok: true, sessionId: realSessionId, ...ctx });
    }

    // ---- 旧 SSE（全量广播活跃会话事件，兼容旧页面）----
    if (p === "/api/events") {
      const rs = activeSession();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", sessionId: rs?.id ?? null })}\n\n`);
      sseConnections.add(res);
      if (rs) {
        const unsub = rs.onEvent((evt) => {
          try {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
          } catch {
            /* ignore */
          }
        });
        const hb = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            /* ignore */
          }
        }, 20000);
        req.on("close", () => {
          clearInterval(hb);
          unsub();
          sseConnections.delete(res);
        });
      } else {
        req.on("close", () => sseConnections.delete(res));
      }
      return;
    }

    // ---- 页面 ----
    if (p === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
      });
      res.end(getPageHtml());
      return;
    }
    if (p === "/favicon.ico") {
      try {
        res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "no-cache" });
        res.end(readFileSync(join(HERE, "favicon.ico")));
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error("[pi-web] request error:", err);
    json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// 启动：先初始化最近会话，再监听端口
await initRecentSession();
server.listen(PORT, "127.0.0.1", () => {
  const rs = activeSession();
  console.log(`\n  ✦ pi-web 已启动（多会话模式）\n`);
  console.log(`  打开浏览器访问:  http://127.0.0.1:${PORT}`);
  if (rs) {
    console.log(`  活跃会话: ${rs.id}  (模型: ${rs.session.model ? `${rs.session.model.provider}/${rs.session.model.id}` : "?"})`);
  }
  console.log(`  按 Ctrl+C 退出\n`);
});

process.on("SIGINT", () => {
  for (const rs of registry.values()) rs.dispose();
  process.exit(0);
});
