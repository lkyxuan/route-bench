// 关键词基线：不调模型，只靠字面重合。用来当“最低线”，好的路由应该远远高于它。
// 规则：打招呼/问时间 → 直接答；短句、指代 → 留在当前；否则按二字词重合给宝和讨论串打分，取最高。
// 不会新建宝，也不会拆分。

const GREET = /^(你好|您好|在吗|hi|hello|thanks|谢谢|多谢|好的?|嗯+|ok|收到|晚安|早上好|下午好|晚上好|拜拜|辛苦了|知道了|行吧|算了|没事了|不用了|对|不是)[呀啊！!。~\s奇奇你]*$/i;
const ASK_TIME = /(几点|几号|星期几|周几|月几号)/;
const PRONOUN = /^(那|就|好|这个|它|再|先|为什么|然后|还有|继续|对了)/;

const bigrams = (s) => {
  const t = s.toLowerCase().replace(/[\s，。、？！,.?!：:（）()「」"“”]/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

export function keywordRouter(baos) {
  const docs = [];
  for (const b of baos) {
    docs.push({ bao: b.name, thread: null, grams: bigrams(`${b.name}${b.desc}`) });
    for (const t of b.threads) docs.push({ bao: b.name, thread: t.name, grams: bigrams(`${t.name}${t.summary}`) });
  }
  return (q) => {
    const text = q.text.trim();
    if (GREET.test(text) || (ASK_TIME.test(text) && text.length < 14)) return { type: "reply", layer: "规则" };
    if (q.current && (text.length <= 10 || PRONOUN.test(text))) return { type: "route", ...q.current, layer: "接着当前" };
    const g = bigrams(text);
    let best = null;
    let bestScore = 0;
    for (const d of docs) {
      let s = 0;
      for (const x of g) if (d.grams.has(x)) s++;
      if (d.thread) s *= 1.2; // 讨论串更具体
      if (s > bestScore) (best = d), (bestScore = s);
    }
    if (!best) return { type: "route", ...(q.current ?? { bao: "生活宝", thread: null }), layer: "兜底" };
    return { type: "route", bao: best.bao, thread: best.thread, layer: "关键词" };
  };
}
