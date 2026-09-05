# QR Code XP

一个 Windows XP 风格的二维码实验台。既能快速生成和扫描二维码，也能检查编码分段、纠错等级、Version、Mask 和罚分等底层信息。

![QR Code XP 界面预览](docs/screenshot.png)

## 功能

- 实时生成二维码，支持文字与网址
- 支持 Numeric、Alphanumeric、Byte 和自动分段
- 支持 L、M、Q、H 四种纠错等级
- 可自动或手动指定 Version 1–40 与 Mask 0–7
- 支持自定义输出分辨率，并导出 PNG
- 展示编码分段、比特长度和八种 Mask 的罚分
- 导出 Analysis JSON
- 通过上传、拖放、粘贴图片或摄像头扫描二维码
- 提供简易模式和高级模式
- Windows XP Luna 风格的窗口、桌面、开始菜单和任务栏
- 在支持 `document.modelContext` 的环境中提供页面工具，可由 AI 配置二维码生成参数

## 技术栈

- React 19
- TypeScript
- vinext / Vite
- Tailwind CSS
- [`qrcode`](https://github.com/soldair/node-qrcode)
- [`jsQR`](https://github.com/cozmo/jsQR)
- Cloudflare Workers

## 本地运行

需要 Node.js 22.13 或更高版本，以及 pnpm。

```bash
git clone https://github.com/Arrow36/qr-code-xp.git
cd qr-code-xp
pnpm install
pnpm dev
```

根据终端提示打开本地地址即可使用。

## 在线体验

[打开 GitHub Pages](https://arrow36.github.io/qr-code-xp/)

## 常用命令

```bash
pnpm dev       # 启动开发服务器
pnpm build     # 构建生产版本
pnpm start     # 本地运行 Workers 构建
pnpm lint      # 检查代码
pnpm format    # 格式化代码
```

## 使用提示

- 摄像头扫码需要在 `localhost` 或 HTTPS 环境下运行。
- 二维码能否成功生成取决于内容长度、编码模式、Version 和纠错等级。
- 界面目前以中文为主。

## License

尚未指定开源许可证。在添加许可证前，保留所有权利。
