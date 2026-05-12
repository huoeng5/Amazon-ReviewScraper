# Windows 打包参考

本文档用于在 Windows 环境把项目打包成可安装、可卸载的桌面程序。

最终安装包名称：

```text
Amazon-ReviewScraper.exe
```

## 1. 打包前准备

推荐环境：

- Windows 10 / Windows 11 x64
- Node.js 24 或更新版本
- Git
- PowerShell

先克隆源码：

```powershell
git clone https://github.com/huoeng5/Amazon-ReviewScraper.git
cd Amazon-ReviewScraper
```

安装依赖：

```powershell
npm install
npm install --prefix ui
```

可以先把 Playwright Chromium 下载到项目依赖目录，方便一起打进安装包：

```powershell
npm run playwright:install:local
```

这一步会把 Chromium 放到：

```text
node_modules/playwright-core/.local-browsers
```

## 2. 打包命令

执行：

```powershell
npm run dist:win
```

`dist:win` 会自动执行三件事：

```text
构建 React UI -> 下载/确认本地 Chromium -> 生成 Windows NSIS 安装包
```

成功后安装包会生成在：

```text
release/Amazon-ReviewScraper.exe
```

## 3. 本地数据不会被打包

项目已经在 `package.json` 的 `build.files` 中排除了本地数据目录和敏感运行文件：

```text
data/
input/
output/
outputs/
exports/
snapshots/
.browser-profiles/
*.sqlite
*.sqlite-*
*.db
*.db-*
*.csv
*.run.json
```

以下内部文档也不会进入安装包：

```text
AMAZON_POC_README.md
ICEMAN_数据抓取技术任务清单.md
ICEMAN_桌面版UI与EXE打包方案.md
```

打包前可以用下面命令确认 Git 工作区中没有误加入本地数据：

```powershell
git status --ignored --short
```

看到 `data/`、`output/`、`exports/`、`snapshots/`、`.browser-profiles/` 显示为 ignored 是正常的。

## 4. 安装后数据保存位置

安装后的程序不会把 SQLite、浏览器 Profile、抓取输出写入安装目录。

Windows 默认运行数据目录：

```text
C:\Users\你的用户名\AppData\Roaming\Amazon ReviewScraper\
```

主要文件和目录：

```text
iceman.sqlite
browser-profiles\amazon-jp\
output\
snapshots\
```

这样安装包本身保持干净，用户数据和程序文件分离。

## 5. 验收步骤

在 Windows 上完成打包后，建议按下面流程验收：

1. 双击 `release/Amazon-ReviewScraper.exe` 安装。
2. 从桌面快捷方式或开始菜单打开程序。
3. 输入一个 Amazon Japan 商品链接，确认任务进入队列。
4. 输入一个 Rakuten 商品链接，确认抓取完成后评论预览可显示。
5. 输入一个 Yahoo! Shopping 商品链接，确认抓取完成后评论预览可显示。
6. 点击“导出当前商品 CSV”，确认能选择保存路径并生成 CSV。
7. 点击左侧“全量导出”，确认能生成全量 CSV。
8. 关闭程序后重新打开，确认队列和 SQLite 数据仍然存在。
9. 在 Windows“应用和功能”里卸载程序。

当前配置为：

```json
"deleteAppDataOnUninstall": false
```

也就是说卸载程序时会移除应用本体，但默认保留用户抓取数据。如果希望卸载时连 SQLite 一起删除，可以把它改成 `true` 后重新打包。

## 6. 常见问题

### 提示找不到 Chromium

重新执行：

```powershell
npm run playwright:install:local
npm run dist:win
```

确认下面目录存在：

```text
node_modules/playwright-core/.local-browsers
```

### 安装包很大

这是正常的。为了让别人安装后直接能抓取，安装包会包含 Playwright Chromium。

### macOS 上能不能直接打 Windows 包

可以尝试，但不建议作为最终发布包。Windows 安装包最好在 Windows 真机上打包并验收，尤其要确认 Chromium、SQLite、CSV 导出和卸载流程都正常。
