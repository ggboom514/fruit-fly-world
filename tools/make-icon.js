/**
 * tools/make-icon.js — 生成 build/icon.png
 *
 * 用 Electron 自带的 Chromium 画布来画，不依赖任何绘图库、也不需要联网。
 * 注意这个脚本要用 **Electron** 跑，不是 bun：
 *
 *     bun run icon          （package.json 里映射到 electron tools/make-icon.js）
 *
 * 想换成自己的图标更简单：拿一张 512×512 以上的 PNG 直接覆盖 build/icon.png 就行，
 * 这个脚本就不用再跑了。electron-builder 会自动把它转成多尺寸的 .ico。
 *
 * 这个文件是 CommonJS —— Electron 主进程默认按 CJS 解析 .js，
 * 和 tools/ 下另外两个跑在 bun 上的 ESM 脚本不一样。
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const SIZE = 512

/**
 * 画图标。
 *
 * 这个函数会被 toString() 序列化后送进渲染进程执行，
 * 所以里面**不能引用任何外部变量**，也不要用模板字符串。
 */
function drawIcon(ctx, S) {
	const TAU = Math.PI * 2
	const u = S / 512 // 归一化单位：下面所有数字都是按 512 设计的

	// —— 底板：深色圆角方块 ——
	ctx.beginPath()
	ctx.roundRect(0, 0, S, S, 112 * u)
	const bg = ctx.createLinearGradient(0, 0, 0, S)
	bg.addColorStop(0, '#3b2d21')
	bg.addColorStop(1, '#1c1510')
	ctx.fillStyle = bg
	ctx.fill()

	// 中心一点暖光，免得整块死黑
	const glow = ctx.createRadialGradient(S * 0.5, S * 0.42, 0, S * 0.5, S * 0.42, S * 0.6)
	glow.addColorStop(0, 'rgba(224, 169, 79, 0.20)')
	glow.addColorStop(1, 'rgba(224, 169, 79, 0)')
	ctx.fillStyle = glow
	ctx.fill()

	// —— 果蝇 ——
	const s = 300 * u
	// 身体重心比几何中心偏向腹侧，所以整体往右上调一点才看着居中
	ctx.save()
	ctx.translate(S * 0.54, S * 0.5)
	ctx.rotate(-0.34)

	// 翅膀（先画，压在身体下面）
	ctx.fillStyle = 'rgba(214, 232, 255, 0.5)'
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)'
	ctx.lineWidth = s * 0.012
	for (const side of [-1, 1]) {
		ctx.save()
		ctx.translate(s * 0.04, side * s * 0.09)
		ctx.rotate(-side * 0.5)
		ctx.beginPath()
		ctx.ellipse(-s * 0.3, 0, s * 0.4, s * 0.13, 0, 0, TAU)
		ctx.fill()
		ctx.stroke()
		ctx.restore()
	}

	// 六条腿
	ctx.strokeStyle = 'rgba(38, 24, 11, 0.92)'
	ctx.lineWidth = s * 0.034
	ctx.lineCap = 'round'
	for (const side of [-1, 1]) {
		for (let i = 0; i < 3; i++) {
			const bx = s * (0.16 - i * 0.15)
			const by = side * s * 0.12
			ctx.beginPath()
			ctx.moveTo(bx, by)
			ctx.lineTo(bx - s * 0.08, side * s * 0.36)
			ctx.lineTo(bx - s * (0.24 + i * 0.05), side * s * (0.48 + i * 0.03))
			ctx.stroke()
		}
	}

	// 腹部
	ctx.fillStyle = '#8a5a2b'
	ctx.beginPath()
	ctx.ellipse(-s * 0.26, 0, s * 0.37, s * 0.29, 0, 0, TAU)
	ctx.fill()

	// 腹部环纹（雌性特征，也让腹部不至于是一坨纯色）
	ctx.strokeStyle = 'rgba(60, 38, 16, 0.45)'
	ctx.lineWidth = s * 0.028
	for (let i = 1; i <= 2; i++) {
		const x = -s * (0.18 + i * 0.12)
		const h = s * 0.29 * Math.sqrt(Math.max(0, 1 - ((x + s * 0.26) / (s * 0.37)) ** 2)) * 0.8
		ctx.beginPath()
		ctx.moveTo(x, -h)
		ctx.lineTo(x, h)
		ctx.stroke()
	}

	// 胸部
	ctx.fillStyle = '#6f4620'
	ctx.beginPath()
	ctx.ellipse(s * 0.07, 0, s * 0.23, s * 0.2, 0, 0, TAU)
	ctx.fill()

	// 头
	ctx.fillStyle = '#5d3a17'
	ctx.beginPath()
	ctx.ellipse(s * 0.32, 0, s * 0.145, s * 0.155, 0, 0, TAU)
	ctx.fill()

	// 复眼
	ctx.fillStyle = '#c0392b'
	for (const side of [-1, 1]) {
		ctx.beginPath()
		ctx.ellipse(s * 0.35, side * s * 0.095, s * 0.095, s * 0.085, 0, 0, TAU)
		ctx.fill()
	}

	ctx.restore()
}

app.whenReady().then(async () => {
	const win = new BrowserWindow({ width: 64, height: 64, show: false })
	await win.loadURL('about:blank')

	// drawIcon 被序列化后送进渲染进程：那边的 Canvas 是真正的 Chromium 实现，
	// 不用为了画一张 PNG 去引一堆图像库。
	const dataUrl = await win.webContents.executeJavaScript(
		'(() => {' +
			'  const c = document.createElement("canvas");' +
			'  c.width = ' + SIZE + '; c.height = ' + SIZE + ';' +
			'  const ctx = c.getContext("2d");' +
			'  (' + drawIcon.toString() + ')(ctx, ' + SIZE + ');' +
			'  return c.toDataURL("image/png");' +
			'})()',
	)

	const png = Buffer.from(dataUrl.split(',')[1], 'base64')
	const out = path.join(__dirname, '..', 'build', 'icon.png')
	fs.mkdirSync(path.dirname(out), { recursive: true })
	fs.writeFileSync(out, png)

	console.log(`[icon] 已生成 ${out}`)
	console.log(`[icon] ${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB`)
	console.log('[icon] electron-builder 会在打包时自动把它转成多尺寸 .ico')

	app.exit(0)
})
