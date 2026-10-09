# 截图（给插件市场用）

这里的图是给 [dshmarket](https://dshmarket.com) 的插件详情页和 awesome-dsh-plugin 的条目页用的，**不影响插件运行、也不进 npm 包**（`package.json` 的 `files` 里没有 `docs/`）。

## 现在有什么

| 文件 | 拍的是什么 |
| --- | --- |
| `LightTheme.png` | 浅色主题 + `Background/the-longest-night.jpeg` + 新会话欢迎页（贴纸 + 粉白艺术字）。2560×1380，1.3 MB |
| `DarkTheme.png` | 深色主题 + `Background/night-reading.jpeg`，同一个空白会话。2560×1380，2.2 MB |

两张都是**空白新会话**（没有任何真实会话正文、文件路径、插件列表），可以放心公开。

顺序由仓库根的 [`screenshots.json`](../../screenshots.json) 决定，第一张就是市场卡片/详情页的封面：

```json
{ "screenshots": [ "docs/screenshots/LightTheme.png", "docs/screenshots/DarkTheme.png" ] }
```

路径相对 `screenshots.json` 自己（也就是仓库根）；写成数组也认。规则：1–8 条、**不能以 `/` 开头、不能含 `..`**、图片必须在仓库里。改完推自己的仓库就生效（下一次 nightly 构建），不用来提 PR。

## 还想再补的话（可选）

1–8 张，同屏同风格最省事。按"能最快说明这插件在干什么"排：

| 建议文件名 | 拍什么 |
| --- | --- |
| `PanelLight.png` | 「✦ 昔涟」人格设定面板展开：编辑框 + 三个开关 + 「✦ 表情包管理」入口那一行 + 背景二选一与缩略图条 |
| `Stickers.png` | 表情包管理器整页（缩略图网格 + 大小滑杆） |
| `Chat.png` | 一段真实对话，最好**有一条贴了表情包**的回复、标题能看出主题（这个要新开一个干净会话再拍，别露出隐私） |

规格：`png` / `jpg`，宽 1600–2560px 即可；**别露出隐私**——会话正文、文件路径、API key、别的插件名都避开，或者新开一个干净会话再拍。加了图记得把文件名补进根目录的 `screenshots.json`。

## 两条容易踩的

- **不声明 `screenshots.json` 也可以**，那时市场会退回去**从仓库根 README 里抽图**——现在 README 里正好放了这两张，效果一样；声明只是为了控制顺序与增删。
- 别把图挪出 `docs/screenshots/`（或改名）却不改 `screenshots.json`：相对路径会直接 404；这也是上游坚持"路径写相对、放自己仓库"的原因。
