/**
 * tools/probe-obsidian.js — 把 probe-obsidian.html 截成一张 PNG
 *
 *     node_modules\.bin\electron.exe tools/probe-obsidian.js [输出路径]
 *
 * 不开窗口（show: false），只在内存里渲染再截图。
 * 和 make-icon.js 一样是 **CommonJS** —— Electron 主进程默认按 CJS 解析 .js。
 *
 * ⚠ 跑之前要清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会当成 node 跑，
 *   require('electron') 拿到的是路径字符串而不是 API
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 窗口按要看的段收窄：整页 1320，只看图鉴卡 900，只看放大特写 820。
// ⚠ Read 回来的图会按尺寸缩，窗口开太宽的话 11px 的字就糊了
const WIDTHS = { onlycards: 900, onlyzoom: 820 }

app.whenReady().then(async () => {
	const WIDTH = WIDTHS[process.argv[3]] || 1320
	const win = new BrowserWindow({
		width: WIDTH,
		height: 900,
		show: false,
		useContentSize: true,
		webPreferences: { sandbox: false },
	})

	const page = path.join(__dirname, 'probe-obsidian.html')
	// 第三个参数选看哪一段：onlyzoom=放大特写，onlycards=图鉴卡（原始字号）。
	// 原理是让别的段 display:none，而不是 capturePage 传矩形 ——
	// 这台机器显示缩放 125%，按 CSS 坐标裁出来的是歪的一块
	const mode = process.argv[3] || ''
	await win.loadFile(page, { search: mode })

	// 等模块脚本把图画完。loadFile 只保证 DOM ready，
	// 而 canvas 上的东西是 <script type="module"> 里画的（模块是延迟执行的）
	const logs = []
	win.webContents.on('console-message', (_e, _lvl, msg) => logs.push(msg))

	await win.webContents.executeJavaScript(
		'new Promise((res) => {' +
			'  const tick = () => (window.__probeReady ? res(1) : setTimeout(tick, 40));' +
			'  tick();' +
			'})',
	)

	// 按内容实际高度把窗口撑开，别把 E 段裁掉
	const h = await win.webContents.executeJavaScript(
		'Math.ceil(document.documentElement.scrollHeight)',
	)
	win.setContentSize(WIDTH, Math.min(h + 8, 4000))

	// 等两帧，让 border-flow 动画落到一个非零相位上
	await new Promise((r) => setTimeout(r, 500))

	const img = await win.webContents.capturePage()
	const out = process.argv[2] || path.join(os.tmpdir(), 'ffw-obsidian.png')
	fs.writeFileSync(out, img.toPNG())

	// 把页面撑到刚好装下内容 —— 整页 1650px 宽，Read 回来会缩，
	// 11px 的字缩完就是一坨糊块，判断不了渐变画上没有
	const body = await win.webContents.executeJavaScript(
		'(() => { const r = document.body.getBoundingClientRect();' +
			'  return { w: Math.ceil(r.width), h: Math.ceil(r.height) }; })()',
	)
	console.log('[probe] content ' + body.w + 'x' + body.h)

	console.log('[probe] ' + out)
	console.log('[probe] ' + img.getSize().width + 'x' + img.getSize().height)

	// 页面里算出来的样式。用 returnByValue 直接取，
	// 别指望 console-message —— 监听器是 loadFile 之后才挂上的，
	// 而模块脚本在那之前就跑完了，日志会整段丢掉
	const diag = await win.webContents.executeJavaScript('window.__diag || null')
	if (diag) {
		console.log('[diag] name  = ' + JSON.stringify(diag.name))
		console.log('[diag] badge = ' + JSON.stringify(diag.badge))
	}

	app.exit(0)
})

app.on('window-all-closed', () => app.exit(0))
