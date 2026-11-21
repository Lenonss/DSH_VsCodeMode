# 父级交给 fork 的摘要模板

复制下面结构并填实；子级不应再读父级对话之外的探索过程。

```json
{
  "task": "一句话目标",
  "claims": ["1 用户可以…", "2 它怎么工作…", "3 在哪…"],
  "exhibits": ["doc-mock：答复面板按钮", "doc-code：桥接脚本 src=… lines=…"],
  "decisions": [{ "id": "send-path", "options": ["sendTask", "composer"], "default": "sendTask" }],
  "paths": { "page": "plans/<slug>/plan.html", "packed": "plans/<slug>/plan.packed.html" },
  "pack": "node plans/<slug>/runtime/pack.mjs plans/<slug>/plan.html --root <workspace>",
  "accept": ["pack exit 0", "主张/决策计数与摘要一致", "含 HTML 计划页：<path> 标记行"]
}
```

要求子级：只写页与打包，不实现功能、不改其他文件；返回 packed 路径、lint 警告摘要与计数。