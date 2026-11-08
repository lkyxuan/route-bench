#!/usr/bin/env node
// 路由测试基准：拿 data/cases.jsonl 的 1000 句话去问一个路由，看它分得对不对，出报告。
//
//   node bench.mjs --router keyword                      # 自带的关键词基线
//   node bench.mjs --router "exec:python3 adapters/vector.py"   # 任意命令：一行一个 JSON 进，一行一个 JSON 出
//   node bench.mjs --router http://127.0.0.1:8080/route  # 任意网址：POST 一个 JSON，回一个 JSON
//   选项：--limit 100（只跑前 N 组）  --only single,episode（只跑这几类）  --concurrency 4  --out reports
//
// 接口说明见 README.md「怎么接你的路由」。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keywordRouter } from "./adapters/keyword.mjs";

const root = import.meta.dirname;
const args = parseArgs(process.argv.slice(2));
const routerSpec = args.router ?? "keyword";
const baos = JSON.parse(readFileSync(join(root, "data", "baos.json"), "utf8"));
let cases = readFileSync(join(root, "data", "cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
if (args.only) cases = cases.filter((c) => args.only.split(",").includes(c.kind));
if (args.limit) cases = cases.slice(0, Number(args.limit));
const concurrency = Number(args.concurrency ?? 4);

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1]?.startsWith("--") || a[i + 1] === undefined ? "1" : a[++i];
  return o;
}

// ---------- 接路由 ----------

/** 返回 route(req) => Promise<res>，和 close() */
async function makeRouter(spec) {
  if (spec === "keyword") {
    const r = keywordRouter(baos);
    return { route: async (q) => r(q), close() {} };
  }
  if (/^https?:\/\//.test(spec)) {
    return {
      async route(q) {
        const r = await fetch(spec, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      },
      close() {},
    };
  }
  if (spec.startsWith("exec:")) return execRouter(spec.slice(5));
  throw new Error(`不认识的路由：${spec}（keyword / exec:命令 / http(s)://网址）`);
}

/** 起一个子进程，一直开着；每个请求带 id 写一行，按 id 收回答 */
function execRouter(cmd) {
  const child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "inherit"], cwd: process.cwd() });
  const waiting = new Map();
  let seq = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return process.stderr.write(`[路由输出不是 JSON，跳过] ${line}\n`);
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.error ? w.reject(new Error(m.error)) : w.resolve(m);
  });
  let dead = null;
  child.on("exit", (code) => {
    dead = `路由进程退出了（${code}）`;
    for (const w of waiting.values()) w.reject(new Error(dead));
    waiting.clear();
  });
  return {
    route(q) {
      if (dead) return Promise.reject(new Error(dead));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, ...q }) + "\n");
      });
    },
    close() {
      child.stdin.end();
    },
  };
}

// ---------- 打分 ----------

const isMain = (t) => t == null || t === "" || t === "主对话";
const labelOf = (e) => (e.type === "route" ? (e.thread ? `${e.bao}/${e.thread}` : e.bao) : e.type === "split" ? `拆:${e.targets.map(labelOf2).join("+")}` : e.type === "new" ? "新建宝" : e.type === "reply" ? "直接答" : "?");
const labelOf2 = (t) => (t.thread ? `${t.bao}/${t.thread}` : t.bao);

/** 一句话的得分：bao 去处对没对（主指标），thread 讨论串也对没对（更严） */
function score(exp, got) {
  const g = got ?? {};
  if (exp.type === "reply") return { bao: g.type === "reply", thread: g.type === "reply" };
  if (exp.type === "new") return { bao: g.type === "new", thread: g.type === "new" };
  if (exp.type === "split") {
    if (g.type !== "split" || !Array.isArray(g.targets)) return { bao: false, thread: false };
    const want = new Set(exp.targets.map((t) => t.bao));
    const have = new Set(g.targets.map((t) => t.bao));
    const bao = want.size === have.size && [...want].every((b) => have.has(b));
    const wantT = new Set(exp.targets.map(labelOf2));
    const haveT = new Set(g.targets.map((t) => (isMain(t.thread) ? t.bao : `${t.bao}/${t.thread}`)));
    return { bao, thread: bao && wantT.size === haveT.size && [...wantT].every((x) => haveT.has(x)) };
  }
  const bao = g.type === "route" && g.bao === exp.bao;
  const thread = bao && (exp.thread ? g.thread === exp.thread : isMain(g.thread));
  return { bao, thread };
}

/** 报告里的分类：连续对话再细分成第一句和后续句 */
const bucketOf = (c, turn, i) => (c.kind !== "episode" ? c.kind : i === 0 ? "episode-first" : turn.followUp ? "episode-same" : "episode-switch");
const BUCKET_NAMES = {
  single: "单句新开",
  thread: "接已有讨论串",
  "episode-first": "连续对话·第一句",
  "episode-same": "连续对话·接着上一句",
  "episode-switch": "连续对话·换了去处",
  split: "一句多件事",
  new: "该新建宝",
  reply: "该直接答",
};

