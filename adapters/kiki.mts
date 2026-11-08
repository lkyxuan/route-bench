// Kiki 现在的路由（kiki-pro 的 src/route.ts：拼提示词 + 解析）接进测试基准。
// 也是 exec 接法：stdin 一行一个请求，stdout 一行一个回答。
//
// 在 Mac 上（kiki-pro 装过依赖，有 tsx）：
//   cd ~/kiki-pro
//   ROUTE_API_KEY=sk-... node ~/route-bench/bench.mjs --router "exec:npx tsx ~/route-bench/adapters/kiki.mts"
//
// 环境变量：
//   KIKI_DIR        kiki-pro 代码目录，默认当前目录
//   KIKI_RULES      分派规则文件，默认 ~/kiki-data/分派规则.md，没有就用 KIKI_DIR/data-template/分派规则.md
//   ROUTE_API_BASE  OpenAI 兼容接口，默认 https://api.deepseek.com/v1
//   ROUTE_API_KEY   密钥（必填）
//   ROUTE_MODEL     模型名，默认 deepseek-chat
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const kiki = resolve(process.env.KIKI_DIR ?? process.cwd());
const route = await import(pathToFileURL(join(kiki, "src", "route.ts")).href);
const MAIN = "主对话";
const rulesFile = [process.env.KIKI_RULES, join(homedir(), "kiki-data", "分派规则.md"), join(kiki, "data-template", "分派规则.md")].find((f) => f && existsSync(f));
const rules = rulesFile ? readFileSync(rulesFile, "utf8") : "";
const base = (process.env.ROUTE_API_BASE ?? "https://api.deepseek.com/v1").replace(/\/$/, "");
const model = process.env.ROUTE_MODEL ?? "deepseek-chat";
const key = process.env.ROUTE_API_KEY;
if (!key) throw new Error("要设 ROUTE_API_KEY");

async function complete(system: string, user: string) {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`模型接口 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return { text: j.choices?.[0]?.message?.content ?? "", usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 } };
}

/** "宝/对话" → {bao, thread}（主对话算 null） */
const split = (label: string) => {
  const [bao, name] = label.split("/");
  return { bao, thread: name === MAIN ? null : name };
};

async function handle(q: any) {
  const candidates = q.baos.map((b: any) => ({
    agent: b.name,
    desc: b.desc,
    group: b.group,
    sessions: [{ label: `${b.name}/${MAIN}`, recent: [] }, ...b.threads.map((t: any) => ({ label: `${b.name}/${t.name}`, summary: t.summary, recent: [] }))],
  }));
  const agents = q.baos.map((b: any) => b.name);
  const targets = candidates.flatMap((c: any) => c.sessions.map((s: any) => s.label));
  const current = q.current ? `${q.current.bao}/${q.current.thread ?? MAIN}` : undefined;
  const { text, usage } = await complete(
    route.buildRouteSystem(rules),
    route.buildRouteInput({ text: q.text, candidates, current, now: new Date().toLocaleString("zh-CN") }),
  );
  const d = route.parseDecision(text, { agents, targets, allowNewBao: true, allowReply: true, tasks: [] });
  if (!d) return { type: "route", ...(q.current ?? { bao: "生活宝", thread: null }), layer: "兜底（模型输出看不懂）", usage, raw: text.slice(0, 300) };
  if (d.action === "reply") return { type: "reply", layer: "模型", usage };
  if (d.action === "continue") return { type: "route", ...split(d.target), layer: "模型", usage };
  if (d.action === "new") return agents.includes(d.agent) ? { type: "route", bao: d.agent, thread: null, layer: "模型", usage } : { type: "new", about: d.newBao, layer: "模型", usage };
  if (d.action === "split")
    return {
      type: "split",
      targets: d.parts.map((p: any) => (p.action === "continue" ? split(p.target) : { bao: p.agent, thread: null })),
      layer: "模型",
      usage,
    };
  return { type: "route", bao: "?", thread: null, layer: `模型给了 ${d.action}`, usage };
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const q = JSON.parse(line);
  handle(q)
    .then((r) => process.stdout.write(JSON.stringify({ id: q.id, ...r }) + "\n"))
    .catch((e) => process.stdout.write(JSON.stringify({ id: q.id, error: (e as Error).message }) + "\n"));
}
