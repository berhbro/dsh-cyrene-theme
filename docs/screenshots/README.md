# 截图（给插件市场用）

这里的图是给 [dshmarket](https://dshmarket.com) 的插件弹窗和 awesome-dsh-plugin 的条目页用的，**不影响插件运行**。目前目录是空的——图要你亲自拍（本机没法自截图），拍好丢进来即可。

## 拍哪几张

| 建议文件名 | 拍什么 |
| --- | --- |
| `01-theme.png` | 主界面全景：左侧栏 + 对话区 + 输入框（浅色主题，「✦ 昔涟」按钮可见） |
| `02-background.png` | 开了背景图的样子，最好能看见输入框与正文压在照片上仍然清楚 |
| `03-panel.png` | 「✦ 昔涟」人格设定面板展开（含「✦ 表情包管理」入口那一行） |
| `04-hero.png` | 新会话欢迎页：昔涟贴纸 + 粉白艺术字 + 输入框占位提示 |
| `05-stickers.png` | 表情包管理器整页（缩略图网格 + 大小滑杆） |
| `06-dark.png` | 深色主题 + `night-reading.jpeg` 那张夜景背景 |

## 规格

- 1–8 张，`png` / `jpg`，宽 1600px 左右就够（约 500 KB 以内一张），命名用两位数字前缀保证顺序。
- **别露出隐私**：会话正文、文件路径、API key、别的插件名都尽量避开，或者新开一个干净会话再拍。
- 拍完在仓库根的 `package.json` 旁边放一个 `screenshots.json`（**现在先别放**——图还没有，放了市场弹窗会去抓 404 空图）：

  ```json
  [
    "docs/screenshots/01-theme.png",
    "docs/screenshots/02-background.png",
    "docs/screenshots/03-panel.png"
  ]
  ```

  路径是相对 `screenshots.json` 自己的（也就是相对仓库根）。写成 `{"screenshots": [ ... ]}` 也认；也可以直接写 **GitHub 托管的 https 绝对 URL**，但第三方图床会被拒。规则：1–8 条、**不能以 `/` 开头、不能出现 `..`**、图片本身要在仓库里（推自己的仓库就生效，不用来提 PR）。

- **不声明也行**：那时市场会退回去**从仓库根 README 里抽图**——所以哪天放了真截图，最好顺手把 `screenshots.json` 写清楚，免得抽到别的东西。
- 这个说明文件（`docs/screenshots/README.md`）本身不参与任何抽取，留着就行。
