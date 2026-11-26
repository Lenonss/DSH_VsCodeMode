# 结构库

## 目录

```
<库根>/index.json              清单：id、name、kind、tags、version、source、待复核标记
<库根>/entries/<id>/
  meta.json                    条目元数据（见 spec.md 第 3 节）
  spec.json                    子树（tree + slots + assets + requires）
  assets/                      条目自带素材，不自引用外部路径
  thumb.png                    320px 宽缩略图
  notes.md                     使用示例、坑
  versions/<n>.json            被引用过的历史版本快照
```

## 解析顺序

1. 按 `config.lib.roots` 顺序查（项目库先，共享库后）。
2. 同 `id` 两级都有时，项目级覆盖共享级；库页显示两个来源徽标。
3. `lib:<id>@<版本>` 锁版本；省略版本用当前版本，并在 spec 里补记实际版本。

## 版本

- 条目内容变化 → `version + 1`，旧版本快照进 `versions/<n>.json`（只留被引用过的）。
- 老版本被删时不要静默失效：提示「<id>@<n> 已不存在，升级到 @<m> 还是保留副本」，由用户选。
- 副本方案：把 `@<n>` 的 `spec.json` 拷进项目库做一条新 id（`<id>-pin-<n>`），spec 改引用它。

## 写入规则

- 默认写项目库。写共享库要在提取面板里勾一下，避免一屏专用结构污染公共资产。
- `lib.writePolicy` = `onlyme` / `team` / `review`：`review` 时写入前先把 meta 摘要给用户过一遍。
- 去重：同 `id`，或子树结构哈希相同（忽略 `id` 与 `rect`）→ 提示更新已有条目，不新建。

## 校验（validate）

扫全部条目，任一项不过标「待复核」：

- `meta.json` 必填：`id`、`name`、`kind`、`source`、`version`、`desc`、`when`、`whenNot`、`tags`
- `assets/` 里声明的文件都存在
- `thumb.png` 存在且 ≤ 320px 宽
- `spec.json` 的 `tree.id` 与 `meta.id` 不冲突、子树无孤儿节点
- `versions/` 里的每个版本都能被 `spec.json` 结构兼容

agent 引用前跳过待复核条目；库页显示 ⚠️ 和原因。

## 使用计数

`used` 每次被 `ref` 引用时 +1（build 时统计并写回 index）。`used = 0` 且 90 天未改的条目标「疑似废弃」，不自动删——删之前问用户。
