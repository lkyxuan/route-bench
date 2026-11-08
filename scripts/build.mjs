// 把 data/ 下手写的 txt 题目编译成 data/cases.jsonl（测试程序只读这个文件）。
// 改了题目就重新跑：node scripts/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "data");
const baos = JSON.parse(readFileSync(join(dir, "baos.json"), "utf8"));
const names = new Set(baos.map((b) => b.name));
const threads = new Set(baos.flatMap((b) => b.threads.map((t) => `${b.name}/${t.name}`)));

const lines = (f) =>
  readFileSync(join(dir, f), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !(l.startsWith("#") && !l.startsWith("## ")));

/** "宝" 或 "宝/讨论串" → {bao, thread}，并检查存在 */
function target(s, where) {
  const [bao, thread] = s.split("/");
  if (!names.has(bao)) throw new Error(`${where}：没有宝「${bao}」`);
  if (thread && !threads.has(s)) throw new Error(`${where}：没有讨论串「${s}」`);
  return { bao, thread: thread ?? null };
}

/** 期望写法 → 期望对象 */
function expect(s, where) {
  if (s === "REPLY") return { type: "reply" };
  if (s.startsWith("NEW:")) return { type: "new", about: s.slice(4) };
  if (s.startsWith("SPLIT:")) return { type: "split", targets: s.slice(6).split("+").map((x) => target(x, where)) };
  return { type: "route", ...target(s, where) };
}

const cases = [];
const add = (kind, turns) => cases.push({ id: `${kind}-${String(cases.filter((c) => c.kind === kind).length + 1).padStart(3, "0")}`, kind, turns });

for (const f of ["singles-1.txt", "singles-2.txt", "singles-3.txt"])
  for (const l of lines(f)) {
    const [t, text] = l.split("|");
    add("single", [{ text, expect: { type: "route", ...target(t, f) } }]);
  }
for (const l of lines("threads.txt")) {
  const [t, text] = l.split("|");
  add("thread", [{ text, expect: { type: "route", ...target(t, "threads.txt") } }]);
}
for (const l of lines("special.txt")) {
  const i = l.indexOf("|");
  const e = expect(l.slice(0, i), "special.txt");
  add(e.type, [{ text: l.slice(i + 1), expect: e }]);
}
let ep = null;
for (const l of lines("episodes.txt")) {
  if (l.startsWith("## ")) {
    ep = { title: l.slice(3), turns: [] };
    add("episode", ep.turns);
    cases.at(-1).title = ep.title;
    continue;
  }
  const m = l.match(/^>\s*(.+?)\s*=>\s*(.+)$/);
  if (!m) throw new Error(`episodes.txt 看不懂：${l}`);
  const same = m[2] === "=";
  if (same && !ep.turns.length) throw new Error(`episodes.txt：第一句不能写 =：${l}`);
  const e = same ? ep.turns.at(-1).expect : expect(m[2], `episodes.txt「${ep.title}」`);
  ep.turns.push({ text: m[1], expect: e, followUp: same });
}

writeFileSync(join(dir, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
const turns = cases.reduce((n, c) => n + c.turns.length, 0);
const byKind = {};
for (const c of cases) byKind[c.kind] = (byKind[c.kind] ?? 0) + c.turns.length;
console.log(`${baos.length} 个宝，${threads.size} 段讨论串，${cases.length} 组，${turns} 句`, byKind);
