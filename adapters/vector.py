#!/usr/bin/env python3
"""向量基线：用本地 bge-small-zh 把宝说明和讨论串摘要变成向量，按相似度取最高（mem0、Zep 取记忆就是这一步）。
也是“exec 接法”的示例：从 stdin 一行读一个 JSON 请求，往 stdout 写一行 JSON 回答，回答带上请求里的 id。

  pip install onnxruntime tokenizers numpy
  BGE_MODEL=/path/model.onnx BGE_TOKENIZER=/path/tokenizer.json node bench.mjs --router "exec:python3 adapters/vector.py"

模型文件：npm 包 dsh-recall-models（model_merged.onnx）和 dsh-recall（lib/vendor/tokenizer.json）里都有，`npm pack` 下载解开即可。
只会选已有的宝或讨论串；不会新建、不会拆分，也不会直接答。
"""
import json, os, sys, time
import numpy as np, onnxruntime as ort
from tokenizers import Tokenizer

sess = ort.InferenceSession(os.environ["BGE_MODEL"])
tok = Tokenizer.from_file(os.environ["BGE_TOKENIZER"])
tok.enable_padding(); tok.enable_truncation(256)

def emb(xs):
    enc = tok.encode_batch(xs)
    ids = np.array([e.ids for e in enc], dtype=np.int64); am = np.array([e.attention_mask for e in enc], dtype=np.int64)
    v = sess.run(None, {"input_ids": ids, "attention_mask": am, "token_type_ids": np.zeros_like(ids)})[0][:, 0]
    return v / np.linalg.norm(v, axis=1, keepdims=True)

index = None
for line in sys.stdin:
    q = json.loads(line)
    if index is None:  # 第一次请求时建索引（宝列表每次都一样）
        keys, texts = [], []
        for b in q["baos"]:
            keys.append((b["name"], None)); texts.append(f'{b["name"]}：{b["desc"]}')
            for t in b["threads"]:
                keys.append((b["name"], t["name"])); texts.append(f'{b["name"]}/{t["name"]}：{t["summary"]}')
        index = (keys, emb(texts))
    keys, E = index
    s = E @ emb([q["text"]])[0]
    i = int(np.argmax(s))
    print(json.dumps({"id": q["id"], "type": "route", "bao": keys[i][0], "thread": keys[i][1], "layer": "向量", "score": round(float(s[i]), 3)}, ensure_ascii=False), flush=True)