// ---------- 跑 ----------

const router = await makeRouter(routerSpec);
const results = [];
let done = 0;
const total = cases.reduce((n, c) => n + c.turns.length, 0);
const started = Date.now();

async function runCase(c) {
  const history = [];
  for (let i = 0; i < c.turns.length; i++) {
    const turn = c.turns[i];
    const prev = c.turns[i - 1]?.expect;
    const q = {
      text: turn.text,
      history, // 前几句和它们的正确去处
      current: prev?.type === "route" ? { bao: prev.bao, thread: prev.thread } : null, // 用户眼下所在（上一句的正确去处）
      baos, // 全部宝和讨论串
    };
    const t0 = performance.now();
    let got, err;
    try {
      got = await router.route(q);
    } catch (e) {
      err = e.message;
    }
    const ms = performance.now() - t0;
    const s = score(turn.expect, got);
    results.push({ id: c.id, turn: i, bucket: bucketOf(c, turn, i), text: turn.text, expect: turn.expect, got: got ?? null, err, ms, usage: got?.usage ?? null, ...s });
    history.push({ text: turn.text, routedTo: turn.expect });
    if (++done % 50 === 0 || done === total) process.stderr.write(`\r${done}/${total}`);
  }
}

const queue = [...cases];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (queue.length) await runCase(queue.shift());
}));
router.close();
process.stderr.write("\n");

// ---------- 报告 ----------

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const quant = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const rows = Object.keys(BUCKET_NAMES).map((b) => {
  const r = results.filter((x) => x.bucket === b);
  return { b, n: r.length, bao: r.filter((x) => x.bao).length, thread: r.filter((x) => x.thread).length };
}).filter((r) => r.n);
const inTok = sum(results.map((r) => r.usage?.input ?? 0));
const outTok = sum(results.map((r) => r.usage?.output ?? 0));
const layers = {};
for (const r of results) if (r.got?.layer) layers[r.got.layer] = (layers[r.got.layer] ?? 0) + 1;
const errors = results.filter((r) => r.err).length;
const wrong = results.filter((r) => !r.bao);

const name = routerSpec.replace(/^exec:/, "").replace(/[^\w一-龥.-]+/g, "_").slice(0, 60);
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const outDir = resolve(root, args.out ?? "reports");
mkdirSync(outDir, { recursive: true });

const md = [
  `# 路由测试：${routerSpec}`,
  "",
  `${stamp} · ${baos.length} 个宝 · ${total} 句 · 用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒${errors ? ` · 出错 ${errors} 句（算错）` : ""}`,
  "",
  `**去对宝：${pct(sum(rows.map((r) => r.bao)), total)}**　连讨论串也对：${pct(sum(rows.map((r) => r.thread)), total)}`,
  "",
  "| 类别 | 句数 | 去对宝 | 连讨论串也对 |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| ${BUCKET_NAMES[r.b]} | ${r.n} | ${pct(r.bao, r.n)} | ${pct(r.thread, r.n)} |`),
  "",
  `每句耗时：平均 ${(sum(results.map((r) => r.ms)) / total).toFixed(0)}ms，中位 ${quant(results.map((r) => r.ms), 0.5).toFixed(0)}ms，最慢 5% ${quant(results.map((r) => r.ms), 0.95).toFixed(0)}ms`,
  inTok || outTok ? `token：输入共 ${inTok}（每句 ${(inTok / total).toFixed(0)}），输出共 ${outTok}（每句 ${(outTok / total).toFixed(0)}）` : "token：路由没报（回答里带 usage 才统计）",
  Object.keys(layers).length ? `哪层拍板：${Object.entries(layers).map(([k, v]) => `${k} ${v} 句（${pct(v, total)}）`).join("，")}` : "",
  "",
  `## 错题（${wrong.length} 句，按类别）`,
  "",
  "| 类别 | 句子 | 应该去 | 实际去 |",
  "| --- | --- | --- | --- |",
  ...wrong.sort((a, b) => a.bucket.localeCompare(b.bucket)).map((r) => `| ${BUCKET_NAMES[r.bucket]} | ${r.text.replace(/\|/g, "/")} | ${labelOf(r.expect)} | ${r.err ? `出错：${r.err}` : r.got ? labelOf(r.got) : "（没回答）"} |`),
  "",
].join("\n");

writeFileSync(join(outDir, `${stamp}-${name}.md`), md);
writeFileSync(join(outDir, `${stamp}-${name}.jsonl`), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(md.split("\n## 错题")[0]);
console.log(`报告：${join(outDir, `${stamp}-${name}.md`)}`);
