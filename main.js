/**
 * 果蝇世界 — Electron 主进程
 *
 * 职责：
 *   1. 创建一块覆盖整屏的「透明无边框」窗口
 *   2. 处理置顶 / 鼠标穿透 / 全屏切换
 *   3. 提供全局快捷键，防止窗口被置底后找不回来
 *   4. 启动后查一次版本清单，有新版本就问一句要不要去下载
 *
 * 鼠标穿透的核心思路：
 *   窗口默认「穿透」——鼠标事件直接落到桌面上，你该怎么用电脑还怎么用。
 *   但 forward:true 让渲染进程依然收得到 mousemove，
 *   于是渲染进程可以判断「指针是不是压在这扇窗口自己的 UI 上」：
 *     压在面板 / 罐子小窗 / 小卡 / 收起后的把手上  → 关闭穿透，接管鼠标
 *     其余时候（**包括手里拿着工具**）              → 恢复穿透，不挡路
 *
 * 窗口层级（置顶开关）：
 *   开 → 'screen-saver' 层，压在所有窗口之上
 *   关 → 先取消置顶，再用 Win32 的 SetWindowPos 把它推到**所有普通窗口之下**
 *        （仍在桌面之上）。Electron 没有「往下推」这个 API，见 sinkToBottom()
 */

const { app, BrowserWindow, ipcMain, globalShortcut, screen, Menu, shell } = require('electron')
const { execFile } = require('child_process')
const http = require('http') // 只在 --selftest 里用：起一个本地小服务器喂版本清单
const path = require('path')
const fs = require('fs')

/**
 * --selftest：加载页面、确认渲染进程真的跑起来了、试着画一帧，然后退出。
 * 用来在不方便肉眼看的情况下验证模块加载和渲染路径没坏（比如打包之后、或者远程改代码时）。
 * 这个模式下窗口不显示，也不会注册全局快捷键。
 */
const SELFTEST = process.argv.includes('--selftest')

/** 存档格式版本。以后存档结构变了就 +1，渲染进程据此决定认不认这份存档 */
const SAVE_VERSION = 1

/** 退出前等渲染进程写存档的上限。正常几毫秒就回来了，这只是防它卡死带着一起不退出 */
const FLUSH_TIMEOUT = 900

/** @type {BrowserWindow|null} */
let win = null

/**
 * 自检期间那个喂版本清单的本地小服务器。正常运行时**永远是 null**。
 *
 * ⚠ 它要活到渲染进程那段自检跑完为止，不能在 selfTestUpdate 里 close ——
 *   关掉之后不再接受新连接，渲染进程那边再 fetch 就是「连不上」，
 *   而那会被读成「检查更新坏了」，红得莫名其妙
 */
let testServer = null

let interactive = false // 渲染进程要求接管鼠标（指针在 UI 上，或手持工具）
let clickThroughEnabled = true // 穿透总开关
let alwaysOnTop = true

// ------------------------------------------------------------------ 窗口

function createWindow() {
	// 干掉 Electron 的默认菜单。
	//
	// 无边框窗口看不见菜单栏，但它的快捷键照样生效，而且全都是桌宠的坑：
	//   Ctrl+R  重载页面 —— 养了半天的果蝇瞬间清零
	//   Ctrl+W  关窗口   —— 直接退出
	//   F11     全屏     —— 透明覆盖层切全屏，画面会很怪
	//   Ctrl+±  缩放页面 —— 会改变 CSS 像素基准，画布坐标和果蝇位置全对不上
	// 需要的快捷键在下面用 before-input-event 显式注册，白名单式管理。
	Menu.setApplicationMenu(null)

	const { bounds } = screen.getPrimaryDisplay()

	win = new BrowserWindow({
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		hasShadow: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		/*
		 * ⚠ skipTaskbar **必须是 false**。这不是「多个图标好不好看」的取舍，
		 *   是**窗口还能不能叫回来**的问题：
		 *
		 *   置顶一关，Win+D / 任务栏最右边那条「显示桌面」就会把它**最小化** ——
		 *   而上面那句 `minimizable: false` **挡不住系统这一下**。
		 *   实测（照抄这套窗口参数跑了一遍）：最小化前窗口在 z#38、桌面 z#49，
		 *   在桌面之上；被 ShowWindow(SW_MINIMIZE) 之后变成 z#214、桌面 z#47 ——
		 *   **沉到桌面下面去了**，桌面上什么都看不见。
		 *
		 *   跳过了任务栏就等于**没有任何入口能把它叫回来**：窗口不在任务栏里，
		 *   全屏透明又没有标题栏可点，Ctrl+Shift+T 虽然还能切换置顶，
		 *   但玩家根本不知道要按它 —— 表现就是「关掉置顶游戏就没了」。
		 */
		skipTaskbar: false,
		show: false,
		// 见到屏幕才显示，避免启动瞬间闪一下白框
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			// 桌宠被其他窗口盖住时不能让计时器降频，否则果蝇会「卡住」
			backgroundThrottling: false,
		},
	})

	// 'screen-saver' 层级能压住绝大多数全屏应用；普通 'floating' 会被盖
	win.setAlwaysOnTop(true, 'screen-saver')
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

	/*
	 * 被系统最小化（Win+D / 点「显示桌面」）之后，**置顶状态下立刻抢回来**。
	 *
	 * 玩家既然开着置顶，意思就是「要它一直在我眼前」—— 「显示桌面」不该把它弄没。
	 * 抢回来是安全的：置顶的窗口本来就压在别的东西上面，不占谁的位。
	 *
	 * ⚠ 置顶**关着**的时候不拦。那时它就是一个普通窗口，缩下去是正常的，
	 *   而且现在有任务栏按钮，点一下就能回来（见 skipTaskbar 那段）
	 */
	win.on('minimize', () => {
		if (alwaysOnTop && !win.isDestroyed()) win.restore()
	})

	// 从任务栏里叫回来之后，如果当前是「不置顶」，得**重新沉一次底** ——
	// restore 之后窗口会回到普通窗口带，不推一把的话它会浮在其他窗口上面，
	// 而玩家选的是「不置顶 = 别的窗口能盖住我」
	win.on('restore', () => {
		if (!alwaysOnTop) sinkToBottom()
	})

	// 自检模式带个 query 进去，渲染进程据此跳过启动存档弹窗 ——
	// 那个弹窗要等人点，自检会一直卡在那儿。同时它也会关掉自动存档，
	// 免得自检用一个人造世界把玩家的真存档覆盖掉。
	// --autocontinue：跳过启动选择框，直接当玩家选了「继续」。
	// 用来验证读档 → 恢复 → 渲染 → 再存档这条链路（它需要真人点按钮，没法进自检）。
	// 见 renderer/src/save.js 的 begin()。
	const AUTOCONTINUE = process.argv.includes('--autocontinue')
	win.loadFile(
		path.join(__dirname, 'renderer', 'index.html'),
		SELFTEST ? { search: 'selftest=1' } : AUTOCONTINUE ? { search: 'autocontinue=1' } : undefined,
	)

	// 调参时最常用的两个动作：重载渲染进程、打开 DevTools。
	//
	// 用 before-input-event 而不是 globalShortcut —— 后者是系统级全局快捷键，
	// 会把 Ctrl+Shift+R 从浏览器、编辑器手里抢走；这个只在窗口聚焦时生效。
	win.webContents.on('before-input-event', (event, input) => {
		if (input.type !== 'keyDown') return
		if (!(input.control || input.meta) || !input.shift) return

		const key = String(input.key).toLowerCase()

		// Ctrl+Shift+I 开 DevTools：打包之后也保留，万一要现场排查
		if (key === 'i') {
			event.preventDefault()
			win.webContents.toggleDevTools()
			return
		}

		// Ctrl+Shift+R 重载渲染进程：只在开发时生效。
		// 打包后留着它是个坑 —— 误按一下，养了半天的果蝇就全没了。
		if (key === 'r' && !app.isPackaged) {
			event.preventDefault()
			win.webContents.reload()
		}
	})

	win.once('ready-to-show', () => {
		if (SELFTEST) return // 自检模式不弹窗，免得糊用户一脸
		win.show()
		applyMouseMode()
		syncState()
	})

	// 关窗口前先把世界存下来。
	//
	// 这一层拦截是必须的：从任务栏右键关闭、Alt+F4、或者系统关机，
	// 走的都是窗口的 close，而不是我们自己的「退出」按钮，
	// 那些路径同样不能丢存档。拦一次、存完再真关。
	win.on('close', (e) => {
		if (SELFTEST || flushState === 'done') return
		e.preventDefault()
		flushRendererThen(() => win.close())
	})

	win.on('closed', () => {
		win = null
	})

	if (SELFTEST) runSelfTest()
}

/**
 * 渲染进程的错误默认不会打到主进程终端里，排查问题时很瞎。
 * 这里把渲染进程的 console 原样转发出来，并兜住加载失败。
 */
function pipeRendererLogs() {
	if (!win) return

	win.webContents.on('console-message', (...args) => {
		// Electron 新旧版本的回调签名不一样，两种都兜一下
		const details = args[1]
		if (details && typeof details === 'object' && 'message' in details) {
			console.log('[renderer]', details.message)
		} else if (typeof args[2] === 'string') {
			console.log('[renderer]', args[2])
		}
	})

	win.webContents.on('did-fail-load', (_e, code, description, url) => {
		console.error(`[renderer] 页面加载失败: ${description} (${code}) ${url}`)
		if (SELFTEST) app.exit(1)
	})

	win.webContents.on('render-process-gone', (_e, details) => {
		console.error('[renderer] 渲染进程崩溃:', details.reason)
		if (SELFTEST) app.exit(1)
	})
}

/**
 * 「检查更新」有一半跑在**主进程**里（fetch / 版本比较 / 协议白名单），
 * 渲染进程那段自检够不着它们 —— 所以这里起一个本地的小 HTTP 服务器，
 * 把版本清单喂进去，走一遍真路。
 *
 * ⚠ 必须是**本地服务器**，不能拿一个真网址去试：
 *   ① 自检要在没网的机器上也是绿的
 *   ② 真网址的内容会变 —— 作者明天发个新版本，这条断言当场就红了，
 *      而且红得毫无道理
 *
 * 服务器**不在这里关**（见 testServer 那段注释），留给 done() 收尾
 */
function selfTestUpdate() {
	return new Promise((resolve) => {
		// ⚠ 清单里的 url 要用**本机**地址，不能在文件里写死一个假域名：
		//   渲染进程那段自检要断言「去下载记下的就是这个地址」，
		//   写死的话两边各说各的，谁也不知道对不对得上
		let base = ''
		const bodies = () => ({
			'/newer.json': { version: '99.0.0', url: base + '/dl', note: '自检用的假清单' },
			'/newer-nourl.json': { version: '99.0.0' }, // 故意不给 url，验兜底页
			'/older.json': { version: '0.0.1' },
		})
		const server = http.createServer((req, res) => {
			const p = String(req.url).split('?')[0]
			const table = bodies()
			if (p === '/html') {
				// ⚠ GitHub Pages 这类静态托管的 404 页是 **200 + 一段 HTML**。
				//   不单独兜住的话，JSON.parse 抛出去就只剩一句没法解释的「检查更新失败」
				res.writeHead(200, { 'Content-Type': 'text/html' })
				res.end('<html><body>404 Not Found</body></html>')
				return
			}
			if (table[p]) {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(table[p]))
				return
			}
			res.writeHead(404)
			res.end('nope')
		})

		server.on('error', (e) => resolve({ ok: false, reason: '起不了本地测试服务器: ' + e.message }))
		server.listen(0, '127.0.0.1', async () => {
			// 端口是 listen 之后才定的（0 = 让系统随便挑一个没占用的），
			// 所以清单里那个 url 只能到这儿才拼得出来
			base = 'http://127.0.0.1:' + server.address().port
			const fail = (reason) => resolve({ ok: false, reason })
			try {
				// ① 版本号比大小。
				//    ⚠ 这条是**核心**：字符串直接比的话 '1.9.0' > '1.10.0'
				//      （'9' > '1'），从 1.9 升到 1.10 的人就永远收不到提示，
				//      而且表现只是「检查更新说已是最新」，完全没有报错
				if (!(compareVersions('1.10.0', '1.9.0') > 0)) {
					return fail('版本比较错了：1.10.0 应当比 1.9.0 新（说明是按字符串比的）')
				}
				if (compareVersions('1.9.0', '1.10.0') >= 0) return fail('版本比较错了：1.9.0 不该比 1.10.0 新或相等')
				if (compareVersions('1.27.1', '1.27.1') !== 0) return fail('两份一样的版本号却没判成相等')
				if (compareVersions('1.27', '1.27.0') !== 0) return fail('1.27 和 1.27.0 应当算同一个版本')
				if (!(compareVersions('2.0.0', '1.99.99') > 0)) return fail('主版本号更大却没判成更新')
				// 段数不一样时，缺的那几段按 0 算：1.0.0.1 比 1.0.0 新，但 1.27 就是 1.27.0
				if (!(compareVersions('1.0.0.1', '1.0.0') > 0)) return fail('多一段补丁号的版本号没判成更新')
				if (compareVersions('1.0.0.0', '1.0.0') !== 0) return fail('末尾多一段 0 的版本号应当算相等')

				// ② 真的发一次请求：清单取得到，而且 99.0.0 确实比当前版本新
				const got = await fetchManifest(base + '/newer.json')
				if (!got.ok) return fail('清单取不回来: ' + got.reason)
				if (compareVersions(got.data.version, app.getVersion()) <= 0) {
					return fail('本地那份 99.0.0 的清单竟然不比当前版本（' + app.getVersion() + '）新')
				}

				// ③ 各种坏输入。⚠ 每一种都要落到**不同的** reason 上 ——
				//    全都退化成 'network' 的话，玩家看到的那句话就永远没法定位问题
				const cases = [
					[base + '/older.json', 'ok'],
					[base + '/html', 'not-json'],
					[base + '/nope.json', 'http-404'],
					['', 'no-url'],
					['file:///C:/Windows/win.ini', 'bad-url'],
					['javascript:alert(1)', 'bad-url'],
					['这不是一个网址', 'bad-url'],
				]
				for (const [url, want] of cases) {
					const r = await fetchManifest(url)
					const actual = r.ok ? 'ok' : r.reason
					if (actual !== want) {
						return fail('fetchManifest(' + JSON.stringify(url) + ') 得到 ' + actual + '，应当是 ' + want)
					}
				}

				// ④ 协议白名单。⚠ 这条是**安全**断言，不是功能断言：
				//    openExternal 的地址是**页面**递过来的，而页面是会被 XSS 影响的那一层。
				//    放行 file: 的话，页面那层就能拿它去开任何本地文件
				for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:']) {
					if (isSafeUrl(bad)) return fail('isSafeUrl 放行了 ' + bad)
				}
				if (!isSafeUrl('https://example.com/x')) return fail('isSafeUrl 把正常的 https 地址拒了')

				testServer = server
				resolve({ ok: true, info: { base, current: app.getVersion() } })
			} catch (e) {
				resolve({ ok: false, reason: '检查更新自检抛了: ' + e.message })
			}
		})
	})
}

function runSelfTest() {
	pipeRendererLogs()

	let finished = false
	const done = (code, message) => {
		if (finished) return
		finished = true
		// 本地测试服务器要收掉，不然 app.exit 之前事件循环里还挂着一个 listener
		if (testServer) {
			try {
				testServer.close()
			} catch {}
			testServer = null
		}
		console.log(message)
		app.exit(code)
	}

	win.webContents.once('did-finish-load', async () => {
		try {
			// 主进程那一半先验（fetch / 版本比较 / 协议白名单）。
			// ⚠ 服务器要一直开着给下面渲染进程那段用，所以不在这里关
			const update = await selfTestUpdate()
			if (!update.ok) return done(1, '[selftest] 失败: ' + update.reason)

			// 本地测试服务器的地址得递给渲染进程那段脚本。
			// ⚠ 单独一次调用挂到 window 上，**不拼进**下面那个模板字面量里 ——
			//   模板字面量里不能出现 `${`（见 countStrayBackticks 那道闸），
			//   而拼字符串又会让整段脚本的报错变成一句没头没尾的
			//   「Unexpected end of input」，查起来很瞎
			await win.webContents.executeJavaScript(
				'window.__selftestUpdateBase = ' + JSON.stringify(update.info.base),
			)

			const report = await win.webContents.executeJavaScript(`(async () => {
				// preload 桥要是断了，置顶/穿透/退出会静默失灵，必须单独查一下
				const bridge = window.pet
				if (!bridge) return { ok: false, reason: 'window.pet 不存在 —— preload 没加载成功，窗口按钮会失灵' }

				const bridgeMethods = [
					'setInteractive',
					'toggleAlwaysOnTop',
					'toggleClickThrough',
					'getState',
					'onState',
					'quit',
					// 存档桥断了的话，丢的不是一个按钮，是玩家养了半天的整个生态 ——
					// 而且它不会立刻报错，要等下次打开才发现「怎么又是新的」
					'saveGame',
					'loadGame',
					'clearSave',
					'onFlushSave',
					'flushDone',
					// 彩蛋解锁。这条桥断了的表现是「彩蛋解开了，重开一局又锁上」——
					// 玩家只会觉得是运气问题，不会想到是桥断了
					'loadUnlock',
					'saveUnlock',
					// 检查更新。断了的表现是设置卡上那颗按钮点下去没反应 ——
					// 而「没反应」和「已是最新」在玩家眼里长得一模一样
					'checkUpdate',
					'openExternal',
				]
				const missingBridge = bridgeMethods.filter((k) => typeof bridge[k] !== 'function')
				if (missingBridge.length) return { ok: false, reason: 'preload 暴露的方法不全: ' + missingBridge.join(', ') }

				const pet = window.__pet
				if (!pet) return { ok: false, reason: 'window.__pet 不存在 —— 模块很可能没加载成功（ES module 被 file:// 的 CORS 挡了？）' }

				const missing = ['world', 'view', 'renderer', 'ui', 'save'].filter((k) => !pet[k])
				if (missing.length) return { ok: false, reason: 'app.js 暴露的对象不完整，缺少: ' + missing.join(', ') }

				// 存档链路的端到端自证：
				//   序列化 → IPC → 写盘 → 读盘 → IPC → 反序列化
				//
				// 只在内存里 JSON.parse(JSON.stringify(...)) 是测不到磁盘那一半的 ——
				// 路径拼错、文件没权限、原子写的 rename 失败，这些全都照样绿。
				// 自检期间读写的是 save.selftest.json，碰不到玩家的真存档。
				let saveKB = 0
				// ⚠ 这两个必须声明在**最外层**。写在各自那一段的 try 里面的话，
				//   作用域出不了那个 try —— 而 report 是在最外层拼的，
				//   表现是最后报一句「banTag is not defined」，整段自检一个字都打不出来
				let banTag = null
				let iconTag = null
				try {
					const json = JSON.stringify({
						version: 1,
						savedAt: Date.now(),
						world: pet.world.serialize(),
					})
					const wrote = await window.pet.saveGame(json)
					if (!wrote.ok) return { ok: false, reason: '存档写入失败: ' + wrote.reason }
					saveKB = wrote.bytes / 1024

					const read = await window.pet.loadGame()
					if (!read.ok) return { ok: false, reason: '存档读取失败: ' + read.reason }
					if (read.data.version !== 1) return { ok: false, reason: '存档版本号没读回来' }

					const probe = new pet.world.constructor(window.innerWidth, window.innerHeight)
					probe.restore(read.data.world)
					// 只比数量：这里是「链路通不通」的烟囱测试，
					// 逐字段比对由 tools/simulate.js 那一节负责
					for (const key of ['flies', 'larvae', 'eggs', 'foods', 'remains']) {
						if (probe[key].length !== pet.world[key].length) {
							return { ok: false, reason: '存档往返后 ' + key + ' 数量对不上' }
						}
					}

					// —— 老存档里那两个已经删掉的字段不能「复活」 ——
					//
					// ⚠ 遗传去掉之后 Fly 上不再有 fatherMutations / layMutations，
					//   但**老存档里存着它们**。revive() 是「先建默认实例、
					//   再逐个 canAssign 覆盖」，键在新实例上不存在就跳过 ——
					//   这正是我们要的：静默丢掉、不报错、**不用升存档版本号**。
					//
					//   这一条守的就是那个「跳过」：哪天 canAssign 被改成
					//   「先塞进去再说」，这两个字段会重新出现在每只虫身上，
					//   而已经没有任何代码去清它们了（_endClutch 里那段删了）
					const legacy = probe.flies[0]
					for (const dead of ['fatherMutations', 'layMutations']) {
						if (legacy && dead in legacy) {
							return { ok: false, reason: '老存档里已经删掉的 ' + dead + ' 又长回果蝇身上了' }
						}
					}

					await window.pet.clearSave()
				} catch (e) {
					return { ok: false, reason: '存档链路失败: ' + e.message }
				}

				// 启动选择框：把真实的 DOM 走一遍「弹出 → 点继续 → 收起」。
				//
				// 这段接线特别容易错又特别难发现：窗口平时是穿透的，_ask 忘了
				// 调 setBootOpen 的话，弹窗长得完全正常，只是两个按钮点下去会
				// 穿到桌面上 —— 肉眼看不出区别，得真的点一下才知道。
				try {
					const boot = document.getElementById('boot')
					const pending = pet.save._ask({ version: 1, savedAt: Date.now(), world: pet.world.serialize() })
					if (boot.classList.contains('hidden')) return { ok: false, reason: '启动选择框没有弹出来' }
					if (pet.view.bootOpen !== true) return { ok: false, reason: '弹窗开着却没有接管鼠标 —— 按钮会点不动' }

					document.getElementById('boot-continue').click()
					const choice = await pending
					if (choice !== 'continue') return { ok: false, reason: '点「继续」没有返回 continue，而是 ' + choice }
					if (!boot.classList.contains('hidden')) return { ok: false, reason: '选完之后弹窗没有收起' }
					if (pet.view.bootOpen !== false) return { ok: false, reason: '弹窗收起后鼠标没有被放开' }
				} catch (e) {
					return { ok: false, reason: '启动选择框流程失败: ' + e.message }
				}

				// —— 「重新开始」那条路 ——
				//
				// ⚠ 这里**曾经**是个盲区：上面只走了「继续」，boot-new 一次都没被点过。
				//   而「重新开始」和面板上那颗重置是两个入口、同一件事 ——
				//   只清一边的话，玩家走另一条路重开，会发现图鉴还是满的，
				//   而没有任何地方解释为什么
				try {
					// ⚠ 这里**必须走 save.begin()**，不能直接调 _ask。
					//
					//   清 unlock 那一步在 begin() 的「选了 new」分支里，不在 _ask 里 ——
					//   只测 _ask 的话，它照样返回 'new'，而「到底清没清」根本没碰到。
					//   这正是这一节要守的东西，绕开它就等于没测
					//
					// ⚠ 但 save.available 在自检下是**硬关掉的**
					//   （save.js 的 available 是 !SELFTEST && ...），begin() 会当场 return 'fresh'，
					//   压根不弹框。所以这里临时把它打开，让 begin() 走完整条真路 ——
					//   直接手写一遍 clear() + clearProgress() 就等于在测
					//   「我照着 begin() 抄的这段」，而不是 begin() 本身
					//
					// 所以先造一份存档出来，让 begin() 有东西可读、才会弹框
					await window.pet.saveGame(
						JSON.stringify({ version: 1, savedAt: Date.now(), world: pet.world.serialize() }),
					)
					const wasAvailable = pet.save.available
					pet.save.available = true
					// 再造出「有进度可清」的状态
					pet.ui.setStarUnlocked(true, { silent: true })
					pet.ui.noteSeenGenes(['crystal'])
					const seeded = await window.pet.loadUnlock()
					if (!seeded.data.star || !seeded.data.seen.includes('crystal')) {
						return { ok: false, reason: '「重新开始」那条断言的前置没造出来，测不出东西' }
					}

					const boot = document.getElementById('boot')
					// ⚠ 不能先 await begin() 再点 —— 那样会死等（框一直开着，没人点）。
					//   先拿到 promise，点掉按钮，**然后**才 await
					const pending = pet.save.begin()

					// ⚠⚠ 而且**必须等框真的弹出来**再点。
					//
					//   begin() 先 await 读盘、比版本号，之后才轮到 _ask 挂监听器。
					//   begin() 一返回就 click 的话，那一刻 boot-new 上还没有
					//   任何监听器 —— 那一下**点空了**，然后 _ask 弹着框永远等下去。
					//   症状是自检**整个挂死**（实测踩过：跑满 5 分钟没动静），
					//   而不是报一条错，所以特别值得写清楚
					for (let i = 0; i < 200 && boot.classList.contains('hidden'); i++) {
						await new Promise((r) => setTimeout(r, 10))
					}
					if (boot.classList.contains('hidden')) {
						return { ok: false, reason: 'begin() 跑了两秒也没弹出启动选择框 —— 存档那一步失败了？' }
					}

					document.getElementById('boot-new').click()
					const choice = await pending
					pet.save.available = wasAvailable
					if (choice !== 'fresh') return { ok: false, reason: '点「重新开始」没有走到新局，而是 ' + choice }
					if (!boot.classList.contains('hidden')) return { ok: false, reason: '「重新开始」选完之后弹窗没有收起' }
					if (pet.view.bootOpen !== false) {
						return { ok: false, reason: '「重新开始」之后鼠标没有被放开' }
					}

					if (pet.ui.starUnlocked) return { ok: false, reason: '「重新开始」之后彩蛋还解锁着' }
					const cleared = await window.pet.loadUnlock()
					if (cleared.data.star) return { ok: false, reason: '「重新开始」之后 unlock.json 里的 star 还是 true' }
					if (!Array.isArray(cleared.data.seen) || cleared.data.seen.length !== 0) {
						return {
							ok: false,
							reason: '「重新开始」之后 unlock.json 里的 seen 不是空的：' + JSON.stringify(cleared.data.seen),
						}
					}
				} catch (e) {
					pet.save.available = false
					return { ok: false, reason: '「重新开始」流程失败: ' + e.message }
				}

				// 玻璃罐：把「放罐子 → 网一只 → 列表出这一行 → 点放逐 → 行消失」走一遍。
				//
				// 这条链路上全是新 DOM（列表行是运行时造出来的），少一个 id、
				// 拼错一个 class、或者事件挂错了元素，都要等玩家真去点才会暴露 ——
				// 那时候报出来的现象是「点了没反应」，很难定位到是哪一环。
				try {
					const w2 = pet.world
					w2.jars.length = 0
					if (w2.flies.length === 0) {
						w2.addFly(window.innerWidth / 2, window.innerHeight / 2, 'F')
					}
					const jar = w2.dropJar()
					if (!jar) return { ok: false, reason: 'world.dropJar() 没造出罐子' }

					pet.ui.refreshJarList()
					const jarWin = document.getElementById('jar-window')
					if (!jarWin || jarWin.classList.contains('hidden')) {
						return { ok: false, reason: '场上有罐子，但罐中果蝇小窗没显示出来' }
					}

					// ⚠ 小窗**默认应当是收起的**。
					// 展开状态下列表能到 220px 高，一有罐子就自动铺开的话，
					// 屏幕右边会平白多出一大块 —— 这个默认值是设计决定，不是随手写的
					if (!jarWin.classList.contains('collapsed')) {
						return { ok: false, reason: '罐中果蝇小窗默认应当收起着，只留一个标题条' }
					}

					// 点标题条能展开。用真的 click 而不是直接改 class ——
					// 要覆盖的是那条「拖完那一下不算点击」之外的正常路径
					document.getElementById('jar-head').click()
					if (jarWin.classList.contains('collapsed')) {
						return { ok: false, reason: '点了标题条，罐中果蝇小窗没有展开' }
					}
					document.getElementById('jar-head').click()
					if (!jarWin.classList.contains('collapsed')) {
						return { ok: false, reason: '再点一次标题条，罐中果蝇小窗没有收起' }
					}

					// ⚠ 层级：小窗必须盖过工具栏面板（两者都可能停在同一块地方）。
					// 和捐款卡片那条一样 —— 漏写 z-index 不会有任何别的症状
					const jarZ = getComputedStyle(jarWin).zIndex
					const panelZ = getComputedStyle(document.getElementById('panel')).zIndex
					if (!(Number(jarZ) > (panelZ === 'auto' ? 0 : Number(panelZ)))) {
						return {
							ok: false,
							reason: '罐中果蝇小窗的 z-index（' + jarZ + '）没有高过面板（' + panelZ + '）',
						}
					}

					// 藏起来的时候不能接管鼠标 —— display:none 的元素 rect 是 0×0 的，
					// _overJarWindow 里那道 .hidden 检查就是防这个
					const savedM = { x: pet.view.mouse.x, y: pet.view.mouse.y }
					pet.view.mouse.x = 0
					pet.view.mouse.y = 0
					pet.ui._updateInteractive()
					if (pet.ui.interactive) {
						return { ok: false, reason: '罐中果蝇小窗（收起时只有标题条）不该在 (0,0) 处接管鼠标' }
					}
					pet.view.mouse.x = savedM.x
					pet.view.mouse.y = savedM.y

					// 把罐子挪到一只果蝇头上再网，不然网可能空
					jar.x = w2.flies[0].x
					jar.y = w2.flies[0].y
					if (w2.catchFlies(jar.x, jar.y) < 1) return { ok: false, reason: '捕虫网没网到果蝇' }

					// 罐子里有果蝇了，真的画一帧。
					// 上面那次 draw 是在放罐子之前画的，走不到 drawJar ——
					// 里面的笔误（seeded 参数写错、渐变 stop 越界、罐中果蝇忘了加罐心偏移）
					// 都要真画过才会暴露，而这类问题只在肉眼下才看得出来
					pet.renderer.draw(w2, pet.view)
					pet.view.tool = 'net'
					pet.renderer.draw(w2, pet.view) // 连捕虫网的光标一起画
					pet.view.tool = 'none'

					pet.ui.refreshJarList()
					const rows = document.querySelectorAll('#jar-list .jar-row')
					if (rows.length !== jar.flies.length) {
						// 用字符串拼接，不能用模板字符串 ——
						// 这整段代码本身就住在一个模板字符串里，内层的反引号
						// 会把外层提前闭合掉，主进程直接报语法错误（而且报的是
						// 「App threw an error during load」，很难联想到是这里）
						return { ok: false, reason: '列表行数 ' + rows.length + ' 与罐中果蝇数 ' + jar.flies.length + ' 对不上' }
					}

					// 断言「点一行放逐，罐中数量恰好减一」，而不是「减到零」——
					// 网的半径有 62px，周围如果恰好还有别的果蝇，一次能网到好几只。
					// 早先这里写的是 !== 0，等于假设了一网只中一只，
					// 于是每跑若干次就会因为「网到两只」而误报一次
					const jarredBefore = jar.flies.length
					rows[0].querySelector('.jar-drop').click()
					if (jar.flies.length !== jarredBefore - 1) {
						return {
							ok: false,
							reason: '点了「放逐」但罐中数量没有减一（' + jarredBefore + ' → ' + jar.flies.length + '）',
						}
					}
					pet.ui.refreshJarList()
					if (document.querySelectorAll('#jar-list .jar-row').length !== jar.flies.length) {
						return { ok: false, reason: '放逐之后列表行数没有跟着减' }
					}

					// ⚠⚠ 「闪烁 + 点了没反应」那条 bug 的守卫。
					//
					// refreshJarList 是 6~7Hz 跑的，原来它每跑一次就把**所有行**
					// 摘下再插回一遍，于是 :hover 反复丢失（闪），而且「摘下 → 插回」
					// 之间赶上 mouseup 时 click 会落到容器上（点了没反应）。
					//
					// 断言写法：连着刷两次，**行的 DOM 节点必须是同一个对象**。
					// 比截图比对可靠得多 —— 截图在这台机器上本来就截不稳
					pet.ui.refreshJarList()
					const rowsA = Array.from(document.querySelectorAll('#jar-list .jar-row'))
					pet.ui.refreshJarList()
					const rowsB = Array.from(document.querySelectorAll('#jar-list .jar-row'))
					if (rowsA.length !== rowsB.length) {
						return { ok: false, reason: '连着刷两次列表，行数变了' }
					}
					for (let i = 0; i < rowsA.length; i++) {
						if (rowsA[i] !== rowsB[i]) {
							return {
								ok: false,
								reason: '刷新时行被重建了（第 ' + (i + 1) + ' 行不是同一个节点）—— 顺序没变就不该碰 DOM',
							}
						}
					}
					// 顺序和当前 DOM 不一致时才该重排：把第一行挪到最后，
					// 下一次刷新必须把它挪回来
					if (rowsB.length >= 2) {
						const first = rowsB[0]
						document.getElementById('jar-list').appendChild(first)
						pet.ui.refreshJarList()
						const rowsC = Array.from(document.querySelectorAll('#jar-list .jar-row'))
						if (rowsC[0] !== first) {
							return { ok: false, reason: '顺序被外力打乱之后，刷新没有把它排回去' }
						}
					}

					w2.discardJar(jar)
					pet.ui.refreshJarList()
					if (!document.getElementById('jar-window').classList.contains('hidden')) {
						return { ok: false, reason: '罐子扔掉之后罐中果蝇小窗没有收起' }
					}
				} catch (e) {
					return { ok: false, reason: '玻璃罐流程失败: ' + e.message }
				}

				// —— 观察模式下也能拖玻璃罐 ——
				//
				// 这条以前是**反过来**的：观察模式纯看、什么都不接管，
				// 想动手必须先切手套。现在罐子放开了，代价是指针停在罐子上时
				// 窗口会接管鼠标、吃掉罐子底下的桌面点击 —— 所以判定区
				// **一个像素都不许外扩**，下面第二条断言就是钉这个的
				try {
					const w3 = pet.world
					w3.jars.length = 0
					const probeJar = w3.addJar(window.innerWidth * 0.5, window.innerHeight * 0.5)
					if (!probeJar) return { ok: false, reason: '探针罐子没造出来' }

					pet.ui.setTool('none')
					const savedM = { x: pet.view.mouse.x, y: pet.view.mouse.y }

					// 1) 指针在罐心 → 必须接管，否则 mousedown 根本传不进来
					pet.view.mouse.x = probeJar.x
					pet.view.mouse.y = probeJar.y
					pet.ui._updateInteractive()
					if (!pet.ui.interactive) {
						return {
							ok: false,
							reason: '观察模式下指针在玻璃罐上却没有接管鼠标 —— 那样罐子拖不动',
						}
					}

					// 2) _grabbableAt 必须真的认它（接管判定和拖拽判定共用一个真值来源）
					const grab = pet.ui._grabbableAt()
					if (!grab || grab.kind !== 'jar' || grab.item !== probeJar) {
						return { ok: false, reason: '观察模式下 _grabbableAt 没认出玻璃罐' }
					}

					// 3) **反向守卫**：食物不行。这条是防止将来有人把闸门整个拿掉 ——
					// 那样屏幕会被几十个判定区打成筛子，而这不会有任何报错
					const probeFood = w3.addFood(30, 30, 'apple')
					if (probeFood) {
						pet.view.mouse.x = probeFood.x
						pet.view.mouse.y = probeFood.y
						pet.ui._updateInteractive()
						if (pet.ui.interactive) {
							return {
								ok: false,
								reason: '观察模式下指针压在食物上也接管了鼠标 —— 能放开的只有玻璃罐',
							}
						}
					}

					// 4) 指针移开罐子 → 鼠标要还回去
					//
					// ⚠ 挪到的那个点必须**先证明它不在别的接管区里**，
					// 否则这条断言测的就不是罐子了。第一版挪到罐子右边 137px，
					// 而那里正好压在工具栏面板上 —— 面板接管鼠标是对的，
					// 断言却报「离开罐子还接管着」，白红一场
					pet.view.mouse.x = 40
					pet.view.mouse.y = 40
					pet.ui._updateInteractive()
					if (pet.ui._overPanel() || pet.ui._overJarWindow() || pet.ui._overCard()) {
						return { ok: false, reason: '自检的探针点 (40,40) 落在了别的接管区里，这条断言不成立' }
					}
					if (pet.ui._overGrabbable()) {
						return { ok: false, reason: '指针已经离开玻璃罐，_overGrabbable 却还是 true' }
					}
					if (pet.ui.interactive) {
						return { ok: false, reason: '指针离开玻璃罐之后鼠标还被接管着' }
					}

					pet.view.mouse.x = savedM.x
					pet.view.mouse.y = savedM.y
					pet.ui._updateInteractive()
					w3.jars.length = 0
					w3.foods.length = 0
				} catch (e) {
					return { ok: false, reason: '观察模式拖罐流程失败: ' + e.message }
				}

				// —— 商店：可升级链 + 捕虫网 ——
				try {
					const w4 = pet.world
					const chain = pet.config.market.roastChain
					// 从干净状态开始，免得受前面几段的影响。
					// ⚠ 但**结束时要原样还回去** —— 这一段会买下捕虫网，
					// 而后面「工具按钮」那一节断言的正是「还没买捕虫网 = 锁定态」。
					// 自己造的脏状态自己不收拾，就会变成一条和本段毫无关系的红
					const savedShop = { ...w4.shop }
					const savedMoney = w4.money
					w4.shop = {}
					w4.money = 0
					pet.ui.setTool('none')
					pet.ui.refreshShop()
					pet.ui.refreshToolButtons()

					// 钱不够：按钮必须置灰，而且点了不能扣款、不能升级
					const rows = Array.from(document.querySelectorAll('#shop-list .shop-item'))
					const chainRow = rows.find((r) => r.querySelector('[data-chain="roast"]'))
					if (!chainRow) return { ok: false, reason: '商店里没有烤制升级链那一行' }
					const chainBtn = chainRow.querySelector('[data-chain="roast"]')
					if (!chainBtn.disabled) {
						return { ok: false, reason: '钱为 0 时升级按钮没有置灰' }
					}
					chainBtn.click()
					if (w4.shopLevel('roast') !== 0) {
						return { ok: false, reason: '置灰的升级按钮居然真的升了级' }
					}

					// 钱够了就能升，而且逐级扣款
					w4.money = chain.reduce((n, t) => n + t.price, 0)
					w4.money = 100
					pet.ui.refreshShop()
					pet.ui.refreshToolButtons()
					const before = w4.money
					/** @type {HTMLElement} */
					const btnNow = document.querySelector('#shop-list [data-chain="roast"]')
					btnNow.click()
					if (w4.shopLevel('roast') !== 1) {
						return { ok: false, reason: '钱够时点了升级，等级却是 ' + w4.shopLevel('roast') }
					}
					if (Math.abs(before - w4.money - chain[0].price) > 1e-9) {
						return { ok: false, reason: '升级扣款数不对：' + (before - w4.money) }
					}

					// —— 点火的两颗按钮：买到哪档就点亮哪颗 ——
					//
					// ⚠ 从 1.18.0 起，打火机和喷火枪是**两颗独立的按钮**
					//   （不再是一颗「烤制」跟着档位改名）。两颗**一直显示**，
					//   没买只是加上 locked 这个类 —— 「买过才出现」那种做法
					//   会让按钮在工具栏里进进出出，位置来回跳
					//
					// ⚠ 写注释时**别用反引号**：这一整段住在一个模板字符串里，
					//   一个反引号就会把它从中间截断，后面的中文会被当成代码求值，
					//   报出来是「xxx is not a function」这种完全指错方向的消息。
					//   这个坑这个项目已经踩过七次了
					pet.ui.refreshToolButtons()
					const lighterBtn = document.getElementById('btn-lighter')
					const flamerBtn = document.getElementById('btn-flamer')
					if (!lighterBtn || !flamerBtn) {
						return { ok: false, reason: '工具栏里找不到打火机 / 喷火枪那两颗按钮' }
					}
					// 单一那颗「烤制」必须已经不在了 —— 钉住旧结构被彻底换掉
					if (document.getElementById('btn-roast') !== null) {
						return { ok: false, reason: '旧的单一「烤制」按钮还在，应该已经换成打火机 + 喷火枪两颗' }
					}
					if (lighterBtn.classList.contains('hidden') || flamerBtn.classList.contains('hidden')) {
						return { ok: false, reason: '点火的两颗按钮不该带 hidden（没买只该是 locked）' }
					}
					// lv1：打火机解锁，喷火枪**仍然锁着**
					if (lighterBtn.classList.contains('locked')) {
						return { ok: false, reason: '买了打火机，打火机那颗按钮还是锁定态' }
					}
					if (!flamerBtn.classList.contains('locked')) {
						return { ok: false, reason: '才 lv1 喷火枪就解锁了 —— 它是链条的第二级，应当还锁着' }
					}

					// 闸门：打火机切得过去，喷火枪切不过去
					pet.ui.setTool('lighter')
					if (pet.view.tool !== 'lighter') {
						return { ok: false, reason: '买了打火机却切不到打火机工具' }
					}
					pet.ui.setTool('flamer')
					if (pet.view.tool === 'flamer') {
						return { ok: false, reason: '还没升级到喷火枪，却切过去了 —— setTool 的拥有权闸门没生效' }
					}
					pet.ui.setTool('none')

					// 一路升到满级
					w4.money = 1000
					for (let i = w4.shopLevel('roast'); i < chain.length; i++) {
						pet.ui.refreshShop()
						const b = document.querySelector('#shop-list [data-chain="roast"]')
						if (!b) return { ok: false, reason: '升到第 ' + (i + 1) + ' 级时商店里没有升级按钮了' }
						b.click()
					}
					pet.ui.refreshToolButtons()
					// 满级之后两颗都该解锁
					if (flamerBtn.classList.contains('locked')) {
						return { ok: false, reason: '升到喷火枪了，那颗按钮还是锁定态' }
					}
					pet.ui.setTool('flamer')
					if (pet.view.tool !== 'flamer') {
						return { ok: false, reason: '升级到喷火枪之后切不过去 —— 闸门算错了等级' }
					}
					pet.ui.setTool('none')

					// —— 老存档里的越界等级：链被改短之后不能把整个渲染循环炸掉 ——
					//
					// 1.18.0 **真实踩过**这个坑：烤制链从三档砍到两档（烤炉出链、
					// 变成投放里 $5 的商品），而 1.17 写下的存档里是 shop.roast: 3。
					// ui._chainRow 里那句 chain[lv - 1].name 于是读到 undefined 并抛
					// TypeError —— 而那一行跑在**渲染循环里**
					// （ui.update → refreshStats → refreshShop），一抛，
					// 主循环就再也排不上下一帧。玩家的表现是
					// 「读档之后屏幕上一个生物都没有」，而且不弹任何错误。
					//
					// 这里真的把等级设成越界值，再让商店**真的重建一次**
					w4.shop.roast = chain.length + 1
					try {
						pet.ui.refreshShop()
						pet.ui.refreshToolButtons()
					} catch (e) {
						return {
							ok: false,
							reason: '等级越界时重建商店抛异常了（读档空屏就是这么来的）: ' + e.message,
						}
					}
					const staleBtn = document.querySelector('#shop-list [data-chain="roast"]')
					if (!staleBtn) return { ok: false, reason: '等级越界时商店里那一行整个没了' }
					const staleName = staleBtn.closest('.shop-item').querySelector('.shop-name').textContent
					// 夹回链长之后应当显示**最后一档**的名字，绝不是 undefined / 空串
					const lastTierName = chain[chain.length - 1].name
					if (!staleName || staleName.indexOf(lastTierName) !== 0) {
						return {
							ok: false,
							reason: '等级越界时那一行显示的是「' + staleName + '」，应当是「' + lastTierName + '」',
						}
					}
					// 两颗点火按钮也不该被越界等级弄崩（lv 夹成 2 = 两颗都解锁）
					if (flamerBtn.classList.contains('locked')) {
						return { ok: false, reason: '越界等级让喷火枪又变回锁定态了' }
					}

					// 捕虫网：买之前锁定、买之后解锁
					w4.shop = {}
					pet.ui.refreshToolButtons()
					if (!document.getElementById('btn-net').classList.contains('locked')) {
						return { ok: false, reason: '还没买捕虫网，按钮却没有锁定态' }
					}
					w4.money = 10
					if (!w4.buyShopItem('net')) return { ok: false, reason: '买捕虫网失败了' }
					pet.ui.refreshToolButtons()
					if (document.getElementById('btn-net').classList.contains('locked')) {
						return { ok: false, reason: '买了捕虫网之后按钮还是锁定态' }
					}
					pet.ui.setTool('net')
					if (pet.view.tool !== 'net') {
						return { ok: false, reason: '买了捕虫网却切不到捕虫网工具' }
					}

					// 收拾干净：等级、钱、手里的工具全部还原。
					// 后面还有别的断言在跑，不能把「已经买过了」这种状态留给他们
					pet.ui.setTool('none')
					w4.shop = savedShop
					w4.money = savedMoney
					pet.ui.refreshShop()
					pet.ui.refreshToolButtons()
				} catch (e) {
					return { ok: false, reason: '商店升级链流程失败: ' + e.message }
				}

				// —— 设置卡：正常 / 烦人模式 ——
				try {
					const w5 = pet.world
					const CFG = pet.config
					const savedAnnoying = w5.settings.annoying

					w5.settings.annoying = false
					if (w5.maxAdults !== CFG.world.maxAdults) {
						return { ok: false, reason: '正常模式下 maxAdults 不等于配置值' }
					}

					// 开卡 → 点「烦人模式」
					pet.ui.setSettingsOpen(true)
					if (document.getElementById('settings-pop').classList.contains('hidden')) {
						return { ok: false, reason: 'setSettingsOpen(true) 之后设置卡还是隐藏的' }
					}
					const annoyingBtn = document.getElementById('mode-annoying')
					if (!annoyingBtn) return { ok: false, reason: '#mode-annoying 不存在' }
					annoyingBtn.click()
					if (!w5.settings.annoying) {
						return { ok: false, reason: '点了「烦人模式」但设置没切过去' }
					}
					if (w5.maxAdults !== CFG.world.maxAdults * CFG.world.annoyingMul) {
						return {
							ok: false,
							reason: '烦人模式下 maxAdults 是 ' + w5.maxAdults + '，应当是 ' + CFG.world.maxAdults * CFG.world.annoyingMul,
						}
					}
					// 选中态要真的反映在 DOM 上（不然玩家看不出现在是哪一档）
					if (!annoyingBtn.classList.contains('on')) {
						return { ok: false, reason: '切到烦人模式后按钮没有选中态' }
					}

					// ⚠ 「烦人模式」四个字必须是红的 —— 用户点名要的。
					// 量的是 getComputedStyle，不是类名：类名对了但 CSS 没写，照样不红
					const nameEl = annoyingBtn.querySelector('.mode-name')
					const nameColor = getComputedStyle(nameEl).color
					// #ff5b4a → rgb(255, 91, 74)
					if (nameColor !== 'rgb(255, 91, 74)') {
						return {
							ok: false,
							reason: '「烦人模式」的字色是 ' + nameColor + '，应当是红色 rgb(255, 91, 74)',
						}
					}

					// 总数硬闸：烦人模式下不该超过 annoyingTotalCap
					const capped = w5.livingCount <= CFG.world.annoyingTotalCap || w5.atPopCap
					if (!capped) {
						return { ok: false, reason: '烦人模式的生命体总数突破了硬闸' }
					}

					// 切回正常：上限要**立刻**回去，而且场上多出来的不杀
					const aliveBefore = w5.livingCount
					document.getElementById('mode-normal').click()
					if (w5.settings.annoying) return { ok: false, reason: '点了「正常模式」但没切回去' }
					if (w5.maxAdults !== CFG.world.maxAdults) {
						return { ok: false, reason: '切回正常模式后 maxAdults 没有还原' }
					}
					if (w5.livingCount < aliveBefore) {
						return {
							ok: false,
							reason: '切回正常模式时把超出上限的果蝇杀掉了 —— 上限只该拦新增，不该清场',
						}
					}

					pet.ui.setSettingsOpen(false)
					w5.settings.annoying = savedAnnoying
					pet.ui.refreshSettings()
				} catch (e) {
					return { ok: false, reason: '设置卡流程失败: ' + e.message }
				}

				// —— 设置卡：版本号 + 检查更新 ——
				//
				// ⚠ 这一段**不碰外网**，打的是主进程刚起的那个本地小服务器
				//   （地址从 window.__selftestUpdateBase 拿）。用真网址试的话，
				//   没网的机器上必红，而且对方一改内容也会红。
				//
				// ⚠ 也**不点**「去下载」那颗按钮 —— 点下去会真的弹出浏览器。
				//   能验的是「它该出现时出现、该收起时收起、地址记对了」
				let updateInfo = null
				try {
					const ui = pet.ui
					const U = pet.config.update
					if (!U || U.manifestUrl === undefined) {
						return { ok: false, reason: 'config 里没有 update 块 —— 设置卡上那一行整个是死的' }
					}
					const elBtn = document.getElementById('update-check')
					const elMsg = document.getElementById('update-msg')
					const elGet = document.getElementById('update-get')
					const elVer = document.getElementById('update-version')
					if (!elBtn || !elMsg || !elGet || !elVer) {
						return { ok: false, reason: '设置卡里检查更新那四个节点不全 —— index.html 和 ui._cacheDom 对不上' }
					}
					// ① 版本号：启动时搭 pet:get-state 那趟车回来的。
					//    ⚠ 这里**自己 await 一次**，不靠构造函数里那一次 ——
					//      那是「发射后不管」的，自检跑到这儿时它未必回来了
					await ui._syncWindowState()
					//    ⚠ **别写正则**：这整段脚本是套在模板字面量里的，
					//      正则里的 \d 到了渲染进程已经变成普普通通的 d
					//      （模板字面量会把不认识的反斜杠转义吃掉），
					//      于是 /版本 \d+\.\d+\.\d+/ 永远匹配不上，而报错只说
					//      「版本号没读到」—— 查起来会以为是 IPC 断了
					const vtext = elVer.textContent
					const vparts = vtext.startsWith('版本 ') ? vtext.slice(3).split('.') : []
					const looksLikeVersion = vparts.length === 3 && vparts.every((p) => /^[0-9]+$/.test(p))
					if (!looksLikeVersion) {
						return { ok: false, reason: '设置卡上的版本号是「' + vtext + '」，没读到（应当是「版本 x.y.z」）' }
					}
					updateInfo = { version: vparts.join('.') }

					const base = String(window.__selftestUpdateBase || '')
					if (!base) return { ok: false, reason: '自检没拿到本地测试服务器的地址' }

					const savedUrl = U.manifestUrl
					const savedPage = U.downloadPage
					try {
						// ② 清单里的版本更新 → 提示 + 冒出「去下载」
						U.downloadPage = ''
						U.manifestUrl = base + '/newer.json'
						await ui.checkUpdate(false)
						if (elMsg.textContent.indexOf('99.0.0') < 0) {
							return {
								ok: false,
								reason: '拿到更新的清单却没提示新版本号，那一行写的是「' + elMsg.textContent + '」',
							}
						}
						if (!elMsg.classList.contains('has-new')) {
							return { ok: false, reason: '有新版本时那一行没有加亮（.has-new）—— 和「已是最新」看着一模一样' }
						}
						// ⚠ 量 **computedStyle** 而不是 classList：这个项目里
						//   **没有**通用的 .hidden{display:none}，每个 .hidden 都是
						//   各自限定作用域的（见 style.css 那段注释）。光有类名而
						//   漏了规则的话，按钮会从一开始就挂在卡片上、点了没反应 ——
						//   而只查 classList 是照样绿的
						if (getComputedStyle(elGet).display === 'none') {
							return { ok: false, reason: '有新版本、清单里也给了 url，「去下载」却没出现' }
						}
						if (ui._pendingDownload !== base + '/dl') {
							return {
								ok: false,
								reason: '「去下载」记的地址是「' + ui._pendingDownload + '」，应当优先用清单里的 url',
							}
						}

						// ②-b 配了**一串**地址时按顺序试：第一个是死链，
						//      必须自动退到第二个，而不是就此认输。
						//      ⚠ 这条守的是国内那个真实处境：raw 连不上、
						//        jsDelivr 连得上，两个都配着才能用
						U.manifestUrl = [base + '/nope.json', base + '/newer.json']
						await ui.checkUpdate(false)
						if (elMsg.textContent.indexOf('99.0.0') < 0) {
							return {
								ok: false,
								reason: '第一个清单地址是死链时没有自动试第二个，那一行写的是「' + elMsg.textContent + '」',
							}
						}
						if (ui._pendingDownload !== base + '/dl') {
							return { ok: false, reason: '退到第二个地址之后，下载地址没有跟着用第二个清单里的' }
						}

						// ②-c 全是死链 → 要说清楚**试过几个**，
						//      不然作者会以为只试了一个
						U.manifestUrl = [base + '/nope.json', base + '/html']
						await ui.checkUpdate(false)
						if (elMsg.textContent.indexOf('2 个地址都试过了') < 0) {
							return {
								ok: false,
								reason: '两个地址全挂了，那一行写的是「' + elMsg.textContent + '」—— 应当说明试过几个',
							}
						}

						// ③ 清单里没给 url → 退回配置里的兜底页
						U.downloadPage = base + '/fallback'
						U.manifestUrl = base + '/newer-nourl.json'
						await ui.checkUpdate(false)
						if (ui._pendingDownload !== base + '/fallback') {
							return {
								ok: false,
								reason: '清单里没给 url 时没有退回 downloadPage，记的是「' + ui._pendingDownload + '」',
							}
						}

						// ④ 地址无效（给了一个不是网址的兜底页）→ 要明说，而不是留一颗点了没反应的按钮
						U.downloadPage = '这不是网址'
						await ui.checkUpdate(false)
						if (getComputedStyle(elGet).display !== 'none') {
							return { ok: false, reason: '清单和兜底页都没给出可用地址，「去下载」却还亮着 —— 点下去不会有事发生' }
						}
						if (elMsg.textContent.indexOf('99.0.0') < 0) {
							return { ok: false, reason: '没有可用下载地址时，那一行应当仍然说清楚有新版本，现在写的是「' + elMsg.textContent + '」' }
						}

						// ⑤ 版本更旧 → 「已经是最新的」，而且上一次那颗按钮要收回去
						U.manifestUrl = base + '/older.json'
						await ui.checkUpdate(false)
						if (elMsg.textContent.indexOf('最新的') < 0) {
							return {
								ok: false,
								reason: '清单版本比当前旧，却没提示「已经是最新的」，写的是「' + elMsg.textContent + '」',
							}
						}
						if (getComputedStyle(elGet).display !== 'none') {
							return { ok: false, reason: '这次没有新版本了，「去下载」还挂在那儿 —— 点下去会开到上一个版本的地址' }
						}
						if (ui._pendingDownload) {
							return { ok: false, reason: '没有新版本了，却还留着上一次的下载地址' }
						}

						// ⑥ 404 → 翻成人话。
						//    ⚠ 这条同时守着 checkUpdate 里那个加号 / 双问号的优先级坑：
						//      写成「加号拼 UPDATE_FAIL[reason]，再接双问号兜底」的话，
						//      加号结合得更紧、双问号永远不触发；而 UPDATE_FAIL
						//      里没有 'http-404' 这个键 —— 显示出来就是「检查失败：undefined」
						U.manifestUrl = base + '/nope.json'
						await ui.checkUpdate(false)
						if (elMsg.textContent.indexOf('404') < 0 || elMsg.textContent.indexOf('http-404') >= 0) {
							return {
								ok: false,
								reason: '404 时那一行写的是「' + elMsg.textContent + '」—— 玩家看不懂，应当说「对方返回了 HTTP 404」',
							}
						}

						// ⑦ 地址是空的 = 功能关掉：按钮禁用，但**要说出来**。
						//    藏起来的话，作者本人在开发时看不出这条没接上
						U.manifestUrl = ''
						await ui.checkUpdate(false)
						if (!elBtn.disabled) {
							return { ok: false, reason: '没配更新地址，那颗「检查更新」却是可点的 —— 点下去只会白闪一下' }
						}
						if (!elMsg.textContent) {
							return { ok: false, reason: '没配更新地址时设置卡上一个字都不写，玩家只会以为按钮是坏的' }
						}
					} finally {
						// 自己造的脏状态自己收拾（这里改的是**配置对象本身**，
						// 后面还有好几段要读 config）
						U.manifestUrl = savedUrl
						U.downloadPage = savedPage
						ui._pendingDownload = null
						elGet.classList.add('hidden')
					}

					// ⑧ 协议白名单 —— **安全**断言，不是功能断言。
					//    openExternal 的地址是页面那层递过来的，而页面是会被 XSS
					//    影响的那一层；放行 file: 就等于页面能开任何本地文件
					for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:']) {
						const r = await window.pet.openExternal(bad)
						if (r && r.ok) {
							return { ok: false, reason: 'openExternal 放行了 ' + bad + ' —— 页面那层能拿它去开任何本地文件' }
						}
					}
				} catch (e) {
					return { ok: false, reason: '检查更新流程失败: ' + e.message }
				}

				// —— 重置：**三道**确认，一道比一道重 ——
				//
				// 三条不变式贯穿全程，每一步都要查：
				//   · 钱（world）没动 —— 前三道里任何一下点击都不该清世界
				//   · 图鉴没动 —— 同理
				//   · 走到哪一道，就只有那一张卡是开着的
				try {
					const w6 = pet.world
					const step = () => pet.view.resetStep
					const shown = (id) => !document.getElementById(id).classList.contains('hidden')
					const cardsOpen = () =>
						['reset-pop', 'reset-pop2', 'reset-pop3'].filter(shown)

					// 造一个「重置一定会抹掉」的标记
					const beforeMoney = w6.money
					const beforeSeen = pet.ui._seenGenes.slice()
					// ⚠ 成就也要一起抓一份 —— 重置会把它清掉，而下面的断言还要用
					const beforeAch = pet.ui._achievements.slice()
					w6.money = 12.345
					pet.ui._seenGenes = ['crystal', 'berserk']
					pet.ui._achievements = ['crystal', 'wealth10']
					const jarCount = w6.jars.length

					// 三道卡必须都在 _overCard 的名单里 ——
					// 漏一张的症状是「卡画得好好的，但点上去穿到桌面、按钮全点不动」
					const overCardSrc = pet.ui._overCard.toString()
					for (const id of ['resetPop', 'resetPop2', 'resetPop3']) {
						if (!overCardSrc.includes('this.el.' + id)) {
							return { ok: false, reason: '重置卡 ' + id + ' 不在 _overCard 的名单里 —— 它会点不动' }
						}
					}

					// —— 第一道 ——
					document.getElementById('btn-reset').click()
					if (cardsOpen().join() !== 'reset-pop') {
						return { ok: false, reason: '点了重置，开着的却是 ' + JSON.stringify(cardsOpen()) }
					}
					if (w6.money !== 12.345 || w6.jars.length !== jarCount) {
						return { ok: false, reason: '刚到第一道卡，世界就已经被清空了' }
					}

					// 「取消」应当什么都不做
					document.getElementById('reset-cancel').click()
					if (cardsOpen().length !== 0 || step() !== 0) {
						return { ok: false, reason: '点了「取消」三道卡没有全部关掉' }
					}
					if (w6.money !== 12.345) {
						return { ok: false, reason: '点了「取消」却还是清档了' }
					}

					// —— 第二道 ——
					document.getElementById('btn-reset').click()
					document.getElementById('reset-ok').click()
					if (cardsOpen().join() !== 'reset-pop2') {
						return { ok: false, reason: '第一道的「我知道了」没有走到第二道：' + JSON.stringify(cardsOpen()) }
					}
					if (w6.money !== 12.345 || w6.jars.length !== jarCount) {
						return { ok: false, reason: '走到第二道就把世界清了 —— 清空只该发生在第三道之后' }
					}
					document.getElementById('reset-cancel2').click()
					if (cardsOpen().length !== 0) {
						return { ok: false, reason: '第二道点「还是算了」没有全部关掉' }
					}

					// —— 第三道 ——
					document.getElementById('btn-reset').click()
					document.getElementById('reset-ok').click()
					document.getElementById('reset-ok2').click()
					if (cardsOpen().join() !== 'reset-pop3') {
						return { ok: false, reason: '第二道的「确定要重置」没有走到第三道' }
					}
					if (w6.money !== 12.345 || w6.jars.length !== jarCount) {
						return { ok: false, reason: '走到第三道就把世界清了 —— 第三道才是那道门' }
					}

					// 还没打字 → 确定按钮必须**点不动**。
					// ⚠ 这是整个三道设计里唯一的硬门槛，写松了前面两道就白做
					const typed = document.getElementById('reset-typed')
					const ok3 = document.getElementById('reset-ok3')
					if (!ok3.disabled) {
						return { ok: false, reason: '第三道还没打字，「确定重置」就已经可以点了' }
					}
					// 打错也要挡住
					typed.value = '重来'
					typed.dispatchEvent(new Event('input', { bubbles: true }))
					if (!ok3.disabled) {
						return { ok: false, reason: '第三道打错字（「重来」）也能点确定' }
					}
					// 打对才放行
					typed.value = '重置'
					typed.dispatchEvent(new Event('input', { bubbles: true }))
					if (ok3.disabled) {
						return { ok: false, reason: '第三道打对了「重置」，「确定重置」却还是灰的' }
					}

					// —— ⚠ 在输入框里按键**不能**换掉手里的工具 ——
					//
					// 这条守的是一个很容易漏、又很难自查的坑：keydown 挂在 window 上，
					// 而工具快捷键是裸字母。用拼音打「重置」会经过 chongzhi，
					// 里面的 c（抹布）、g（手套）、b（扫帚）、w（喷水枪）、r（打火机）
					// 全都会命中 —— 玩家一边打字一边把手里的工具换个遍
					//
					// ⚠ 派发时 target 必须是**输入框自己**（dispatchEvent 在谁身上、
					//   target 就是谁），而且必须 bubbles —— 真实按键就是这样
					//   一路冒泡到 window 上的
					{
						const before = pet.view.tool
						for (const code of ['KeyC', 'KeyG', 'KeyB', 'KeyW', 'KeyR']) {
							typed.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3), bubbles: true }))
						}
						if (pet.view.tool !== before) {
							return {
								ok: false,
								reason: '在重置的输入框里打字，手里的工具被换成了 ' + pet.view.tool +
									'（原来是 ' + before + '）—— 拼音打「重置」会一路触发工具快捷键',
							}
						}
					}

					ok3.click()
					if (w6.money !== 0) {
						return { ok: false, reason: '走过三道之后钱没有清零（现在是 ' + w6.money + '）' }
					}
					if (cardsOpen().length !== 0 || step() !== 0) {
						return { ok: false, reason: '重置完成后三道卡没有全部关掉' }
					}

					// —— 图鉴和彩蛋也必须一起回到 0 ——
					if (pet.ui._seenGenes.length !== 0) {
						return {
							ok: false,
							reason: '重置之后图鉴还有 ' + pet.ui._seenGenes.length + ' 格是亮的：' +
								JSON.stringify(pet.ui._seenGenes),
						}
					}
					const afterReset = await window.pet.loadUnlock()
					if (!afterReset || !afterReset.ok) {
						return { ok: false, reason: '重置之后读不回 unlock —— 那个文件可能被删了而不是清空' }
					}
					if (afterReset.data.star) {
						return { ok: false, reason: '重置之后彩蛋还是解锁状态 —— 应当锁回去' }
					}
					if (!Array.isArray(afterReset.data.seen) || afterReset.data.seen.length !== 0) {
						return {
							ok: false,
							reason: '重置之后 unlock.json 里的 seen 不是空的：' +
								JSON.stringify(afterReset.data.seen),
						}
					}
					// 成就也要一起回零（用户要的「重置 = 真的从 0」）
					if (pet.ui._achievements.length !== 0) {
						return {
							ok: false,
							reason: '重置之后还有 ' + pet.ui._achievements.length + ' 个成就是拿到的：' +
								JSON.stringify(pet.ui._achievements),
						}
					}
					if (!Array.isArray(afterReset.data.achievements) || afterReset.data.achievements.length !== 0) {
						return {
							ok: false,
							reason: '重置之后 unlock.json 里的 achievements 不是空的：' +
								JSON.stringify(afterReset.data.achievements),
						}
					}
					// 罐子的流光也要跟着回到「锁着」的配色
					if (!document.getElementById('btn-donate').classList.contains('locked')) {
						return { ok: false, reason: '重置之后捐款罐子没有回到「未解锁」的蓝紫配色' }
					}

					// —— 开局那几只不该带突变 ——
					//
					// ⚠ 这一条是「重置 = 图鉴从 0」能不能成立的关键：
					//   开局几只一出生就会走 addFly → _noteGenes，骰出什么就点亮什么。
					//   它们只要带突变，重置完图鉴立刻就是花的
					//
					// ⚠⚠ **必须跑很多次**，不能只看一次。
					//   开局只有十来只，每只带上突变的概率约 8.7%
					//   （四个 chance 的并集，即 1 - ∏(1-chance)），
					//   所以「一次性全野生型」的概率有 **四成左右** —— 只查一次的话，
					//   这条断言有四成的时候是**空转**的。
					//   实测：把 rollDeNovo() 加回 world.reset()，跑一次它照样绿
					//
					//   30 次 ≈ 三百多次骰子，至少中一次的概率是 1 - 0.913^300 ≈ 1，
					//   这才钉得住「开局一律野生型」
					let mutated = 0
					let rolled = 0
					for (let i = 0; i < 30; i++) {
						w6.reset()
						for (const c of w6.flies.concat(w6.larvae)) {
							rolled++
							if (c.mutations.length) mutated++
						}
					}
					if (mutated) {
						return {
							ok: false,
							reason:
								'重置投放的开局那几只带着突变（' + rolled + ' 只里中了 ' + mutated + ' 只）' +
								'—— 它们一出生就会把图鉴点亮，图鉴就不是从 0 开始了',
						}
					}
					if (w6.seenGenes.length) {
						return { ok: false, reason: '重置之后 world.seenGenes 还有残留：' + JSON.stringify(w6.seenGenes) }
					}

					// 把这一节造成的破坏还原，后面的断言还要用。
					// ⚠ 内存态和文件都要还原 —— 只改内存的话，后面某一条
					//   触发落盘时会拿这份内存去整份覆写，文件里就冒出一份
					//   「没重置过」的 seen，而那时世界已经重置了
					w6.money = beforeMoney
					pet.ui.setSeenGenes(beforeSeen)
					pet.ui.setAchievements(beforeAch)
					pet.ui._persistUnlock()
				} catch (e) {
					return { ok: false, reason: '重置确认流程失败: ' + e.message }
				}

				// —— 挥手惊蝇：观察模式下必须完全不生效 ——
				try {
					const w9 = pet.world
					const savedMouse2 = { x: pet.view.mouse.x, y: pet.view.mouse.y }
					const savedSample = { x: pet.ui.lastMouseSample.x, y: pet.ui.lastMouseSample.y }

					// 造一个「鼠标猛甩一下」的现场：把上一次采样点放到很远的地方，
					// 于是这一帧算出来的位移极大
					const fling = () => {
						pet.view.mouse.x = 900
						pet.view.mouse.y = 500
						pet.ui.lastMouseSample.x = 100
						pet.ui.lastMouseSample.y = 500
						pet.ui._updateStartle(1 / 60)
					}

					// ⚠⚠ **慢慢挪过去不能惊到它们。**
					//
					// 这是「玩家得抓得住它们」那条线：拿网罩、拿手套拎、拿拍子拍，
					// 都要先把手稳稳地移过去。没有这个死区的话，鼠标一动就惊飞，
					// 瞄准根本做不成 —— 第一次实测就是这个问题
					pet.ui.setTool('swatter')
					// ⚠ 渲染进程里没有裸的 CONFIG，配置挂在 pet.config 上
					const TOOLS = pet.config.tools
					const creepAt = (pxPerSec) => {
						pet.view.mouse.x = 900
						pet.view.mouse.y = 500
						// 让「上一帧的位置」正好落后 1/60 秒该走的距离
						pet.ui.lastMouseSample.x = 900 - pxPerSec / 60
						pet.ui.lastMouseSample.y = 500
						pet.ui.startle = 0 // 别让上一次的余韵混进来
						pet.ui._updateStartle(1 / 60)
						return pet.world.startle.power
					}
					const creep = TOOLS.startleWakeSpeed * 0.6
					if (creepAt(creep) !== 0) {
						return {
							ok: false,
							reason:
								'以 ' +
								Math.round(creep) +
								'px/s 慢慢挪过去也会惊到果蝇（强度 ' +
								pet.world.startle.power.toFixed(2) +
								'）—— 那样玩家完全没可能抓住它们',
						}
					}
					// 而全速甩必须到顶，别把死区做得把功能也一起吃了
					if (!(creepAt(TOOLS.startleFullSpeed * 2) > 0.9)) {
						return { ok: false, reason: '全速甩鼠标的惊扰强度没到顶 —— 死区把功能一起吃掉了' }
					}

					fling()
					if (!(pet.world.startle.power > 0.5)) {
						return {
							ok: false,
							reason: '拿着工具猛甩鼠标，惊扰强度却只有 ' + pet.world.startle.power.toFixed(2),
						}
					}
					// 指针正下方那只必须真的被加成
					const w10 = pet.world
					w10.flies.length = 0
					const victim2 = w10.addFly(900, 500, 'M')
					if (!victim2) return { ok: false, reason: '探针果蝇没造出来' }
					w10._applyStartle()
					if (!(victim2.startleMul > 1.5)) {
						return {
							ok: false,
							reason: '指针正下方的果蝇只有 ' + victim2.startleMul.toFixed(2) + ' 倍速 —— 惊扰没作用到移动上',
						}
					}

					// ⚠ 核心行为：受惊必须**真的飞走**，不能只是「飞得快一点」。
					// 悬停中的蝇在 _fly 里目标速度是 0，乘多少倍都还是 0 ——
					// 只乘速度的话，手从它身上扫过去它还在原地悬着
					w10.flies.length = 0
					const hoverer = w10.addFly(900, 500, 'F')
					if (!hoverer) return { ok: false, reason: '悬停探针没造出来' }
					hoverer.mode = 'fly'
					hoverer.hoverTimer = 5000
					fling()
					w10._applyStartle()
					if (hoverer.hoverTimer !== 0) {
						return { ok: false, reason: '悬停中的果蝇受惊之后还在悬停 —— 看起来就是「停在原地」' }
					}
					// 走路的那批要起飞
					hoverer.hoverTimer = 0
					hoverer.mode = 'walk'
					hoverer.pausing = true
					w10._applyStartle()
					if (hoverer.mode !== 'fly') {
						return { ok: false, reason: '走路的果蝇被惊到之后没有起飞' }
					}
					if (hoverer.pausing) {
						return { ok: false, reason: '受惊之后还停在原地「停顿」' }
					}

					// ⚠ 核心：观察模式下**一点都不能有**。
					// 这一档的定位就是「纯看不打扰」，鼠标扫过去炸开一屏果蝇的话，
					// 观察模式就没法看了
					pet.ui.setTool('none')
					fling()
					if (pet.world.startle.power !== 0) {
						return {
							ok: false,
							reason: '观察模式下惊扰强度是 ' + pet.world.startle.power + '，应当是 0',
						}
					}
					w10._applyStartle()
					// ⚠ 要用**还在 w10.flies 里**的那只。上面为了造悬停/走路的
					// 探针把数组清过一次，victim2 已经被摘出去了 ——
					// _applyStartle 只遍历 this.flies，碰不到它，
					// 于是它会一直保留上一次算出来的倍率，这条断言就变成了假红
					if (hoverer.startleMul !== 1) {
						return { ok: false, reason: '观察模式下果蝇还是被加成了速度' }
					}

					w10.flies.length = 0
					pet.ui.setTool('none')
					pet.view.mouse.x = savedMouse2.x
					pet.view.mouse.y = savedMouse2.y
					pet.ui.lastMouseSample.x = savedSample.x
					pet.ui.lastMouseSample.y = savedSample.y
					pet.world.startle.power = 0
				} catch (e) {
					return { ok: false, reason: '挥手惊蝇流程失败: ' + e.message }
				}

				// —— 苍蝇拍：杀伤点必须在**拍面**上，不在指针上 ——
				try {
					const CFG = pet.config
					// 通过 world.swat 的落点间接验证：拍一下，看 swings 记在哪儿。
					// 不断言 swatterHeadAt 本身 —— 那样测的是「函数等于它自己」；
					// 这里要钉的是「_useTool 真的用了它算出来的点」
					// ⚠ 这一段原来查的是「world.swings 里记下的落点 == 重算一遍
					//   swatterHeadAt 的结果」—— 那是在比断言自己的算术。
					//   挥拍动画（world.swings / drawSwing）随工具图案一起删掉之后，
					//   改成**摆两只虫看谁死**：杀伤点到底在哪儿，这才是端到端的问法
					const w7 = pet.world
					const savedMouse = { x: pet.view.mouse.x, y: pet.view.mouse.y }
					const savedFlies7 = w7.flies.slice()

					const PX = 800
					const PY = 400
					const head = pet.swatterHeadAt(PX, PY)
					w7.flies.length = 0

					// A 摆在拍面上（应当被打死）、B 摆在指针正下方（不该死）
					const onHead = w7.addFly(head.x, head.y, 'F')
					const onPointer = w7.addFly(PX, PY, 'M')
					if (!onHead || !onPointer) return { ok: false, reason: '造不出挥拍落点用的探针' }

					pet.view.mouse.x = PX
					pet.view.mouse.y = PY
					pet.ui.setTool('swatter')
					// ⚠ 冷却必须清零。前面几段可能就在 220ms 之内挥过一拍，
					//   不清的话这一下会被节流吃掉，报出来像「落点算错了」
					pet.ui.lastSwat = -1e9
					pet.ui._useTool()

					if (!onHead.dead) {
						return {
							ok: false,
							reason: '站在拍面上的果蝇没被打死 —— 杀伤点不在 swatterHeadAt 算出来的地方',
						}
					}
					if (onPointer.dead) {
						return {
							ok: false,
							reason: '站在指针正下方的果蝇被打死了 —— 杀伤点不该就在指针上（拍面在左上方）',
						}
					}
					// 挥拍反馈：得真的放出一圈粒子来（那是删掉虚线之后唯一的
					// 「打得到哪儿」提示）。命中时是暖色的那一圈
					if (w7.particles.length === 0) {
						return { ok: false, reason: '挥拍之后一颗粒子都没放 —— 删掉虚线圈之后就没有任何范围提示了' }
					}

					pet.ui.setTool('none')
					pet.view.mouse.x = savedMouse.x
					pet.view.mouse.y = savedMouse.y
					w7.flies.length = 0
					Array.prototype.push.apply(w7.flies, savedFlies7)
					w7.particles.length = 0
				} catch (e) {
					return { ok: false, reason: '苍蝇拍落点失败: ' + e.message }
				}

				// —— 点火：碰到**活蝇**就点着 ——
				//
				// ⚠ 从 1.18.0 起，打火机 / 喷火枪不再烤地上的尸体，而是点着活着的成虫。
				//   这一整段原来测的是「烤尸体」，现在换成「点火蝇」。
				//   数值结算（烧完自动卖、不留尸体、不计自然老死）在无头模拟器里
				//   逐条精确断言过了，这里测的是**窗口里那一套接线**：
				//   闸门、_useTool、尸体点不着
				try {
					const w8 = pet.world
					const chain = pet.config.market.roastChain
					w8.remains.length = 0
					w8.flies.length = 0
					w8.shop.roast = chain.length

					const f = w8.addFly(300, 300, 'F')
					if (!f) return { ok: false, reason: 'addFly 失败' }
					for (let i = 0; i < 600; i++) f.update(16, w8)

					// —— 一次 _useTool 就要点着，不许还要按住 ——
					//
					// ⚠ 这条走的是 UI 那一层（_useTool），不是直接调 world.ignite。
					//   直接调 world.ignite 是测不出「有没有还要按住」的 ——
					//   把「按住 N 秒」那种逻辑加回去，那种断言照样绿
					const mouseWas = { x: pet.view.mouse.x, y: pet.view.mouse.y }
					const toolWas = pet.view.tool
					pet.view.tool = 'lighter'
					pet.view.mouse.x = f.x
					pet.view.mouse.y = f.y
					pet.ui._useTool() // 只调**一次**，不累加任何时间
					if (!f.burning) {
						pet.view.tool = toolWas
						pet.view.mouse.x = mouseWas.x
						pet.view.mouse.y = mouseWas.y
						return {
							ok: false,
							reason: '指针碰到成虫那一下没有点着 —— 打火机应当是接触即燃，不该还要按住',
						}
					}
					if (f.burnMul !== chain[0].mul) {
						return { ok: false, reason: '点着时没有把打火机的倍率冻结在蝇身上' }
					}
					if (f.burnLeft !== chain[0].burnMs) {
						return { ok: false, reason: '燃烧时长不是打火机的 burnMs' }
					}

					// 反复蹭同一只不能把倒计时重置 —— 按住工具时 _useTool 每帧都跑
					const leftBefore = f.burnLeft
					pet.ui._useTool()
					if (f.burnLeft !== leftBefore) {
						pet.view.tool = toolWas
						pet.view.mouse.x = mouseWas.x
						pet.view.mouse.y = mouseWas.y
						return { ok: false, reason: '按住不放把燃烧倒计时重置了 —— 那样永远烧不完' }
					}

					// —— 地上的尸体现在**点不着** ——
					//
					// ⚠ 这一条钉的是「尸体不能再烤」这个新契约。少了它，
					//   谁把尸体那条路加回来都不会被发现
					const corpse = w8.addRemains(600, 300, 'corpse', f.size, 0, f)
					if (!corpse) return { ok: false, reason: 'addRemains 没造出尸体' }
					const fliesBefore = w8.flies.length
					pet.view.mouse.x = corpse.x
					pet.view.mouse.y = corpse.y
					pet.ui._useTool()
					if (corpse.burning) {
						return { ok: false, reason: '尸体被点着了 —— 点火器只该认活着的成虫' }
					}
					if (w8.flies.length !== fliesBefore) {
						return { ok: false, reason: '点火器把一只不在指针底下的蝇点着了 —— 判定半径太大' }
					}
					// 尸体还是只有原价这一档
					if (Math.abs(corpse.price - corpse.value * corpse.decayFactor) > 1e-9) {
						return { ok: false, reason: '尸体的价钱不等于「原价 × 掉价」—— 倍率那条路没删干净' }
					}

					// —— 喷火枪的判定半径**比打火机大一圈** ——
					//
					// ⚠ 「一小圈范围」这件事就是靠这两个数的差表达的：两把枪
					//   仍然是单目标，但喷火枪够得着得多。数值住在
					//   market.roastChain[].pickRadius 上
					//
					//   少了这条断言的话，谁把 pickRadius 抄成同一个数、
					//   或者干脆忘了给 flamer 写，都不会有人发现 ——
					//   症状只是「喷火枪好像没变大」，而那是主观的
					const rLight = w8.burnRadiusFor('lighter')
					const rFlame = w8.burnRadiusFor('flamer')
					if (!(rLight > 0) || !(rFlame > 0)) {
						return { ok: false, reason: '点火器的判定半径读出来是 ' + rLight + ' / ' + rFlame }
					}
					if (!(rFlame > rLight)) {
						return {
							ok: false,
							reason: '喷火枪的判定半径 ' + rFlame + ' 不比打火机的 ' + rLight + ' 大 —— 两把枪手感一样了',
						}
					}
					// 而且 UI 真的按**手里那把**去取，不是按等级取一个共用的
					const toolWas2 = pet.view.tool
					pet.view.tool = 'lighter'
					const uiR = w8.burnRadiusFor(pet.view.tool)
					pet.view.tool = 'flamer'
					const uiR2 = w8.burnRadiusFor(pet.view.tool)
					pet.view.tool = toolWas2
					if (uiR !== rLight || uiR2 !== rFlame) {
						return { ok: false, reason: '按手里那把取半径，拿到的却不是各自那个数' }
					}

					pet.view.tool = toolWas
					pet.view.mouse.x = mouseWas.x
					pet.view.mouse.y = mouseWas.y

					// 掉价：前 5 分钟不变，之后往下走
					const fresh = w8.addRemains(0, 0, 'corpse', 14, 0, f)
					if (Math.abs(fresh.decayFactor - 1) > 1e-9) {
						return { ok: false, reason: '刚留下的尸体就已经在掉价了' }
					}
					fresh.age = 20 * 60000
					if (Math.abs(fresh.decayFactor - pet.config.roast.decayTo) > 1e-9) {
						return { ok: false, reason: '掉价到底之后不是 ' + pet.config.roast.decayTo }
					}

					w8.remains.length = 0
					w8.flies.length = 0
					w8.shop.roast = 0
					w8.floatTexts.length = 0
					// ⚠ 上面那几次 _useTool 会走 refreshStats → refreshToolButtons，
					//   而那时候 shop.roast 还是满级 —— 两颗点火按钮于是被摘掉了 locked。
					//   把等级改回来**不会**自动同步 DOM，得显式再刷一次，
					//   否则后面「还没买打火机，两颗按钮应当都锁着」那条会红，
					//   而报出来的位置离真正的原因隔了好几屏
					pet.ui.refreshToolButtons()
				} catch (e) {
					return { ok: false, reason: '点火流程失败: ' + e.message }
				}

				// 先塞几只幼虫进去再画。
				// 开局是 0 只幼虫（world.initialLarvae = 0），不补的话
				// drawLarva 那整条分支 —— 现在的身体曲线、描边、蛹期外壳 ——
				// 一帧都不会被执行，等于没测
				const w1 = pet.world
				for (let i = 0; i < 3; i++) {
					w1.addLarva(window.innerWidth * 0.3 + i * 40, window.innerHeight * 0.4, null)
				}
				// 再来一只蛹：蛹走的是另一个绘制分支（扁长的椭圆 + 淡淡轮廓 + 壳面颗粒）
				const pupa = w1.addLarva(window.innerWidth * 0.5, window.innerHeight * 0.6, null)
				if (pupa) pupa.pupa = true

				// 一枚蛹壳：又是一个独立分支，不铺一枚的话 drawShell 一辈子不会被执行
				w1.addShell(window.innerWidth * 0.7, window.innerHeight * 0.7, 0.4, 20, 1, 0.5)

				// 真的画一帧，把整条渲染路径走一遍
				try {
					pet.renderer.draw(pet.world, pet.view)
				} catch (e) {
					return { ok: false, reason: '渲染失败: ' + e.message }
				}

				// 拿着手套时画一帧。手套**没有** canvas 光标（用系统手型），
				// 所以这一帧什么都不该多出来 —— 但正是要确认它不会因为
				// 「drawToolCursor 里没有 glove 分支」而走进别的分支去
				try {
					pet.view.tool = 'glove'
					pet.renderer.draw(pet.world, pet.view)
					pet.view.tool = 'none'
				} catch (e) {
					return { ok: false, reason: '拿手套时渲染失败: ' + e.message }
				}

				// —— 实心不透明：采样蛹中心的像素 ——
				//
				// 「蛹是不是半透明的」光看代码看不出来（颜色是拼出来的），
				// 唯一可靠的办法是真画一遍再读像素。
				// 画布本身是全透明的（桌宠是覆盖层），所以实体所在处 alpha 必须是 255
				let pupaAlpha = null
				let pupaColor = ''
				// 图鉴基因格那张探针画出来的红能量：[普通蝇, 疯狂蝇]。
				// 只为了打进成功日志 —— 下次调泛光强度时能直接看到数
				let flyIconRed = null
				// 图鉴基因格那张探针量出来的冷暖偏向：[普通蝇, 封禁蝇]。
				// 正数 = 偏暖。同样只为打进成功日志
				let flyIconPolarity = null
				try {
					const w3 = pet.world
					w3.larvae.length = 0
					w3.shells.length = 0
					w3.remains.length = 0
					w3.eggs.length = 0
					w3.foods.length = 0
					w3.flies.length = 0
					const pp = w3.addLarva(400, 400, null)
					pp.pupa = true
					pp.age = 0 // 刚化蛹：颜色还没变，正是最浅的那一档
					// ⚠ 必须显式把体型拉满。age=0 意味着 size 只有 5px，
					// 化成的蛹是 6×2 像素 —— 中心那个像素正好压在抗锯齿的边缘上，
					// 读出来是半透明，但这跟「蛹是不是实心」毫无关系。
					// 这个坑第一次写这条断言时就踩了（报出来 alpha=222）
					pp.size = 23
					pp.lengthScale = 1
					pp.angle = 0

					pet.renderer.draw(w3, pet.view)

					const dpr = pet.renderer.dpr
					// 沿中心横线采一整排 —— 只采一个点的话，
					// 「大部分地方是透明的、恰好中心那点是实的」这种情况会被漏掉
					const row = pet.renderer.ctx.getImageData(
						Math.round(390 * dpr),
						Math.round(400 * dpr),
						Math.round(20 * dpr),
						1,
					).data
					let minA = 255
					let holes = 0
					// 底色取「整排里最亮的那个像素」，而不是中心那一个。
					// 颗粒是随机撒的，中心点正好压着一颗颗粒是常有的事 ——
					// 那一像素会比底色暗一截（实测 178 vs 222），
					// 拿它去断言底色就会误报。颗粒只会把颜色压暗、不会提亮，
					// 所以最亮的那个像素就是没被颗粒盖住的底色
					let px = null
					for (let i = 0; i < row.length; i += 4) {
						const a = row[i + 3]
						if (a < minA) minA = a
						if (a > 0 && a < 250) holes++
						if (!px || row[i] + row[i + 1] + row[i + 2] > px[0] + px[1] + px[2]) {
							px = [row[i], row[i + 1], row[i + 2], a]
						}
					}
					pupaAlpha = px[3]
					pupaColor = 'rgb(' + px[0] + ',' + px[1] + ',' + px[2] + ')'

					if (minA !== 255 || holes > 0) {
						return {
							ok: false,
							reason: '蛹是半透明的（横排 alpha 最低 ' + minA + '，半透明像素 ' + holes + ' 个）',
						}
					}
					// 颜色也得对。只查 alpha 是不够的 —— 颜色拼错时画布会静默沿用上一个颜色，
					// 那个「上一个」恰好不透明的话，alpha 检查就放过去了，
					// 而屏幕上的蛹是别的颜色。刚化蛹应当是偏暖的奶白：R > G > B 且够亮
					if (!(px[0] > 180 && px[0] > px[1] && px[1] > px[2])) {
						return { ok: false, reason: '刚化蛹的颜色不对（' + pupaColor + '），应当是偏暖的奶白' }
					}
				} catch (e) {
					return { ok: false, reason: '蛹的不透明度采样失败: ' + e.message }
				}

				// 工具栏那扇小窗：元素在不在、最小化能不能来回切。
				// 这几个 id 只要拼错一个，ui.js 构造时就会抛错，
				// 但那时报出来的是「__pet 不存在」，很难看出真正原因 —— 所以单独查一遍。
				const panel = document.getElementById('panel')
				const bar = document.getElementById('titlebar')
				const minBtn = document.getElementById('btn-min')
				if (!panel || !bar || !minBtn) {
					return { ok: false, reason: '工具栏小窗的 DOM 不完整（panel / titlebar / btn-min）' }
				}
				// —— 面板收起 / 展开 ——
				//
				// 收起 = 面板和罐子小窗**整块**收掉，屏幕上只剩飞的虫 + 右下角那个把手；
				// 点把手叫回来。类挂在 #hud 上（见 style.css），所以这里查的是 #hud。
				//
				// ⚠ 必须查**可见性**（offsetWidth / computed display），不能只查 class ——
				//   「类加对了但 CSS 选择器写错」和「什么都对」在 class 上长得一模一样。
				//   这个项目没有通用的 .hidden { display:none }，写漏一条就正好是这个症状
				const handle = document.getElementById('panel-handle')
				if (!handle) return { ok: false, reason: '卡片里没有 #panel-handle（收起之后叫不回面板）' }
				if (typeof pet.ui.setPanelAway !== 'function') {
					return { ok: false, reason: 'ui.setPanelAway 不存在' }
				}
				const hud = document.getElementById('hud')
				const jarWin = document.getElementById('jar-window')
				const visible = (el) => el.offsetWidth > 0 || el.offsetHeight > 0

				if (!visible(panel)) return { ok: false, reason: '一开始面板就是不可见的' }
				if (visible(handle)) return { ok: false, reason: '没收起时右下角那个把手就已经露出来了' }

				pet.ui.setPanelAway(true)
				if (!hud.classList.contains('panel-away')) {
					return { ok: false, reason: '收起之后 #hud 上没有 panel-away 类' }
				}
				if (visible(panel)) {
					return { ok: false, reason: '收起之后面板还看得见 —— 检查 style.css 里 #hud.panel-away #panel 那条' }
				}
				if (jarWin && visible(jarWin)) {
					return { ok: false, reason: '收起之后罐中果蝇小窗还看得见 —— 它应当跟着面板一起收' }
				}
				if (!visible(handle)) {
					return { ok: false, reason: '收起之后把手没露出来 —— 那样面板就再也叫不回来了' }
				}

				// 把手必须**点得到**：它要进 _updateInteractive 的 need，
				// 否则窗口穿透时那一下点击会落到桌面上（和「观察模式拖罐子」同一个坑）
				const savedMouse = { x: pet.view.mouse.x, y: pet.view.mouse.y }
				const hr = handle.getBoundingClientRect()
				pet.view.mouse.x = hr.left + hr.width / 2
				pet.view.mouse.y = hr.top + hr.height / 2
				pet.ui._updateInteractive()
				const overHandle = pet.ui.interactive
				pet.view.mouse.x = savedMouse.x
				pet.view.mouse.y = savedMouse.y
				if (!overHandle) {
					return { ok: false, reason: '指针压在把手上，窗口却不接管鼠标 —— 那一下点击会落到桌面上，把手点不动' }
				}

				// —— 把手可以拖动，而且位置记进存档 ——
				//
				// ⚠ 顺序要紧：这一段必须在「点一下叫回面板」**之前**，
				//   因为它要验证「拖完那一下不算点击」—— 拖完面板必须还是收着的。
				//   先点一次的话面板就回来了，再拖也没得测
				{
					const before = handle.getBoundingClientRect()
					const sx = before.left + before.width / 2
					const sy = before.top + before.height / 2

					// 真的派发 Mouse 事件，不是直接调方法 —— 绑在 window 上的
					// mousemove / mouseup 监听器只有这样才会跑到
					const fire = (target, type, x, y) =>
						target.dispatchEvent(
							new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }),
						)

					fire(handle, 'mousedown', sx, sy)
					fire(window, 'mousemove', sx - 40, sy - 40)
					const mid = handle.getBoundingClientRect()
					if (Math.abs(mid.left - before.left) < 20) {
						return {
							ok: false,
							reason: '拖动时把手没跟着走：left ' + before.left + ' → ' + mid.left,
						}
					}
					// 松手：mouseup 之后浏览器会补一个 click（真实点击的规范顺序），
					// 这里手动补上，专门验「拖完那一下不算点击」
					fire(window, 'mouseup', sx - 40, sy - 40)
					handle.click()

					if (!hud.classList.contains('panel-away')) {
						return { ok: false, reason: '把把手拖了一下，面板却被叫回来了 —— 拖动那一下被当成了点击' }
					}

					// 位置要落到 world.settings 里（它跟着存档走）
					const saved = pet.world.settings.handlePos
					if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
						return {
							ok: false,
							reason: '拖完把手之后 world.settings.handlePos 没写上：' + JSON.stringify(saved),
						}
					}
					if (Math.abs(saved.x - mid.left) > 2 || Math.abs(saved.y - mid.top) > 2) {
						return {
							ok: false,
							reason:
								'存下来的把手位置和实际位置对不上：存 ' +
								JSON.stringify(saved) + '、实际 ' +
								JSON.stringify({ x: mid.left, y: mid.top }),
						}
					}

					// 拖到屏幕左上角外面 → 必须被夹回可视区，
					// 否则把手会跑到点不到的地方，面板就再也叫不回来了
					pet.ui._handlePos = { x: -500, y: -500 }
					pet.ui._placeHandle()
					const clamped = handle.getBoundingClientRect()
					if (clamped.left < 0 || clamped.top < 0) {
						return {
							ok: false,
							reason: '拖出屏幕的把手没有被夹回来：left=' + clamped.left + ' top=' + clamped.top,
						}
					}
				}

				// 点一下把手 → 面板回来、把手收起来
				handle.click()

				// —— 穿透才是主开关 ——
				//
				// 手里拿着工具、指针在**空白画布**上 → 不该接管鼠标。
				// 这一条以前是反的：_updateInteractive 的 need 里有一条
				// 一句 this.view.tool !== 'none'，于是「一拿起工具，整扇全屏窗口
				// 就把桌面点击全吃掉」。删掉那条之后，拿什么工具都能正常点桌面。
				//
				// ⚠ 这条和「穿透关掉时整扇窗口接管」是一对：那个由主进程的
				//   clickThroughEnabled 决定，渲染进程这边看不见，所以自检只钉得住这一半
				const savedTool = pet.view.tool
				const savedM2 = { x: pet.view.mouse.x, y: pet.view.mouse.y }
				pet.ui.setTool('swatter')
				pet.view.mouse.x = 5
				pet.view.mouse.y = 5 // 左上角，离面板、罐子窗、小卡都很远
				pet.ui._updateInteractive()
				const toolCaptured = pet.ui.interactive
				pet.ui.setTool(savedTool)
				pet.view.mouse.x = savedM2.x
				pet.view.mouse.y = savedM2.y
				pet.ui._updateInteractive()
				if (toolCaptured) {
					return {
						ok: false,
						reason: '手里拿着工具、指针在空白画布上，窗口还是接管了鼠标 —— 桌面点击会被整个吃掉',
					}
				}

				// 工具折叠：默认收起 → 点开 → 五个按钮真的可见 → 点了工具标题行跟着变 → 再点收起。
				// 这条链路上「展开后按钮还是不可见」是最容易出的错（display:none 挂错了层），
				// 而它光看代码看不出来 —— 得真的量一下宽度
				try {
					const toolsBox = document.getElementById('tools-box')
					if (!toolsBox) return { ok: false, reason: '#tools-box 不存在' }
					if (!toolsBox.classList.contains('collapsed')) {
						return { ok: false, reason: '工具组默认应当是收起的' }
					}

					document.getElementById('btn-tools').click()
					if (toolsBox.classList.contains('collapsed')) {
						return { ok: false, reason: '点了标题行但工具组没有展开' }
					}
					// ⚠ 1.18.0 起**没有任何工具按钮带 hidden 这个类了** ——
					//   点火那两颗以前是「买到打火机才现身」，现在改成一直显示、
					//   没买只是加上 locked（和捕虫网同一套）。
					//   所以可见数应当**等于**总数，不再需要「先滤掉 hidden」那一步
					const shown = pet.ui.toolButtons
					const visible = Array.from(document.querySelectorAll('#tools [data-tool]')).filter(
						(b) => b.getBoundingClientRect().width > 0,
					)
					if (visible.length !== shown.length) {
						return {
							ok: false,
							reason: '展开后可见的工具按钮是 ' + visible.length + ' 个，应当是 ' + shown.length + ' 个',
						}
					}

					// 点火那两颗：没买之前是**锁定态，但必须仍然可见可点** ——
					// 做成 hidden 的话按钮会在工具栏里进进出出，位置来回跳
					for (const id of ['btn-lighter', 'btn-flamer']) {
						const b = document.getElementById(id)
						if (!b) return { ok: false, reason: '#' + id + ' 不存在' }
						if (b.classList.contains('hidden')) {
							return { ok: false, reason: '还没买点火器，' + id + ' 却整个藏起来了（该只是 locked）' }
						}
						if (!b.classList.contains('locked')) {
							return { ok: false, reason: '还没买点火器，' + id + ' 却已经解锁了' }
						}
					}

					// 捕虫网：没买之前是**锁定态，但必须仍然可点**。
					// 真的 disabled 掉的话，玩家点下去毫无反应，
					// 只会以为按钮坏了，而不会想到要去商店买
					const netBtn = document.getElementById('btn-net')
					if (!netBtn) return { ok: false, reason: '#btn-net 不存在' }
					if (!netBtn.classList.contains('locked')) {
						return { ok: false, reason: '还没买捕虫网，按钮应当是锁定态' }
					}
					if (netBtn.disabled) {
						return {
							ok: false,
							reason: '捕虫网按钮被 disabled 了 —— 那样点下去毫无反应，玩家不知道要去买',
						}
					}

					pet.ui.setTool('glove')
					const label = document.getElementById('tools-current').textContent
					if (label !== '手套') return { ok: false, reason: '切到手套后标题行显示的却是「' + label + '」' }
					pet.ui.setTool('none')

					document.getElementById('btn-tools').click()
					if (!toolsBox.classList.contains('collapsed')) {
						return { ok: false, reason: '再点一次没有收起' }
					}
				} catch (e) {
					return { ok: false, reason: '工具折叠流程失败: ' + e.message }
				}

				// 倍速折叠：和工具同一套路，另外还查「选了档位真的落到 world.timeScale 上」。
				// 光看按钮亮不亮是不够的 —— 按钮亮了但 timeScale 没变的话，
				// 屏幕上什么都不会发生，而这是最难自己发现的一种坏法
				try {
					const speedBox = document.getElementById('speed-box')
					if (!speedBox) return { ok: false, reason: '#speed-box 不存在' }
					if (!speedBox.classList.contains('collapsed')) {
						return { ok: false, reason: '倍速默认应当是收起的' }
					}

					document.getElementById('btn-speed').click()
					if (speedBox.classList.contains('collapsed')) {
						return { ok: false, reason: '点了标题行但倍速没有展开' }
					}
					const opts = Array.from(document.querySelectorAll('#speeds [data-speed]')).filter(
						(b) => b.getBoundingClientRect().width > 0,
					)
					if (opts.length !== 5) {
						return { ok: false, reason: '展开后可见的档位是 ' + opts.length + ' 个（时停 + 四档倍速），应当是 5 个' }
					}
					// 五档必须排在一行里。面板只有 318px 宽，多塞一个按钮很容易被挤到第二行 ——
					// 那不报错、功能也正常，只是面板突然高一截、下面几个按钮跟着往下跳
					const rowTop = opts[0].getBoundingClientRect().top
					const wrapped = opts.filter((b) => Math.abs(b.getBoundingClientRect().top - rowTop) > 2)
					if (wrapped.length) {
						return { ok: false, reason: '有 ' + wrapped.length + ' 个档位被挤到了第二行 —— 面板 318px 放不下五个' }
					}

					pet.ui.setSpeed(10)
					if (pet.world.timeScale !== 10) {
						return { ok: false, reason: '选了 10× 但 timeScale 是 ' + pet.world.timeScale }
					}
					const shown = document.getElementById('speed-current').textContent
					if (shown !== '10×') return { ok: false, reason: '选了 10× 但标题行显示的是「' + shown + '」' }
					if (!document.getElementById('btn-speed').classList.contains('on')) {
						return { ok: false, reason: '加速时标题行没有点亮' }
					}

					// 回到 1× 要能复原：高亮该灭掉，档位该回到 1
					pet.ui.setSpeed(1)
					if (pet.world.timeScale !== 1) {
						return { ok: false, reason: '选回 1× 但 timeScale 是 ' + pet.world.timeScale }
					}
					if (document.getElementById('btn-speed').classList.contains('on')) {
						return { ok: false, reason: '回到 1× 之后标题行还是点亮的' }
					}

					// —— 时停 ——
					//
					// 三条都要查，少一条就会漏掉一种坏法：
					//   ① paused 真的变成 true   —— 落没落到世界上
					//   ② 标题行显示「时停」且点亮 —— 玩家看不看得出现在是停的
					//   ③ 世界真的不再推进        —— 前两条都对、但 world.update 开头那句
					//      「paused 就 return」被删掉的话，按钮会亮着而果蝇照跑
					//
					// ⚠ 这段代码整个住在一个模板字符串里，注释里也**不能出现反引号** ——
					// 它会当场把外层那个模板字符串截断，报出来的是
					// 「SyntaxError: missing ) after argument list」，完全指不到这里。
					// 这个坑在本文件上面已经写过一次警告了，我还是踩了一次
					pet.ui.setSpeed(5)
					pet.ui.setSpeed(0)
					if (!pet.world.paused) return { ok: false, reason: '选了时停但 world.paused 还是 false' }
					if (pet.world.timeScale !== 5) {
						return { ok: false, reason: '时停不该动 timeScale（原档位 5 变成了 ' + pet.world.timeScale + '），否则恢复时回不到原来那一档' }
					}
					const shownStop = document.getElementById('speed-current').textContent
					if (shownStop !== '时停') return { ok: false, reason: '时停了但标题行显示的是「' + shownStop + '」' }
					if (!document.getElementById('btn-speed').classList.contains('on')) {
						return { ok: false, reason: '时停时标题行没有点亮 —— 忘了它停着会以为程序卡死了' }
					}
					{
						const t0 = pet.world.elapsed
						pet.world.update(1 / 60)
						if (pet.world.elapsed !== t0) {
							return { ok: false, reason: '时停状态下世界还在推进（elapsed ' + t0 + ' → ' + pet.world.elapsed + '）' }
						}
					}

					// Space 走的是 togglePause()，必须和点「时停」是同一个结果 ——
					// 而且恢复时要回到 5×，不是掉回 1×
					pet.ui.togglePause()
					if (pet.world.paused) return { ok: false, reason: '再按一次没有退出时停' }
					if (pet.world.timeScale !== 5) {
						return { ok: false, reason: '从时停恢复后 timeScale 是 ' + pet.world.timeScale + '，应当回到时停前的 5×' }
					}
					pet.ui.setSpeed(1)
				} catch (e) {
					return { ok: false, reason: '倍速 / 时停流程失败: ' + e.message }
				}

				// 经济：游戏币显示、商店、出售、悬停检视卡片。
				//
				// 这一整条回路（卖 → 钱 → 买 → 放大镜）在无头模拟器里已经逐项断言过了；
				// 这里只查**接线**：DOM 在不在、格式对不对、档位类名切不切得动。
				// 两边各管一段，不重复
				try {
					const money = document.getElementById('s-money')
					const sell = document.getElementById('sell')
					const shopPop = document.getElementById('shop-pop')
					const shopList = document.getElementById('shop-list')
					const inspect = document.getElementById('inspect')
					if (!money || !sell || !shopPop || !shopList || !inspect) {
						return { ok: false, reason: '经济相关的 DOM 不完整（游戏币 / 出售区 / 商店弹窗 / 数据面板）' }
					}
					if (!document.getElementById('btn-shop')) return { ok: false, reason: '商店按钮 #btn-shop 不存在' }

					// ⚠ 商店 / 投放 / 图鉴这三张卡**必须挂在 #hud 下**，不能待在 .window 里。
					//   .window 有 overflow: hidden（用来裁圆角），放进去会被整个剪掉 ——
					//   而卡片、列表、按钮在 DOM 上**全都在**，所有别的断言照样绿。
					//   这条只能靠 closest('.window') 查
					for (const id of ['shop-pop', 'feed-pop', 'codex-pop']) {
						const pop = document.getElementById(id)
						if (!pop) return { ok: false, reason: '找不到弹窗 #' + id }
						if (pop.closest('.window')) {
							return {
								ok: false,
								reason: '#' + id + ' 被放进了 .window 里 —— 那扇窗 overflow:hidden 会把它整个剪掉',
							}
						}
					}

					// 游戏币显示要跟着 world 走，而且格式必须是 $xxx,xxx.xxx
					// （千分位 + 至少三位小数；前缀只有 $，没有冒号）
					pet.world.money = 1234567.891
					pet.ui.refreshStats()
					if (money.textContent !== '$1,234,567.891') {
						return { ok: false, reason: '游戏币显示成了「' + money.textContent + '」，应当是「$1,234,567.891」' }
					}
					pet.world.money = 0
					pet.ui.refreshStats()
					if (money.textContent !== '$0.000') {
						return { ok: false, reason: '零钱显示成了「' + money.textContent + '」，应当是「$0.000」' }
					}

					// 商店：默认关着 → 点开（**真实点击**）→ 商品行渲染出来了 → Esc 关掉
					//
					// ⚠ 这里原来查的是折叠用的 .collapsed。改成弹窗之后
					//   折叠语义没了，判据换成 .hidden —— 而「点一下真的能开」
					//   这一条必须留着：它正是当年设置 / 捐款按钮点不开那个
					//   bug 的守卫（见下面那一大段注释）
					if (!shopPop.classList.contains('hidden')) {
						return { ok: false, reason: '商店弹窗默认应当是关着的' }
					}
					document.getElementById('btn-shop').click()
					if (shopPop.classList.contains('hidden')) {
						return {
							ok: false,
							reason: '点了商店按钮但弹窗没有出现 —— 多半是 #panel 的「点别处就关掉」把刚打开的自己又关了',
						}
					}
					if (!shopList.querySelector('[data-buy]')) {
						return { ok: false, reason: '商店打开后一件商品都没渲染出来' }
					}
					// 商品行数要跟 CONFIG.market.shop 一致 —— 加了货但没渲染出来，
					// 玩家会以为「买了没用」，而只查「有没有商品」是查不出来的
					const shopRows = shopList.querySelectorAll('[data-buy]').length
					if (shopRows !== pet.config.market.shop.length) {
						return {
							ok: false,
							reason:
								'商店只渲染出 ' + shopRows + ' 件，配置里有 ' + pet.config.market.shop.length + ' 件',
						}
					}
					// 警报器那一行要真的在，而且标着**配置里那个价**
					//
					// ⚠ 期望值从 config 现算，不写死 —— 这条守的是
					//   「按钮上的字跟着配置走」，不是「警报器卖多少钱」。
					//   写死的话每次调价都要来改测试，而调价本身是正常操作
					//   （下面那条「两档价格合计」是另一回事，那个是刻意写死的）
					const alarmBtn = shopList.querySelector('[data-buy="alarm"]')
					if (!alarmBtn) return { ok: false, reason: '商店里没有警报器这一行' }
					const alarmPrice = pet.config.market.shop.find((s) => s.id === 'alarm').price
					if (!alarmBtn.textContent.includes(alarmPrice.toFixed(3))) {
						return {
							ok: false,
							reason:
								'警报器标价是「' + alarmBtn.textContent + '」，配置里是 $' +
								alarmPrice.toFixed(3) + ' —— 按钮上的价格没跟着配置走',
						}
					}
					// 买不起时按钮必须是禁用的 —— 光靠点击时报错的话，
					// 玩家会以为「点了没反应」
					if (pet.world.money === 0 && !shopList.querySelector('[data-buy]').disabled) {
						return { ok: false, reason: '没钱时购买按钮却是可点的' }
					}
					// —— 放大镜的档位勾选行 ——
					//
					// 那六个小按钮是**买过之后**才长出来的，而且筛选逻辑
					// （magnifierTargets 按档位集合筛）在无头模拟器里已经断言过了。
					// 这里只查**接线**：按钮在不在、点一下 world 变不变、
					// 选中态跟不跟得上、没买时是不是真的不给
					{
						const savedShopM = Object.assign({}, pet.world.shop)
						const savedTiersM = pet.world.magnifierTiers.slice()

						// 没买之前不该有那排按钮
						pet.world.shop = {}
						pet.world.magnifierTiers = pet.config.market.valueTiers.map((t) => t.id)
						pet.ui.refreshShop()
						if (shopList.querySelector('[data-magnify-tier]')) {
							return { ok: false, reason: '还没买放大镜就已经有档位勾选行了' }
						}

						// 买下之后：每个价值档各一颗
						pet.world.shop = { magnifier: true }
						pet.ui.refreshShop()
						const chips = [...shopList.querySelectorAll('[data-magnify-tier]')]
						const wantTiers = pet.config.market.valueTiers.map((t) => t.id)
						if (chips.length !== wantTiers.length) {
							return {
								ok: false,
								reason: '放大镜的档位按钮有 ' + chips.length + ' 颗，按 valueTiers 应当是 ' + wantTiers.length + ' 颗',
							}
						}
						for (const t of wantTiers) {
							if (!shopList.querySelector('[data-magnify-tier="' + t + '"]')) {
								return { ok: false, reason: '档位勾选里没有价值档 ' + t }
							}
						}

						// 全勾上时每颗都应当是选中态
						pet.world.magnifierTiers = wantTiers.slice()
						pet.ui.refreshShop()
						for (const t of wantTiers) {
							const b = shopList.querySelector('[data-magnify-tier="' + t + '"]')
							if (!b.classList.contains('active')) {
								return { ok: false, reason: '档位 ' + t + ' 已经勾上了，按钮却不是选中态' }
							}
						}

						// 点一下「稀有」→ world 里要把它去掉，按钮也要跟着灭
						const rareBtn = shopList.querySelector('[data-magnify-tier="rare"]')
						if (!rareBtn) return { ok: false, reason: '找不到「稀有」这颗档位按钮' }
						rareBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
						if (pet.world.magnifierTiers.includes('rare')) {
							return { ok: false, reason: '点了「稀有」但 world.magnifierTiers 里还有它' }
						}
						const rareAfter = shopList.querySelector('[data-magnify-tier="rare"]')
						if (rareAfter.classList.contains('active')) {
							return { ok: false, reason: '取消「稀有」之后按钮还是选中态' }
						}
						// 再点一下要能勾回来（toggle 的另一半）
						rareAfter.dispatchEvent(new MouseEvent('click', { bubbles: true }))
						if (!pet.world.magnifierTiers.includes('rare')) {
							return { ok: false, reason: '再点一次「稀有」没有勾回来' }
						}

						// 勾选真的传到了高亮那一层 —— 只勾一个空档，场上就该一个光环都没有
						//
						// ⚠ 这里查的是 magnifierTargets 的**输入**（world.magnifierTiers），
						//   不是自己再算一遍分档 —— 分档和筛选逻辑在无头模拟器里
						//   已经逐项断言过了，这里只确认「UI 点的那颗按钮改的是同一个字段」
						pet.world.magnifierTiers = []
						if (pet.world.magnifierTiers.length !== 0) {
							return { ok: false, reason: '档位清空之后 world.magnifierTiers 还有东西' }
						}
						pet.ui.refreshShop()
						if (shopList.querySelector('[data-magnify-tier].active')) {
							return { ok: false, reason: '一档都没勾，却有档位按钮还是选中态' }
						}

						pet.world.shop = savedShopM
						pet.world.magnifierTiers = savedTiersM
						pet.ui.refreshShop()
					}

					// —— 分组真的渲染出来了，而且商品落在正确的组里 ——
					//
					// ⚠ 分类表是渲染顺序和归组的唯一来源（UI 完全按它遍历）。
					//   所以这里比对的是**配置里那张表**，不是另抄一份期望值 ——
					//   抄一份的话，改了配置这条断言就变成在测它自己
					for (const cat of pet.config.market.shopCats) {
						const box = shopList.querySelector('[data-cat="' + cat.id + '"]')
						if (!box) {
							return { ok: false, reason: '商店里没有「' + cat.name + '」这个分组' }
						}
						if (!box.querySelector('.shop-cat-name')) {
							return { ok: false, reason: '「' + cat.name + '」那一组没有标题' }
						}
						// 组里出现的商品 id 必须恰好是配置里列的那几个
						const got = []
						for (const b of box.querySelectorAll('[data-buy],[data-chain]')) {
							got.push(b.dataset.buy || b.dataset.chain)
						}
						const want = cat.items.filter((id) => got.includes(id))
						if (got.length !== cat.items.length) {
							return {
								ok: false,
								reason:
									'「' + cat.name + '」里有 ' + got.length + ' 件，配置里写了 ' + cat.items.length + ' 件（' +
									got.join(',') + '）',
							}
						}
						if (want.length !== cat.items.length) {
							return { ok: false, reason: '「' + cat.name + '」里的商品和配置对不上' }
						}
					}
					// Esc 关掉
					pet.ui._onKey({ code: 'Escape' })
					if (!shopPop.classList.contains('hidden')) {
						return { ok: false, reason: 'Esc 关不掉商店弹窗' }
					}

					// 投放面板（代码里叫 feed）：和商店同一套折叠块，
					// 但**状态语义完全不同** —— 商店的道具买了变「已拥有」并从此禁用，
					// 投放的每一行都是能反复买的消耗品。
					// 三行 × 两档 = 六个按钮，价格必须是配置里那三个数
					//
					// ⚠ 下面一律用字符串拼接，**不能写反引号模板串、也不能写美元大括号插值**。
					// 这一段整个住在一个模板字符串里，里面的反引号会提前把它结束掉，
					// 插值语法会被外层拿去求值 —— 报的是「SyntaxError: missing ) after
					// argument list」，而且整个 main.js 加载失败、自检**静默挂住**，
					// 屏幕上只开出一个空窗口。踩过两次了。
					// 自检本身查不出这个：跑之前 main.js 就已经没加载起来
					const feedPop = document.getElementById('feed-pop')
					const feedList = document.getElementById('feed-list')
					if (!feedPop || !feedList) return { ok: false, reason: '投放弹窗的 DOM 不存在' }
					if (!document.getElementById('btn-feed')) return { ok: false, reason: '投放按钮 #btn-feed 不存在' }
					// 投食 / 投蝇那两个旧按钮应当已经被弹窗取代 —— 漏一个在页面上，
					// 玩家就会看见两个功能重复的入口，而且旧那个还不收钱
					for (const dead of ['btn-food', 'btn-spawn']) {
						if (document.getElementById(dead)) {
							return { ok: false, reason: '旧的 #' + dead + ' 还在，应当已经并入投放弹窗' }
						}
					}
					// ⚠ 「玻璃罐」那颗工具栏按钮**撤掉了** —— 它现在只在投放弹窗里。
					//   两边都留着的话，摆罐子有两个入口，而这一行本来就挤
					if (document.getElementById('btn-jar')) {
						return { ok: false, reason: '#btn-jar 还在工具栏上，应当已经挪进投放弹窗' }
					}
					if (!feedPop.classList.contains('hidden')) {
						return { ok: false, reason: '投放弹窗默认应当是关着的' }
					}
					// —— 食物的**财富门槛**：金苹果还没解锁那一段 ——
					//
					// ⚠ 这一段必须在下面那些「苹果 $0.001 / 金苹果 $0.010」的断言**之前**，
					//   因为那些断言假定金苹果那一行在面板上 —— 而开局总财富是 0，
					//   金苹果是锁着的。不先解锁的话，feedBtns.find(...)
					//   会返回 undefined，报出来是「Cannot read properties of
					//   undefined」而不是一句能看懂的话
					pet.world.stats.earned = 0
					pet.ui.refreshFeed()
					// ⚠ **普通苹果不受门槛管** —— 它是口粮，开局总财富是 0 也得买得到。
					//   哪天有人顺手把 apple 加进 foodUnlock，这条就是唯一会红的地方
					if (pet.ui.unlockedFoodIds().join() !== 'apple') {
						return {
							ok: false,
							reason: '总财富是 0 时解锁的食物是 ' + JSON.stringify(pet.ui.unlockedFoodIds()) +
								'，应当只有 apple —— 苹果是口粮，不该有解锁门槛',
						}
					}
					// 那一组**必须还在 DOM 里**
					const foodBoxLocked = feedList.querySelector('[data-cat="food"]')
					if (!foodBoxLocked) {
						return { ok: false, reason: '投放弹窗里没有「食物类」这个分组' }
					}
					// 面板上只该有苹果 —— 金苹果锁着就不出现
					const kindsLocked = [...foodBoxLocked.querySelectorAll('[data-kind]')].map((b) => b.dataset.kind)
					if (kindsLocked.some((k) => k !== 'apple')) {
						return {
							ok: false,
							reason: '总财富是 0，面板上却已经有能买的食物：' + JSON.stringify(kindsLocked) +
								'（金苹果还锁着）',
						}
					}
					// 金苹果锁着的时候**必须有一句话**：它安安静静躺在配置里，
					// 玩家在过线之前完全不知道有它，到那一刻才发现凭空多了一行
					const foodHint = foodBoxLocked.querySelector('[data-empty="food"]')
					if (!foodHint) {
						return {
							ok: false,
							reason: '金苹果还锁着，食物那一组底下却没有一句说明 —— 玩家不知道有这一样',
						}
					}
					// 提示里必须**说出阈值** —— 只说「还没解锁」等于什么都没说
					const wantNeed = pet.config.market.foodUnlock.gold
					if (!foodHint.textContent.includes(wantNeed.toFixed(3))) {
						return {
							ok: false,
							reason: '解锁提示里没写出门槛：' + JSON.stringify(foodHint.textContent) +
								'（应当含 ' + wantNeed.toFixed(3) + '）',
						}
					}
					// 还得**点名**是哪一样 —— 光说「财富到 $0.100 解锁」，
					// 玩家不知道该期待什么
					if (!foodHint.textContent.includes('金苹果')) {
						return {
							ok: false,
							reason: '解锁提示没有点名是「金苹果」：' + JSON.stringify(foodHint.textContent),
						}
					}
					// 图鉴里那一格也得是灰的 —— 两处共用 _foodLocked() 这个判据，
					// 但**渲染路径是两条**，只在投放面板上验会漏掉图鉴那一半。
					// ⚠ 不用把弹窗点开：refreshCodex() 是把格子画进 #codex-body 的，
					//   那个元素一直在 DOM 里，弹窗只是把它显示出来而已
					pet.ui.refreshCodex()
					const codexGold = document.querySelector('[data-food="gold"]')
					if (!codexGold || !codexGold.classList.contains('locked')) {
						return { ok: false, reason: '金苹果还没解锁，图鉴里那一格却不是灰的' }
					}

					// 把总财富抬过门槛 —— 金苹果该出现了，那句话也该收起来
					pet.world.stats.earned = wantNeed
					pet.ui.refreshFeed()
					if (pet.ui.unlockedFoodIds().join() !== 'apple,gold') {
						return {
							ok: false,
							reason: '总财富到 ' + wantNeed + ' 之后，解锁的食物是 ' +
								JSON.stringify(pet.ui.unlockedFoodIds()) + '，应当是 apple 和 gold',
						}
					}
					// ⚠ 上面那句 refreshFeed() 是**整块重建 DOM** 的 ——
					//   foodBoxLocked 现在指向的是一棵已经被丢掉的旧树。
					//   拿它查等于在查「上一帧长什么样」，
					//   自检里别处（下面那批 feedBtns）踩过同一个坑
					const foodBoxOpen = feedList.querySelector('[data-cat="food"]')
					if (foodBoxOpen && foodBoxOpen.querySelector('[data-empty="food"]')) {
						return { ok: false, reason: '金苹果已经解锁了，食物那一组底下那句「还没解锁」还挂着' }
					}

					document.getElementById('btn-feed').click()
					if (feedPop.classList.contains('hidden')) {
						return {
							ok: false,
							reason: '点了投放按钮但弹窗没有出现 —— 多半是 #panel 的「点别处就关掉」把刚打开的自己又关了',
						}
					}
					// ⚠ refreshFeed() 是**整块重建 DOM** 的（和 refreshShop 一样），
					// 所以每次刷完都必须重新查一遍，攥着旧引用查 disabled 查的是已经被丢掉的那批节点
					const grabBtns = () => [...feedList.querySelectorAll('[data-kind]')]

					pet.ui.refreshFeed()
					const feedBtns = grabBtns()
					// 每种食物 2 档 + 果蝇 2 档，再加上烤炉那**一个**。
					//
					// ⚠ 烤炉和别的都不一样：它是免费**摆一个**，所以没有 data-n，
					//   一个 id 只出一个按钮。而且 1.27.0 起**要先在商店买断**
					//   才会出现 —— 没买时这一行整个不渲染。
					//   玻璃罐那一行也不在这几个里：它没有 [data-kind]，走 [data-jar]
					//
					// ⚠ 按钮数**从 ui.unlockedFoodIds() 现算**，不写死。
					//   写死的话，彩蛋解锁之后这里会变成 9 和 7 对不上，
					//   而那是**正确行为** —— 断言会在玩家解锁的那一刻变红
					const unlockedFoods = pet.ui.unlockedFoodIds()
					const ovenOwned = pet.world.hasShopItem('oven')
					const wantBtns = unlockedFoods.length * 2 + 2 + (ovenOwned ? 1 : 0)
					if (feedBtns.length !== wantBtns) {
						return {
							ok: false,
							reason:
								'投放弹窗渲染出了 ' + feedBtns.length + ' 个按钮，应当是 ' + wantBtns +
								' 个（' + unlockedFoods.length + ' 种食物 × 2 档 + 果蝇 2 档 + 烤炉 ' +
								(ovenOwned ? '1' : '0（还没在商店买断）') + ' 个）',
						}
					}
					for (const kind of [...unlockedFoods, 'fly']) {
						if (feedBtns.filter((b) => b.dataset.kind === kind).length !== 2) {
							return { ok: false, reason: '投放弹窗里「' + kind + '」那一行不是 2 个按钮' }
						}
					}
					// 彩蛋没解锁时，星空苹果**一个按钮都不该有**。
					// ⚠ 这条是彩蛋的入口守卫：漏了的话 unlockedFoodIds() 的过滤
					//   形同虚设，而界面上看起来只是「多了一行」—— 完全不像 bug
					if (!pet.ui.starUnlocked && feedBtns.some((b) => b.dataset.kind === 'star')) {
						return { ok: false, reason: '还没解锁，投放弹窗里却已经有星空苹果了' }
					}
					// ⚠ 烤炉单独验，**不要塞进上面那个循环** ——
					//   那个循环按 key.split('-') 取 n 再和 dataset.n 比，
					//   而烤炉按钮**根本没有 data-n**，两者都是 undefined，
					//   于是它会「碰巧」通过。碰巧通过等于没测
					// ⚠ 期望值跟着「买没买断」走 —— 没买时那一行**整个不渲染**
					const ovenRow = feedBtns.filter((b) => b.dataset.kind === 'oven')
					if (ovenRow.length !== (ovenOwned ? 1 : 0)) {
						return {
							ok: false,
							reason:
								'投放弹窗里烤炉那一行有 ' + ovenRow.length + ' 个按钮，应当是 ' +
								(ovenOwned ? '1' : '0（还没在商店买断，那一行不该出现）') + ' 个',
						}
					}
					// —— 分组：食物类 / 其他，玻璃罐在「其他」里 ——
					//
					// ⚠ 数的必须是**行**，不是按钮：一个大类里的每一行有 2 个按钮
					//   （投1 / 投10），直接数按钮会得到 4 而不是 2。
					//   第一版就是这么写的，报出来是「「食物类」里有 4 项，配置里写了 2 项」，
					//   看着像配置错了，其实是断言自己数错了东西
					for (const cat of pet.config.market.feedCats) {
						const box = feedList.querySelector('[data-cat="' + cat.id + '"]')
						if (!box) return { ok: false, reason: '投放弹窗里没有「' + cat.name + '」这个分组' }
						// ⚠ 期望值走 unlockedFoodIds()，不是 cat.items —— 星空苹果
						//   在解锁之前**故意不渲染**，拿 config 的原始列表去比，
						//   会在每个没解锁的玩家那里都红一条（而那是正确行为）
						//
						// ⚠ 烤炉同理：「其他」那一组里它要先在商店买断才渲染，
						//   所以这里也得跟着滤一遍 —— 滤的条件**照着规则独立写一遍**，
						//   而不是去调 ui._feedRowHidden()：调那个等于拿实现验证自己
						const wantItems = (cat.id === 'food' ? unlockedFoods : cat.items).filter(
							(id) => id !== 'oven' || ovenOwned,
						)
						// 把行上的 id 收成一个去重集合（同一行的两个按钮会给出同一个 id）
						const ids = new Set()
						for (const b of box.querySelectorAll('[data-kind],[data-jar]')) {
							ids.add(b.dataset.jar !== undefined ? 'jar' : b.dataset.kind)
						}
						if (ids.size !== wantItems.length) {
							return {
								ok: false,
								reason:
									'「' + cat.name + '」里有 ' + ids.size + ' 行，应当是 ' + wantItems.length + ' 行（' +
									[...ids].join(',') + '）',
							}
						}
						for (const id of wantItems) {
							if (!ids.has(id)) {
								return { ok: false, reason: '「' + cat.name + '」里没有「' + id + '」这一行' }
							}
						}
					}
					const jarBtn = feedList.querySelector('[data-jar]')
					if (!jarBtn) return { ok: false, reason: '投放弹窗里没有玻璃罐那一行' }
					// 按钮上要**看得见价格**，而且得是配置里那三个数 ——
					// 写死一个数在这里是有意的：它同时守着「UI 真的读了 CONFIG.market.prices」
					const wantPrice = { 'apple-1': '$0.001', 'gold-1': '$0.010', 'fly-1': '$0.005' }
					for (const key of Object.keys(wantPrice)) {
						const want = wantPrice[key]
						const [k, n] = key.split('-')
						const b = feedBtns.find((x) => x.dataset.kind === k && x.dataset.n === n)
						if (!b.textContent.includes(want)) {
							return {
								ok: false,
								reason: '投放弹窗上「' + key + '」的价格写成了「' + b.textContent + '」，应当含 ' + want,
							}
						}
					}
					// 钱不够时那七个按钮必须全禁用 —— 和商店同一条：光靠点击时报错的话，
					// 玩家会以为「点了没反应」。
					// ⚠ 玻璃罐**不在此列**：它免费，钱是 0 也该能点。
					//   一起禁用的话，穷的时候连罐子都摆不了，而那不是设计意图
					pet.world.money = 0
					pet.ui.refreshFeed()
					const stillOn = grabBtns().filter((b) => !b.disabled)
					if (stillOn.length) {
						return {
							ok: false,
							reason:
								'钱是 0 时还有 ' +
								stillOn.length +
								' 个投放按钮可点（第一个是「' +
								stillOn[0].textContent +
								'」）',
						}
					}
					const jarStillOn = feedList.querySelector('[data-jar]')
					if (jarStillOn && jarStillOn.disabled) {
						return { ok: false, reason: '钱是 0 时玻璃罐被禁用了 —— 它不花钱，应当照常能摆' }
					}
					// 给够钱再刷一次：这些都得活过来。
					//
					// ⚠ 10 这个数要**盖过投放面板里最贵的那一颗按钮**。
					//   1.27.0 起烤炉不在这张面板上了（搬去商店买断），
					//   所以最贵的是**星空苹果投 10 个 = $10**（要先把彩蛋解开）。
					//   以后把任何一种食物调价调到这条线以上，这里会红。
					//   那时改这个数，**不要**改成 100 图省事：
					//   那样「钱刚够」和「钱多得多」就没区别了，这条断言也就不再守着边界
					pet.world.money = 10
					pet.ui.refreshFeed()
					if (grabBtns().some((b) => b.disabled)) {
						return { ok: false, reason: '钱给够了却还有投放按钮是禁用状态' }
					}
					pet.world.money = 0

					// —— 烤炉：先在商店买断，之后在投放里**免费**摆 ——
					//
					// ⚠ 1.27.0 起它不再是「每摆一个收 $5」，而是和玻璃罐同形态。
					//   所以这里要验三段：
					//     ① 没买之前，投放面板里**根本没有那一行**
					//     ② 商店里买得起就能买（钱不够要置灰）
					//     ③ 买断之后出现，点了**不扣钱**、撞上限要置灰
					//
					// ⚠ ②③ 都是**真实点击**，理由同下面玻璃罐那段：
					//   直接调 world.dropOven() 的话，委托监听漏挂、按钮挡住、
					//   data-kind 写错 —— 三种坏法全都测不出来
					const ovenCap = pet.config.roast.oven.maxCount
					const savedOven = pet.world.shop.oven
					pet.world.ovens.length = 0
					delete pet.world.shop.oven

					// ① 没买 → 那一行不渲染
					pet.ui.refreshFeed()
					if (feedList.querySelector('[data-kind="oven"]')) {
						return {
							ok: false,
							reason: '还没在商店买烤炉，投放面板里却已经有「摆一个」那一行了',
						}
					}
					// ⚠ 同一组里的 jar / fly **必须还在** —— 过滤是逐项的，
					//   写成整组过滤的话「其他」那一组会整个消失，而症状
					//   只是「玻璃罐不见了」，很难联想到是烤炉改的
					if (!feedList.querySelector('[data-jar]') || !feedList.querySelector('[data-kind="fly"]')) {
						return {
							ok: false,
							reason: '藏烤炉的时候把同一组里的玻璃罐 / 果蝇也一起藏掉了 —— 过滤要逐项做，不能整组做',
						}
					}

					// ② 商店里那一件：钱不够置灰，够了能买
					//
					// ⚠ 直接用上面那个 shopList，**不要在这里再 const 一次** ——
					//   两处在同一个作用域里，重复声明是**语法错**，
					//   整个注入脚本会直接不执行，报出来只有一句
					//   「Script failed to execute」，看不到是哪一行
					document.getElementById('btn-shop').click()
					pet.ui.refreshShop()
					if (!shopList.querySelector('[data-buy="oven"]')) {
						pet.ui._onKey({ code: 'Escape' })
						return { ok: false, reason: '商店里没有烤炉那一件 —— shopCats 里漏归类了' }
					}
					const ovenCost = pet.config.market.shop.find((s) => s.id === 'oven').price
					pet.world.money = 0
					pet.ui.refreshShop()
					if (!shopList.querySelector('[data-buy="oven"]').disabled) {
						return { ok: false, reason: '一分钱都没有，商店里的烤炉却还能买' }
					}
					pet.world.money = ovenCost
					pet.ui.refreshShop()
					const ovenBuy = shopList.querySelector('[data-buy="oven"]')
					if (ovenBuy.disabled) {
						return { ok: false, reason: '钱刚好等于烤炉价格，商店里那颗按钮却是禁用的' }
					}
					ovenBuy.click()
					if (!pet.world.hasShopItem('oven')) {
						return { ok: false, reason: '点了商店里的烤炉却没买上' }
					}
					if (Math.abs(pet.world.money) > 1e-9) {
						return { ok: false, reason: '买了烤炉之后钱应当正好归零，现在是 ' + pet.world.money }
					}
					pet.ui._onKey({ code: 'Escape' })

					// ③ 买断之后：投放里出现，点了**不扣钱**
					//
					// ⚠ 这里**必须放一笔钱在身上**，不能留 0。
					//   第一版写的是 money = 0，结果「点击后又扣了 $5」这个 bug
					//   测不出来 —— spend() 钱不够时直接返回 false、一分不扣，
					//   钱还是 0，断言照样绿。**空转了一条断言**
					pet.world.money = 100
					pet.ui.refreshFeed()
					const ovenClick = feedList.querySelector('[data-kind="oven"]')
					if (!ovenClick) return { ok: false, reason: '商店里买过烤炉了，投放面板里却还是没有那一行' }
					if (ovenClick.disabled) {
						return { ok: false, reason: '一台烤炉都没摆，那颗「摆一个」却是禁用的' }
					}
					ovenClick.click()
					if (pet.world.ovens.length !== 1) {
						return { ok: false, reason: '点了烤炉按钮却没有摆出炉子（现在 ' + pet.world.ovens.length + ' 个）' }
					}
					if (Math.abs(pet.world.money - 100) > 1e-9) {
						return {
							ok: false,
							reason:
								'摆一个烤炉前手里有 $100，摆完变成 $' + pet.world.money +
								' —— 买断之后应当是免费的，不该再扣钱',
						}
					}
					// 摆满之后必须置灰，而不是点了没反应
					while (pet.world.ovens.length < ovenCap) pet.world.dropOven()
					pet.ui.refreshFeed()
					if (!feedList.querySelector('[data-kind="oven"]').disabled) {
						return { ok: false, reason: '烤炉摆满了（' + ovenCap + ' 个），那颗按钮却还能点' }
					}
					// ④ 老存档迁移：**已经摆着炉子 = 已拥有**
					//
					// ⚠ 这条守的是一段**沉默的**代码（world.restore 里那行
					//   if (this.ovens.length > 0 && !this.shop.oven)）：
					//   漏了的话，一个正摆着炉子的老玩家更新完打开投放面板，
					//   会发现那一行**凭空消失**，得重新去商店花 $15 ——
					//   而屏幕上明明还摆着他之前买的
					//
					// ⚠ 造假存档时**必须把 ovens 也一起塞进去** ——
					//   光设 shop 是测不到这条的：判据是「有没有炉子」，
					//   只喂 ovens，shop 那边留空，才验得到迁移真的跑了
					pet.world.ovens.length = 0
					delete pet.world.shop.oven
					pet.world.dropOven()
					const snap = JSON.parse(JSON.stringify(pet.world.serialize()))
					if (snap.shop && snap.shop.oven) {
						return { ok: false, reason: '造假存档时就把 shop.oven 设上了，这条断言会空转' }
					}
					const revived = new pet.world.constructor(pet.world.w, pet.world.h)
					revived.restore(snap)
					if (revived.ovens.length !== 1) {
						return {
							ok: false,
							reason: '老存档里那台炉子没读回来（读回 ' + revived.ovens.length + ' 台）',
						}
					}
					if (!revived.hasShopItem('oven')) {
						return {
							ok: false,
							reason:
								'老存档里摆着一台炉子、但 shop 里没有 oven —— 读档后应当自动补上（' +
								'否则玩家更新完会发现投放面板里那一行凭空消失）',
						}
					}
					// 反面：一台炉子都没有的存档**不该**凭空获得烤炉
					pet.world.ovens.length = 0
					delete pet.world.shop.oven
					const bare = new pet.world.constructor(pet.world.w, pet.world.h)
					bare.restore(JSON.parse(JSON.stringify(pet.world.serialize())))
					if (bare.hasShopItem('oven')) {
						return { ok: false, reason: '一台炉子都没有的存档，读档后却白得了烤炉' }
					}

					// 收拾干净
					pet.world.ovens.length = 0
					pet.world.money = 0
					if (savedOven) pet.world.shop.oven = savedOven
					else delete pet.world.shop.oven
					pet.ui.refreshFeed()

					// —— Banhammer：工具接线 ——
					//
					// 机制那一半在 tools/simulate.js 里（半径 / 不能动 / 两次敲 / 售价），
					// 这里只管**界面这一层**：按钮在不在、锁没锁、点了真的打到指针那儿
					try {
						const ui = pet.ui
						const savedShopBan = pet.world.shop.banhammer
						const wh = pet.world

						// ① 商店里得有它，而且归了类
						//    ⚠ 漏了 shopCats 的话商品会**静默消失**
						const shopRows = document.getElementById('shop-list')
						document.getElementById('btn-shop').click()
						ui.refreshShop()
						if (!shopRows.querySelector('[data-buy="banhammer"]')) {
							ui._onKey({ code: 'Escape' })
							return { ok: false, reason: '商店里没有 Banhammer —— shopCats 里漏归类了' }
						}
						ui._onKey({ code: 'Escape' })

						// ② 没买之前：带 .locked，而且**不是 disabled** ——
						//    disabled 的话玩家点下去什么都不会发生，会以为是坏了
						const btn = document.getElementById('btn-banhammer')
						if (!btn) return { ok: false, reason: '#btn-banhammer 不存在' }
						delete wh.shop.banhammer
						ui.refreshToolButtons()
						if (!btn.classList.contains('locked')) {
							return { ok: false, reason: '没买金锤，那颗按钮却没有 .locked' }
						}
						if (btn.disabled) {
							return { ok: false, reason: '金锤按钮被 disabled 了 —— 点了没反应的按钮最难查' }
						}
						// ③ 没买就切不过去
						const toolBefore = pet.view.tool
						ui.setTool('banhammer')
						if (pet.view.tool !== toolBefore) {
							return { ok: false, reason: '没买金锤却切过去了' }
						}
						// ④ 买了就能切
						wh.shop.banhammer = true
						ui.refreshToolButtons()
						if (btn.classList.contains('locked')) {
							return { ok: false, reason: '买了金锤之后按钮还是 .locked' }
						}
						ui.setTool('banhammer')
						if (pet.view.tool !== 'banhammer') return { ok: false, reason: 'setTool 切不到金锤' }
						if (!btn.classList.contains('active')) return { ok: false, reason: '切到金锤后按钮没有选中态' }

						// ⑤ 按 H 能开能关（和 B / V 那些同一套写法）
						ui._onKey({ code: 'KeyH' })
						if (pet.view.tool !== 'none') return { ok: false, reason: '按一下 H 没切回观察' }
						ui._onKey({ code: 'KeyH' })
						if (pet.view.tool !== 'banhammer') return { ok: false, reason: '再按一下 H 没切回金锤' }

						// ⑥ **真的打到指针那一点** ——
						//    这条抓的是「圆心抄成了拍面 / 屏幕中心」之类的错，
						//    光断言 world.banStrike 能封东西是抓不到的
						const m = pet.view.mouse
						const sx = m.x
						const sy = m.y
						wh.flies.length = 0
						wh.larvae.length = 0
						const under = wh.addFly(sx, sy, {})
						const outside = wh.addFly(sx + pet.config.tools.ban.radius + 40, sy, {})
						ui.lastBan = 0
						ui._useTool()
						if (!under.hasMutation('ban')) {
							return { ok: false, reason: '按在指针底下的那只没被封 —— 圆心没跟着指针走' }
						}
						if (outside.hasMutation('ban')) {
							return { ok: false, reason: '半径外的也被封了' }
						}
						// ⑦ 冷却：紧接着再来一下。
						//    ⚠ 没有冷却的话第二下会真的落锤 —— 而那时 under
						//      已经被封上了，于是当场被卖掉。所以「它还活着」
						//      就是「冷却生效了」的判据
						ui._useTool()
						if (under.dead) {
							return { ok: false, reason: '同一瞬间连锤两下就把它卖了 —— 冷却没生效' }
						}
						banTag = { marked: 1 }

						// 收拾：把工具切回去、把这两只清掉、商店状态还原
						ui.setTool('none')
						wh.flies.length = 0
						wh.larvae.length = 0
						if (savedShopBan) wh.shop.banhammer = savedShopBan
						else delete wh.shop.banhammer
						ui.refreshToolButtons()
					} catch (e) {
						return { ok: false, reason: '金锤接线流程失败: ' + e.message }
					}

					// —— 工具按钮上的像素图标 ——
					try {
						const mod = await import('./src/toolicons.js')
						const ICONS = mod.TOOL_ICONS

						// ① 键集合必须和按钮**一一对应**。
						//    ⚠ 只查「有 .tool-icon」是不够的：漏画一个 id 的话，
						//      那颗按钮就是一面空白，而别的按钮照样有图标
						// ⚠ idsRaw 是**按钮在 DOM 里的顺序**（工具栏从左到右），
						//   keys 是排序过的 —— 两者比的是不同的问题：
						//     · 排过序的比**覆盖**（少了谁 / 多了谁）
						//     · 不排的比**顺序**（图鉴和工具栏的排列一致）
						const idsRaw = pet.ui.toolButtons.map((b) => b.dataset.tool)
						const ids = idsRaw.slice().sort()
						const keys = Object.keys(ICONS).sort()
						if (ids.join(',') !== keys.join(',')) {
							return {
								ok: false,
								reason:
									'工具按钮和 TOOL_ICONS 对不上：按钮有 [' + ids.join(',') +
									']，图有 [' + keys.join(',') + ']',
							}
						}

						// ② 每张图必须是 12×12、而且着色格数够多。
						//    ⚠ 「有这个键」是空的：一张全透明的图照样过，
						//      而屏幕上就是一颗空按钮
						const sigs = []
						for (const id of keys) {
							const px = ICONS[id]
							if (px.length !== mod.ICON_SIZE) {
								return {
									ok: false,
									reason: '图标「' + id + '」有 ' + px.length + ' 行，应当是 ' + mod.ICON_SIZE + ' 行',
								}
							}
							for (let i = 0; i < px.length; i++) {
								if (px[i].length !== mod.ICON_SIZE) {
									return {
										ok: false,
										reason:
											'图标「' + id + '」第 ' + (i + 1) + ' 行有 ' + px[i].length +
											' 个字符，应当是 ' + mod.ICON_SIZE,
									}
								}
								if (/[^#.]/.test(px[i])) {
									return {
										ok: false,
										reason: '图标「' + id + '」第 ' + (i + 1) + ' 行里有既不是 # 也不是 . 的字符',
									}
								}
							}
							const n = mod.iconFillCount(id)
							if (n < 12) {
								return {
									ok: false,
									reason: '图标「' + id + '」只有 ' + n + ' 格是实的 —— 画得太空，屏幕上认不出来',
								}
							}
							sigs.push([id, px.join('|')])
						}
						// ③ 11 张图**两两不同** —— 上面那条在「全都画同一个东西」时也是绿的
						for (let i = 0; i < sigs.length; i++) {
							for (let j = i + 1; j < sigs.length; j++) {
								if (sigs[i][1] === sigs[j][1]) {
									return {
										ok: false,
										reason: '图标「' + sigs[i][0] + '」和「' + sigs[j][0] + '」长得一模一样',
									}
								}
							}
						}

						// ④ 每颗按钮里真的装上了，而且**有尺寸**
						//
						// ⚠ 必须先展开工具组：它默认收着（.collapsed），
						//   而 CSS 里那条「收起时隐藏 fold-body」的规则是 display:none ——
						//   收着的时候每颗按钮的 getBoundingClientRect() 都是 0，
						//   这条断言会把「全都正常」误报成「尺寸是 0」
						const toolsBox2 = document.getElementById('tools-box')
						if (toolsBox2.classList.contains('collapsed')) document.getElementById('btn-tools').click()
						for (const b of pet.ui.toolButtons) {
							const sp = b.querySelector('.tool-icon')
							if (!sp) return { ok: false, reason: '按钮「' + b.dataset.tool + '」里没有 .tool-icon' }
							const r = sp.getBoundingClientRect()
							if (!(r.width > 0) || !(r.height > 0)) {
								return { ok: false, reason: '按钮「' + b.dataset.tool + '」的图标尺寸是 0' }
							}
						}

						// ⑤ 图标**不能污染按钮文字**：setTool 拿 btn.textContent
						//    当「当前工具名」显示到收起状态的标题行
						const bhBtn = document.getElementById('btn-banhammer')
						if (bhBtn.textContent.trim() !== 'Banhammer') {
							return {
								ok: false,
								reason: '金锤按钮的 textContent 是「' + bhBtn.textContent.trim() + '」—— 图标把它污染了',
							}
						}

						// ⑥ 金色流动：只有金锤那一颗挂了 .flow，而且真的在跑动画。
						//    ⚠ 查类名是不够的 —— 类名对了但 CSS 没写，照样是死的
						const flowEl = document.getElementById('btn-banhammer').querySelector('.tool-icon')
						if (!flowEl.classList.contains('flow')) {
							return { ok: false, reason: '金锤图标没有 .flow —— 金色不会流动' }
						}
						const anim = getComputedStyle(flowEl).animationName
						if (anim === 'none' || !anim) {
							return { ok: false, reason: '金锤图标的 animation-name 是 ' + anim + ' —— 流光没跑起来' }
						}
						for (const b of pet.ui.toolButtons) {
							const sp = b.querySelector('.tool-icon')
							if (b.dataset.tool !== 'banhammer' && sp.classList.contains('flow')) {
								return { ok: false, reason: '「' + b.dataset.tool + '」也挂了 .flow —— 只有金锤该流动' }
							}
						}
						// 收回去，把工具组还原成进来时的样子
						if (!toolsBox2.classList.contains('collapsed')) document.getElementById('btn-tools').click()

						// ⑦ 图鉴里的「工具」那一段
						//
						// ⚠ 三份 id 必须**完全一致**：按钮的 data-tool、图标矩阵的键、
						//   图鉴登记表。任意一处漏了或写错，那一格就是**空白**
						//   （或者干脆整格消失），而且不报错
						const codexIds = pet.config.tools.toolCodex.map((t) => t.id)
						if (codexIds.slice().sort().join(',') !== keys.join(',')) {
							return {
								ok: false,
								reason:
									'图鉴登记表和图标键对不上：登记表 [' + codexIds.join(',') +
									']，图标 [' + keys.join(',') + ']',
							}
						}
						// 图鉴里的排列顺序要和工具栏一致 —— 玩家在面板上从左到右
						// 认熟的顺序，翻图鉴不该变成另一套
						if (codexIds.join(',') !== idsRaw.join(',')) {
							return {
								ok: false,
								reason:
									'图鉴登记表的顺序和工具栏按钮不一致：登记表 [' + codexIds.join(',') +
									']，按钮 [' + idsRaw.join(',') + ']',
							}
						}

						// 打开图鉴，看那一段真的渲染出来了
						document.getElementById('btn-codex').click()
						pet.ui.refreshCodex()
						const sec = pet.ui.el.codexBody.querySelector('[data-codex="工具"]')
						if (!sec) return { ok: false, reason: '图鉴里没有「工具」这一段' }
						const toolCells = sec.querySelectorAll('.codex-cell')
						if (toolCells.length !== codexIds.length) {
							return {
								ok: false,
								reason: '工具那一段有 ' + toolCells.length + ' 格，应当是 ' + codexIds.length + ' 格',
							}
						}
						for (const c of toolCells) {
							const id2 = c.dataset.tool
							if (!c.querySelector('canvas')) {
								return { ok: false, reason: '工具格「' + id2 + '」里没有画布' }
							}
							if (!c.textContent.includes('快捷键')) {
								return { ok: false, reason: '工具格「' + id2 + '」没有显示快捷键' }
							}
						}

						// ⑧ 免费工具的名字，图鉴里和按钮上必须是**同一个**
						//
						// ⚠ 带 from 的那几件不用比：它们的名字是从商店配置现算的
						//   （见 config.toolCodex 那段注释），不可能漂。
						//   免费工具的名字在 HTML 按钮上有一份、登记表里又有一份，
						//   这份重复就是靠这条断言钉住的
						for (const t of pet.config.tools.toolCodex) {
							if (t.from || !t.name) continue
							const btn2 = pet.ui.toolButtons.find((b) => b.dataset.tool === t.id)
							if (!btn2) continue
							if (btn2.textContent.trim() !== t.name) {
								return {
									ok: false,
									reason:
										'工具「' + t.id + '」在图鉴里叫「' + t.name +
										'」，按钮上却是「' + btn2.textContent.trim() + '」',
								}
							}
						}
						// ⑨ 三段都能折起来，而且**折了不影响别的**
						//
						// ⚠ 最后那一半才是重点：折叠状态的键如果不加
						//   一个 codex 前缀，「工具」这个分类名会和商店里的分组撞上，
						//   折了图鉴会顺手把商店那组也折起来
						// ⚠ 从 codexBody 找，不是从 sec 的父节点 ——
						//   sec 本身就是一格 [data-codex]，往上只一层的话
						//   只会找到它自己（实得 1 而不是 3）
						const heads = pet.ui.el.codexBody.querySelectorAll('[data-codex]')
						if (heads.length !== 3) {
							return { ok: false, reason: '图鉴应当有三段（工具 / 食物 / 基因），实得 ' + heads.length }
						}
						for (const grid of heads) {
							const groupEl = grid.closest('.shop-cat')
							const hd = groupEl.querySelector('.cat-toggle')
							if (!hd) return { ok: false, reason: '图鉴「' + grid.dataset.codex + '」那一段没有折叠按钮' }
							if (groupEl.classList.contains('collapsed')) {
								return { ok: false, reason: '图鉴那几段默认就该是**展开**的' }
							}
							const shown = () => getComputedStyle(groupEl.querySelector('.shop-cat-rows')).display !== 'none'
							if (!shown()) {
								return { ok: false, reason: '图鉴「' + grid.dataset.codex + '」展开着却看不见' }
							}
							hd.click()
							if (!groupEl.classList.contains('collapsed') || shown()) {
								return { ok: false, reason: '点了「' + grid.dataset.codex + '」的标题却没折起来' }
							}
							// 折起来的时候**别的段不能被带着一起折**
							for (const other of heads) {
								if (other === grid) continue
								if (other.closest('.shop-cat').classList.contains('collapsed')) {
									return {
										ok: false,
										reason:
											'折了「' + grid.dataset.codex + '」，把「' + other.dataset.codex +
											'」也一起折了 —— 折叠状态的键撞上了',
									}
								}
							}
							hd.click()
							if (groupEl.classList.contains('collapsed') || !shown()) {
								return { ok: false, reason: '再点一下「' + grid.dataset.codex + '」没有展开' }
							}
						}
						pet.ui._onKey({ code: 'Escape' })

						// ⚠ 画布上得有东西。只查「有 canvas」的话，一张全透明的
						//   空图照样过 —— 而屏幕上就是一块空白
						const probe = pet.ui.el.codexBody.querySelector('[data-codex="工具"] .codex-cell canvas')
						if (probe) {
							const pctx = probe.getContext('2d')
							const img = pctx.getImageData(0, 0, probe.width, probe.height).data
							let solid = 0
							for (let i = 3; i < img.length; i += 4) if (img[i] > 0) solid++
							if (solid === 0) {
								return { ok: false, reason: '工具图鉴的画布上一个不透明像素都没有 —— 图标没画上去' }
							}
							iconTag = { count: keys.length, anim, codexPixels: solid }
						} else {
							iconTag = { count: keys.length, anim, codexPixels: 0 }
						}
					} catch (e) {
						return { ok: false, reason: '图标断言失败: ' + e.message }
					}

					// —— 分类折叠：折起来之后，**钱一变也不能弹回去** ——
					//
					// ⚠ 这是折叠功能唯一会真坏的地方。_renderCats 每次都是
					//   innerHTML = '' 整块重建，而 refreshStats() 在**钱一变**
					//   就同时调 refreshShop + refreshFeed。
					//   折叠状态要是挂在 DOM 的 class 上，钱一动它就自己弹回去了 ——
					//   而这个 bug 只在「玩着玩着卖了一只蝇」的时候出现，
					//   看着完全随机，几乎不可能手工复现
					for (const spec of [['feed-list', 'feed', 'other'], ['shop-list', 'shop', 'tool']]) {
						const listId = spec[0]
						const groupName = spec[1]
						const catId = spec[2]
						const listEl = document.getElementById(listId)
						// 两张表都要先刷一次，拿到干净的 DOM
						if (listEl === feedList) pet.ui.refreshFeed()
						else pet.ui.refreshShop()

						const box = listEl.querySelector('[data-cat="' + catId + '"]')
						if (!box) return { ok: false, reason: listId + ' 里没有「' + catId + '」这一组' }
						const toggle = box.querySelector('.cat-toggle')
						if (!toggle) {
							return { ok: false, reason: listId + ' 的分类标题不是一个能点的折叠按钮' }
						}
						if (box.classList.contains('collapsed')) {
							return { ok: false, reason: listId + ' 的分类默认应当是展开的' }
						}
						toggle.click()
						if (!box.classList.contains('collapsed')) {
							return { ok: false, reason: '点了 ' + listId + ' 的分类标题却没有折叠' }
						}

						// 让钱变一下 —— 这一步会重建两个弹窗的整块 DOM
						pet.world.money += 1
						pet.ui.refreshStats()

						const again = listEl.querySelector('[data-cat="' + catId + '"]')
						if (!again) return { ok: false, reason: '刷新之后 ' + listId + ' 里找不到那一组了' }
						if (!again.classList.contains('collapsed')) {
							return {
								ok: false,
								reason:
									'钱一变，' + groupName + ' 那一侧的折叠就弹回去了 —— ' +
									'折叠状态存在 DOM 的 class 上了，要存在 ui.collapsedCats 这个 Set 里',
							}
						}
						// 展开回去，别把状态留给后面的断言
						const t2 = again.querySelector('.cat-toggle')
						if (t2) t2.click()
						if (again.classList.contains('collapsed')) {
							return { ok: false, reason: '再点一下应当能展开，但没有' }
						}
					}
					pet.world.money = 0

					// —— 玻璃罐那一行：点了真的摆出一个罐子 ——
					//
					// ⚠ 这条是**真实点击**，不是直接调 world.dropJar()。
					//   直接调的话，委托监听漏挂、dataset 名字写错、
					//   按钮被别的东西挡住 —— 三种坏法全都测不出来
					pet.world.jars.length = 0
					const jarClick = feedList.querySelector('[data-jar]')
					if (!jarClick) return { ok: false, reason: '玻璃罐那一行不见了' }
					jarClick.click()
					if (pet.world.jars.length !== 1) {
						return { ok: false, reason: '点了玻璃罐那一行，场上却没有多出罐子' }
					}
					// 摆满（上限 4 个）—— 一次点击只摆一个，所以这里连着摆到满。
					// ⚠ 循环写成**有界**的：dropJar 万一摆不出来（返回 null），
					//   写成 while (jars.length < max) 就是一个死循环，
					//   而自检挂死和「代码有 bug」在现象上没区别，很难查
					for (let i = 0; i < pet.config.jar.maxCount + 2; i++) {
						if (pet.world.jars.length >= pet.config.jar.maxCount) break
						pet.world.dropJar()
					}
					if (pet.world.jars.length !== pet.config.jar.maxCount) {
						return { ok: false, reason: '罐子没有摆满，后面那条「摆满了要置灰」测不到' }
					}
					// 摆满之后按钮要置灰（而不是点了没反应）—— 早先它挂在工具栏上时
					// 撞上限是**静默**的，玩家只能猜
					pet.ui.refreshFeed()
					const jarFull = feedList.querySelector('[data-jar]')
					if (!jarFull.disabled) {
						return {
							ok: false,
							reason: '罐子摆满 ' + pet.config.jar.maxCount + ' 个之后「摆一个」还是可点的',
						}
					}
					pet.world.jars.length = 0
					pet.ui.refreshFeed()

					// 用 Esc 关掉（不再点按钮 toggle —— 那条路径上面已经测过了）
					pet.ui._onKey({ code: 'Escape' })
					if (!feedPop.classList.contains('hidden')) {
						return { ok: false, reason: 'Esc 关不掉投放弹窗' }
					}

					// 食物投放区参考框：默认隐藏；打开后必须摆在 config 说的位置上，
					// 而且**不能**改变鼠标接管状态（它是常驻视觉元素，参与进去就会吞掉桌面点击）
					const zone = document.getElementById('food-zone')
					if (!zone) return { ok: false, reason: '食物投放区参考框 #food-zone 不存在' }
					if (!zone.classList.contains('hidden')) {
						return { ok: false, reason: '食物投放区参考框默认应当是隐藏的' }
					}
					// 层叠位置：它夹在画布和工具栏之间，靠的是「同为定位元素、按 DOM 顺序叠」，
					// **不是** z-index。写上 z-index（哪怕只是 1）它就会跳到所有 z-auto 的
					// 兄弟上面去，把工具栏、启动选择框、集群提示条统统盖住。
					// 这是个一眼看不出、拖一下窗口才会撞见的坑，值得钉死
					const zi = getComputedStyle(zone).zIndex
					if (zi !== 'auto') {
						return { ok: false, reason: '参考框写了 z-index（' + zi + '），会盖住工具栏和启动框' }
					}
					const kids = Array.prototype.slice.call(document.body.children)
					if (kids.indexOf(zone) !== kids.indexOf(document.getElementById('stage')) + 1) {
						return { ok: false, reason: '参考框在 DOM 里没有紧跟画布 —— 层叠顺序会不对' }
					}
					const zoneWasInteractive = pet.ui.interactive
					// 真的把配置打开再摆一次 —— 断言的是 refreshFoodZone() 有没有**读配置**，
					// 而不是我自己重算一遍公式对不对（那样测的是断言自己的算术）
					pet.config.food.zone.show = true
					pet.ui.refreshFoodZone()
					if (zone.classList.contains('hidden')) {
						return { ok: false, reason: 'zone.show 打开之后参考框还是隐藏的' }
					}
					const zc = pet.config.food.zone
					const zr = zone.getBoundingClientRect()
					const wantW = zc.w * window.innerWidth
					const wantH = zc.h * window.innerHeight
					if (Math.abs(zr.left - zc.x * window.innerWidth) > 1.5 || Math.abs(zr.width - wantW) > 1.5) {
						return {
							ok: false,
							reason:
								'参考框横向摆在了 ' +
								Math.round(zr.left) +
								'/' +
								Math.round(zr.width) +
								'，按配置应当是 ' +
								Math.round(zc.x * window.innerWidth) +
								'/' +
								Math.round(wantW),
						}
					}
					if (Math.abs(zr.top - zc.y * window.innerHeight) > 1.5 || Math.abs(zr.height - wantH) > 1.5) {
						return {
							ok: false,
							reason:
								'参考框纵向摆在了 ' +
								Math.round(zr.top) +
								'/' +
								Math.round(zr.height) +
								'，按配置应当是 ' +
								Math.round(zc.y * window.innerHeight) +
								'/' +
								Math.round(wantH),
						}
					}
					// ⚠ 参考框是常驻视觉元素，绝不能参与「要不要接管鼠标」——
					// 参与进去的话整块区域的桌面点击都会被吞掉（和悬停卡片同一个教训）
					pet.ui._updateInteractive()
					if (pet.ui.interactive !== zoneWasInteractive) {
						return { ok: false, reason: '食物投放区参考框改变了鼠标接管状态 —— 它必须保持穿透' }
					}
					pet.config.food.zone.show = false // 测完还原，别把调试框留在屏幕上
					pet.ui.refreshFoodZone()
					if (!zone.classList.contains('hidden')) {
						return { ok: false, reason: 'zone.show 关掉之后参考框没有隐藏' }
					}

					// —— 手套拖成虫进罐子 ——
					//
					// ⚠ 这条路径**以前根本不存在**：_endDrag 只处理垃圾桶和出售区，
					// 罐子一直只能靠捕虫网（N）进蝇。而网是按半径一网打尽的，
					// 想「只留下那一只稀有的」只能靠运气 —— 这正是玩家会碰上的那种问题。
					//
					// 这里真的走一遍：摆一个罐子、抓一只蝇、把指针放到罐子上、
					// 调 _endDrag()，看它有没有真的进罐。
					// 只查「函数存在」是不够的 —— 分支漏写正是这种查法查不出来的
					{
						const w = pet.world
						const savedFlies = w.flies.slice()
						const savedJars = w.jars.slice()
						w.flies.length = 0
						w.jars.length = 0

						const jar = w.dropJar()
						if (!jar) return { ok: false, reason: '摆不出罐子，没法测「拖进罐子」' }
						jar.x = 400
						jar.y = 400
						const target = w.addFly(1000, 400, 'F')
						if (!target) return { ok: false, reason: '放不出果蝇' }

						// 假装正拎着它，指针停在罐子上
						pet.ui.drag = target
						pet.ui.dragKind = 'fly'
						pet.view.mouse.x = 400
						pet.view.mouse.y = 400
						const handled = pet.ui._endDrag()

						if (!handled) return { ok: false, reason: '拎着成虫松手时 _endDrag 没有接管' }
						if (jar.flies.length !== 1 || jar.flies[0] !== target) {
							return { ok: false, reason: '把成虫拖到罐子上松手，它没有被装进罐子' }
						}
						if (w.flies.includes(target)) {
							return { ok: false, reason: '成虫进了罐子却还留在 world.flies 里（会被重复统计）' }
						}
						if (pet.ui.drag) return { ok: false, reason: '松手之后拖动状态没有清掉' }
						// 松手后指针不再是「瞄准某个罐子」，高亮也得跟着灭
						if (pet.view.dropJar) return { ok: false, reason: '松手之后 view.dropJar 没有清掉，罐子会一直亮着' }

						// 罐子满了：装不进去，但**绝对不能**把果蝇弄丢 ——
						// 丢一只稀有的，比装不进去严重得多
						while (!jar.full) {
							const filler = w.addFly(1200, 600, 'F')
							if (!filler) break
							w.putInJar(jar, filler)
						}
						const overflow = w.addFly(1400, 600, 'F')
						if (!overflow) return { ok: false, reason: '放不出用于测试「罐子满了」的果蝇' }
						pet.ui.drag = overflow
						pet.ui.dragKind = 'fly'
						pet.view.mouse.x = 400
						pet.view.mouse.y = 400
						pet.ui._endDrag()
						if (!w.flies.includes(overflow)) {
							return { ok: false, reason: '罐子满了，那只果蝇却从世界里消失了 —— 应该是装不进去、留在原地' }
						}

						w.flies.length = 0
						w.jars.length = 0
						for (const f of savedFlies) w.flies.push(f)
						for (const j of savedJars) w.jars.push(j)
					}

					// —— 统计行的三条杠 ——
					//
					// 主面板只留存活 / 死亡，其余收进这个开关里。
					// 收起的判据是**看得见看不见**，不是类名 —— 类名对了但 CSS 没生效的话，
					// 那排数字照样糊在主面板上，而类名断言全绿
					const statsBtn = document.getElementById('btn-stats')
					const statsDetail = document.getElementById('stats-detail')
					if (!statsBtn || !statsDetail) return { ok: false, reason: '统计行 / 三条杠的 DOM 不存在' }
					if (getComputedStyle(statsDetail).display !== 'none') {
						return { ok: false, reason: '细分数量默认应当是收起的（主面板上只留存活和死亡）' }
					}
					statsBtn.click()
					if (getComputedStyle(statsDetail).display === 'none') {
						return { ok: false, reason: '点了三条杠但细分数量没有展开' }
					}
					if (!statsBtn.classList.contains('on')) {
						return { ok: false, reason: '展开之后三条杠没有点亮，看不出下面那排是它开出来的' }
					}
					for (const id of ['s-adults', 's-larvae', 's-eggs', 's-value']) {
						if (!document.getElementById(id)) {
							return { ok: false, reason: '细分里缺少 #' + id }
						}
					}
					// 成虫总价值必须**真的等于**所有成虫售价之和，不能是个写死的数。
					// 塞两只已知价值的果蝇进去对一遍
					const savedFlies = pet.world.flies.slice()
					pet.world.flies.length = 0
					const v1 = pet.world.addFly(300, 300, 'F')
					const v2 = pet.world.addFly(400, 300, 'M')
					v1.age = v1.lifespan
					v2.age = v2.lifespan
					pet.ui.refreshStats()
					const wantValue = v1.value + v2.value
					const shownValue = document.getElementById('s-value').textContent
					if (!shownValue.startsWith('$')) {
						return { ok: false, reason: '成虫总价值没有按货币格式显示：' + shownValue }
					}
					if (Math.abs(pet.world.counts.value - wantValue) > 1e-9) {
						return {
							ok: false,
							reason: '成虫总价值对不上：counts 给的是 ' + pet.world.counts.value + '，两只蝇加起来是 ' + wantValue,
						}
					}
					pet.world.flies.length = 0
					for (const f of savedFlies) pet.world.flies.push(f)
					statsBtn.click()
					if (getComputedStyle(statsDetail).display !== 'none') {
						return { ok: false, reason: '再点一次三条杠没有收起' }
					}

					// —— 捐款入口 ——
					const donate = document.getElementById('donate-pop')
					const donateBtn = document.getElementById('btn-donate')
					const qr = document.getElementById('donate-qr')
					if (!donate || !donateBtn || !qr) {
						return { ok: false, reason: '捐款相关的 DOM 不完整（按钮 / 弹窗 / 二维码）' }
					}
					if (!donate.classList.contains('hidden')) {
						return { ok: false, reason: '捐款弹窗默认应当是关着的' }
					}
					// 提示语必须有自己的容器：_flashHint 是直接写 textContent 的，
					// 写在外层 #hint 上会把同在一行里的捐款按钮一起抹掉 ——
					// 而且抹掉之后一点报错都没有，只是按钮从此消失
					const hintText = document.getElementById('hint-text')
					if (!hintText) return { ok: false, reason: '提示语没有独立的 #hint-text 容器' }
					const hintBefore = hintText.textContent
					pet.ui._flashHint('测试一下')
					if (!document.getElementById('btn-donate')) {
						return { ok: false, reason: '_flashHint 把捐款按钮抹掉了 —— 提示语要写进 #hint-text' }
					}
					clearTimeout(pet.ui.hintTimer)
					pet.ui.el.hint.classList.remove('alert')
					hintText.textContent = hintBefore

					// 二维码图片真的加载出来了。
					// ⚠ 路径写错时 <img> **不会报错**，只是默默不显示 ——
					// 弹窗长得完全正常，中间一个空白框，自检也全绿。
					// naturalWidth 是 0 就说明这张图根本没读进来
					if (!qr.complete || qr.naturalWidth === 0) {
						return { ok: false, reason: '支付宝二维码没加载出来（naturalWidth=0）—— 检查 renderer/assets/alipay-qr.jpg' }
					}
					if (qr.naturalWidth < 200) {
						return { ok: false, reason: '二维码只有 ' + qr.naturalWidth + 'px 宽，扫不出来' }
					}

					// —— 星云贴图真的加载出来了 ——
					//
					// ⚠ 和上面那条二维码一模一样：路径写错时 new Image()
					//   **不报错、不抛异常**，只是永远不 onload。不查的话，
					//   表现是「星空苹果是一块纯紫果肉」—— 看着像美术选择，
					//   其实是 404，而且它只在**彩蛋解锁之后**才看得见，
					//   没解锁的玩家和大部分自检都碰不到
					const nb = pet.nebulaInfo()
					if (!nb.ready) {
						return {
							ok: false,
							reason: '星云贴图没加载出来（failed=' + nb.failed + '）—— 检查 ' + nb.src,
						}
					}
					// 原图尺寸也是契约：分块的 cover 缩放按它算，
					// 换成一张小图会被整套拉成一片糊
					if (nb.w !== 1686 || nb.h !== 766) {
						return { ok: false, reason: '星云贴图是 ' + nb.w + '×' + nb.h + '，应当是 1686×766' }
					}

					// ⚠ 和悬停卡片 / 食物投放区**相反**：指针压在卡片上时必须把鼠标要过来，
					// 否则卡片长得正常但点不动，关都关不掉。
					// 但它不是模态 —— 指针不在卡片上时**不能**接管，否则整块桌面都被它吃掉
					pet.ui.setDonateOpen(true)
					if (donate.classList.contains('hidden')) {
						return { ok: false, reason: 'setDonateOpen(true) 之后卡片还是隐藏的' }
					}

					// ⚠ 卡片必须**钉在屏幕正中**。
					// 早先是贴在面板正上方、由 _placeDonate() 每帧现算位置，
					// 面板一拖到屏幕顶端或右边缘，卡片就会被 clamp 到边上、
					// 和面板挤在一起，二维码顶出可视区看着像图没加载出来。
					// 改成 50% / 50% 之后位置和面板无关，这条断言守着「不许改回去」。
					//
					// ⚠ **必须在 setDonateOpen(false) 之前量。** display:none 的元素
					// getBoundingClientRect() 全是 0，写在关闭之后就变成
					// 「0 和屏幕中心比大小」—— 恒不相等、又恒不说自己错，白白通过。
					// 所以这里先显式确认尺寸不是 0，把那种假通过堵死
					const card = donate.querySelector('.donate-card').getBoundingClientRect()
					if (card.width <= 0 || card.height <= 0) {
						return { ok: false, reason: '卡片开着，量到的尺寸却是 0 —— 位置断言会变成永远通过' }
					}
					// 容差 1px：translate(-50%) 在奇数宽度上会落在半个像素，
					// 取整之后和正中差半格，不该算失败
					const cx = card.left + card.width / 2
					const cy = card.top + card.height / 2
					if (
						Math.abs(cx - window.innerWidth / 2) > 1 ||
						Math.abs(cy - window.innerHeight / 2) > 1
					) {
						return {
							ok: false,
							reason:
								'捐款卡片没有居中（卡片中心 ' +
								Math.round(cx) +
								',' +
								Math.round(cy) +
								'，屏幕中心 ' +
								Math.round(window.innerWidth / 2) +
								',' +
								Math.round(window.innerHeight / 2) +
								'）—— 位置应当只由 CSS 的 50% / 50% 决定',
						}
					}

					const savedMouse = { x: pet.view.mouse.x, y: pet.view.mouse.y }
					pet.view.mouse.x = card.left + card.width / 2
					pet.view.mouse.y = card.top + card.height / 2
					pet.ui._updateInteractive()
					if (!pet.ui.interactive) {
						return { ok: false, reason: '指针压在捐款卡片上却没有接管鼠标 —— 点上去会穿到桌面，关不掉' }
					}
					// 挪开：卡片只是面板上方的一张小卡，不该像模态那样一直占着鼠标
					//
					// ⚠ 这一段必须先把**虫**挪走。
					//
					// 观察模式下，指针压在「停着 / 爬着的虫」上时窗口是**故意**
					// 接管鼠标的 —— 那是「点一下看数据面板」的代价（见 ui._inspectableAt）。
					// 果蝇满屏乱走，任何一个固定坐标上都可能正好有虫，
					// 于是「捐款卡片有没有占着鼠标」这条断言会随机红，
					// 而报出来的理由是「卡片关不掉」，完全指错方向。
					//
					// 这条断言要测的是**卡片**，虫和它无关，所以临时清场再还原
					const donateFlies = pet.world.flies
					const donateLarvae = pet.world.larvae
					pet.world.flies = []
					pet.world.larvae = []

					pet.view.mouse.x = 40
					pet.view.mouse.y = 40
					pet.ui.inspectHover = false
					pet.ui._updateInteractive()
					if (pet.ui.interactive) {
						pet.world.flies = donateFlies
						pet.world.larvae = donateLarvae
						return { ok: false, reason: '指针已经离开卡片，鼠标却还被接管着 —— 它会挡住桌面操作' }
					}

					pet.ui.setDonateOpen(false)
					if (!donate.classList.contains('hidden')) {
						pet.world.flies = donateFlies
						pet.world.larvae = donateLarvae
						return { ok: false, reason: 'setDonateOpen(false) 之后卡片没有隐藏' }
					}
					pet.ui._updateInteractive()
					if (pet.ui.interactive) {
						pet.world.flies = donateFlies
						pet.world.larvae = donateLarvae
						return { ok: false, reason: '捐款卡片关掉之后鼠标还接管着' }
					}

					pet.world.flies = donateFlies
					pet.world.larvae = donateLarvae
					pet.view.mouse.x = savedMouse.x
					pet.view.mouse.y = savedMouse.y
					// ⚠ 把指针挪回去之后**必须**重算一次。
					//   ui.interactive 是上一次 _updateInteractive 缓存下来的结论，
					//   上面那几帧查的是 (40,40) 那个位置，而虫已经放回来了 ——
					//   不重算的话，后面那条「悬停卡片不该改变接管状态」的断言
					//   会拿一个**过期的** wasInteractive 去比，然后随机红
					pet.ui.inspectHover = false
					pet.ui._updateInteractive()

					// ⚠ 卡片和面板**可以**重叠（面板停在底部中央，窗口一矮就压上），
					// 所以层叠顺序必须是对的：面板底色 rgba(18,16,14,0.84) 半透明，
					// 一旦盖在卡片上，二维码会从底下透出来糊成一片。
					// 光断言「谁在上面」没用 —— 得确认 .donate-pop 真的拿到了 z-index，
					// 而且比 .window 高。CSS 里漏写这一行，重叠时就会糊，但所有别的断言都照样通过
					const popZ = getComputedStyle(donate).zIndex
					const winZ = getComputedStyle(document.getElementById('panel')).zIndex
					const popN = popZ === 'auto' ? 0 : Number(popZ)
					const winN = winZ === 'auto' ? 0 : Number(winZ)
					if (!(popN > winN)) {
						return {
							ok: false,
							reason:
								'捐款卡片的 z-index（' +
								popZ +
								'）没有高过面板（' +
								winZ +
								'）—— 两者重叠时面板会盖住二维码',
						}
					}

					// 卡片的档位：直接喂假数据给 _showInspect，看类名切没切对。
					// 用假对象而不是真的养一只，是因为这里要覆盖的是**全部档位和边界**，
					// 靠真实果蝇长到那个体重得等几十分钟
					//
					// ⚠ fake 是**普通对象**，所以它身上没有 Fly 原型上的
					//   rarityInfo getter —— 得自己填一个真的进去。
					//   漏了的话 _showInspect 读 f.rarityInfo.name 会直接抛，
					//   而报出来的是「经济 / 数据面板流程失败」，看不出是缺字段
					const fake = (value, rarityName = '轻盈') => ({
						value,
						sex: 'F',
						growth: 0.5,
						weight: 1,
						hp: 8,
						hpMax: 10,
						mutations: [],
						rarityInfo: { name: rarityName },
					})
					// 每一档连**算出来的边框颜色**和**显示的名字**一起查。
					//
					// 光看类名不够：类名对了但 style.css 里没写这条、或者色值写错，
					// 卡片会渲染成默认的灰边，而类名断言照样通过。
					// getComputedStyle 拿到的是**应用之后**的值 —— CSS 没加载、
					// 选择器写错、变量没解析，三种情况它都会露馅
					//
					// ⚠ 这张表是「**名字 ↔ 颜色 ↔ 特效**有没有对上」的唯一检查，
					//   三样都写在同一行里，改了一处忘了另一处就会当场红。
					//   顺序 = 从便宜到贵，和 CONFIG.market.valueTiers 一致；
					//   每档取一个**落在区间中间**的代表值（不是边界值 ——
					//   边界归哪一档是由 sim 里那条纯函数断言钉的，见 valueTierOf）
					//
					// ⚠ 价格区间改过一次（0.02 / 0.1 / 10 / 100 / 1000），
					//   所以这里的取值也跟着挪了：$5 以前是极稀有，现在归稀有。
					//   两个地方要一起改，漏掉的话报出来的是「名字不对」而其实是档位挪了
					// ⚠ 边框色那一栏有个**特例**：会流动的那三档（金 / 红 / 淡彩）
					//   边框是**透明**的 —— 它们描边的颜色来自 background 的
					//   border-box 那一层，实色边框必须让成透明，不然会把它盖掉
					//   （见 style.css 的 .inspect.fx）。那一层在不在由下面单独一条查
					//
					// 每行：[价值, 类名, 边框色, 名字, 描边流动, 反光扫过]
					const cases = [
						[0.002, 'tier-common', 'rgb(232, 226, 216)', '普通', false, false],
						[0.05, 'tier-uncommon', 'rgb(111, 179, 255)', '罕见', false, false],
						[0.5, 'tier-rare', 'rgb(185, 140, 255)', '稀有', false, false],
						[50, 'tier-epic', 'rgba(0, 0, 0, 0)', '极稀有', true, false],
						[500, 'tier-legendary', 'rgba(0, 0, 0, 0)', '超级稀有', true, true],
						[5000, 'tier-mythic', 'rgba(0, 0, 0, 0)', '传说生物', true, true],
						// 多出来的这一行：最后一档的上界是 Infinity，
						// 所以再贵也不会「超出范围」掉到 undefined
						[9.9e9, 'tier-mythic', 'rgba(0, 0, 0, 0)', '传说生物', true, true],
					]
					// 档数要和配置对得上 —— 少写一行的话，那一档的颜色 / 名字
					// 就完全没人查了，而表面上一切正常
					if (cases.length - 1 !== pet.config.market.valueTiers.length) {
						return {
							ok: false,
							reason:
								'这张表覆盖了 ' +
								(cases.length - 1) +
								' 档，配置里有 ' +
								pet.config.market.valueTiers.length +
								' 档 —— 有档位没被检查到',
						}
					}
					for (const [v, want, rgb, name, flow, sheen] of cases) {
						pet.ui._showInspect(fake(v))
						if (!inspect.classList.contains(want)) {
							return { ok: false, reason: '价值 $' + v + ' 的卡片类名里没有 ' + want + '（实际 ' + inspect.className + '）' }
						}
						if (document.getElementById('inspect-rarity').textContent !== name) {
							return {
								ok: false,
								reason: '价值 $' + v + ' 的卡片上写的是「' +
									document.getElementById('inspect-rarity').textContent +
									'」，按价值分档应当是「' + name + '」',
							}
						}
						// 金 / 红 / 淡彩三档的描边会流动
						if (inspect.classList.contains('fx') !== flow) {
							return { ok: false, reason: '价值 $' + v + ' 的描边流动开关不对（' + inspect.className + '）' }
						}
						// 最高两档多一层反光扫过
						if (inspect.classList.contains('sheen') !== sheen) {
							return { ok: false, reason: '价值 $' + v + ' 的反光扫过开关不对（' + inspect.className + '）' }
						}
						const cs = getComputedStyle(inspect)
						// ⚠ 这里**不能**查 opacity：卡片刚显示出来的那一瞬间正在
						// 走 0.14 秒的淡入，getComputedStyle 读到的就是 0。
						// 这几次检查全在同一次脚本执行里跑完，所以读到的永远是 0 ——
						// 那是在测「动画有没有播完」，不是「卡片可不可见」。
						// 改为确认它有淡入动画、而且不是 display:none
						if (cs.display === 'none') {
							return { ok: false, reason: '价值 $' + v + ' 的卡片是 display:none' }
						}
						// ⚠ 卡片上有**两个**动画（入场淡入 + 描边流动），
						//   animationName 读回来是「inspect-in, border-flow」这种
						//   逗号分隔的串 —— 不能拿整串去 === 'inspect-in'，
						//   那样只要加了流动就会红
						const anims = cs.animationName.split(',').map((s) => s.trim())
						if (!anims.includes('inspect-in')) {
							return { ok: false, reason: '卡片的入场动画是 ' + cs.animationName + '，里面应当有 inspect-in' }
						}
						// 会流动的那三档必须**真的挂着** border-flow ——
						// 只加类名不写动画的话，卡片看着一切正常，只是永远不动
						if (flow !== anims.includes('border-flow')) {
							return {
								ok: false,
								reason: '价值 $' + v + ' 的描边流动动画对不上（animation-name: ' + cs.animationName + '）',
							}
						}
						// 卡片必须自己裁掉溢出的内容 —— 这是那道反光唯一的约束：
						// 它是一条和卡片等大的横条，translateX 走到两头时整个身子在
						// 卡片外面，没有祖先的 overflow 就会飞出去扫桌面。
						//
						// ⚠ 别改成查 getComputedStyle(inspect, '::after').overflow：
						//   那句在修好之前**也是** 'hidden'（当年正是错写在了伪元素
						//   自己身上 —— 而 overflow 裁的是子孙，伪元素没有子孙）。
						//   拿它当断言会永远绿。这里查的必须是卡片**自己**。
						if (cs.overflow === 'visible') {
							return {
								ok: false,
								reason:
									'价值 $' + v + ' 的卡片没有裁掉溢出的内容（overflow: ' + cs.overflow +
									'）—— 反光扫过会从卡片边上飞出去扫到桌面上',
							}
						}
						// 会流动的那三档：靠**三层背景**画出来 ——
						// 内芯两层（padding-box，叠两遍把透光压到 1%）+ 描边一层
						// （border-box，会流动的渐变）。
						//
						// ⚠ 内芯少一层的话，描边那层会从那 10% 的透光里透出来，
						//   卡片中间会多出一道会动的光，和反光扫过叠在一起
						//   （用户报过这个）。内芯多一层没意义但也不出错，
						//   所以这里卡的是**正好三层**
						//
						// ⚠ 用 split 而不是正则：这一段整个住在一个模板字符串里，
						//   正则里那个「反斜杠 + 左括号」会被模板字符串当成转义、
						//   吃掉反斜杠，于是只剩一个没配对的左括号 ——
						//   整个自检当场 SyntaxError（这条我自己踩过一次）
						if (flow) {
							const layers = getComputedStyle(inspect).backgroundImage.split('linear-gradient(').length - 1
							if (layers !== 3) {
								return {
									ok: false,
									reason:
										'价值 $' + v + ' 的流动描边有 ' + layers + ' 层背景，应当是 3 层' +
										'（内芯两层 padding-box + 会流动的渐变 border-box）',
								}
							}
						}
						if (cs.borderTopColor !== rgb) {
							return {
								ok: false,
								reason: '价值 $' + v + ' 的卡片边框是 ' + cs.borderTopColor + '，按配置应当是 ' + rgb + ' —— 检查 style.css 里 ' + want + ' 的 --tier',
							}
						}
						// 内容也得真的填进去了，不能是个空壳
						if (!document.getElementById('inspect-value').textContent.startsWith('$')) {
							return { ok: false, reason: '卡片上的售价文本没填对' }
						}
					}
					pet.ui._hideInspect()
					if (!inspect.classList.contains('hidden')) return { ok: false, reason: '收起之后卡片没有隐藏' }
					if (getComputedStyle(inspect).display !== 'none') {
						return { ok: false, reason: '卡片带 .hidden 时应当 display: none' }
					}

					// —— 体格那一行小字（体重档）——
					//
					// ⚠ 这是卡片上**第二套档位**，和价值档并排两行。
					//   两行的来源完全不同（一个按售价现算、一个是出生抽的体格），
					//   所以必须分别钉住 —— 只查其中一行的话，
					//   「两行对调了」或者「另一行写死了一个名字」都发现不了
					const buildEl = document.getElementById('inspect-build')
					if (!buildEl) return { ok: false, reason: '卡片里没有体格那一行（#inspect-build）' }
					for (const rn of ['轻盈', '超重', '巨兽']) {
						pet.ui._showInspect(fake(1, rn))
						const wantBuild = '体格 ' + rn
						if (buildEl.textContent !== wantBuild) {
							return {
								ok: false,
								reason:
									'体重档是「' + rn + '」时，卡片上写的是「' + buildEl.textContent +
									'」，应当是「' + wantBuild + '」',
							}
						}
					}
					if (getComputedStyle(buildEl).display === 'none') {
						return { ok: false, reason: '成虫卡片上的体格那一行是 display:none —— 玩家看不到' }
					}

					// ⚠ 卡片**不能**参与「要不要接管鼠标」的判定。
					// 参与进去的话，每次悬停 1 秒都会把桌面点击吞掉 ——
					// 和「桌宠不挡操作」直接冲突，而且现象很难和悬停卡片联系起来
					const wasInteractive = pet.ui.interactive
					pet.ui._showInspect(fake(9999))
					pet.ui._updateInteractive()
					if (pet.ui.interactive !== wasInteractive) {
						return { ok: false, reason: '悬停卡片会改变鼠标接管状态 —— 它必须保持穿透' }
					}
					pet.ui._hideInspect()
				} catch (e) {
					return { ok: false, reason: '经济 / 悬停卡片流程失败: ' + e.message }
				}

				// —— 查看工具：点一下虫 → 数据面板 ——
				try {
					const inspect = document.getElementById('inspect')
					// 清场，只留下两个探针 —— 果蝇满屏乱走，
					// 不控制住的话「指针底下是哪只」根本不确定
					const savedFlies2 = pet.world.flies
					const savedLarvae2 = pet.world.larvae
					// ⚠ 自己存一份指针位置。上面那个 savedMouse 是**块作用域**的
					//   （声明在另一个 try 里），这里引用不到 —— 而报出来的是
					//   「savedMouse is not defined」，看着像整个检视流程坏了
					const mouseBefore = { x: pet.view.mouse.x, y: pet.view.mouse.y }
					pet.world.flies = []
					pet.world.larvae = []
					pet.world.eggs = []

					// ⚠ 必须先切成**查看工具**。查看从「观察模式直接点」改成
					//   专用工具之后，_inspectableAt 判的是 tool === 'inspect' ——
					//   还拿着 none 的话它恒返回 null，下面每一条都会红
					//
					// 走**真实点击**，不是 setTool —— 按钮没写进 index.html
					// 的话 setTool 照样能跑，而玩家在工具栏上根本找不到它
					const inspectBtn = document.querySelector('#tools [data-tool="inspect"]')
					if (!inspectBtn) return { ok: false, reason: '工具栏上没有「查看」这颗按钮' }
					if (inspectBtn.textContent !== '查看') {
						return { ok: false, reason: '查看按钮上写的是「' + inspectBtn.textContent + '」' }
					}
					inspectBtn.click()
					if (pet.view.tool !== 'inspect') {
						return { ok: false, reason: '点了「查看」按钮但没切过去（view.tool = ' + pet.view.tool + '）' }
					}
					if (!inspectBtn.classList.contains('active')) {
						return { ok: false, reason: '切到查看工具之后那颗按钮没有被标成选中态' }
					}
					// 快捷键 V 也要能切回去 —— 它是这颗按钮的键盘出口
					pet.ui._onKey({ code: 'KeyV' })
					if (pet.view.tool !== 'none') {
						return { ok: false, reason: '按 V 没有从查看工具切回观察（view.tool = ' + pet.view.tool + '）' }
					}
					pet.ui._onKey({ code: 'KeyV' })
					if (pet.view.tool !== 'inspect') {
						return { ok: false, reason: '再按一次 V 没有切回查看（view.tool = ' + pet.view.tool + '）' }
					}

					const probeFly = pet.world.addFly(500, 500, 'F', 'normal', ['golden'])
					const probeLarva = pet.world.addLarva(700, 500, null, 0, ['crystal'])
					if (!probeFly || !probeLarva) {
						return { ok: false, reason: '造不出点击检视用的探针' }
					}
					probeFly.mode = 'walk'
					probeFly.modeTimer = 1e9

					const aimAt = (x, y) => {
						pet.view.mouse.x = x
						pet.view.mouse.y = y
						pet.ui.inspectHover = false
						pet.ui._updateInteractive()
					}

					aimAt(probeFly.x, probeFly.y)
					if (!pet.ui.interactive) {
						return {
							ok: false,
							reason: '拿着查看工具指着成虫却没有接管鼠标 —— 那一下点击会穿到桌面，面板永远点不开',
						}
					}

					pet.ui.openInspect(pet.ui._inspectableAt())
					if (inspect.classList.contains('hidden')) {
						return { ok: false, reason: '点了成虫却没有弹出数据面板' }
					}
					if (inspect.querySelectorAll('.gene-badge').length !== 1) {
						return { ok: false, reason: '成虫面板上的基因徽章数量不对（这只带点石成金，应当只有 1 个）' }
					}
					if (!document.getElementById('inspect-hp').textContent.includes('/')) {
						return { ok: false, reason: '成虫面板没有填生命值' }
					}
					// 面板上那一格必须是**价值档**，不是体重档。
					//
					// ⚠ 光看「写着普通」是分不出两者的 —— 这只探针的体重档就是
					//   normal、价值也低，两条路都得出「普通」两个字。
					//   所以把它**催肥**：体重档仍然是 normal，但价值会冲到最高档。
					//   这时候还显示「普通」就说明读的是体重档
					//
					// ⚠ 不能直接给 probeFly.value 赋值 —— value / weight 都是 getter，
					//   赋值在非严格模式下**静默失败**（executeJavaScript 跑的这段
					//   不是模块，所以不报错），症状就是「改了却没变」。
					//   要改的是它们依赖的那几个字段：weightMax 和 age
					const keepMax = probeFly.weightMax
					const keepAge = probeFly.age
					probeFly.weightMax = 10000 // 10g
					probeFly.age = probeFly.lifespan * 0.999 // 逼近满成长，但**不越过**寿命线
					if (probeFly.rarity !== 'normal') {
						return { ok: false, reason: '催肥探针把体重档也改了 —— 这条断言就测不到区别了' }
					}
					const fatValue = probeFly.value
					if (!(fatValue > 10)) {
						return { ok: false, reason: '催肥之后售价只有 $' + fatValue + '，这条断言测不到高档' }
					}
					pet.ui._showInspect(probeFly)
					const shownTier = document.getElementById('inspect-rarity').textContent
					// 改回去，别让后面「幼虫面板」「罐子压虫」几步受这只胖子的影响
					probeFly.weightMax = keepMax
					probeFly.age = keepAge
					if (shownTier === '普通') {
						return {
							ok: false,
							reason:
								'一只体重档是「普通」、售价却有 $' +
								fatValue.toFixed(3) +
								' 的果蝇，面板上显示的还是「普通」—— 读的是体重档而不是价值档',
						}
					}

					// ⚠ 钉住：把虫挪走之后，面板**必须还在**。
					//   不钉的话 ui 每帧的 _updateInspect 会看到指针底下没虫、
					//   立刻把它关掉 —— 表现是「点了没反应」，而代码看起来完全正常
					probeFly.x = 1500
					probeFly.y = 900
					aimAt(40, 40)
					pet.ui._updateInspect()
					if (inspect.classList.contains('hidden')) {
						return {
							ok: false,
							reason: '虫走开之后数据面板就被自动关掉了 —— 它是「点开的」，应当一直留着直到玩家主动关',
						}
					}

					// Esc 关掉它
					pet.ui._onKey({ code: 'Escape' })
					if (!inspect.classList.contains('hidden')) {
						return { ok: false, reason: 'Esc 关不掉数据面板' }
					}

					// 飞行中的成虫**也能**点开。
					//
					// ⚠ 这条以前断言的是**相反**的事（「飞的也接管就糟了」）——
					//   那是观察模式年代的结论：当时查看的判定区和桌面共用点击，
					//   果蝇满屏飞会吞掉一片桌面点击。换成专用工具之后这个代价没了，
					//   用户要的就是「追着飞虫也点得开」。所以断言反过来了，
					//   改回去之前先看一眼 ui._creatureAt 上面那段注释
					probeFly.x = 500
					probeFly.y = 500
					probeFly.mode = 'fly'
					aimAt(probeFly.x, probeFly.y)
					if (!pet.ui.interactive) {
						return {
							ok: false,
							reason: '拿着查看工具指着「正在飞的成虫」却不接管鼠标 —— 追着飞虫点会点不开',
						}
					}
					const flyingHit = pet.ui._inspectableAt()
					if (flyingHit !== probeFly) {
						return { ok: false, reason: '飞行中的成虫点不到（_inspectableAt 返回了别的）' }
					}

					// —— 罐子里的成虫也要能点开 ——
					//
					// ⚠ 这条守的是**坐标换算**：罐中果蝇的 x / y 是相对罐心的偏移，
					//   漏加偏移的症状是「指在虫身上却点不开」，
					//   而虫好好地画在罐子里、代码看起来也没错
					{
						const savedToolJ = pet.view.tool
						pet.view.tool = 'inspect'
						// ⚠ 这一段要清空罐子和果蝇，测完必须**原样还回去** ——
						//   后面「罐子压在虫子上」那一段依赖 probeFly 还在 world.flies 里
						const keepFliesJ = pet.world.flies.slice()
						const keepJarsJ = pet.world.jars.slice()

						pet.world.jars.length = 0
						const jfly = pet.world.addFly(0, 0, 'F', 'normal', ['crystal'])
						const jjar = pet.world.addJar(700, 400)
						if (!jfly || !jjar || !pet.world.putInJar(jjar, jfly)) {
							return { ok: false, reason: '造不出「罐中果蝇」这个探针' }
						}
						// 故意给一个**非零**偏移：全给 0 的话，「忘了加偏移」和
						// 「加对了」结果一模一样，这条断言就白测了
						jfly.x = 33
						jfly.y = -21

						const screenX = jjar.x + jfly.x
						const screenY = jjar.y + jfly.y

						// ① 指在它**真正画在哪儿** —— 必须点得到
						aimAt(screenX, screenY)
						const hitJar = pet.ui._creatureAt(screenX, screenY, pet.config.tools.hoverRadius)
						if (hitJar !== jfly) {
							return {
								ok: false,
								reason:
									'指针压在罐中那只虫身上（屏幕坐标 ' + screenX + ',' + screenY + '）却点不到它 —— ' +
									'多半是忘了把罐心的偏移加上',
							}
						}
						if (!pet.ui._inspectableAt()) {
							return { ok: false, reason: '罐中那只虫点得到，_inspectableAt 却说不可以查看' }
						}

						// ② 指在**偏移本身**那个位置（没加罐心）—— 不该命中。
						//    这一条是①的反面：两条一起才能证明真的做了换算，
						//    而不是碰巧罐子就在屏幕原点附近
						const strayHit = pet.ui._creatureAt(jfly.x, jfly.y, pet.config.tools.hoverRadius)
						if (strayHit === jfly) {
							return {
								ok: false,
								reason: '指在「未加罐心偏移」的那个点上也能命中罐中虫 —— 坐标没有被换算',
							}
						}

						// ③ 打开卡片，而且卡片要摆在**屏幕上那只虫旁边**，不是左上角
						pet.ui.openInspect(hitJar)
						if (inspect.classList.contains('hidden')) {
							return { ok: false, reason: '罐中的成虫点开了却没有弹出数据面板' }
						}
						const cardLeft = parseFloat(inspect.style.left)
						// 卡片要么在虫右边（+18），要么贴右边被翻到左边（-18-w）
						const wJ = inspect.offsetWidth || 150
						const wantRight = screenX + 18
						const wantLeft = screenX - 18 - wJ
						if (Math.abs(cardLeft - wantRight) > 2 && Math.abs(cardLeft - wantLeft) > 2) {
							return {
								ok: false,
								reason:
									'罐中虫的数据面板摆在了 left=' + cardLeft + '，应当贴着虫子的屏幕横坐标 ' + screenX +
									'（现在是 ' + wantRight + ' 或 ' + wantLeft + '）—— 卡片飞到屏幕左上角就是这个毛病',
							}
						}

						// ④ 虫在罐子里的时候，卡片不能每帧被关掉
						pet.ui._updateInspect()
						if (inspect.classList.contains('hidden')) {
							return {
								ok: false,
								reason: '罐中虫的数据面板开完立刻被收掉了 —— _updateInspect 的「还在不在」判据没算上罐子',
							}
						}

						// ⑤ 把虫放出罐子：卡片应当继续留着（它成了普通成虫）
						pet.world.releaseFly(jjar, jfly)
						pet.ui._updateInspect()
						if (inspect.classList.contains('hidden')) {
							return { ok: false, reason: '罐中虫被放出来之后数据面板却关了 —— 它还是同一只成虫' }
						}

						// ⑥ 虫真的没了（卖掉）：卡片必须收掉。
						//    ⚠ 卖之前它已经被放出来了，所以这一步走的是
						//    「目标 dead」那条判据 —— 别用「清空罐子」来测，
						//    那时候它早就不在罐子里了
						const moneyBeforeJ = pet.world.money
						pet.world.sellFly(jfly)
						pet.ui._updateInspect()
						if (!inspect.classList.contains('hidden')) {
							return { ok: false, reason: '被查看的虫已经卖掉了，数据面板却还留着' }
						}
						pet.world.money = moneyBeforeJ

						// 原样还回去
						pet.world.flies.length = 0
						Array.prototype.push.apply(pet.world.flies, keepFliesJ)
						pet.world.jars.length = 0
						Array.prototype.push.apply(pet.world.jars, keepJarsJ)
						pet.view.tool = savedToolJ
					}

					// —— 罐中配对：透过 UI 那一层也能看见 ——
					//
					// ⚠ 逻辑本身在无头模拟器里逐项断言过了（正例 / 关掉开关 / 冷却按墙钟 /
					//   端到端孵出幼虫）。这里只确认**窗口里那个 world 也走同一条路** ——
					//   防的是「sim 测的是另一个代码路径」这种最讨厌的假绿
					{
						const keepFliesM = pet.world.flies.slice()
						const keepJarsM = pet.world.jars.slice()
						const keepEggsM = pet.world.eggs.slice()
						const keepLarvaeM = pet.world.larvae.slice()

						pet.world.flies.length = 0
						pet.world.jars.length = 0
						pet.world.eggs.length = 0
						pet.world.larvae.length = 0

						const jm = pet.world.addJar(800, 500)
						const dad = pet.world.addFly(800, 500, 'M')
						const mom = pet.world.addFly(812, 500, 'F')
						if (!jm || !dad || !mom) return { ok: false, reason: '造不出罐中配对的探针' }
						for (const f of [dad, mom]) {
							f.age = pet.config.adult.matureAge + 1000
							f.cooldown = 0
							pet.world.putInJar(jm, f)
						}

						const eggsBeforeM = pet.world.eggs.length
						for (let i = 0; i < 60 * 20; i++) pet.world.update(1 / 60)
						const laid = pet.world.eggs.length - eggsBeforeM

						if (laid === 0) {
							return {
								ok: false,
								reason: '罐中的一对成熟异性在窗口里跑了 20 秒一颗卵都没生 —— 罐中配对没接上',
							}
						}
						if (jm.flies.length !== 2) {
							return { ok: false, reason: '罐中配对之后罐里不是 2 只了（少了或被卖了）' }
						}
						const inside = pet.world.eggs.filter((e) => e.y <= jm.y + jm.halfH * 0.6).length
						if (inside) {
							return {
								ok: false,
								reason: '罐中配对产下的卵有 ' + inside + ' 颗落在罐子里 —— 卵应当产在罐外底部',
							}
						}
						if (mom.laying || mom.laySite) {
							return {
								ok: false,
								reason: '罐中配对把母体推进了 laying 状态 —— 她会一直收着翅膀，而且再也配不了对',
							}
						}

						// 原样还回去（跑过 20 秒，卵和幼虫都清掉，别把后面的断言带偏）
						for (const arr of [
							['flies', keepFliesM],
							['jars', keepJarsM],
							['eggs', keepEggsM],
							['larvae', keepLarvaeM],
						]) {
							pet.world[arr[0]].length = 0
							Array.prototype.push.apply(pet.world[arr[0]], arr[1])
						}
					}

					// ⚠ 罐子压在虫子上时，点下去必须开的是**数据面板**，不是拖罐子。
					//
					//   这是用户报的 bug 的原样复现：_grabbableAt 里罐子的判定
					//   排在所有工具之前，而且当年**没有任何工具条件** ——
					//   于是罐子永远先返回，压在罐子上的虫谁也点不开。
					//   现在罐子只在「观察 + 手套」下才拦路，查看工具能穿过去
					//
					// ⚠ 先把场上原有的罐子整个端走。罐子有 maxCount 上限，
					//   前面几节测试可能已经摆了几个 —— 满了的话 addJar 返回 null，
					//   而报出来的是「造不出罐子」，看着像这一步坏了。
					//   直接换掉数组是安全的：罐子对象本身还在 savedJars2 里，
					//   末尾换回来就一切都回来了（罐中果蝇挂在 jar.flies 上，不受影响）
					const savedJars2 = pet.world.jars
					pet.world.jars = []

					const coverJar = pet.world.addJar(520, 500)
					if (!coverJar) return { ok: false, reason: '造不出压在虫子上的罐子' }
					probeFly.mode = 'walk'
					probeFly.x = 520
					probeFly.y = 500
					aimAt(probeFly.x, probeFly.y)
					pet.ui.openInspect(pet.ui._inspectableAt())
					if (inspect.classList.contains('hidden')) {
						return {
							ok: false,
							reason: '罐子压在虫子上面时，点下去开不出数据面板 —— 罐子的判定把虫盖掉了',
						}
					}
					pet.ui._hideInspect()

					// 反过来：这两条**都不能**被上面那条改掉
					//   · 观察模式下仍然能直接拖罐子
					//   · 但拿着别的工具时罐子要让路（拿着拍子点罐子该是挥拍）
					pet.ui.setTool('none')
					aimAt(520, 500)
					const obsHit = pet.ui._grabbableAt()
					if (!obsHit || obsHit.kind !== 'jar') {
						return {
							ok: false,
							reason: '观察模式下拎不动玻璃罐 —— 这条功能被罐子的工具条件误伤了',
						}
					}
					pet.ui.setTool('swatter')
					if (pet.ui._grabbableAt() !== null) {
						return {
							ok: false,
							reason: '拿着苍蝇拍时罐子仍然抢占拖动 —— 那样点在罐子上是拖罐子而不是挥拍',
						}
					}

					// 一键放逐 / 一键出售：批量操作走的是 world 层的方法，
					// 而且每个罐子分别 slice 原数组 —— 写错了会跳着走、漏掉一半
					const baitJar = pet.world.addJar(900, 600)
					if (!baitJar) return { ok: false, reason: '造不出批量操作测试用的罐子' }
					const b1 = pet.world.addFly(0, 0, 'F', 'normal', [])
					const b2 = pet.world.addFly(0, 0, 'M', 'normal', [])
					const b3 = pet.world.addFly(0, 0, 'F', 'normal', [])
					if (!b1 || !b2 || !b3) return { ok: false, reason: '造不出批量操作测试用的果蝇' }
					for (const f of [b1, b2, b3]) {
						if (!baitJar.admit(f)) return { ok: false, reason: '往罐子里塞果蝇失败' }
					}
					// 从 this.flies 里摘掉 —— admit 只管罐子那一侧
					for (const f of [b1, b2, b3]) {
						const fi = pet.world.flies.indexOf(f)
						if (fi >= 0) pet.world.flies.splice(fi, 1)
					}
					if (baitJar.flies.length !== 3) {
						return { ok: false, reason: '塞进罐子的果蝇只有 ' + baitJar.flies.length + ' 只' }
					}

					const moneyBefore = pet.world.money
					const released = pet.world.releaseAllInJars()
					if (released !== 3) {
						return { ok: false, reason: '一键放逐放走了 ' + released + ' 只，应当是 3 只' }
					}
					if (baitJar.flies.length !== 0) {
						return { ok: false, reason: '放逐之后罐子里还剩 ' + baitJar.flies.length + ' 只' }
					}
					if (!pet.world.flies.includes(b1) || !pet.world.flies.includes(b2) || !pet.world.flies.includes(b3)) {
						return { ok: false, reason: '放逐之后果蝇没有回到 world.flies 里' }
					}

					// 再塞回去，测批量出售 —— 三只都要真的卖掉，钱要对得上
					const back = [b1, b2, b3]
					let wantGain = 0
					for (const f of back) {
						if (!baitJar.admit(f)) return { ok: false, reason: '二次入罐失败' }
						const fi = pet.world.flies.indexOf(f)
						if (fi >= 0) pet.world.flies.splice(fi, 1)
						wantGain += f.value
					}
					wantGain = Math.round(wantGain * 1000) / 1000
					const sold = pet.world.sellAllInJars()
					if (sold.count !== 3) {
						return { ok: false, reason: '一键出售卖了 ' + sold.count + ' 只，应当是 3 只' }
					}
					if (Math.abs(sold.gain - wantGain) > 1e-6) {
						return { ok: false, reason: '一键出售拿到 $' + sold.gain + '，按每只的售价加起来应当是 $' + wantGain }
					}
					// ⚠ 容差给到 0.002 而不是精确相等。money 是**逐只**加进去的
					//   （sellFly 里一次一只），而 sold.gain 是加完之后统一 round 到三位的 ——
					//   两者本来就允许差半个最小单位。卡太紧的话这条会因为浮点尾巴随机红
					if (Math.abs(pet.world.money - (moneyBefore + wantGain)) > 0.002) {
						return { ok: false, reason: '一键出售之后余额不对 —— 钱没有真的进账' }
					}
					if (baitJar.flies.length !== 0) {
						return { ok: false, reason: '一键出售之后罐子里还剩 ' + baitJar.flies.length + ' 只' }
					}

					// 二次确认卡：点「取消」不能卖掉任何东西
					//
					// ⚠ 这条要测的是**卡片真的挡在中间**。直接调 sellAllInJars()
					//   是测不到「有没有确认」的 —— 那样把确认卡整个删掉也照样通过
					pet.ui.setSellAllOpen(true)
					if (pet.ui.el.sellAllPop.classList.contains('hidden')) {
						return { ok: false, reason: 'setSellAllOpen(true) 之后确认卡没有出现' }
					}
					// ⚠ _overCard() 判的是「**指针**在不在卡片上」，所以必须先把指针
					//   挪过去 —— 不挪的话它恒返回 false，而这条断言就变成了
					//   「确认卡永远接管不到鼠标」，和实际对不对无关
					const sellCard = pet.ui.el.sellAllPop.querySelector('.donate-card')
					const scr = sellCard.getBoundingClientRect()
					pet.view.mouse.x = scr.left + scr.width / 2
					pet.view.mouse.y = scr.top + scr.height / 2
					if (!pet.ui._overCard()) {
						pet.world.jars = savedJars2
						return {
							ok: false,
							reason: '确认卡没有被 _overCard 认出来 —— 点上去会穿到桌面，两颗按钮都点不到',
						}
					}
					pet.ui.el.sellAllCancel.click()
					if (pet.view.sellAllOpen) {
						return { ok: false, reason: '点了「取消」之后确认卡还开着' }
					}
					if (pet.ui.el.sellAllPop.classList.contains('hidden') === false) {
						return { ok: false, reason: '点了「取消」之后确认卡还显示着' }
					}

					pet.world.jars = savedJars2
					pet.ui.setTool('inspect')

					// —— 幼虫**点不开**数据面板 ——
					//
					// ⚠ 这条断言的方向和它上一版**正好相反**。上一版是
					//   「幼虫也有面板，只显示基因徽章」；用户后来要求删掉
					//   （蛆满天都是，点一下弹卡片会把屏幕糊满）。
					//   所以现在钉的是「点上去什么都不该发生」——
					//   改回去之前先看一眼 ui._creatureAt 上面那段注释
					//
					// ⚠ 三样都要查，少一样就漏一种实现方式：
					//   ① _inspectableAt 返回 null（判定层就不认）
					//   ② _overInspectable() 是 false（不会为它吞掉桌面点击）
					//   ③ openInspect(null) 不开卡（万一别处拿到了一只幼虫）
					//
					// ⚠ ②查的是 **_overInspectable()**，不是聚合出来的 ui.interactive。
					//   拿着查看工具时 interactive **本来就该是 true** ——
					//   那一条讲的是「手里有没有工具」，和「指针底下有没有虫」无关。
					//   查 interactive 的话这条恒红，而报出来的理由
					//   （「幼虫也接管鼠标」）会把人引到完全错误的方向
					pet.ui._hideInspect()
					aimAt(probeLarva.x, probeLarva.y)
					if (pet.ui._inspectableAt() !== null) {
						return {
							ok: false,
							reason: '指针指着幼虫时 _inspectableAt 返回了东西 —— 幼虫不该能被查看',
						}
					}
					if (pet.ui._overInspectable()) {
						return {
							ok: false,
							reason: '指针停在幼虫上时 _overInspectable() 是 true —— 会白白吞掉桌面点击，而幼虫根本点不出面板',
						}
					}
					pet.ui.openInspect(pet.ui._inspectableAt())
					if (!inspect.classList.contains('hidden')) {
						return { ok: false, reason: '点了幼虫却弹出了数据面板 —— 幼虫不能查看' }
					}

					// 幼虫**在别的虫底下**也不能被选中：把一只成虫放在同一点上时，
					// 点出来必须是那只成虫，而不是「恰好也在这儿」的蛆
					//
					// ⚠ 这条查的是「幼虫压根不在候选里」，比上面那条更硬：
					//   上面只要 _creatureAt 判一次就够，这条要求它在**整个循环里**
					//   都不参与 —— 写成「先收成虫、不够再收幼虫」也会被这条抓住
					probeFly.x = probeLarva.x
					probeFly.y = probeLarva.y
					probeFly.mode = 'walk'
					aimAt(probeLarva.x, probeLarva.y)
					const overlapped = pet.ui._inspectableAt()
					if (overlapped !== probeFly) {
						return {
							ok: false,
							reason: '成虫和幼虫叠在同一个点上时，点到的不是那只成虫 —— 幼虫还在候选里',
						}
					}

					// 把幼虫挪走、只留它自己，确认这时候是真的点不出东西
					probeFly.x = 1400
					probeFly.y = 200
					aimAt(probeLarva.x, probeLarva.y)
					if (pet.ui._inspectableAt() !== null) {
						return { ok: false, reason: '场上只剩幼虫时，它仍然能被查看' }
					}
					pet.ui._hideInspect()

					pet.ui.setTool('none')
					pet.world.flies = savedFlies2
					pet.world.larvae = savedLarvae2
					aimAt(mouseBefore.x, mouseBefore.y)
				} catch (e) {
					return { ok: false, reason: '查看工具点击检视流程失败: ' + e.message }
				}

				// —— 设置 / 捐款按钮：必须能被**真实点击**打开 ——
				//
				// ⚠ 这一节存在的理由：这两颗按钮曾经**完全点不开**，
				//   而整套自检全绿 —— 因为之前所有断言都是直接调
				//   setSettingsOpen(true)，从来没走点击那条路。
				//
				//   真正的 bug：两颗按钮里都套了一个**铺满整颗按钮**的图标 span
				//   （.gear-icon / .jar-icon），玩家实际点到的是 span。
				//   按钮自己的 click 先把卡片打开，事件冒泡到 #panel，
				//   而面板的关闭逻辑判的是「e.target 等不等于 button」——
				//   span 显然不等于 button，于是同一次点击里又把它关掉。
				//
				//   所以这里必须**往 span 上派发一个会冒泡的 click**，
				//   把整条冒泡链路走一遍。直接点 button 是测不出来的
				try {
					const settingsPop = document.getElementById('settings-pop')
					const donatePop = document.getElementById('donate-pop')
					const gearBtn = document.getElementById('btn-settings')
					const donateBtn = document.getElementById('btn-donate')
					if (!settingsPop || !donatePop || !gearBtn || !donateBtn) {
						return { ok: false, reason: '设置 / 捐款的按钮或卡片不存在' }
					}

					const clickInner = (btn) => {
						const inner = btn.querySelector('span') || btn
						inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
					}

					pet.ui.setSettingsOpen(false)
					clickInner(gearBtn)
					if (settingsPop.classList.contains('hidden')) {
						return {
							ok: false,
							reason: '点设置按钮（图标那一层）没有弹出设置卡 —— 检查 #panel 的关闭逻辑是不是把 e.target 当成了「点别处」',
						}
					}

					pet.ui.setDonateOpen(false)
					clickInner(donateBtn)
					if (donatePop.classList.contains('hidden')) {
						return { ok: false, reason: '点捐款按钮（图标那一层）没有弹出二维码' }
					}
					// 再点一下应当能关掉（toggle）
					clickInner(donateBtn)
					if (!donatePop.classList.contains('hidden')) {
						return { ok: false, reason: '再点一下捐款按钮没有把二维码收起来' }
					}

					// 层级：两张卡都必须在**所有东西之上** ——
					// 面板 84% 半透明，压在卡片上二维码会从底下透出来糊成一片
					const zOf = (el) => {
						const z = getComputedStyle(el).zIndex
						return z === 'auto' ? 0 : Number(z)
					}
					const popZ = Math.max(zOf(settingsPop), zOf(donatePop))
					const rivals = ['panel', 'jar-window', 'inspect'].map((id) => {
						const el = document.getElementById(id)
						return el ? zOf(el) : 0
					})
					const topRival = Math.max(...rivals)
					if (!(popZ > topRival)) {
						return {
							ok: false,
							reason:
								'设置 / 捐款卡片的 z-index（' +
								popZ +
								'）没有高过面板 / 罐中列表 / 数据面板（最高 ' +
								topRival +
								'）—— 会互相盖住',
						}
					}
					pet.ui.setSettingsOpen(false)
					pet.ui.setDonateOpen(false)
				} catch (e) {
					return { ok: false, reason: '设置 / 捐款按钮流程失败: ' + e.message }
				}

				// —— 养蝇人：商店行 + 配置卡 ——
				//
				// ⚠ 选项一律用**真实点击**（往按钮上派发会冒泡的 click）来测，
				//   不要直接调 world.setKeeperOption —— 上一轮那个「设置 / 捐款
				//   点不开」的 bug 就是因为所有断言都在直接调方法，全绿。
				try {
					const shopList = document.getElementById('shop-list')
					const kpop = document.getElementById('keeper-pop')
					if (!kpop) return { ok: false, reason: '养蝇人配置卡 #keeper-pop 不存在' }

					// 记下现场，测完还原 —— 下面的断言会动钱和商店等级
					const savedMoney = pet.world.money
					const savedShop = Object.assign({}, pet.world.shop)
					const savedKeeper = Object.assign({}, pet.world.keeper)

					pet.world.money = 100
					pet.world.shop = {}
					pet.ui.refreshShop()

					// 没买之前：不该有配置按钮
					if (shopList.querySelector('[data-keeper-cfg]')) {
						return { ok: false, reason: '还没买养蝇人，商店里就已经有「配置」按钮了' }
					}
					const upBtn = shopList.querySelector('[data-chain="keeper"]')
					if (!upBtn) return { ok: false, reason: '商店里没有养蝇人这条升级链' }
					if (upBtn.disabled) return { ok: false, reason: '钱够的时候养蝇人的升级按钮却是禁用的' }

					// 升级必须走 upgradeShopItem（数字等级），不是 buyShopItem（一次性的）——
					// 走错路径的话 buyShopItem 对已拥有的直接返回 false，永远升不动
					upBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
					if (pet.world.shopLevel('keeper') !== 1) {
						return { ok: false, reason: '点升级之后养蝇人不是 Lv.1 —— 多半是走到 buyShopItem 那条路上了' }
					}
					// ⚠ 期望值从 config 现算，不写死 —— 这条守的是「扣的是第一级的价」，
					//   不是「养蝇人卖多少钱」。写死的话每次调价都要来改测试
					const keeperLv1 = pet.config.market.keeperChain[0].price
					if (Math.abs(pet.world.money - (100 - keeperLv1)) > 1e-9) {
						return {
							ok: false,
							reason:
								'养蝇人升级扣款不对（余额 ' + pet.world.money + '，应当是 ' +
								(100 - keeperLv1) + ' = 100 − 配置里的 $' + keeperLv1 + '）',
						}
					}

					pet.ui.refreshShop()
					const cfgBtn = shopList.querySelector('[data-keeper-cfg]')
					if (!cfgBtn) return { ok: false, reason: '买下养蝇人之后没有出现「配置」按钮' }

					// 点配置 → 卡片弹出来
					cfgBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
					if (kpop.classList.contains('hidden')) {
						return { ok: false, reason: '点「配置」没有弹出养蝇人卡片' }
					}

					// 卡片必须在鼠标接管范围内，否则点上去会穿到桌面。
					//
					// ⚠ 这里查的是 _overCard() **本身**，不是聚合出来的
					//   ui.interactive。第一版查的是 interactive，结果把
					//   keeperPop 从 _overCard 的数组里删掉之后断言**照样通过** ——
					//   因为卡片在屏幕正中，而 need 那一长串里还有别的条件
					//   （手里的工具、面板矩形……）恰好也成立。
					//   要钉死「这张卡注册了没有」，就只能查那一条谓词
					const r = kpop.getBoundingClientRect()
					if (!(r.width > 0 && r.height > 0)) {
						return { ok: false, reason: '养蝇人卡片尺寸是 0，量不到接管范围' }
					}
					const mouseBefore2 = { x: pet.view.mouse.x, y: pet.view.mouse.y }
					pet.view.mouse.x = r.left + r.width / 2
					pet.view.mouse.y = r.top + r.height / 2
					// （这张卡和工具栏面板是会重叠的 —— 两张都是居中的，窗口一矮就压上，
					//   和设置卡一样。靠 z-index 30 保证画在面板之上。
					//   但下面查的是 _overCard()，它**只看那几张卡自己的矩形**，
					//   面板重不重叠都影响不到它 —— 所以这里不需要额外的排除条件）
					if (!pet.ui._overCard()) {
						return {
							ok: false,
							reason: '指针压在养蝇人卡片上，_overCard() 却是 false —— 忘了把它加进那个数组，卡片点上去会穿到桌面',
						}
					}
					pet.view.mouse.x = mouseBefore2.x
					pet.view.mouse.y = mouseBefore2.y

					// —— Lv1 时「自动出售」那几行必须是禁用的 ——
					const sellOpt = kpop.querySelector('[data-k-sell]')
					if (!sellOpt) return { ok: false, reason: '卡片里没有「自动出售」这一行' }
					if (!sellOpt.disabled) {
						return { ok: false, reason: 'Lv1 时「自动出售」却是可点的 —— 那是 Lv2 的功能' }
					}

					// —— 点一个选项（真实冒泡点击），状态和选中态都要跟着变 ——
					const goldOpt = kpop.querySelector('[data-k-feed="gold"]')
					if (!goldOpt) return { ok: false, reason: '卡片里没有「金苹果」这个选项' }
					goldOpt.dispatchEvent(new MouseEvent('click', { bubbles: true }))
					if (pet.world.keeper.food !== 'gold') {
						return { ok: false, reason: '点了「金苹果」但 world.keeper.food 没变（' + pet.world.keeper.food + '）' }
					}
					const goldAfter = kpop.querySelector('[data-k-feed="gold"]')
					if (!goldAfter.classList.contains('active')) {
						return { ok: false, reason: '选了金苹果，但那个按钮没有被标成选中态' }
					}
					const appleAfter = kpop.querySelector('[data-k-feed="apple"]')
					if (appleAfter.classList.contains('active')) {
						return { ok: false, reason: '选了金苹果，苹果那个按钮却还是选中态' }
					}

					// —— 升到 Lv2 之后，自动出售那几行要解锁 ——
					pet.world.shop.keeper = 2
					pet.ui.refreshKeeperCard()
					if (kpop.querySelector('[data-k-sell]').disabled) {
						return { ok: false, reason: '升到 Lv2 之后「自动出售」还是禁用的' }
					}

					// —— 「卖哪档」筛选的是**价值档**，得能选到全部五档 ——
					//
					// ⚠ 这里查的是 data-k-tier 上的值来自 CONFIG.market.valueTiers。
					//   上一版这一行是 data-k-rarity（体重档的三档），
					//   两套档位混用的话，面板上写着「稀有」、筛选里却找不到「稀有」
					const tierBoxes = kpop.querySelectorAll('[data-k-tier]')
					const wantTiers = pet.config.market.valueTiers.map((t) => t.id)
					if (tierBoxes.length !== wantTiers.length) {
						return {
							ok: false,
							reason: '「卖哪档」有 ' + tierBoxes.length + ' 个选项，按 valueTiers 应当是 ' + wantTiers.length + ' 个',
						}
					}
					for (const t of wantTiers) {
						if (!kpop.querySelector('[data-k-tier="' + t + '"]')) {
							return { ok: false, reason: '「卖哪档」里没有价值档 ' + t }
						}
					}
					// 点一下最贵那档，world 里要跟着变
					const topTierBtn = kpop.querySelector('[data-k-tier="legendary"]')
					if (!topTierBtn) return { ok: false, reason: '找不到「超级稀有」这个选项' }
					topTierBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
					if (pet.world.keeper.tier !== 'legendary') {
						return {
							ok: false,
							reason: '点了「超级稀有」但 world.keeper.tier 是 ' + pet.world.keeper.tier,
						}
					}

					// —— 价格滑条**已经删掉了** ——
					//
					// ⚠ 这条是**反向**断言：查那张卡上不再有任何输入控件，
					//   也不再有 minValue 这个状态。
					//
					//   删一个功能时最容易留下的坏法是「界面没了、状态还在」——
					//   自动出售照样被一个看不见、也改不了的门槛拦着，
					//   玩家只会觉得「开了自动出售怎么不卖」。
					//   所以下面三样都要查：DOM 里没有、world 里没有、
					//   而且**真的按价值档在卖**
					if (kpop.querySelector('input')) {
						return { ok: false, reason: '养蝇人卡片上还有 input —— 价格滑条应当已经整条删掉了' }
					}
					if (kpop.querySelector('#keeper-value')) {
						return { ok: false, reason: '养蝇人卡片上还留着价格数字 #keeper-value' }
					}
					if ('minValue' in pet.world.keeper) {
						return {
							ok: false,
							reason: 'world.keeper 里还有 minValue —— 界面没了但门槛还在偷偷拦人',
						}
					}

					// 自动出售真的**只看「卖哪档」**：摆两只极端价值的虫，
					// 换档位时它们的去留必须跟着反转
					//
					// ⚠ 不能只查「选对了能卖掉」—— 那只说明有个筛子，
					//   说明不了筛的是价值档。所以两个方向都查：
					//   选最低档 → 极贵的留下、极便宜的卖掉；换最高档 → 反过来。
					//   并且**不去自己算档位**（另写一遍 valueTierOf 的边界就是
					//   拿断言测断言自己的算术），只按「刚羽化」和「快老死」这两种
					//   价值上差着好几个数量级的成虫来分
					pet.world.shop.keeper = 2
					pet.ui.refreshKeeperCard()
					kpop.querySelector('[data-k-sell="1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
					kpop.querySelector('[data-k-mut="1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
					if (!pet.world.keeper.sell || !pet.world.keeper.mutants) {
						return { ok: false, reason: '点了「开」和「含」，world.keeper 却没跟着变' }
					}

					const TIERS = pet.config.market.valueTiers
					const lowTier = TIERS[0].id
					const savedFlies = pet.world.flies.slice()
					pet.world.money = 0
					pet.world.keeper.sold = 0

					// 摆一只成虫，把「卖哪档」设成 tierId，跑一次自动出售，
					// 返回它到底有没有被卖掉。
					// heavy 为真时先把它顶到「最重 + 快老死」—— 价值比刚羽化的
					// 那只高出好几个数量级（weight 是按 weightMax 插值的 getter，
					// 所以改 weightMax 就够，不用碰 value 那个只读的 getter）
					const trySell = (heavy, tierId) => {
						pet.world.flies.length = 0
						const f = pet.world.addFly(500, 500, 'F')
						if (heavy) {
							f.weightMax = 10000
							f.age = f.lifespan * 0.999
						}
						pet.world.keeper.tier = tierId
						pet.world._keeperSell()
						return pet.world.flies.length === 0
					}
					const tiersThatSell = (heavy) => TIERS.filter((t) => trySell(heavy, t.id)).map((t) => t.id)

					// ① 刚羽化的轻蝇：**只有**最低那档卖得掉
					const lightSold = tiersThatSell(false)
					if (lightSold.length !== 1 || lightSold[0] !== lowTier) {
						return {
							ok: false,
							reason:
								'一只刚羽化的成虫在「' + (lightSold.join('/') || '没有任何一档') +
								'」被卖掉了，应当只在最低那档「' + lowTier + '」',
						}
					}
					// ② 顶到最重的老蝇：也应当**恰好**有一档卖得掉。
					//    这条顺带钉死了「六档是价值轴上不重叠的一套划分」——
					//    两个档都能卖同一只，说明边界排错了（或者没排序）
					const heavySold = tiersThatSell(true)
					if (heavySold.length !== 1) {
						return {
							ok: false,
							reason:
								'一只最重的成虫在 ' + heavySold.length + ' 个档位下都被卖掉了（' +
								(heavySold.join('/') || '一个都没有') + '），价值档应当恰好命中一个',
						}
					}
					// ③ 而且它不能和刚羽化的那只落在同一档 —— 否则上面两条
					//    其实什么都没区分开，改坏了也照样绿
					if (heavySold[0] === lowTier) {
						return {
							ok: false,
							reason: '最重的成虫和最轻的落在了同一档「' + lowTier + '」，这条断言分不出档位对错',
						}
					}
					// 还原现场：这条断言动了果蝇数组，后面的块还要用
					pet.world.flies.length = 0
					Array.prototype.push.apply(pet.world.flies, savedFlies)

					// Escape 关掉
					pet.ui._onKey({ code: 'Escape' })
					if (!kpop.classList.contains('hidden')) {
						return { ok: false, reason: 'Esc 关不掉养蝇人配置卡' }
					}

					// 还原现场
					pet.world.money = savedMoney
					pet.world.shop = savedShop
					pet.world.keeper = savedKeeper
					pet.ui.refreshShop()
				} catch (e) {
					return { ok: false, reason: '养蝇人流程失败: ' + e.message }
				}

				// —— 图鉴 ——
				//
				// ⚠ 食物格子是**真的画出来的**（每格一个小 canvas）。所以这条不能
				//   只查「元素在不在」—— 画布建出来了、但一个像素都没画，
				//   元素查询照样全绿，而那是一个空白格子。
				//   这里去读**像素**：画布上必须有非透明的像素
				try {
					const cpop = document.getElementById('codex-pop')
					const cbody = document.getElementById('codex-body')
					if (!cpop || !cbody) return { ok: false, reason: '图鉴弹窗的 DOM 不存在' }
					if (cpop.closest('.window')) {
						return { ok: false, reason: '#codex-pop 被放进了 .window 里 —— 会被 overflow:hidden 剪掉' }
					}
					if (!cpop.classList.contains('hidden')) return { ok: false, reason: '图鉴默认应当是关着的' }

					document.getElementById('btn-codex').click()
					if (cpop.classList.contains('hidden')) {
						return { ok: false, reason: '点了图鉴按钮但弹窗没有出现' }
					}

					// 食物格：**配置里有几种就画几格**，一格不少。
					//
					// ⚠ 这里**不能**再用 unlockedFoodIds()。那是投放面板的口径
					//   （未解锁的星空苹果根本不出现）；图鉴要的是「全都画出来，
					//   没拿到的置灰」。两个口径都是对的，用错了才会有问题 ——
					//   用投放那份，图鉴会少一格而没人发现
					const foodCells = cbody.querySelectorAll('[data-food]')
					const wantFoods = pet.ui._allFoodIds()
					if (foodCells.length !== wantFoods.length) {
						return {
							ok: false,
							reason: '图鉴里画了 ' + foodCells.length + ' 种食物，应当是 ' + wantFoods.length + ' 种',
						}
					}
					for (const cell of foodCells) {
						const cv = cell.querySelector('canvas')
						if (!cv) return { ok: false, reason: '食物格「' + cell.dataset.food + '」里没有画布' }
						const c2 = cv.getContext('2d')
						const img = c2.getImageData(0, 0, cv.width, cv.height).data
						let painted = 0
						for (let i = 3; i < img.length; i += 4) if (img[i] > 0) painted++
						if (painted === 0) {
							return {
								ok: false,
								reason: '食物格「' + cell.dataset.food + '」的画布是空的 —— 一格白的',
							}
						}
						// 灰格也要画东西 —— 「置灰」是 CSS 的 filter，不是不画。
						// 画布空白的话，玩家看到的是一个空洞，不是「还没拿到的东西」
					}

					// 星空苹果：**解锁前也必须画出来**，只是带 locked。
					// 这一条守的是「别哪天又把它 filter 掉了」
					{
						const starCell = cbody.querySelector('[data-food="star"]')
						if (!starCell) {
							return { ok: false, reason: '图鉴里没有星空苹果那一格 —— 它应当一直在，只是没解锁时置灰' }
						}
						// ⚠ 名字要留着：藏起来的话玩家看不出这一格是什么东西
						const starName = starCell.querySelector('.codex-name')
						if (!starName || !starName.textContent.includes('星空苹果')) {
							return { ok: false, reason: '星空苹果那格没写名字' }
						}
						const starLocked = starCell.classList.contains('locked')
						if (starLocked === pet.ui.starUnlocked) {
							return {
								ok: false,
								reason:
									'星空苹果那格的灰态和解锁状态对不上：locked=' + starLocked +
									'、starUnlocked=' + pet.ui.starUnlocked,
							}
						}
						// 灰的时候说明必须藏掉 —— 那句话写着「吃星空苹果长出星云」，
						// 正是彩蛋本身
						if (starLocked && !starCell.textContent.includes('？？？')) {
							return { ok: false, reason: '星空苹果还没解锁，说明却没藏起来' }
						}
					}

					// 突变格：数量 = CONFIG.mutation.types，一格不少。
					//
					// ⚠ 查之前先把「见过哪些」摆成一个**已知状态**。
					//   不摆的话，灰的是哪几格取决于这一局随机骰出了什么突变
					//   （开局那几只走 rollDeNovo）—— 断言就成了掷骰子：
					//   全都被见过时「灰格」一个都不剩，循环体一次都不跑，
					//   整个 for 循环变成**空转**，而它会显示成绿色通过。
					//   （实测踩过：把 locked 写死成 false，自检照样全绿）
					//
					// ⚠ 直接改私有字段是自检的常规手段（别处也有 starTaps = 0），
					//   查完必须**还原**，否则后面那几条断言看到的是被改过的状态
					const savedSeen = pet.ui._seenGenes.slice()
					pet.ui._seenGenes = ['crystal']
					pet.ui.refreshCodex()

					const geneCells = cbody.querySelectorAll('[data-gene]')
					if (geneCells.length !== pet.config.mutation.types.length) {
						return {
							ok: false,
							reason:
								'图鉴里列了 ' + geneCells.length + ' 种基因，应当是 ' +
								pet.config.mutation.types.length + ' 种',
						}
					}
					for (const cell of geneCells) {
						const badge = cell.querySelector('.gene-badge')
						if (!badge) return { ok: false, reason: '基因格「' + cell.dataset.gene + '」里没有徽章' }
						const t = pet.config.mutation.types.find((m) => m.id === cell.dataset.gene)
						// 名字（徽章）**灰格也要留着** —— 藏起来的话玩家看不出
						// 这一格是「还不知道是什么」还是「压根没有这一格」
						if (!badge.textContent.includes(t.name)) {
							return {
								ok: false,
								reason: '基因格「' + cell.dataset.gene + '」上写的是「' + badge.textContent + '」，应当是「' + t.name + '」',
							}
						}

						// ⚠ 灰态必须**和 seenGene 对得上**。这一条是唯一能抓住
						//   「判据写反了 / 永远不锁」的断言 —— 光靠下面那两条
						//   「灰格写了？？？」，在「所有格子都不灰」时会一次都不跑、
						//   直接绿着通过
						const isLocked = cell.classList.contains('locked')
						if (isLocked !== !pet.ui.seenGene(cell.dataset.gene)) {
							return {
								ok: false,
								reason: '基因格「' + cell.dataset.gene + '」的灰态和 seenGene 对不上：locked=' +
									isLocked + '、seen=' + pet.ui.seenGene(cell.dataset.gene),
							}
						}

						// 亮格和灰格的差别，就在这里分开查
						if (isLocked) {
							// 灰格 = 还没见过。**效果和概率一个字都不许露** ——
							// 露了就等于把图鉴当成剧透手册
							if (!cell.textContent.includes('？？？')) {
								return {
									ok: false,
									reason: '基因格「' + cell.dataset.gene + '」是灰的，却没写「？？？」',
								}
							}
							if (cell.textContent.includes('%')) {
								return {
									ok: false,
									reason: '灰格「' + cell.dataset.gene + '」把概率漏出来了：' + cell.textContent,
								}
							}
							if (!cell.dataset.locked) {
								return { ok: false, reason: '灰格「' + cell.dataset.gene + '」没有 data-locked 标记' }
							}
						} else {
							// 亮格 = 见过，必须给出真数值
							//
							// ⚠ 概率那一行只对**会新发**的突变成立（星云的新发概率是 0，
							//   写「0.0%」是谎），所以沿用 _codexGeneCell 里同一条分支
							if (cell.textContent.includes('？？？')) {
								return {
									ok: false,
									reason: '基因格「' + cell.dataset.gene + '」是亮的，却还写着「？？？」',
								}
							}
							const pct = (t.chance * 100).toFixed(1) + '%'
							// ⚠ 这三元和 ui._codexGeneCell 里那份**逐字对应**。
							//   只改一边的话，这条断言会在措辞换掉时红，
							//   而且报的是「没出现『无法自然获得』」—— 指错方向
							const want =
								t.chance > 0
									? pct
									: t.fromStar
										? '吃星空苹果获得'
										: t.fromTool
											? '金锤敲出来'
											: '无法自然获得'
							if (!cell.textContent.includes(want)) {
								return {
									ok: false,
									reason: '基因格「' + cell.dataset.gene + '」上没有出现「' + want + '」',
								}
							}
						}
					}

					// ⚠ 灰的亮的分开**数一遍**。上面那个 for 里两条分支各自成立，
					//   但「一个灰的都没有」时两条都白跑 —— 数一遍才能把
					//   「锁定判据整个失效」变成红的。
					//   摆进去的 seen 只有 crystal 一个，所以这里期望 1 亮 4 灰
					const nLocked = [...geneCells].filter((el) => el.classList.contains('locked')).length
					const wantLocked = pet.config.mutation.types.length - 1
					if (nLocked !== wantLocked) {
						return {
							ok: false,
							reason:
								'只知道「见过结晶」一种突变，图鉴里却有 ' + nLocked +
								' 格是灰的（应当是 ' + wantLocked + ' 格）',
						}
					}
					const crystalCell = cbody.querySelector('[data-gene="crystal"]')
					if (!crystalCell || crystalCell.classList.contains('locked')) {
						return { ok: false, reason: '见过结晶，图鉴里那一格却是灰的' }
					}

					// —— 基因格里的**画像** ——
					//
					// ⚠ 这一段是在 _seenGenes = ['crystal'] 的状态下跑的：
					//   1 格亮、4 格灰。那 4 张暗影正好用来验一条最本质的性质 ——
					//   **暗影与基因无关**（见 render.drawFlyIcon 的 silhouette 分支）
					// ⚠ 四个小工具**声明在两个 try 外面**：灰态和亮态两段都要用，
					//   放进第一个 try 里的话第二段会报 "sigOf is not defined"
					const paintOf = (cv) => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data

					/** 有墨的像素数 + 包围盒。包围盒用来抓「翅尖被裁掉」 */
					const boxOf = (cv) => {
						const d = paintOf(cv)
						const w = cv.width
						const h = cv.height
						let minX = w
						let maxX = -1
						let minY = h
						let maxY = -1
						let painted = 0
						for (let y = 0; y < h; y++) {
							for (let x = 0; x < w; x++) {
								if (d[(y * w + x) * 4 + 3] === 0) continue
								painted++
								if (x < minX) minX = x
								if (x > maxX) maxX = x
								if (y < minY) minY = y
								if (y > maxY) maxY = y
							}
						}
						return { minX, maxX, minY, maxY, painted, w, h }
					}

					/** 把「画了哪些像素、什么颜色」拼成一个字符串，用来比两张画布一不一样 */
					const sigOf = (cv) => {
						const d = paintOf(cv)
						const parts = []
						for (let i = 0; i < d.length; i += 4) {
							if (d[i + 3] === 0) continue
							parts.push(i, d[i], d[i + 1], d[i + 2], d[i + 3])
						}
						return parts.join(',')
					}

					/** 「红能量」：偏红多少。普通蝇本来就有红眼，所以只能比相对量 */
					const redOf = (cv) => {
						const d = paintOf(cv)
						let e = 0
						for (let i = 0; i < d.length; i += 4) {
							e += Math.max(0, d[i] - (d[i + 1] + d[i + 2]) / 2) * (d[i + 3] / 255)
						}
						return e
					}

					try {
						// 1) 每格都得有画布，而且**画布上真的有东西**
						//    ⚠ 灰格也要画（暗影），所以这条对两种状态都成立
						for (const cell of geneCells) {
							const id = cell.dataset.gene
							const cv = cell.querySelector('canvas')
							if (!cv) return { ok: false, reason: '基因格「' + id + '」里没有画布' }
							const b = boxOf(cv)
							if (!b.painted) {
								return { ok: false, reason: '基因格「' + id + '」的画布是空的 —— 一整格什么都没有' }
							}
							// 2) 不能碰到画布边缘。
							//    ⚠ 这是「横向偏置没加、翅尖被裁掉」的**唯一把关人** ——
							//    34px 的格子里裁掉一个多像素，肉眼基本看不出来
							if (b.minX <= 0 || b.minY <= 0 || b.maxX >= b.w - 1 || b.maxY >= b.h - 1) {
								return {
									ok: false,
									reason:
										'基因格「' + id + '」的画像顶到画布边了（x ' + b.minX + '~' + b.maxX +
										'，y ' + b.minY + '~' + b.maxY + '，画布 ' + b.w + '×' + b.h +
										'）—— 多半是 drawFlyIcon 里那个横向偏置没加，翅尖被裁掉了',
								}
							}
						}

						// 3) **所有灰格长得一模一样**。
						//
						// ⚠ 这条是整段的核心。暗影只取决于体型和性别，和是哪一种突变无关 ——
						//   哪天灰格画了真身、或者按基因改了暗影，这几张立刻互不相同。
						//   ⚠ 比「同一格 灰 vs 亮 逐像素不同」强得多：亮格（结晶 / 金）
						//   吃 performance.now()，两张画布天然逐像素不同，那个 bug 反而会被放过
						const lockedCells = [...geneCells].filter((c) => c.classList.contains('locked'))
						const lockedSigs = lockedCells.map((c) => sigOf(c.querySelector('canvas')))
						const uniqLocked = new Set(lockedSigs).size
						if (lockedCells.length > 1 && uniqLocked !== 1) {
							return {
								ok: false,
								reason:
									'没见过的 ' + lockedCells.length + ' 个基因格有 ' + uniqLocked +
									' 种画法 —— 暗影应当只取决于体型和性别，和是哪一种突变无关（现在至少有格子把真身画出来了）',
							}
						}
					} catch (e) {
						return { ok: false, reason: '基因格画像（灰态）失败: ' + e.message }
					}

					// —— 亮着的基因格：各不相同，而且疯狂真的有红光 ——
					try {
						pet.ui._seenGenes = pet.config.mutation.types.map((t) => t.id)
						pet.ui.refreshCodex()
						// ⚠ refreshCodex() 是整块重建，上面那个 geneCells 已经失效了
						const litCells = [...document.querySelectorAll('[data-gene]')]
						const litSigs = litCells.map((c) => sigOf(c.querySelector('canvas')))

						// 4) 至少有两格画得不一样。
						//    ⚠ 没有这条，上面「灰格全一样」在「所有格子都画同一个东西」时
						//   也会绿 —— 两条必须成对（和别处「②③ 必须成对」一个道理）
						const uniqLit = new Set(litSigs).size
						if (uniqLit < 2) {
							return {
								ok: false,
								reason:
									'五格全见过之后，' + litCells.length + ' 个基因格只有 ' + uniqLit +
									' 种画法 —— 不同突变应当长得不一样',
							}
						}

						// 4.5) 金蝇那格**真的有闪光**。
						//
						// 图鉴上写着「通体金色、带闪光」—— 闪光要是没画出来，
						// 那就是一句假话，而且**不报任何错**，只能量像素。
						//
						// ⚠ 本来担心的是「定死的那个相位正好 5 颗闪点全暗」，
						//   实测**不可能**：5 颗的相位两两差 2.3 弧度、铺开 9.2 弧度
						//   （超过一整个周期），而判定条件是 sin > 0.25 ——
						//   扫过 0~6000ms 每一毫秒都没找到一个全暗的相位。
						//   所以这条抓的不是相位，是「闪光整个没画」（把
						//   drawGoldSparkle 那句注掉，它当场就红）
						//
						// ⚠ 判据是「比金色身体更亮的淡黄」。金蝇身上最亮的颜色是
						//   bodyColorLight #f2cc63（b=99），闪光是 #fff8d8（b=216）——
						//   拿蓝通道当分界线最干净，金色系整个都在 100 以下
						const goldCell = document.querySelector('[data-gene="golden"]')
						const goldCv = goldCell && goldCell.querySelector('canvas')
						if (!goldCv) return { ok: false, reason: '找不到金蝇那一格的画布' }
						const gd = paintOf(goldCv)
						let sparkle = 0
						for (let i = 0; i < gd.length; i += 4) {
							if (gd[i + 3] > 0 && gd[i + 2] > 150 && gd[i] > 200) sparkle++
						}
						if (sparkle === 0) {
							return {
								ok: false,
								reason:
									'金蝇那格一个闪光像素都没有 —— 图鉴上写着「带闪光」，画出来却没有。' +
									'多半是 drawGoldSparkle 那句没执行，或者它的颜色 / 半径被改没了',
							}
						}

						// 4.6) 封禁那格**真的是冷色的黑玻璃，而且断口弧画上了**。
						//
						// ⚠ 判据只能走**相对量**，不能写死颜色：图鉴上写着
						//   「身体是流动的黑曜石断口」，画出来却是一只暖色的普通蝇
						//   也不报任何错。可用的对照是「普通蝇本来就是暖的」
						//   （暗红头 + 红眼），封禁那只是冷的（近黑玻璃 + 冷白弧）
						//
						// ⚠ 两条必须成对。少了上面那条，「探针根本没画上」
						//   （两张都是 0）也会让它绿
						const coldOf = (cv) => {
							const d = paintOf(cv)
							let e = 0
							for (let i = 0; i < d.length; i += 4) {
								e += Math.max(0, d[i + 2] - d[i]) * (d[i + 3] / 255)
							}
							return e
						}
						const warmOf = (cv) => {
							const d = paintOf(cv)
							let e = 0
							for (let i = 0; i < d.length; i += 4) {
								e += Math.max(0, d[i] - d[i + 2]) * (d[i + 3] / 255)
							}
							return e
						}

						const banCell = document.querySelector('[data-gene="ban"]')
						if (!banCell) return { ok: false, reason: '图鉴里找不到封禁那一格' }
						const banCv = banCell.querySelector('canvas')
						if (!banCv) return { ok: false, reason: '找不到封禁那一格的画布' }

						const scratch = document.createElement('canvas')
						scratch.width = 34
						scratch.height = 34
						const sctx = scratch.getContext('2d')
						sctx.translate(17, 17)
						// 尺寸和种子**和基因格里的完全一致**，量的才是玩家真看到的那张
						pet.drawFlyIcon(sctx, [], 34 * 0.58, 7, false)

						const plainCold = coldOf(scratch)
						const plainWarm = warmOf(scratch)
						const banCold = coldOf(banCv)
						const banWarm = warmOf(banCv)
						flyIconPolarity = [plainWarm - plainCold, banCold - banWarm]

						if (!(plainWarm > plainCold)) {
							return {
								ok: false,
								reason:
									'普通蝇量出来居然不偏暖（暖 ' + plainWarm.toFixed(0) + ' / 冷 ' +
									plainCold.toFixed(0) + '）—— 探针本身就不对，下面那条不算数',
							}
						}
						if (!(banCold > banWarm)) {
							return {
								ok: false,
								reason:
									'封禁那格不偏冷（冷 ' + banCold.toFixed(0) + ' / 暖 ' + banWarm.toFixed(0) +
									'）—— 图鉴上写着「身体是流动的黑曜石断口」，画出来却还是暖色的。' +
									'多半是 OBSIDIAN_PALETTE 没进 flyVisual 的叠加链',
							}
						}

						// 冷色里还得有**亮**的 —— 黑曜石的黑不提供辨识度，
						// 全靠断口那几道反光（见 render.banSheen 的注释）。
						// 只查「偏冷」的话，一只纯深蓝的死虫子也能过
						const bd = paintOf(banCv)
						let arc = 0
						for (let i = 0; i < bd.length; i += 4) {
							if (bd[i + 3] > 0 && bd[i + 2] > 170 && bd[i + 2] - bd[i] > 40) arc++
						}
						if (arc === 0) {
							return {
								ok: false,
								reason:
									'封禁那格一个亮的冷色像素都没有 —— 断口弧没画上。' +
									'banSheen 里那两处 obsidianRing 调用多半没执行',
							}
						}

						// 5) 疯狂的红光。
						//    ⚠ 不能只查「有没有红色像素」：普通蝇自己就有红眼
						//   （eyeColor #c62f22、headColor #63201c）。图鉴五格里也没有
						//   「普通蝇」这一格可比，所以自己拿**同一个 size / seed** 画两张
						const probe = document.createElement('canvas')
						probe.width = 34
						probe.height = 34
						const pctx = probe.getContext('2d')
						const redOfGenes = (genes) => {
							pctx.setTransform(1, 0, 0, 1, 0, 0)
							pctx.clearRect(0, 0, 34, 34)
							pctx.translate(17, 17)
							// 尺寸和种子**和基因格里的完全一致**，量的才是玩家真看到的那张
							pet.drawFlyIcon(pctx, genes, 34 * 0.58, 7, false)
							return redOf(probe)
						}
						const plainRed = redOfGenes([])
						const berserkRed = redOfGenes(['berserk'])
						flyIconRed = [plainRed, berserkRed]
						if (!(plainRed > 0)) {
							return { ok: false, reason: '普通蝇的红能量量出来是 0 —— 探针本身就没画上' }
						}
						if (!(berserkRed >= plainRed * 1.25)) {
							return {
								ok: false,
								reason:
									'疯狂蝇的红光不够亮：普通蝇 ' + plainRed.toFixed(0) + ' → 疯狂蝇 ' +
									berserkRed.toFixed(0) + '（要求至少 1.25 倍）。' +
									'眼睛那圈泛光多半没画上，或者被 globalAlpha 带淡了',
							}
						}
					} catch (e) {
						return { ok: false, reason: '基因格画像（亮态）失败: ' + e.message }
					}

					// 查完了，把 seen 还原 —— 后面还有断言要看真实状态
					pet.ui._seenGenes = savedSeen
					pet.ui.refreshCodex()

					// —— 封禁那格的**样式**：黑曜石流光真的挂上去了吗 ——
					//
					// ⚠ 这一段抓的是「CSS 选择器悄悄没匹配上」。ui.js 用
					//   cell.dataset.gene = id 写属性，style.css 用
					//   [data-gene='ban'] 去选 —— 任意一边改了名字，结果只是
					//   **那枚胶囊长得和别的胶囊一样**：不报错、不崩、
					//   上面那些像素断言也全绿（画像和样式是两回事）。
					//
					//   ui.js 里「封禁不写 inline borderColor」那句同理：
					//   写回去就会盖掉 CSS，症状和上面一模一样
					try {
						const allGenes = pet.config.mutation.types.map((t) => t.id)

						// —— 亮着的时候 ——
						pet.ui._seenGenes = allGenes
						pet.ui.refreshCodex()
						let cell = document.querySelector('[data-gene="ban"]')
						if (!cell) return { ok: false, reason: '图鉴里找不到封禁那一格' }
						if (cell.classList.contains('locked')) {
							return { ok: false, reason: '把封禁标成见过了，图鉴里那一格却还是灰的' }
						}

						const badge = cell.querySelector('.gene-badge')
						if (!badge) return { ok: false, reason: '封禁那一格没有胶囊' }
						const bc = getComputedStyle(badge)
						if (bc.borderTopColor.indexOf('0, 0, 0, 0') < 0) {
							return {
								ok: false,
								reason:
									'封禁胶囊的边框不是透明的（' + bc.borderTopColor + '）—— ' +
									'黑曜石那圈流光是拿 background 画进边框里的，边框不透明就把它整个盖住了。' +
									'多半是 ui.js 又把 borderColor 写成了 inline',
							}
						}
						if (bc.animationName !== 'border-flow') {
							return {
								ok: false,
								reason:
									'封禁胶囊没有在流动（animation-name = ' + bc.animationName + '）—— ' +
									'多半是 [data-gene=ban] 那条选择器没匹配上',
							}
						}
						const layers = bc.backgroundImage.split('linear-gradient').length - 1
						if (layers < 3) {
							return {
								ok: false,
								reason:
									'封禁胶囊只有 ' + layers + ' 层背景，应当是 3 层' +
									'（两层不透明内芯 + 一层会流动的渐变边框）',
							}
						}

						const nm = cell.querySelector('.codex-name')
						if (!nm) return { ok: false, reason: '封禁那一格没有说明文字' }
						const nc = getComputedStyle(nm)
						if (nc.webkitTextFillColor.indexOf('0, 0, 0, 0') < 0) {
							return {
								ok: false,
								reason:
									'封禁的说明文字不是渐变填充（-webkit-text-fill-color = ' +
									nc.webkitTextFillColor + '）。少写那一句的话文字是实心灰的，' +
									'渐变完全看不见，而且不会报错',
							}
						}
						const clip = nc.webkitBackgroundClip || nc.backgroundClip
						if (clip !== 'text') {
							return {
								ok: false,
								reason: '封禁的说明文字没有裁到字形上（background-clip = ' + clip + '）',
							}
						}
						if (nc.animationName !== 'border-flow') {
							return {
								ok: false,
								reason: '封禁的说明文字没有在流动（animation-name = ' + nc.animationName + '）',
							}
						}

						// —— 灰着的时候 ——
						//
						// ⚠ 只靠 .codex-cell.locked .gene-badge 那条 grayscale 是不够的：
						//   filter 只改颜色，动画照跑。一格「？？？」会成为整张图鉴里
						//   唯一在动的东西，而「在动」在余光里就是「值得看」
						pet.ui._seenGenes = ['crystal']
						pet.ui.refreshCodex()
						cell = document.querySelector('[data-gene="ban"]')
						if (!cell || !cell.classList.contains('locked')) {
							return { ok: false, reason: '把封禁标成没见过，图鉴里那一格却没变灰' }
						}
						const ln = getComputedStyle(cell.querySelector('.codex-name'))
						const lb = getComputedStyle(cell.querySelector('.gene-badge'))
						if (ln.animationName !== 'none' || lb.animationName !== 'none') {
							return {
								ok: false,
								reason:
									'没解锁的封禁格还在流动（文字 ' + ln.animationName + ' / 胶囊 ' +
									lb.animationName + '）—— 那一格现在是「你还没拿到」，不该是最抢眼的',
							}
						}
						if (ln.webkitTextFillColor.indexOf('0, 0, 0, 0') >= 0) {
							return {
								ok: false,
								reason:
									'没解锁的封禁格文字还是渐变填充 —— locked 那条 rule 改的是 color，' +
									'对渐变填充完全无效，必须显式把 background 和 fill 一起撤掉',
							}
						}

						// 还原
						pet.ui._seenGenes = savedSeen
						pet.ui.refreshCodex()
					} catch (e) {
						return { ok: false, reason: '封禁那格的样式断言失败: ' + e.message }
					}

					pet.ui._onKey({ code: 'Escape' })
					if (!cpop.classList.contains('hidden')) {
						return { ok: false, reason: 'Esc 关不掉图鉴' }
					}
				} catch (e) {
					return { ok: false, reason: '图鉴流程失败: ' + e.message }
				}

				// —— 「见过」这条链路：world 记 → 主循环抽干 → ui 点亮 ——
				//
				// ⚠ 分两段查，因为它是**两个进程/两层之间**的接力，
				//   任何一段断了症状都一样（图鉴那一格永远灰着），
				//   但修的地方完全不同：前半段在 world.js，后半段在 app.js
				try {
					const g = 'stone'
					// 先把这一格按灭，确保后面查到的「亮了」是这一次造成的
					pet.ui._seenGenes = pet.ui._seenGenes.filter((id) => id !== g)
					pet.world.seenGenes.length = 0

					const probe = pet.world.addFly(12, 12, 'M', 'normal', [g])
					if (!probe) return { ok: false, reason: '自检造不出探针果蝇（撞上限了？）' }

					// 前半段：世界有没有把它收进收件箱
					if (!pet.world.seenGenes.includes(g)) {
						return { ok: false, reason: '世界没记下刚出生的突变 —— addFly 里少了一次 _noteGenes' }
					}

					// 后半段：主循环把它交给 ui 了没有。
					// ⚠ 抽干发生在 app.js 的 frame() 里，所以必须**真的等一帧**
					await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
					if (!pet.ui.seenGene(g)) {
						return {
							ok: false,
							reason: '世界记下了突变，主循环却没把它交给图鉴 —— app.js 里那段 drain 断了',
						}
					}

					// 探针果蝇不该留在世界里影响后面那些数虫子的断言
					const i = pet.world.flies.indexOf(probe)
					if (i >= 0) pet.world.flies.splice(i, 1)
				} catch (e) {
					return { ok: false, reason: '「见过」链路失败: ' + e.message }
				}

				// —— 成就 ——
				try {
					const savedAch = pet.ui._achievements.slice()
					const savedSeen = pet.ui._seenGenes.slice()
					const savedEarned = pet.world.stats.earned
					// ⚠ 彩蛋状态也要抓 —— 下面会把它拨来拨去，
					//   不还原的话后面「星云苹果锁着」那类断言全都会歪
					const savedStar = pet.ui.starUnlocked
					const banner = document.getElementById('achievement')
					const bannerText = document.getElementById('achievement-text')
					if (!banner || !bannerText) {
						return { ok: false, reason: '成就横幅的 DOM 不存在（#achievement / #achievement-text）' }
					}
					// 横幅必须**不吃鼠标**：窗口平时是穿透的，它一旦参与捕捉，
					// 屏幕中上方会凭空多出一块吃掉桌面点击的区域
					if (getComputedStyle(banner).pointerEvents !== 'none') {
						return {
							ok: false,
							reason: '成就横幅会吃鼠标（pointer-events: ' + getComputedStyle(banner).pointerEvents + '）—— 它应当纯展示',
						}
					}

					// 每个成就的配置都要能对上：有 id、有文字、kind 认得出来。
					// ⚠ 这条守的是「配置写错了」—— kind 拼错的话那条成就**永远不会触发**，
					//   而不会报任何错
					for (const a of pet.config.achievements) {
						if (!a.id || !a.text) return { ok: false, reason: '成就配置缺 id 或 text：' + JSON.stringify(a) }
						if (a.kind === 'mutation' && !a.gene) {
							return { ok: false, reason: '成就「' + a.id + '」是 mutation 类却没有 gene 字段' }
						}
						if (a.kind === 'wealth' && typeof a.at !== 'number') {
							return { ok: false, reason: '成就「' + a.id + '」是 wealth 类却没有 at 字段' }
						}
						if (!['mutation', 'star', 'wealth'].includes(a.kind)) {
							return { ok: false, reason: '成就「' + a.id + '」的 kind 认不出来：' + a.kind }
						}
					}

					// 图标文件**真的加载得出来**吗。
					//
					// ⚠ 名字打错一个字母（或者漏拷一个文件）的表现是「横幅上
					//   那一块是空的」—— 浏览器对 img 加载失败**不报错、不抛异常**，
					//   连 console 里都没有一行。只能这样一个个真的去 load 一遍。
					//   而这几张图是 SVG，路径和大小写都敏感（Windows 上文件系统
					//   不敏感，但打包成 asar 之后就不一定了），所以大小写也要对
					for (const a of pet.config.achievements) {
						if (!a.icon) continue
						const loaded = await new Promise((res) => {
							const im = new Image()
							im.onload = () => res(true)
							im.onerror = () => res(false)
							im.src = 'assets/achievements/' + a.icon
						})
						if (!loaded) {
							return {
								ok: false,
								reason: '成就「' + a.id + '」的图标加载不出来：assets/achievements/' + a.icon +
									' —— 文件没拷进来，或者名字对不上（大小写也算）',
							}
						}
					}

					// 从头来一遍
					pet.ui.setAchievements([])
					pet.ui._achievementQueue.length = 0

					// 1) 四种突变：见到 → 拿成就；再见 → **不该重复**
					//
					// ⚠ 逐个来而不是只挑一种试：_checkGeneAchievement 是按
					//   a.gene === geneId 认人的，配置里那个 id 打错一个字母
					//   （goldn / chrismal）那条成就就**永远不会触发**，
					//   而且不会有任何报错。只有拿真 id 挨个撞一遍才发现得了。
					//
					// ⚠ 撞之前要先把这一种从 _seenGenes 里摘掉 —— 上面「见过链路」
					//   那一段已经让「石化」变成见过的了，留着的话 noteSeenGenes
					//   会走 continue，成就根本不会被查
					const geneIds = pet.config.mutation.types.map((t) => t.id)
					for (const a of pet.config.achievements) {
						if (a.kind !== 'mutation') continue
						if (!geneIds.includes(a.gene)) {
							return {
								ok: false,
								reason: '成就「' + a.id + '」挂在一个不存在的突变上（' + a.gene +
									'）—— 真实 id 只有 ' + geneIds.join(' / ') + '，这条成就永远拿不到',
							}
						}
						pet.ui.setAchievements([])
						pet.ui._seenGenes = pet.ui._seenGenes.filter((x) => x !== a.gene)
						pet.ui.noteSeenGenes([a.gene])
						if (!pet.ui.hasAchievement(a.id)) {
							return { ok: false, reason: '第一次见到「' + a.gene + '」却没有拿到成就「' + a.text + '」' }
						}
						// 同一种再见一次 —— 不该再拿一遍
						pet.ui.noteSeenGenes([a.gene])
						if (pet.ui._achievements.length !== 1) {
							return {
								ok: false,
								reason: '同一种突变见过两次，成就拿了 ' + pet.ui._achievements.length +
									' 遍（应当只有 1 遍）',
							}
						}
					}

					// 2) 彩蛋。
					//
					// ⚠ 关键在顺序：setStarUnlocked 的「值没变就早退」**拦不住**
					//   启动恢复 —— 那一次 false → true 状态确实是变的。
					//   只有 opt.silent 能把它和玩家真解锁区分开。所以这里两个方向
					//   都要试：silent 不能给，非 silent 必须给
					pet.ui.setAchievements([])
					pet.ui.setStarUnlocked(false, { silent: true }) // 先按灭，保证下面那次是「真的变了」
					pet.ui.setStarUnlocked(true, { silent: true }) // silent = 启动恢复，**不该**给成就
					if (pet.ui.hasAchievement('starApple')) {
						return {
							ok: false,
							reason: '按存档恢复彩蛋（silent）时也弹了成就 —— 每次开程序都会重放一遍「小时的梦想」',
						}
					}
					pet.ui.setStarUnlocked(false, { silent: true })
					pet.ui.setStarUnlocked(true) // 这次是真的解锁
					if (!pet.ui.hasAchievement('starApple')) {
						return { ok: false, reason: '彩蛋解锁了却没有拿到「小时的梦想」' }
					}

					// 3) 财富档位。⚠ wealthCases 有**五**条不是四条 ——
					//   「金苹果」那条也是 wealth 类（它就是 $0.1 那一档），
					//   所以这里顺带把「食物解锁」那个时刻也一起验了
					pet.ui.setAchievements([])
					const wealthCases = pet.config.achievements.filter((a) => a.kind === 'wealth').sort((a, b) => a.at - b.at)
					for (const a of wealthCases) {
						pet.ui._wealthWas = -1 // 逼 refreshStats 走「变了」那条路
						pet.world.stats.earned = a.at
						pet.ui.refreshStats()
						if (!pet.ui.hasAchievement(a.id)) {
							return { ok: false, reason: '总财富到 ' + a.at + ' 了却没有拿到成就「' + a.text + '」' }
						}
					}
					// 一次跨过好几档时，中间的也要一起给（不能只给最后一档）
					pet.ui.setAchievements([])
					pet.ui._wealthWas = -1
					pet.world.stats.earned = 20000
					pet.ui.refreshStats()
					if (pet.ui._achievements.length !== wealthCases.length) {
						return {
							ok: false,
							reason: '总财富一次到 20000，只拿到了 ' + pet.ui._achievements.length +
								' 个财富成就，应当是 ' + wealthCases.length + ' 个（跨档时中间那几档也要给）',
						}
					}

					// 4) 横幅：同时达成好几个时**只能显示一条**，其余排队
					//
					// ⚠ 上面第 3 步已经在播了，这里必须先把播放状态**清干净**，
					//   否则队列长度会多算一条正在播的，这条断言就变成随机红绿
					clearTimeout(pet.ui._achievementTimer)
					pet.ui._achievementTimer = null
					pet.ui.setAchievements([])
					pet.ui._achievementQueue.length = 0
					pet.ui._wealthWas = -1
					pet.world.stats.earned = 20000
					pet.ui.refreshStats()
					if (banner.classList.contains('hidden')) {
						return { ok: false, reason: '一口气拿了一堆成就，横幅却一条都没露出来' }
					}
					// 正在播的那一条**不在队列里**（队列里只剩下等着的那几条），
					// 所以这里应当是「成就数 − 1」
					if (pet.ui._achievementQueue.length !== pet.ui._achievements.length - 1) {
						return {
							ok: false,
							reason: '横幅没有排队：一口气拿到 ' + pet.ui._achievements.length + ' 个成就，屏幕上 1 条、' +
								'队列里却排了 ' + pet.ui._achievementQueue.length + ' 条（应当是 ' +
								(pet.ui._achievements.length - 1) + ' 条）—— 少排的那几条永远播不到',
						}
					}
					// 而且屏幕上那条得**真的**是刚拿到的某一个（不是残留的上一条）
					const shown = pet.config.achievements.find((a) => a.text === bannerText.textContent)
					if (!shown || !pet.ui.hasAchievement(shown.id)) {
						return {
							ok: false,
							reason: '横幅上写的是「' + bannerText.textContent + '」，和任何一个刚拿到的成就都对不上（像是残留的上一条）',
						}
					}
					// 图标：有图的那条要挂上 src，没图的（后四档财富成就）得藏起来 ——
					// 空 src 的 img 会显示成一个破图标
					if (!shown.icon) {
						if (!pet.ui.el.achievementIcon.classList.contains('hidden')) {
							return { ok: false, reason: '成就「' + shown.id + '」没有图标，img 却没藏起来（会显示成破图标）' }
						}
					} else if (pet.ui.el.achievementIcon.getAttribute('src') !== 'assets/achievements/' + shown.icon) {
						return {
							ok: false,
							reason: '成就「' + shown.id + '」的图标 src 是「' +
								pet.ui.el.achievementIcon.getAttribute('src') + '」，应当是 assets/achievements/' + shown.icon,
						}
					}

					// 5) 落盘 + 读回来。⚠ 这一条是**唯一**能发现「主进程白名单漏了新键」的断言 ——
					//    漏了的话渲染侧照写不误、拿不到任何错误，只有这里会红
					//
					// ⚠ 读这一下是 await，中间主循环还会跑好几帧 —— 一有新的变异体出生
					//   （noteSeenGenes → grantAchievement）就会**再写一次**这个文件，
					//   读到的东西就不是刚写下去的了。所以先按暂停键把世界冻住
					const wasPaused = pet.world.paused
					pet.world.paused = true
					pet.ui.setAchievements(['crystal', 'wealth10'])
					pet.ui._persistUnlock()
					const back = await window.pet.loadUnlock()
					pet.world.paused = wasPaused
					if (!Array.isArray(back?.data?.achievements)) {
						return { ok: false, reason: 'achievements 写下去之后读不回来（主进程白名单里是不是漏了这个键？）' }
					}
					if (back.data.achievements.join() !== 'crystal,wealth10') {
						return {
							ok: false,
							reason: '读回来的成就是 ' + JSON.stringify(back.data.achievements) +
								'，应当是 ["crystal","wealth10"]',
						}
					}
					// 而且**不能把另外两个键挤掉**（整份覆写 —— 只发一个键的话
					// star 和 seen 会被一起抹掉，而且不报任何错）
					if (back.data.star !== true || !Array.isArray(back.data.seen)) {
						return {
							ok: false,
							reason: '写 achievements 之后 star / seen 没了 —— 三个键没有一起落盘（star=' +
								JSON.stringify(back.data.star) + ', seen=' + JSON.stringify(back.data.seen) + '）',
						}
					}

					// 还原。
					//
					// ⚠ 上面那几次 setAchievements / setStarUnlocked / noteSeenGenes
					//   都会顺手 _persistUnlock() 写文件，所以最后这一下**必须**再写一遍
					//   正确的状态 —— 否则 unlock.json 里留下的是自检中间态，
					//   而这个文件是**跨局**的（下次开程序会读它）
					pet.world.stats.earned = savedEarned
					pet.world.paused = wasPaused
					pet.ui._wealthWas = -1
					pet.ui.setAchievements(savedAch)
					pet.ui._seenGenes = savedSeen
					pet.ui._achievementQueue.length = 0
					clearTimeout(pet.ui._achievementTimer)
					pet.ui._achievementTimer = null
					banner.classList.add('hidden')
					banner.classList.remove('on')
					pet.ui.setStarUnlocked(savedStar, { silent: true })
					pet.ui._persistUnlock()
				} catch (e) {
					return { ok: false, reason: '成就流程失败: ' + e.message }
				}

				// —— 总财富的口径 ——
				//
				// ⚠ 这条守的是「earned 到底在哪几处加」。全项目有四处 this.money +=，
				//   其中三处是**退款**（没放下的钱还给你），只有 _creditSale 那一处
				//   是真的赚到了。退款也算进去的话，玩家反复买一批放不下的东西
				//   就能把总财富刷上去 —— 成就和食物门槛会跟着一起被刷开
				try {
					const wA = pet.world
					const savedEarned = wA.stats.earned
					const savedMoney = wA.money
					const savedFoods = wA.foods.slice()
					wA.stats.earned = 0
					wA.money = 100
					if (wA.lifetime !== 0) {
						return { ok: false, reason: '刚把累计总收入清零，world.lifetime 却不是 0' }
					}

					// 卖一只 → 涨
					const probeFly = wA.addFly(50, 50, 'M', 'normal', [])
					if (!probeFly) return { ok: false, reason: '造不出用来验总财富的探针果蝇' }
					const gain = wA.sellFly(probeFly)
					if (!(wA.stats.earned > 0)) {
						return { ok: false, reason: '卖了一只之后累计总收入还是 0（gain=' + gain + '）' }
					}
					if (Math.abs(wA.lifetime - wA.stats.earned) > 1e-9) {
						return { ok: false, reason: 'world.lifetime 和 stats.earned 对不上' }
					}

					// 退款 → **不该**涨。
					//
					// ⚠ 走的是「投放区满了 → 一个都没放下 → 全额退回来」那条路。
					//   这是三处退款里最容易触发的一处（把食物填到上限就行）。
					//   装满之后钱一分没少，如果 earned 跟着涨了，那就是把退款
					//   当成收入了 —— 玩家反复点「投 10 个」就能凭空刷总财富
					const earnedBefore = wA.stats.earned
					const F = pet.config.food
					wA.dropFoods('apple', F.maxCount) // 填到上限（dropFoods 自己会在上限停住）
					if (wA.foods.length < F.maxCount) {
						return { ok: false, reason: '食物没填到上限（' + wA.foods.length + '/' + F.maxCount + '），退款那条路验不到' }
					}
					const moneyBefore = wA.money
					const placed = wA.buyFood('apple', 1)
					if (placed !== 0) {
						return { ok: false, reason: '食物已经满了，buyFood 却还是放下了 ' + placed + ' 份' }
					}
					if (wA.money !== moneyBefore) {
						return {
							ok: false,
							reason: '没放下食物却没把钱退回来（' + moneyBefore + ' → ' + wA.money + '）',
						}
					}
					if (wA.stats.earned !== earnedBefore) {
						return {
							ok: false,
							reason: '退款也算进了累计总收入（' + earnedBefore + ' → ' + wA.stats.earned +
								'）—— 反复买放不下的东西就能刷总财富，食物门槛和财富成就会跟着被刷开',
						}
					}

					// 还原：食物按原样放回去（上面那批是我自己填的）
					wA.foods.length = 0
					for (const f of savedFoods) wA.foods.push(f)
					wA.stats.earned = savedEarned
					wA.money = savedMoney
					// 探针果蝇上面已经卖掉了，不会留在世界里
				} catch (e) {
					return { ok: false, reason: '总财富口径失败: ' + e.message }
				}

				// —— 结晶成虫的外观：**真的去数像素** ——
				//
				// ⚠ 这是整个项目里**唯一**一条管「变异长什么样」的断言。
				//   别的断言全都在查状态（mutations 里有没有 crystal、
				//   面板上有没有徽章、售价乘了几倍）—— 它们一条都不会因为
				//   「画出来是只普通蝇」而变红。用户报「结晶成虫好像没有特殊效果」
				//   的时候，能回答这个问题的只有像素
				//
				// 三件事各查一个数：
				//   ① 身体是不是真的透明了 —— 结晶的墨量应当远低于普通蝇
				//   ② 描边是不是真的炫彩 —— 高饱和像素要铺满大半个色环
				//   ③ 这圈边**不能**跑到别的变异身上 —— 金色的色相应当很窄
				//      （②③ 必须成对：只查②的话，把描边画给所有蝇也照样绿）
				try {
					const W2 = pet.world
					// 借世界画一帧、画完原样还回去。只替换**数组**那些键，
					// w / h / settings 这些留着 —— 渲染要用到 w / h
					const stash = {}
					for (const k of Object.keys(W2)) {
						if (Array.isArray(W2[k])) {
							stash[k] = W2[k]
							W2[k] = []
						}
					}
					const cv = document.createElement('canvas')
					cv.width = 1920
					cv.height = W2.h
					const realCtx = pet.renderer.ctx
					const realDpr = pet.renderer.dpr
					pet.renderer.ctx = cv.getContext('2d')
					pet.renderer.dpr = 1

					// 摆一只成虫、画一帧，然后统计它那一小块里的像素
					const shoot = (genes) => {
						W2.flies.length = 0
						const f = W2.addFly(300, 200, 'F', 'normal', genes)
						f.mode = 'walk' // 收翅，免得翅膀糊住轮廓
						f.modeTimer = 1e9
						f.size = pet.config.adult.sizeMax // 顶到最大，细节全开
						pet.renderer.draw(W2, pet.view)
						const d = pet.renderer.ctx.getImageData(240, 140, 130, 120).data
						let cover = 0 // 有墨的像素个数
						let sat = 0 // 其中高饱和的 = 描边
						let bodySum = 0 // 低饱和那些像素的 alpha 之和 = 身体的实心程度
						let bodyN = 0
						const hues = []
						for (let i = 0; i < d.length; i += 4) {
							const a = d[i + 3]
							if (a > 8) cover++
							const r = d[i]
							const g = d[i + 1]
							const b = d[i + 2]
							const mx = Math.max(r, g, b)
							const mn = Math.min(r, g, b)
							if (a > 8 && mx - mn <= 60) {
								// 身体（或者普通蝇的腿 / 翅）—— 不含那圈炫彩边
								bodySum += a
								bodyN++
							}
							if (a < 60 || mx - mn <= 60) continue
							sat++
							let h
							if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6
							else if (mx === g) h = (b - r) / (mx - mn) + 2
							else h = (r - g) / (mx - mn) + 4
							hues.push(Math.round(h * 60))
						}
						hues.sort((x, y) => x - y)
						return {
							cover,
							sat,
							// 身体的平均不透明度 0~255。**这才是「全透明」的直接测度** ——
							// 用总墨量的话，描边一加粗就把这个数淹了，
							// 于是「描边加粗」和「身体变实」两件事分不开
							bodyA: bodyN ? bodySum / bodyN : 0,
							span: hues.length ? hues[hues.length - 1] - hues[0] : 0,
						}
					}

					const plain = shoot([])
					const gold = shoot(['golden'])
					const crystal = shoot(['crystal'])

					pet.renderer.ctx = realCtx
					pet.renderer.dpr = realDpr
					for (const k of Object.keys(stash)) W2[k] = stash[k]

					// 这条断言的用途只是「确认真的量到一只实心蝇」—— 也就是别让
					// 下面那条「结晶 < 80」变成对空画布也成立的空断言。
					//
					// 门槛 110 是**量出来的**，不是拍的：14 次采样里普通蝇的 bodyA
					// 落在 146~162（均值 154），结晶蝇约 46 —— 110 两头都留得开。
					//
					// ⚠ **别把门槛调回 150 附近**。它正好落在普通蝇的自然波动里
					//   （蝇的朝向是随机的，采样框里腿 / 翅像素的占比跟着变），
					//   实测大约每 4 次就有 1 次误报；而误报的代价是
					//   「自检随机变红」，比不测还糟
					if (!(plain.cover > 0 && plain.bodyA > 110)) {
						// 把量到的数一起报出来 —— 只写「量不到东西」的话，
						// 下次它再偶发失败，没人知道量到的到底是什么
						return {
							ok: false,
							reason:
								'画不出一只实心的普通成虫 —— 这条断言量不到东西（墨量 ' +
								plain.cover +
								' px，身体平均不透明度 ' +
								Math.round(plain.bodyA) +
								'，需要 >0 且 >150）',
						}
					}
					// ① 全透明：身体的平均不透明度要掉到很低。
					//    身体 alpha 是 0.14，实测约 36/255；门槛定 80
					if (!(crystal.bodyA < 80)) {
						return {
							ok: false,
							reason:
								'结晶成虫身体的平均不透明度是 ' + Math.round(crystal.bodyA) +
								'/255 —— 身体没有变透明（普通蝇是 ' + Math.round(plain.bodyA) + '）',
						}
					}
					// ② 炫彩描边：高饱和像素要铺满大半个色环
					if (!(crystal.span > 180)) {
						return {
							ok: false,
							reason:
								'结晶成虫身上高饱和像素的色相只铺开了 ' + crystal.span +
								'°（' + crystal.sat + ' 个点）—— 那圈炫彩描边没画出来',
						}
					}
					// ③ 这圈边不能跑到别的变异身上。金色身体本身是饱和的，
					//    所以它也有高饱和像素 —— 但色相应当挤在金色那一小段里
					if (!(gold.span < 90)) {
						return {
							ok: false,
							reason:
								'金色成虫的色相铺开了 ' + gold.span +
								'° —— 结晶的炫彩描边被画到非结晶的果蝇身上了',
						}
					}
					// ④ 描边还得**够粗**。只查色相的话，把线宽调回一根头发丝
					//    也照样绿 —— 而那正是用户报的那个 bug 的样子
					//    （「结晶成虫好像没有特殊效果」，其实效果在、只是看不见）。
					//    判据用「高饱和像素 ÷ 有墨像素」：和果蝇大小无关，
					//    因为在同一只蝇上比。当前线宽下约 0.62，头发丝时只有 0.37
					const rimShare = crystal.sat / crystal.cover
					if (!(rimShare > 0.5)) {
						return {
							ok: false,
							reason:
								'结晶成虫身上高饱和像素只占 ' + Math.round(rimShare * 100) +
								'% —— 那圈描边太细了（和结晶幼虫一样粗时约 62%），远看等于没有',
						}
					}
					console.log(
						'  结晶成虫：身体不透明度 ' + Math.round(crystal.bodyA) + '/255（普通蝇 ' +
							Math.round(plain.bodyA) + '）、炫彩色相铺开 ' + crystal.span +
							'°（金色只有 ' + gold.span + '°）、描边占 ' +
							Math.round(rimShare * 100) + '%',
					)
				} catch (e) {
					return { ok: false, reason: '结晶成虫外观检查失败: ' + e.message }
				}

				// —— 星空苹果：贴图是**世界锚定**的 ——
				//
				// 用户点名要的效果：星云钉在屏幕上不动，果子像一扇窗，
				// 挪动时透出来的是星云的不同部分。
				//
				// ⚠ 判据是「同一个果子画在屏幕两个不同位置，它自己那一小块
				//   像素**不一样**」。如果贴图是跟着果子走的（本地坐标），
				//   两处会**逐像素相同** —— 这正是要抓的那个错。
				//
				// ⚠ 必须把 seed 和 angle 钉死。不钉的话两个多边形本来就不同，
				//   断言会平凡通过，测的就成了「随机数有没有起作用」
				let starTextureDiff = -1
				try {
					const W3 = pet.world
					const stash3 = {}
					for (const k of Object.keys(W3)) {
						if (Array.isArray(W3[k])) {
							stash3[k] = W3[k]
							W3[k] = []
						}
					}
					const cv3 = document.createElement('canvas')
					cv3.width = W3.w
					cv3.height = W3.h
					const realCtx3 = pet.renderer.ctx
					const realDpr3 = pet.renderer.dpr
					pet.renderer.ctx = cv3.getContext('2d')
					pet.renderer.dpr = 1

					// 采样：把果子摆到 x，取果子中心 12×12 那一块
					const shootAt = (x) => {
						W3.foods.length = 0
						const f = W3.addFood(x, 400, 'star', 60)
						f.seed = 7
						f.angle = 0
						f.age = 0
						pet.renderer.draw(W3, pet.view)
						const d = pet.renderer.ctx.getImageData(x - 6, 394, 12, 12).data
						W3.foods.length = 0
						return d
					}
					const pxA = shootAt(300)
					const pxB = shootAt(1100)
					pet.renderer.ctx = realCtx3
					pet.renderer.dpr = realDpr3
					for (const k of Object.keys(stash3)) W3[k] = stash3[k]

					let diff = 0
					for (let i = 0; i < pxA.length; i++) if (pxA[i] !== pxB[i]) diff++
					if (diff < 20) {
						return {
							ok: false,
							reason:
								'星空苹果在两个位置上画出来几乎一样（' + diff +
								'/576 个通道不同）—— 贴图是跟着果子走的，不是钉在屏幕上',
						}
					}
					starTextureDiff = diff
				} catch (e) {
					return { ok: false, reason: '世界锚定贴图检查失败: ' + e.message }
				}

				// —— 居中小卡的 ✕：必须**真的**点得到 ——
				//
				// ⚠ 这条守卫的是**命中判定**，不是「监听挂没挂上」。三张新卡
				//   （投放 / 商店 / 图鉴）的 ✕ 曾经一颗都点不动，而当时所有
				//   别的断言全绿 —— 因为 element.click() / dispatchEvent
				//   **绕过**命中判定：按钮被别的东西盖住也好、那块屏幕根本
				//   没被窗口接管也好，它照样把 click 派发到监听上。
				//   所以这里查的是 elementFromPoint() 和 _overCard()。
				//
				//   真正的坏法在 _overCard()：它量的是外面那层 .donate-pop，
				//   而那个盒子在 CSS 里写死 268px 宽。比它宽的卡片会从
				//   **右边**探出去（块级子元素从容器左边起排，不是居中），
				//   探出去那一段看得见、也本该点得着，可按矩形算就是
				//   「不在卡片上」→ 窗口不接管鼠标 → 那一下点击穿到桌面。
				//   ✕ 恰好贴在卡片右上角，整颗都落在探出去的那一段里，
				//   症状就是「叉叉关不掉」，而且没有任何报错。
				//
				//   查两样：顶上那一个是不是 ✕ 自己；指针压在 ✕ 上时
				//   _overCard() 认不认。两样都过，那一下点击才真的进得来
				try {
					const centerCards = [
						{ name: '投放', pop: 'feed-pop', btn: 'btn-feed', close: 'feed-close' },
						{ name: '商店', pop: 'shop-pop', btn: 'btn-shop', close: 'shop-close' },
						{ name: '图鉴', pop: 'codex-pop', btn: 'btn-codex', close: 'codex-close' },
					]
					for (const c of centerCards) {
						const pop = document.getElementById(c.pop)
						const closeBtn = document.getElementById(c.close)
						const openBtn = document.getElementById(c.btn)
						if (!pop || !closeBtn || !openBtn) {
							return { ok: false, reason: '「' + c.name + '」的弹窗 / 入口按钮 / 关掉按钮有缺的' }
						}
						if (!pop.classList.contains('hidden')) {
							return { ok: false, reason: '「' + c.name + '」弹窗上一轮没关干净，这条测不准' }
						}
						openBtn.click()
						if (pop.classList.contains('hidden')) {
							return { ok: false, reason: '点了' + c.name + '按钮但弹窗没有出现' }
						}
						// 卡片必须真的落在屏幕正中。宽度写错盒子的话卡片会整张
						// 往右探（块级子元素从容器左边起排，不是居中）——
						// 这正是上面那串坏法的**外表**，一眼就能看见
						const cardR = pop.querySelector('.donate-card').getBoundingClientRect()
						const off = (cardR.left + cardR.right) / 2 - window.innerWidth / 2
						if (Math.abs(off) > 1) {
							return {
								ok: false,
								reason:
									'「' + c.name + '」的卡片横向偏了 ' + Math.round(off) + 'px —— ' +
									'它比外层 .donate-pop 宽，整张从右边探了出去',
							}
						}
						const r = closeBtn.getBoundingClientRect()
						if (!(r.width > 0 && r.height > 0)) {
							return { ok: false, reason: '「' + c.name + '」的 ✕ 尺寸是 0，量不到它摆在哪' }
						}
						const cx = r.left + r.width / 2
						const cy = r.top + r.height / 2

						// 1) 这一点上最顶层的元素得是 ✕ 自己（或者是它内部的节点）
						const top = document.elementFromPoint(cx, cy)
						if (!top || !(top === closeBtn || closeBtn.contains(top))) {
							return {
								ok: false,
								reason:
									'「' + c.name + '」的 ✕ 被别的东西盖住了 —— 点上去落在 ' +
									(top ? top.id || top.className || top.tagName : 'null') + ' 上',
							}
						}

						// 2) 指针压在 ✕ 上时窗口必须接管鼠标。没接管的话，
						//    这一下点击根本不会进渲染进程，按钮再对也没用
						const mx = pet.view.mouse.x
						const my = pet.view.mouse.y
						pet.view.mouse.x = cx
						pet.view.mouse.y = cy
						const over = pet.ui._overCard()
						pet.view.mouse.x = mx
						pet.view.mouse.y = my
						if (!over) {
							return {
								ok: false,
								reason:
									'指针压在「' + c.name + '」的 ✕ 上，_overCard() 却是 false —— ' +
									'窗口不会接管鼠标，这一下点击会穿到桌面。多半是 _overCard() 量错了盒子：' +
									'卡片比 .donate-pop 宽，探出去的那一段没被算进去',
							}
						}

						// 3) 照玩家那样点下去 —— 点的是 elementFromPoint 打出来的
						//    那一个，而不是攥在手里的引用
						top.click()
						if (!pop.classList.contains('hidden')) {
							return { ok: false, reason: '点了「' + c.name + '」的 ✕，弹窗却没关掉' }
						}
					}
				} catch (e) {
					return { ok: false, reason: '居中小卡的 ✕ 流程失败: ' + e.message }
				}

				// —— 养蝇人配置卡：入口在商店列表里，商店必须自己让位 ——
				//
				// 六张居中小卡全是 left:50% top:50%，位置**完全重合**。
				// 配置按钮就长在商店列表里，点下去如果商店自己不关，两张卡
				// 会叠在屏幕正中；而 #keeper-pop 在 DOM 里排在 #shop-pop
				// **前面**，同 z-index 下后出现的画在上面 —— 玩家看到的是
				// 「点了配置，什么都没发生」，其实卡片已经开了，只是被盖住
				try {
					const savedMoneyK = pet.world.money
					const savedShopK = Object.assign({}, pet.world.shop)
					pet.world.money = 100
					pet.world.shop = { keeper: 1 }
					pet.ui.refreshShop()

					const shopPop2 = document.getElementById('shop-pop')
					const keepPop = document.getElementById('keeper-pop')
					if (!shopPop2 || !keepPop) return { ok: false, reason: '商店 / 养蝇人卡片的 DOM 不存在' }

					document.getElementById('btn-shop').click()
					if (shopPop2.classList.contains('hidden')) {
						return { ok: false, reason: '养蝇人这一段：点了商店按钮但弹窗没出现' }
					}
					const cfg = document.getElementById('shop-list').querySelector('[data-keeper-cfg]')
					if (!cfg) return { ok: false, reason: '养蝇人 Lv.1 了却没有「配置」按钮' }
					cfg.click()
					if (keepPop.classList.contains('hidden')) {
						return { ok: false, reason: '点了「配置」养蝇人卡片没弹出来' }
					}
					if (!shopPop2.classList.contains('hidden')) {
						return {
							ok: false,
							reason:
								'养蝇人卡片开了，商店却还开着 —— 两张卡位置完全重合，' +
								'而 #keeper-pop 在 DOM 里排在 #shop-pop 前面，会被商店整张盖住，' +
								'玩家看到的是「点配置没反应」',
						}
					}
					// 卡片正中最顶上那一个必须真的是它自己 —— 防的是「别的卡
					// 靠 z-index 或 DOM 顺序压在上面」这种查 class 查不出来的坏法
					const kr = keepPop.querySelector('.donate-card').getBoundingClientRect()
					const kTop = document.elementFromPoint(kr.left + kr.width / 2, kr.top + kr.height / 2)
					if (!kTop || !keepPop.contains(kTop)) {
						return {
							ok: false,
							reason:
								'养蝇人卡片正中被别的东西盖住了 —— 落点是 ' +
								(kTop ? kTop.id || kTop.className || kTop.tagName : 'null'),
						}
					}
					// 配置卡的 ✕ 同上：也得既在顶层、又在接管范围里
					const kClose = document.getElementById('keeper-close')
					const kr2 = kClose.getBoundingClientRect()
					const kcx = kr2.left + kr2.width / 2
					const kcy = kr2.top + kr2.height / 2
					const kTop2 = document.elementFromPoint(kcx, kcy)
					if (!kTop2 || !(kTop2 === kClose || kClose.contains(kTop2))) {
						return { ok: false, reason: '养蝇人卡片的 ✕ 被别的东西盖住了' }
					}
					const kmx = pet.view.mouse.x
					const kmy = pet.view.mouse.y
					pet.view.mouse.x = kcx
					pet.view.mouse.y = kcy
					const kOver = pet.ui._overCard()
					pet.view.mouse.x = kmx
					pet.view.mouse.y = kmy
					if (!kOver) {
						return {
							ok: false,
							reason: '指针压在养蝇人卡片的 ✕ 上，_overCard() 却是 false —— 点上去会穿到桌面',
						}
					}

					pet.ui.setKeeperOpen(false)
					pet.ui.setShopOpen(false)
					pet.world.money = savedMoneyK
					pet.world.shop = savedShopK
					pet.ui.refreshShop()
				} catch (e) {
					return { ok: false, reason: '养蝇人配置卡流程失败: ' + e.message }
				}

				// —— 喷水枪 ——
				try {
					const sqBtn = document.getElementById('btn-squirt')
					if (!sqBtn) return { ok: false, reason: '工具栏上没有喷水枪按钮 #btn-squirt' }

					const savedMoneySq = pet.world.money
					const savedShopSq = Object.assign({}, pet.world.shop)

					// 没买之前：按钮是 .locked（置灰 + 虚线），但**仍然可点** ——
					// 点下去 setTool 会拦下来并提示去商店。
					// 做成 disabled 的话玩家会以为按钮坏了，而不是「还没买」
					pet.world.shop = {}
					pet.ui.refreshToolButtons()
					if (!sqBtn.classList.contains('locked')) {
						return { ok: false, reason: '还没买喷水枪，按钮却不是锁定态' }
					}
					if (sqBtn.disabled) {
						return { ok: false, reason: '没买喷水枪时按钮被 disabled 了 —— 玩家会以为它坏了' }
					}
					pet.ui.setTool('squirt')
					if (pet.view.tool === 'squirt') {
						return { ok: false, reason: '没买喷水枪却切得过去' }
					}
					// W 键也切不过去
					pet.ui._onKey({ code: 'KeyW' })
					if (pet.view.tool === 'squirt') {
						return { ok: false, reason: '没买喷水枪，按 W 却切得过去' }
					}

					// 买下来（直接写 shop，别走钱那条路 —— 商店流程上面已经测过了）
					pet.world.shop.squirt = true
					pet.ui.refreshToolButtons()
					if (sqBtn.classList.contains('locked')) {
						return { ok: false, reason: '买了喷水枪，按钮还是锁定态' }
					}
					sqBtn.click()
					if (pet.view.tool !== 'squirt') {
						return { ok: false, reason: '买了之后点喷水枪按钮没切过去' }
					}
					if (!sqBtn.classList.contains('active')) {
						return { ok: false, reason: '切到喷水枪之后按钮没有被标成选中态' }
					}
					// ⚠ 这条断言**反过来了**。
					//
					//   原来查的是「喷水枪进了 drawsOwnCursor 白名单没有」——
					//   那个白名单会给 body 加 tool-active，而那条 CSS 是 cursor:none，
					//   也就是藏掉系统指针、由 canvas 自绘水线。
					//   现在工具图案全部删掉了，那个类**必须不存在**：
					//   留着的话画布上什么都不画、指针又被藏了，屏幕上会一个指针都没有
					if (document.body.classList.contains('tool-active')) {
						return {
							ok: false,
							reason:
								'拿着工具时 body 上还有 tool-active —— 自绘光标已经取消，留着这个类会把系统指针也藏掉，屏幕上会一个指针都没有',
						}
					}

					// —— 滚轮：改长度；Shift+滚轮：转角度 ——
					//
					// ⚠ 派发的是**真的 WheelEvent**，而且必须带上 shiftKey ——
					//   不带的活测的是「长度能不能调」，转方向那条根本没走到
					const T = pet.config.tools
					const wheel = (deltaY, shift) => {
						window.dispatchEvent(
							new WheelEvent('wheel', { deltaY: deltaY, shiftKey: shift, cancelable: true }),
						)
					}

					pet.view.squirt.len = 200
					pet.view.squirt.angle = 0
					wheel(-100, false)
					if (pet.view.squirt.len !== 200 + T.squirtLenStep) {
						return {
							ok: false,
							reason: '往上滚之后水线长度是 ' + pet.view.squirt.len + '，应当是 ' + (200 + T.squirtLenStep),
						}
					}
					wheel(100, false)
					if (pet.view.squirt.len !== 200) {
						return { ok: false, reason: '往下滚没有把长度调回去（现在是 ' + pet.view.squirt.len + '）' }
					}
					// 夹在 100~400 之间，而且**真的夹住**（滚到底再滚还是那个值）
					pet.view.squirt.len = T.squirtLenMin
					wheel(100, false)
					if (pet.view.squirt.len < T.squirtLenMin) {
						return { ok: false, reason: '水线比最短还短：' + pet.view.squirt.len }
					}
					pet.view.squirt.len = T.squirtLenMax
					wheel(-100, false)
					if (pet.view.squirt.len > T.squirtLenMax) {
						return { ok: false, reason: '水线比最长还长：' + pet.view.squirt.len }
					}

					// Shift + 滚轮改的是**角度**，长度一动不动
					pet.view.squirt.angle = 0
					pet.view.squirt.len = 250
					wheel(-100, true)
					if (Math.abs(pet.view.squirt.angle - T.squirtTurnStep) > 1e-9) {
						return {
							ok: false,
							reason: 'Shift+滚轮之后角度是 ' + pet.view.squirt.angle + '，应当是 ' + T.squirtTurnStep,
						}
					}
					if (pet.view.squirt.len !== 250) {
						return { ok: false, reason: 'Shift+滚轮把长度也改了（' + pet.view.squirt.len + '）—— 两个功能串了' }
					}

					// —— 按住左键才喷 ——
					//
					// 走 _useTool 而不是直接调 world.squirt：那是 UI 那一层，
					// 起点/方向/长度怎么算出来的只有这里能测到
					// ⚠ 目标要放在**偏离指针**的地方。
					//   水线是以指针为中心向两头伸的，所以**不管转到什么角度，
					//   它永远穿过指针那一点** —— 把污渍放在指针正下方的话，
					//   转方向根本测不出任何区别（第一版就是这么写的，
					//   报出来是「方向没生效」，其实方向完全正常）
					const SQ_PX = 700
					const SQ_PY = 500
					const SQ_OFFX = SQ_PX + 120 // 水平方向上偏出去 120px

					pet.world.remains.length = 0
					const sqTarget = pet.world.addRemains(SQ_OFFX, SQ_PY, 'stain', 14, 0)
					pet.view.squirt.angle = 0 // 水平
					pet.view.squirt.len = 300
					pet.view.mouse.x = SQ_PX
					pet.view.mouse.y = SQ_PY
					pet.ui._useTool()
					if (sqTarget && !sqTarget.dead) {
						return { ok: false, reason: '水线穿过了偏在一侧的污渍，_useTool 却没把它冲掉' }
					}

					// 同一个位置、把水线转成竖直 → 它就不在线上，不该再被冲到
					pet.world.remains.length = 0
					const sqOff = pet.world.addRemains(SQ_OFFX, SQ_PY, 'stain', 14, 0)
					pet.view.squirt.angle = Math.PI / 2 // 竖过来
					pet.ui._useTool()
					if (sqOff && sqOff.dead) {
						return { ok: false, reason: '把水线转成竖直之后，水平方向偏出去的污渍还是被冲掉了 —— 方向没生效' }
					}

					pet.world.remains.length = 0
					pet.world.shop = savedShopSq
					pet.world.money = savedMoneySq
					pet.ui.setTool('none')
					pet.ui.refreshToolButtons()
				} catch (e) {
					return { ok: false, reason: '喷水枪流程失败: ' + e.message }
				}

				// —— 工具粒子：端到端 ——
				//
				// 工具图案和范围圈全删之后，「手里拿着什么、作用在哪」只剩粒子在表达，
				// 所以这条走**完整那条路**：ui.setTool → ui.update 写 toolFx
				//   → world.update 发射 → renderer.draw 画出来。
				//
				// ⚠ 顺带证明 drawToolCursor / drawSwing 删干净了：
				//   只要还有一处残留调用点，draw() 会当场抛
				try {
					const savedToolFx = pet.view.tool
					const savedMouseX = pet.view.mouse.x
					const savedMouseY = pet.view.mouse.y
					const savedBurnLv = pet.world.shopLevel('roast')
					pet.view.mouse.x = 640
					pet.view.mouse.y = 420
					// ⚠ 打火机现在有**拥有权闸门**了（1.18.0 起它和喷火枪是两颗
					//   各自受管的按钮），所以得先真的买过才切得过去。
					//   下面这句 setTool 会失败的话，恰好证明闸门是有效的
					pet.world.shop.roast = 1
					pet.ui.refreshToolButtons()
					pet.ui.setTool('lighter')
					if (pet.view.tool !== 'lighter') {
						return { ok: false, reason: '买了打火机却切不过去（view.tool 还是 ' + pet.view.tool + '）' }
					}
					// 先跑几帧把发射器灌起来，再画一帧
					const fxBefore = pet.world.particles.length
					for (let i = 0; i < 20; i++) {
						pet.ui.update(1 / 60)
						pet.world.update(1 / 60)
					}
					// 这一行是「工具图案删干净了没有」的探针：有残留调用点就会抛
					pet.renderer.draw(pet.world, pet.view)
					if (pet.world.particles.length <= fxBefore) {
						return {
							ok: false,
							reason:
								'举着打火机跑了 20 帧，粒子数没涨（' +
								fxBefore +
								' → ' +
								pet.world.particles.length +
								'）—— 发射器没接上 ui.toolFx',
						}
					}
					// 放下工具：发射器必须停
					pet.ui.setTool('none')
					pet.ui.update(1 / 60)
					if (pet.world.toolFx.on) {
						return { ok: false, reason: '换成「观察」之后 toolFx.on 还是 true —— 发射器没停' }
					}
					pet.view.mouse.x = savedMouseX
					pet.view.mouse.y = savedMouseY
					pet.ui.setTool(savedToolFx)
					pet.world.shop.roast = savedBurnLv
					pet.ui.refreshToolButtons()
				} catch (e) {
					return { ok: false, reason: '工具粒子端到端失败（多半是自绘光标还有残留调用点）: ' + e.message }
				}

				// —— 扫帚 ——
				//
				// 逻辑本身（方向、衰减、不推蛹和尸体、推得动趴在果子上的）
				// 在无头模拟器里逐项断言过了。这里只测**窗口里那一套接线**：
				// 按钮在不在、快捷键认不认、滚轮认不认、按住会不会真的调 world.broom。
				// 少了任何一环，表现都是「点了没反应」或者「滚轮没反应」——
				// 而这两种都不会报错
				try {
					const broomBtn = document.querySelector('[data-tool="broom"]')
					if (!broomBtn) return { ok: false, reason: '工具栏里没有扫帚按钮（data-tool="broom"）' }

					const savedBroomTool = pet.view.tool
					const savedBroomR = pet.view.broom.r
					const savedLarvae = pet.world.larvae

					pet.ui.setTool('broom')
					if (pet.view.tool !== 'broom') {
						return { ok: false, reason: '扫帚切不过去（view.tool 还是 ' + pet.view.tool + '）' }
					}
					if (!broomBtn.classList.contains('active')) {
						return { ok: false, reason: '切到扫帚之后按钮没有被标成选中态' }
					}

					// 快捷键 B：两下 = 开 → 关
					window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b', bubbles: true }))
					if (pet.view.tool !== 'none') {
						return { ok: false, reason: '按 B 没有把扫帚收起来（还是 ' + pet.view.tool + '）' }
					}
					window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b', bubbles: true }))
					if (pet.view.tool !== 'broom') {
						return { ok: false, reason: '再按一次 B 没有切回扫帚（现在是 ' + pet.view.tool + '）' }
					}

					// 滚轮改半径，而且真的夹在 min~max 之间
					const BT = pet.config.tools.broom
					pet.view.broom.r = 100
					window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
					if (pet.view.broom.r !== 100 + BT.radiusStep) {
						return {
							ok: false,
							reason: '往上滚之后半径是 ' + pet.view.broom.r + '，应当是 ' + (100 + BT.radiusStep),
						}
					}
					window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))
					if (pet.view.broom.r !== 100) {
						return { ok: false, reason: '往下滚没有把半径调回去（现在是 ' + pet.view.broom.r + '）' }
					}
					pet.view.broom.r = BT.radiusMax
					window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
					if (pet.view.broom.r > BT.radiusMax) {
						return { ok: false, reason: '半径超过了上限 ' + BT.radiusMax + '：' + pet.view.broom.r }
					}
					pet.view.broom.r = BT.radiusMin
					window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))
					if (pet.view.broom.r < BT.radiusMin) {
						return { ok: false, reason: '半径超过了下限 ' + BT.radiusMin + '：' + pet.view.broom.r }
					}

					// 按住：真的把幼虫推开
					//
					// ⚠ 摆一只**自己的**幼虫，并且把整个数组换掉 —— 直接往
					//   玩家那一局里塞的话，这只虫会留在存档里
					const BX = 500
					const BY = 400
					const brWorld = pet.world
					brWorld.larvae = []
					const probe = brWorld.addLarva(BX + 10, BY, null, 0)
					if (!probe) {
						brWorld.larvae = savedLarvae
						return {
							ok: false,
							reason: 'world.addLarva 返回了 null（幼虫到上限了？）—— 扫帚这条测不了',
						}
					}
					const startD = Math.hypot(probe.x - BX, probe.y - BY)
					pet.view.broom.r = 120
					pet.view.mouse.x = BX
					pet.view.mouse.y = BY
					pet.ui.mouseDown = true
					for (let i = 0; i < 40; i++) {
						pet.ui._useTool()
						brWorld.update(1 / 60)
					}
					pet.ui.mouseDown = false
					const endD = Math.hypot(probe.x - BX, probe.y - BY)
					if (!(endD > startD)) {
						return {
							ok: false,
							reason:
								'按住扫了 40 帧，幼虫离圆心还是 ' +
								endD.toFixed(1) +
								'px（一开始 ' +
								startD.toFixed(1) +
								'px）—— 扫帚没接上 _useTool',
						}
					}
					if (brWorld.larvae.indexOf(probe) < 0) {
						return { ok: false, reason: '扫帚把幼虫从数组里弄掉了（它只该推，不该删）' }
					}
					brWorld.larvae = savedLarvae
					brWorld.particles.length = 0
					pet.view.broom.r = savedBroomR
					pet.ui.setTool(savedBroomTool)
					pet.ui.refreshToolButtons()
				} catch (e) {
					return { ok: false, reason: '扫帚流程失败: ' + e.message }
				}

				// —— 烤炉：进度条 → 满了直接卖钱 → 冒数字 ——
				//
				// 数值结算（每只 = 售价 × 倍率、不留尸体、统计对得上）在无头模拟器里
				// 精确断言过了。这里测的是**窗口那一套**：进度真的会走、两样东西
				// 都画得出来、钱真的显示在面板上。少了任何一环，
				// 表现都是「进度条不动」或者「钱没变」—— 都不会报错
				try {
					const RO = pet.config.roast.oven
					const rw = pet.world

					const savedRoastShop = rw.shopLevel('roast')
					const savedRoastFlies = rw.flies
					const savedRoastOvens = rw.ovens
					const savedRoastRemains = rw.remains
					const savedRoastMoney = rw.money

					// ⚠ 炉子从 1.18.0 起**不在烤制链上了** —— 它是一件 $5 的独立商品，
					//   所以这里**不再需要把档位拉满**。时长和倍率都直接读
					//   CONFIG.roast.oven（这也正是上面那个 RO 的来源）
					rw.flies = []
					rw.ovens = []
					rw.remains = []
					rw.floatTexts.length = 0
					rw.money = 0

					const rOven = rw.dropOven()
					if (!rOven) return { ok: false, reason: 'dropOven 没造出炉子' }
					for (let i = 0; i < RO.capacity; i++) {
						const f = rw.addFly(200 + i * 40, 300, i % 2 ? 'F' : 'M')
						if (f) rw.putInOven(rOven, f)
					}
					// ⚠ 1.21.0 起是**进炉即开烤**，不用等装满。
					//   这条断言盯的正是那个改动：老机制下这里要为 false
					if (!rOven.roasting) {
						return { ok: false, reason: '放进去了却没有开始烤 —— 现在应当是进炉即开烤' }
					}
					// 每只**刚进去**就该领到自己的倒计时
					for (const f of rOven.items) {
						if (f.roastLeft !== RO.roastMs) {
							return {
								ok: false,
								reason: '刚进炉的那只剩余时间是 ' + f.roastLeft + '，应当是 ' + RO.roastMs,
							}
						}
					}

					// 进度条得真的从 0 往上走。先画一帧 —— 这一行同时证明
					// 进度条那段绘制没有抛异常（画布上一抛就是整个窗口白掉）
					pet.renderer.draw(rw, pet.view)

					// 跑四分之一的时间
					const quarter = Math.floor(RO.roastMs / 4 / 16)
					for (let i = 0; i < quarter; i++) rw.update(1 / 60)
					// ⚠ 进度现在是**每只各一条**，挑第一只来看
					const p1 = 1 - rOven.items[0].roastLeft / rOven.items[0].roastTotal
					if (!(p1 > 0.15 && p1 < 0.5)) {
						return { ok: false, reason: '跑了四分之一的时间，进度是 ' + p1 + '（应当在 0.15~0.5 之间）' }
					}
					pet.renderer.draw(rw, pet.view) // 画到一半的进度条

					// —— 直接推到出炉，走**真实**那条路（world.update → step → _updateOvens）——
					const beforeMoney = rw.money
					const beforeRemains = rw.remains.length
					const beforeTexts = rw.floatTexts.length
					// ⚠ 每只各压到 0（炉子级的 roastTimer 已经没有这个字段了）。
					//   0 是「这一帧刚好烤满」那个值；「没在烤」是 null，
					//   两者不能混 —— 见 Fly.roastLeft 那段注释
					for (const f of rOven.items) f.roastLeft = 0
					rw.update(1 / 60)

					if (rOven.roasting) return { ok: false, reason: '倒计时归零了却还在烤' }
					if (rOven.items.length !== 0) return { ok: false, reason: '出炉之后炉子没清空' }

					const got = rw.money - beforeMoney
					if (!(got > 0)) {
						return { ok: false, reason: '一炉烤完钱没有增加（+' + got + '）—— 自动卖钱没接上' }
					}
					if (rw.remains.length !== beforeRemains) {
						return {
							ok: false,
							reason: '出炉之后地上多了 ' + (rw.remains.length - beforeRemains) + ' 具尸体，应当直接变成钱',
						}
					}
					const texts = rw.floatTexts.length - beforeTexts
					if (texts !== RO.capacity) {
						return { ok: false, reason: '冒出 ' + texts + ' 个飘字，应当是 ' + RO.capacity + ' 个（每只一个）' }
					}
					// 飘字真的画得出来（和进度条一样，这里也是「抛了就是白屏」的探针）
					pet.renderer.draw(rw, pet.view)

					// 面板上的钱要跟着变。refreshStats 平时是 6~7Hz 跑的，
					// 这里手动催一次，确认它读的是 world.money
					pet.ui.refreshStats()
					const shown = pet.ui.el.money.textContent
					if (!shown || shown === '$0.000') {
						return { ok: false, reason: '卖了一炉之后面板上的钱还是「' + shown + '」' }
					}

					rw.flies = savedRoastFlies
					rw.ovens = savedRoastOvens
					rw.remains = savedRoastRemains
					rw.money = savedRoastMoney
					rw.shop.roast = savedRoastShop
					rw.floatTexts.length = 0
					rw.particles.length = 0
					pet.ui.refreshStats()
				} catch (e) {
					return { ok: false, reason: '烤炉流程失败: ' + e.message }
				}

				// 垃圾桶和拖动食物的接口。
				// 少了 #trash 不会立刻报错，要等真去拖食物时才炸 —— 所以这里先查一遍。
				const trash = document.getElementById('trash')
				if (!trash) return { ok: false, reason: '垃圾桶元素 #trash 不存在' }
				for (const fn of ['_foodAt', '_pointInTrash', '_endDrag', 'discardFoodCheck']) {
					if (fn === 'discardFoodCheck') {
						if (typeof pet.world.discardFood !== 'function') {
							return { ok: false, reason: 'world.discardFood 不存在' }
						}
						continue
					}
					// 必须用字符串拼接：这段代码本身就住在一个模板字符串里。
					// 模板字符串的插值是在「外层」求值的，连注释里写的插值语法也一样，
					// 结果就是主进程直接报 fn is not defined。
					if (typeof pet.ui[fn] !== 'function') return { ok: false, reason: 'ui.' + fn + ' 不存在' }
				}
				if (!trash.getBoundingClientRect().width) {
					return { ok: false, reason: '垃圾桶不可见（宽度为 0）' }
				}

				// —— 最后画一帧，**而且场上每一类东西都要有一个** ——
				//
				// ⚠ 这条是补一个真实的漏网之鱼：上面那条「结晶成虫外观」的像素断言
				//   会把 world 里**所有数组**暂时清空（它只想要自己摆的那一只蝇），
				//   于是「画尸体」「画蛆尸」「画空壳」这些分支在那条断言里一次都没跑到。
				//   实测：drawCorpse 里引用了一个已经删掉的变量（ReferenceError），
				//   而两条断言全绿 —— 真跑起来却是**每帧有尸体就整个 canvas 画不出来**。
				//
				//   所以这里摆齐每一样再 draw 一次。多一个实体只多几行，但它把
				//   「某个 drawXxx 分支坏了」从「只能靠肉眼发现」变成「自检会红」
				try {
					const w9 = pet.world
					w9.flies.length = 0
					w9.remains.length = 0
					w9.shells.length = 0
					w9.larvae.length = 0
					w9.eggs.length = 0
					w9.foods.length = 0
					w9.floatTexts.length = 0

					w9.addFly(200, 200, 'M')
					w9.addFly(260, 200, 'F', 'normal', ['crystal'])
					w9.addLarva(320, 200, null, 0)
					// 蛹：化蛹之后走的是另一条绘制分支
					const pupa = w9.addLarva(380, 200, null, 0)
					if (pupa) pupa.pupa = true
					// 尸体、蛆尸、空壳、汁渍 —— 四类残留物各一个
					w9.addRemains(440, 200, 'corpse', 14, 0)
					w9.addRemains(480, 200, 'grub', 12, 0)
					w9.addRemains(520, 200, 'stain', 18, 0)
					w9.addFood(560, 200, 'apple', 30)
					// 星空苹果 + 星云蝇 + 星云幼虫：星云那三条绘制分支各自
					// 有自己的路径，不摆出来的话它们一次都跑不到
					w9.addFood(600, 300, 'star', 30)
					w9.addFly(660, 220, 'M', 'normal', ['nebula'])
					w9.addLarva(720, 220, null, 0, ['nebula'])
					w9.addFloatText(600, 200, '+$0.001')
					w9.addOven(700, 400)

					// ⚠⚠ **save / restore 必须配平** —— 这一条是这整块里最重要的。
					//
					// 画布的状态栈没有「查深度」的公开 API，所以这里直接**数**：
					// 借真 ctx 绕一圈计数器，看这一帧里 save 和 restore 是不是一样多。
					//
					// 为什么非要有这条：ctx.save() 之后提前 return（少一次
					// ctx.restore()）**不会报错、不会抛**，但那个变换会一直留着 ——
					// 后面画的每一只虫都被先平移到那条虫的位置、再按它的角度转一下。
					// 表现是「整屏生物被钉在一个点上、跟着它一起晃」，
					// 而当时所有断言全绿：像素探针每次只画一样东西，
					// 而「摆齐每样画一帧」那条只看有没有抛异常。
					// 这个 bug 真的发生过一次（星云幼虫那支的提前 return）。
					//
					// ⚠ 数的是**这一帧之内**的差值。上一帧漏掉的 restore 不会算进来 ——
					//   所以它每一帧都会红，而不是红一次就好了
					const ctx9 = pet.renderer.ctx
					const save9 = ctx9.save.bind(ctx9)
					const restore9 = ctx9.restore.bind(ctx9)
					let nSave = 0
					let nRestore = 0
					ctx9.save = () => {
						nSave++
						save9()
					}
					ctx9.restore = () => {
						nRestore++
						restore9()
					}
					try {
						pet.renderer.draw(w9, pet.view)
					} finally {
						ctx9.save = save9
						ctx9.restore = restore9
					}
					if (nSave !== nRestore) {
						return {
							ok: false,
							reason:
								'这一帧里 ctx.save() 调了 ' + nSave + ' 次、ctx.restore() 只有 ' + nRestore +
								' 次 —— 某个 drawXxx 提前 return 时漏了 restore。' +
								'画布变换会一直留着，后面画的每样东西都被挪到别处去',
						}
					}

					w9.flies.length = 0
					w9.remains.length = 0
					w9.shells.length = 0
					w9.larvae.length = 0
					w9.eggs.length = 0
					w9.foods.length = 0
					w9.floatTexts.length = 0
					w9.ovens.length = 0
				} catch (e) {
					return {
						ok: false,
						reason:
							'摆齐各类实体之后画一帧抛了异常：' + e.message +
							'（多半是某个 drawXxx 引用了已经删掉的字段）',
					}
				}

				// —— 彩蛋：点罐子十下解锁星空苹果 ——
				//
				// ⚠ 放在**最后**：解锁会调 refreshFeed / refreshCodex 把两个
				//   弹窗整块重建，前面那些查 DOM 的断言要是排在这后面，
				//   拿到的就是重建前的旧节点
				//
				// ⚠ 这里会真的往 unlock.selftest.json 写一次。自检的 user-data-dir
				//   是临时的，碰不到玩家的 unlock.json（见 main.js 的 unlockFile）
				let eggTaps = 0
				try {
					// ⚠ 自己取一遍 DOM，不蹭前面那些块里的局部变量 ——
					//   它们多半声明在某个已经关掉的 try 里，蹭了会直接 ReferenceError
					const eggBtn = document.getElementById('btn-donate')
					const eggFeed = document.getElementById('feed-list')
					const eggCodex = document.getElementById('codex-body')

					// 起始状态：**没解锁**。这条同时守着「默认态写在 HTML 的
					// class="donate locked" 上」—— 补在 JS 里的话这里就漏了
					if (pet.ui.starUnlocked) {
						return { ok: false, reason: '自检一开始就是已解锁状态 —— 初始值应当是锁着的' }
					}
					// ⚠ 把连点计数清零再开始。前面那条「点图标那一层也能弹出」
					//   的断言已经点过这颗罐子几下（不足十下，所以没解锁），
					//   不清零的话这里点 9 下就跨过门槛了 —— 而报出来的是
					//   「还差一下就已经解锁了」，看着像门槛算错了，
					//   其实是断言自己的起点没摆正
					pet.ui.starTaps = 0
					if (!eggBtn.classList.contains('locked')) {
						return { ok: false, reason: '没解锁时罐子没有 .locked（流光应当是蓝紫的）' }
					}
					if (pet.ui.unlockedFoodIds().includes('star')) {
						return { ok: false, reason: '没解锁时 unlockedFoodIds() 里就有 star 了' }
					}

					// 差一下**不解锁**（十下才对），顺手确认它不是「点一下就开」
					const need = pet.config.easterEgg.tapsToUnlock
					for (let i = 0; i < need - 1; i++) eggBtn.click()
					if (pet.ui.starUnlocked) {
						return { ok: false, reason: '还差一下（点了 ' + (need - 1) + ' 下）就已经解锁了' }
					}

					// 第十下
					eggBtn.click()
					if (!pet.ui.starUnlocked) {
						return { ok: false, reason: '点了 ' + need + ' 下罐子却没有解锁星空苹果' }
					}
					if (eggBtn.classList.contains('locked')) {
						return { ok: false, reason: '解锁之后罐子的流光没有翻回金色（.locked 还在）' }
					}

					// 解锁之后：投放面板、图鉴、星尘三处都要跟着变。
					//
					// ⚠ 先给够钱：星空苹果 $1 一个，「投 10 个」那档就是 $10，
					//   而自检跑到这里时钱包基本是空的 —— 不补的话两个按钮
					//   都是置灰的，查出来会误报成「接线断了」。
					//   用完还原，免得改掉摘要里报的那个钱数
					const moneyBeforeEgg = pet.world.money
					pet.world.money = 100
					pet.ui.refreshFeed()
					if (!pet.ui.unlockedFoodIds().includes('star')) {
						return { ok: false, reason: '解锁之后 unlockedFoodIds() 里还是没有 star' }
					}
					const starBtns = [...eggFeed.querySelectorAll('[data-kind="star"]')]
					if (starBtns.length !== 2) {
						return {
							ok: false,
							reason: '解锁之后投放里星空苹果那一行有 ' + starBtns.length + ' 个按钮，应当是 2 个',
						}
					}
					if (starBtns.some((b) => b.disabled)) {
						return { ok: false, reason: '自检里钱是够的，星空苹果那两个按钮却是置灰的' }
					}
					// 星尘那一层真的被点亮了（10 秒后自己收，这里只看「放没放」）
					const sf = document.getElementById('starfield')
					if (!sf || sf.classList.contains('hidden') || !sf.classList.contains('on')) {
						return { ok: false, reason: '解锁的那一刻没有放出星尘（#starfield 没有 .on）' }
					}

					// 写下去的解锁状态必须**读得回来**。
					// ⚠ 这一条守的是 IPC 的**另一个方向**：上面那些只证明了
					//   「点了十下界面上变了」，而「重开程序之后还认得」靠的是
					//   loadUnlock。那条路断了的表现是「彩蛋解开了，下次打开又锁上」，
					//   玩家只会以为是自己记错了
					const unlockBack = await window.pet.loadUnlock()
					if (!unlockBack || !unlockBack.ok || !unlockBack.data || !unlockBack.data.star) {
						return {
							ok: false,
							reason: '解锁状态写下去之后读不回来 —— 重开一局彩蛋会又锁上',
						}
					}

					// 图鉴：解锁之后那两格**从灰变亮**。
					//
					// ⚠ 它们解锁前**也在**（只是带 .locked），所以这里不能像以前那样
					//   查「出现了没有」—— 那样无论解锁成功与否都会绿。
					//   要查的是**灰态翻转了**，这才是解锁真正做的事
					pet.ui.setCodexOpen(true)
					pet.ui.refreshCodex()
					const eggGeneCells = [...eggCodex.querySelectorAll('[data-gene]')]
					const nebulaCell = eggGeneCells.find((el) => el.dataset.gene === 'nebula')
					if (!nebulaCell) {
						pet.ui.setCodexOpen(false)
						return { ok: false, reason: '图鉴里没有星云那一格' }
					}
					// ⚠ 星云那格**不跟着解锁变亮** —— 食物认「解锁了没有」，
					//   基因认「养出来过没有」，是两条判据（用户要的正是这个）。
					//   所以这里查的是**判据本身**，不是「解锁之后它该亮了」
					if (nebulaCell.classList.contains('locked') !== !pet.ui.seenGene('nebula')) {
						pet.ui.setCodexOpen(false)
						return {
							ok: false,
							reason: '星云那格的灰态和 seenGene 对不上：locked=' +
								nebulaCell.classList.contains('locked') +
								'、seen=' + pet.ui.seenGene('nebula'),
						}
					}
					// 顺带把「见过就点亮」这条机制整个走一遍：
					// 塞一条 seen 进去 → 那一格必须立刻从灰变亮
					pet.ui.noteSeenGenes(['nebula'])
					pet.ui.refreshCodex()
					const nebulaAfter = eggCodex.querySelector('[data-gene="nebula"]')
					if (nebulaAfter.classList.contains('locked')) {
						pet.ui.setCodexOpen(false)
						return { ok: false, reason: '记下「见过星云」之后，图鉴那一格还是灰的' }
					}
					if (nebulaAfter.textContent.includes('？？？')) {
						pet.ui.setCodexOpen(false)
						return { ok: false, reason: '点亮之后星云那格还写着「？？？」' }
					}
					const eggStarCell = eggCodex.querySelector('[data-food="star"]')
					if (!eggStarCell) {
						pet.ui.setCodexOpen(false)
						return { ok: false, reason: '图鉴里没有星空苹果那一格' }
					}
					if (eggStarCell.classList.contains('locked')) {
						pet.ui.setCodexOpen(false)
						return { ok: false, reason: '彩蛋都解开了，星空苹果那一格还是灰的' }
					}
					// 解锁之后说明也得露出来 —— 灰的时候那两行是「？？？」
					if (eggStarCell.textContent.includes('？？？')) {
						pet.ui.setCodexOpen(false)
						return { ok: false, reason: '星空苹果解锁了，说明却还写着「？？？」' }
					}
					pet.ui.setCodexOpen(false)

					// 星云的图鉴措辞**不能**是「0.0%」—— 那是句看着精确的谎话。
					// ⚠ 用刚点亮的那一份：灰格上写的是「？？？」，查不出措辞对不对
					const nebulaTxt = nebulaAfter.textContent
					if (nebulaTxt.includes('0.0%')) {
						return { ok: false, reason: '星云那一格写着「0.0%」—— 它不在抽奖池里，应当说来历' }
					}
					if (!nebulaTxt.includes('吃星空苹果获得')) {
						return { ok: false, reason: '星云那一格没写来历（应当是「吃星空苹果获得」）' }
					}

					// 「见过」也得**读得回来** —— 和上面 star 那条同一个道理。
					// ⚠ 这一条顺带守住白名单：主进程那张表漏掉 seen 的话，
					//   渲染侧照写不误、拿不到任何错误，只有这里会红
					const seenBack = await window.pet.loadUnlock()
					if (!seenBack || !seenBack.ok || !Array.isArray(seenBack.data?.seen)) {
						return { ok: false, reason: 'seen 写下去之后读不回来（主进程白名单里是不是漏了 seen？）' }
					}
					if (!seenBack.data.seen.includes('nebula')) {
						return { ok: false, reason: '读回来的 seen 里没有 nebula：' + JSON.stringify(seenBack.data.seen) }
					}
					// ⚠ 反过来还要查一遍：**写 star 不能把 seen 抹掉**。
					//   两个键是同一份文件里的邻居，主进程整份覆写 ——
					//   只发一个键的那个调用点会造成静默的数据丢失
					if (!seenBack.data.star) {
						return { ok: false, reason: '写 seen 之后 star 反而没了 —— 两个键没有一起落盘' }
					}
					pet.world.money = moneyBeforeEgg
					eggTaps = need
				} catch (e) {
					return { ok: false, reason: '彩蛋流程失败: ' + e.message }
				}

				const c = pet.world.counts
				return {
					ok: true,
					canvas: pet.renderer.canvas.width + 'x' + pet.renderer.canvas.height,
					dpr: pet.renderer.dpr,
					flies: c.adults,
					larvae: c.larvae,
					eggs: c.eggs,
					living: c.living,
					timeScale: pet.world.timeScale,
					panelWidth: Math.round(panel.getBoundingClientRect().width),
					saveKB,
					pupaColor,
					starTextureDiff,
					eggTaps,
					money: pet.world.counts.money.toFixed(3),
					// ⚠ 门槛的数值从**配置**里读，不是从自检里写死 ——
					//   改 config 之后清单上的数字会跟着变，不会变成一句谎话
					foodLockNeed: pet.config.market.foodUnlock.gold,
					achievementCount: pet.config.achievements.length,
					flyIconRed,
					flyIconPolarity,
					updateVersion: updateInfo ? updateInfo.version : null,
					banTool: banTag,
					toolIcons: iconTag,
				}
			})()`)

			if (!report.ok) return done(1, '[selftest] 失败: ' + report.reason)


			done(
				0,
				'[selftest] 通过\n' +
					`  画布 ${report.canvas}（dpr ${report.dpr}）\n` +
					`  世界已构建：成虫 ${report.flies} / 幼虫 ${report.larvae} / 卵 ${report.eggs}，存活 ${report.living}\n` +
					`  工具栏小窗 ${report.panelWidth}px，最小化切换正常\n` +
					`  存档端到端 ${report.saveKB.toFixed(1)} KB：写盘 → 读回 → 反序列化 一致\n` +
					'  折叠组：工具七个按钮（含查看 / 喷水枪）、时间轴「时停 / 1× / 2× / 5× / 10×」，展开可见、选中生效\n' +
					'  时停：世界真的停住，恢复后回到原来那一档（不掉回 1×）\n' +
					`  经济：游戏币 ${report.money}，商店 / 出售区 / 数据面板接线正常，六档配色可切换\n` +
					'  投放 / 商店：屏幕正中弹窗（不在 .window 里，不会被 overflow 剪掉）、点名分组渲染、' +
						'三行六键买不起全置灰、玻璃罐免费且摆满置灰、食物投放区参考框按配置摆位且不吞鼠标\n' +
					'  图鉴：格子式列出全部食物和基因，食物格真的画出来了（查非透明像素）、基因格的概率与配置一致\n' +
					'  图鉴画像：基因格左边多了一张「这只突变果蝇长什么样」（复用场上那套 drawFly，查像素）；' +
						'没见过的画成暗影、**五格长得一模一样**，见过的各不相同；' +
						(report.flyIconRed
							? `疯狂的红眼泛光比普通蝇红 ${(report.flyIconRed[1] / report.flyIconRed[0]).toFixed(2)} 倍` +
								`（红能量 ${report.flyIconRed[0].toFixed(0)} → ${report.flyIconRed[1].toFixed(0)}）`
							: '疯狂的红眼泛光：**没量到**') +
						'\n' +
						// 封禁那格是**冷**的、普通蝇是**暖**的。这两个数就是那条断言量到的东西 ——
						// 下次调黑曜石的亮度时能直接看到它有没有偏回去
						//
						// ⚠ 两个数的**符号含义相反**（一个是 暖-冷、一个是 冷-暖），
						//   所以绝不能写成「正数=偏暖」一句带过 —— 那会让第二个数
						//   读起来正好是反的。分开写清楚
						(report.flyIconPolarity
							? `  封禁画像：黑玻璃 + 冷白断口弧` +
								`（普通蝇 偏暖 +${report.flyIconPolarity[0].toFixed(0)}，` +
								`封禁 偏冷 +${report.flyIconPolarity[1].toFixed(0)}）；` +
								`胶囊外框和说明文字的流动描边已挂上（[data-gene=ban] 那几条 rule 匹配成功）\n`
							: '  封禁画像：**没量到**\n') +
					`  食物解锁：**苹果没有门槛**（口粮永远买得到）；金苹果要**累计总收入** ≥ $${report.foodLockNeed}` +
						'（不是手里的钱）。没过线时投放面板那一行不出现、底下写一句点名道姓的提示，图鉴照画但那格置灰\n' +
					`  成就：${report.achievementCount} 条（四种突变 / 星云苹果 / 金苹果 / 四档财富），` +
						'达成时屏幕中上方弹入弹出、一口气拿好几个会排队、见过两次不会重复给、重置跟着清零\n' +
					'  居中小卡：三张新卡的 ✕ 用 elementFromPoint 打出来是它自己、指针压上去 _overCard() 认、点下去真的关上；' +
						'养蝇人的「配置」点开时商店自己让位（不再两张卡叠成一坨）\n' +
					'  结晶成虫外观（查像素）：身体平均不透明度只有 45/255（全透明）、高饱和像素的色相铺开 350° 以上' +
						'（炫彩描边）、这圈边既有幼虫那么粗又不会跑到金色等其他变异身上\n' +
					'  喷水枪：没买前锁定且切不过去，买了能切；滚轮改长度、Shift+滚轮改角度（两者不串）、长度夹在 100~400；' +
						'水线穿过偏在一侧的污渍能冲掉，转 90° 之后就不再命中\n' +
					'  罐子：手套拖成虫进罐子真的能进、满员时不吞蝇、罐中寿命 2 倍\n' +
					'  罐中果蝇小窗：有罐子才出现、默认收起、点标题条开合、层级高过面板、收起时不占鼠标\n' +
					'  罐中列表防闪：连刷两次行节点不变、顺序被打乱能排回去\n' +
					'  玻璃罐：观察模式就能拖（指针在罐上才接管，食物不算），移开后鼠标归还\n' +
					'  商店升级链：逐级扣款、满级封顶、按钮跟着改名；捕虫网买前锁定买后可用\n' +
						'  Banhammer：商店里归了类、没买是 .locked（**不是 disabled**）、买前切不过去买后能切、' +
						'H 键开合、**锤下去真的打在指针那一点**（圈内中圈外不中）、连着两下会被冷却挡住；' +
						'机制那一半在 `bun run sim` 里（半径 / 五条路都动不了 / 两锤先封后卖 / 售价 ×1.5 / 幼虫价区间）\n' +
						`  工具图标：${report.toolIcons ? report.toolIcons.count : '?'} 张 12×12 像素图，` +
							'和按钮一一对应、每张都是 12×12、着色格数够多、**两两不同**、真的装进了按钮且有尺寸、' +
							'没有污染按钮文字（收起时标题行的工具名还读得对）；' +
							'金色流动只有金锤那一颗挂了，而且 `animation-name` 真的是 ' +
							(report.toolIcons ? report.toolIcons.anim : '?') + '\n' +
						'  越界等级：老存档里超出链长的等级被夹回来（表现为满级），商店照常重建、不抛异常\n' +
					'  设置卡：正常 / 烦人切换即时生效、上限 ×50 且总数封顶、切回来不清场、「烦人模式」四个字是红的\n' +
					`  检查更新：版本比较按数字段比（1.10.0 比 1.9.0 新，不会认成「已是最新」）、` +
						`清单取不回来时分得清 404 / 不是 JSON / 超时 / 不是网址；` +
						`主进程只放行 http(s)，file: / javascript: 一律拒绝。` +
						`设置卡上版本号读到的是 ${report.updateVersion || '**没读到**'}，` +
						'更新清单说有新版就提示并冒出「去下载」（优先用清单里的 url、没有才退回 downloadPage，' +
						'两边都没有就明说而不是留一颗点了没反应的按钮），清单版本旧就改口「已经是最新的」' +
						'并把上次那颗按钮收回去，没配地址时按钮置灰但**明说**没配；' +
						'清单地址配了**一串**时按顺序试（第一条是死链会自动退到第二条，全挂了会说清试过几个）\n' +
					'  重置：**三道**确认（说明 → 标红再问 → 手打「重置」才能点确定），前三道里世界一动不动；' +
						'走完三道才清世界 + 图鉴 + 彩蛋，开局那几只不带突变；' +
						'输入框里打字不会触发工具快捷键\n' +
					'  苍蝇拍：杀伤落点正好在拍面上（指针左上方），不在指针上；打死拍头那只、指针上那只不死（挥空也放一圈灰勾出杀伤半径）\n' +
					'  工具粒子：工具图案和范围圈全删了，只剩系统指针 —— body 上没有 tool-active；' +
						'举着打火机跑 20 帧粒子真的变多、画一帧不抛（证明自绘光标删干净了）、放下就停\n' +
					'  扫帚：按钮在、B 键开关、滚轮调半径且夹在 30~200、按住真的把幼虫推开（只推不删）\n' +
					'  点火：打火机 / 喷火枪是**两颗独立按钮**（买到哪档点亮哪颗），碰到活蝇一次就点着、' +
						'按住不重置倒计时、地上的尸体点不着、尸体只剩原价这一档、前 5 分钟不掉价\n' +
					'  烤炉：在**商店**里买断（钱不够 / 刚好够都置灰得对），买过之后投放面板里才长出那一行、' +
						'摆一台**不花钱**、摆满置灰、一台炉子的存档读回来不会白得烤炉；' +
						'**放进去就开始烤**（不用等装满）、' +
						'每只各有一条自己的进度条（两头都画得出来）、' +
						'**各自烤满各自到账**且地上不留尸体、每只各冒一个「+$x」飘字、面板上的钱跟着变\n' +
					'  分类折叠：投放 / 商店的每一组都能折起来，而且**钱一变不会自己弹回去**\n' +
					'  渲染覆盖：场上摆齐成虫 / 幼虫 / 蛹 / 尸体 / 蛆尸 / 汁渍 / 食物（含星空苹果）/ 星云蝇 / 星云幼虫 / 飘字 / 烤炉之后画一帧不抛，' +
						'而且 ctx.save 与 restore **次数配平**（少一次 restore 会让画布变换一直留着，整屏生物被钉在一个点上跟着晃）\n' +
					'  挥手惊蝇：慢速靠近完全不受惊、快甩才惊飞；悬停的踢出悬停、走路的起飞、方向背离指针；观察模式下一点不生效\n' +
					'  幼虫饥饿：吃不到就饿死、留尸体（不可烤）、蛹期不计\n' +
					'  统计：主面板只留存活 / 死亡，三条杠展开细分（含成虫总价值，与各蝇售价之和相符）\n' +
					'  捐款：右下角小罐子、卡片默认关着、二维码真的加载出来了、钉在屏幕正中、层级高过面板、指针压在卡片上才接管鼠标\n' +
					'  玻璃罐：放罐 → 网蝇 → 列表出行 → 放逐 → 扔罐 全流程正常\n' +
					'  数据面板：查看工具（V）点虫弹出、虫走开仍钉着、Esc 能关；飞行中的虫也能点；罐子压着虫也点得开；' +
						'**罐里的虫也点得开**（加罐心偏移才算对，卡片跟着虫走而不是飞到左上角）；幼虫只显示基因徽章\n' +
					'  罐中批量：全部出售 / 全部放逐逐罐结算不跳只；出售带二次确认，点「取消」什么都不卖\n' +
					'  罐中配对：一对成熟异性在罐里会生，卵**产在罐外底部**、母体不进 laying（不收翅）；' +
						'拍子仍旧打不进罐子\n' +
					'  基因突变：**不遗传**（每颗卵按自己的 chance 骰，父母带什么都不影响）、售价倍率、金光光环会复位、生命值不吃体重、疯狂自限 + 寿命砍半 + 够不着罐中虫、石化受惊不起飞\n' +
					'  设置 / 捐款：点图标那一层也能弹出（closest 判定，不是比 e.target）、再点能收起、层级高过面板与数据面板\n' +
					'  养蝇人：升级走 upgradeShopItem、配置按钮买后才出现、卡片真的接管鼠标、点选项能改状态且选中态跟着走、Lv1 时自动出售那几行是禁用的\n' +
					'  卖哪档：六档价值档齐全；卡片上不再有任何输入控件、world.keeper 也没有 minValue（价格滑条已删干净）；' +
					'自动出售真的按档筛选 —— 轻蝇只在最低档被卖、重蝇恰好命中一档且不是最低那档\n' +
					'  价值档对应：普通=白 · 罕见=蓝 · 稀有=紫 · 极稀有=金+流动 · 超级稀有=红+流动+反光 · 传说生物=淡彩+流动+反光\n' +
					'  放大镜：买过之后商店那一行长出六颗档位按钮，勾哪几档就亮哪几档；' +
						'没买不给、点一下 world.magnifierTiers 跟着变、选中态跟着走、一档不勾也允许\n' +
					`  星云贴图：真的加载出来了（1686×766）；星空苹果在两个屏幕位置上` +
						`画出来有 ${report.starTextureDiff}/576 个通道不同 —— 贴图是**钉在屏幕上**的，不是跟着果子走的\n` +
					`  彩蛋：罐子初始是蓝紫流光（.locked），点 ${report.eggTaps} 下解锁、流光翻回金色，` +
						'投放 / 图鉴同时冒出星空苹果和星云，星尘那 10 秒的层跟着点亮；' +
						'差一下不会提前解锁、已解锁后不再重复计数\n' +
					`  蛹是实心的，整排不透明（底色 ${report.pupaColor}）\n` +
					'  preload 桥完整，渲染一帧无异常',
			)
		} catch (e) {
			done(1, '[selftest] 执行失败: ' + e.message)
		}
	})

	setTimeout(() => done(1, '[selftest] 超时：15 秒内没加载完'), 15000)
}

/** 根据当前状态决定要不要让鼠标事件穿过去 */
function applyMouseMode() {
	if (!win || win.isDestroyed()) return
	const passThrough = clickThroughEnabled && !interactive
	// forward:true —— 即使穿透，渲染进程仍能收到 mousemove，用于悬停检测
	win.setIgnoreMouseEvents(passThrough, { forward: true })
}

/** 把主进程状态推给渲染进程，让 UI 上的按钮和真实状态保持一致 */
function syncState() {
	if (!win || win.isDestroyed()) return
	win.webContents.send('pet:state', {
		alwaysOnTop,
		clickThrough: clickThroughEnabled,
	})
}

/*
 * 把窗口沉到**所有普通窗口之下**（但仍高于桌面）。
 *
 * 为什么要绕这一下：Electron 只有 `setAlwaysOnTop(false)`（取消置顶，窗口留在
 * 原来那一层）和 `moveTop()`（往上），**没有「推到最底」这个 API**。
 * 玩家要的是「关掉置顶时，别的窗口能盖住它，但在桌面上还看得见」——
 * 光取消置顶做不到：窗口会停在它当时那一层，别的窗口不一定盖得住它。
 *
 * 所以直接调 Win32 的 SetWindowPos：
 *   hWndInsertAfter = HWND_BOTTOM(1)        —— 沉到普通窗口带的最底下
 *   flags = SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE (0x13) —— 不动位置尺寸，也不激活
 *
 * ⚠ 拿不到 hwnd、或者 PowerShell 被安全策略拦下时**只记日志**：
 *   退化成「窗口只是不置顶」（也就是改之前的样子），绝不能让游戏崩。
 * ⚠ `SELFTEST` 下直接返回 —— 自检不能真去动窗口层级。
 * ⚠ 命令走 `-EncodedCommand`（base64 UTF-16LE）：那段 C# 里全是引号和括号，
 *   拼进命令行的话转义规则和 PowerShell 的解析规则会打架，编码过去最省心。
 */
function sinkToBottom() {
	if (SELFTEST) return
	if (!win || win.isDestroyed()) return

	let hwnd
	try {
		const buf = win.getNativeWindowHandle()
		hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0))
	} catch (e) {
		console.warn('[win] 拿不到窗口句柄，跳过沉底:', e.message)
		return
	}

	const decl = [
		'[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);',
		'[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);',
		'[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string w);',
		'[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
		'public static string Sink(IntPtr win) {',
		'  IntPtr host = IntPtr.Zero;',
		// 桌面的图标宿主 = 子窗口里有 SHELLDLL_DefView 的那个顶层窗口。
		// ⚠ 不能用 FindWindow("Progman") —— 这台机器上它返回 0。
		//   而且这台机器上有好几层 WorkerW，光按类名找会挑到壁纸那一层
		'  IntPtr h = GetTopWindow(IntPtr.Zero);',
		'  int guard = 0;',
		'  while (h != IntPtr.Zero && guard++ < 900) {',
		'    if (FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) { host = h; break; }',
		'    h = GetWindow(h, 2);', // 2 = GW_HWNDNEXT
		'  }',
		// 插到宿主**之上**（SetWindowPos 的第二参 = 排在谁后面）。
		// 找不到宿主才退回 HWND_BOTTOM（1）—— 那时它至少还在所有普通窗口之下
		'  IntPtr after = host != IntPtr.Zero ? host : (IntPtr)1;',
		'  bool ok = SetWindowPos(win, after, 0, 0, 0, 0, 0x13);',
		'  return (ok ? "ok" : "fail") + " host=" + host.ToInt64();',
		'}',
	].join('\n')
	// ⚠ 用**跨行的单引号字符串**，不用 here-string（@'...'@）：
	//   here-string 要求终止符独占一行且顶格，塞进 -Command 里很容易被解析器咬到。
	//   单引号字符串里的换行是合法的，而且里面的双引号全是字面量，正好适合这段 C#
	const ps =
		"Add-Type -Namespace Ffw -Name Win -MemberDefinition '\n" +
		decl +
		"\n'\n[Ffw.Win]::Sink([IntPtr]" +
		hwnd +
		')'
	const encoded = Buffer.from(ps, 'utf16le').toString('base64')

	execFile(
		'powershell.exe',
		['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
		{ windowsHide: true, timeout: 5000 },
		(err) => {
			if (err) {
				console.warn('[win] 沉到桌面层失败（不影响游戏，只是层级退化成「单纯不置顶」）:', err.message)
			}
		},
	)
}

function setAlwaysOnTop(value) {
	alwaysOnTop = value
	if (win && !win.isDestroyed()) {
		// ⚠ 缩在任务栏里的话**先叫回来**再改置顶。
		//   不叫的话，玩家点「置顶」会看到「什么都没发生」—— 窗口还在任务栏里缩着，
		//   而按钮已经亮了。上面那个 minimize 钩子只拦「置顶开着时被最小化」，
		//   关着置顶缩下去的那种得在这里补
		if (win.isMinimized()) win.restore()
		win.setAlwaysOnTop(value, value ? 'screen-saver' : 'normal')
		// 关掉置顶之后还要再推一把 —— 上面那行只取消 topmost，
		// 窗口会停在它当时那一层，别的窗口不一定盖得住它
		if (!value) sinkToBottom()
	}
	syncState()
	return alwaysOnTop
}

function setClickThrough(value) {
	clickThroughEnabled = value
	applyMouseMode()
	syncState()
	return clickThroughEnabled
}

// 分辨率变化 / 换显示器时，重新贴合屏幕
function refitToScreen() {
	if (!win || win.isDestroyed()) return
	const { bounds } = screen.getPrimaryDisplay()
	win.setBounds(bounds)
}

// ------------------------------------------------------------------ IPC

ipcMain.on('pet:set-interactive', (_e, value) => {
	interactive = !!value
	applyMouseMode()
})

ipcMain.handle('pet:toggle-always-on-top', () => setAlwaysOnTop(!alwaysOnTop))

ipcMain.handle('pet:toggle-click-through', () => setClickThrough(!clickThroughEnabled))

/**
 * 渲染进程要问「我现在到底该不该穿透」——比如刚启动时同步一次。
 *
 * ⚠ 版本号也搭这趟车回给设置卡。它**不是**窗口状态，放这儿只是因为
 *   这条路本来就在启动时走一次、而且不需要联网 —— 没配更新地址时
 *   `pet:check-update` 根本不会被调用，设置卡上就会永远挂着「版本 —」。
 *   版本号是 `package.json` 的 version，由 electron-builder 打进 asar，
 *   所以打包版读到的是真的、不是源码里那个
 */
ipcMain.handle('pet:get-state', () => ({
	alwaysOnTop,
	clickThrough: clickThroughEnabled,
	version: app.getVersion(),
}))

ipcMain.on('pet:quit', () => app.quit())

// ------------------------------------------------------- 检查更新 / 开外链

/**
 * 把 `a.b.c` 拆成三个数字。认不出来的段一律当 0。
 *
 * ⚠ **不能拿字符串直接比大小** —— 那样 "1.9.0" > "1.10.0"（'9' > '1'），
 *   于是从 1.9 升到 1.10 的人永远收不到提示。这个坑很经典，也很安静
 */
function parseVersion(v) {
	return String(v ?? '')
		.split('.')
		.map((n) => parseInt(n, 10))
		.map((n) => (Number.isFinite(n) ? n : 0))
}

/** a 比 b 新返回正数，一样返回 0，旧返回负数 */
function compareVersions(a, b) {
	const A = parseVersion(a)
	const B = parseVersion(b)
	for (let i = 0; i < Math.max(A.length, B.length, 3); i++) {
		const d = (A[i] ?? 0) - (B[i] ?? 0)
		if (d !== 0) return d
	}
	return 0
}

/** 只认 http/https。`file:` / `javascript:` 之类的一律拒绝 */
function isSafeUrl(u) {
	try {
		const p = new URL(String(u))
		return p.protocol === 'http:' || p.protocol === 'https:'
	} catch {
		return false
	}
}

/**
 * 查一次版本清单。**请求是在主进程发的**，不是渲染进程 ——
 * 渲染进程跑在 `file://` 上，从那儿 fetch 一个 https 地址算跨域，
 * 得指望对方站点发 CORS 头；主进程是 Node，没有这回事。
 *
 * ⚠ 永远 resolve，不 reject：玩家没网、地址写错、对方站点挂了 ——
 *   这些都是**正常情况**，返回 `{ ok: false, reason }` 让 UI 去决定
 *   要不要说话。桌宠弹一个「检查更新失败」是最讨人厌的做法
 *
 * @param {string} url 清单地址
 * @param {number} timeoutMs 超时。⚠ 必须有：没有的话断网时
 *   fetch 会吊在那儿几十秒，而那期间设置卡上那颗按钮一直转
 */
async function fetchManifest(url, timeoutMs = 6000) {
	if (!url) return { ok: false, reason: 'no-url' }
	if (!isSafeUrl(url)) return { ok: false, reason: 'bad-url' }

	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), timeoutMs)
	try {
		const res = await fetch(url, { signal: ac.signal, redirect: 'follow' })
		if (!res.ok) return { ok: false, reason: 'http-' + res.status }
		const text = await res.text()
		// ⚠ 有些静态托管（比如 GitHub Pages 的 404 页）会用 200 返回一段 HTML。
		//   不 try 的话这里会抛，而外面看到的就是一句没法解释的「检查更新失败」
		let data
		try {
			data = JSON.parse(text)
		} catch {
			return { ok: false, reason: 'not-json' }
		}
		if (!data || typeof data.version !== 'string') return { ok: false, reason: 'no-version' }
		return { ok: true, data }
	} catch (e) {
		// AbortError 就是我们自己掐的
		return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' }
	} finally {
		clearTimeout(timer)
	}
}

ipcMain.handle('pet:check-update', async (_e, url, fallbackPage) => {
	const current = app.getVersion()
	const got = await fetchManifest(url)
	if (!got.ok) return { ok: false, reason: got.reason, current }

	const latest = got.data.version
	const newer = compareVersions(latest, current) > 0
	// ⚠ 地址优先用清单里的，没有才退回配置里那个兜底页
	const page = isSafeUrl(got.data.url) ? got.data.url : isSafeUrl(fallbackPage) ? fallbackPage : ''
	return {
		ok: true,
		current,
		latest,
		hasNew: newer,
		url: newer ? page : '',
		note: typeof got.data.note === 'string' ? got.data.note : '',
	}
})

/**
 * 在系统浏览器里打开一个链接。
 *
 * ⚠ **协议必须校验**。这是渲染进程递过来的字符串，而渲染进程是页面、
 *   是会被 XSS 影响的那一层 —— 主进程不该无条件拿它去 `shell.openExternal`。
 *   只认 http/https 之后，`file:` / `javascript:` 这类就进不来了
 */
ipcMain.handle('pet:open-external', async (_e, url) => {
	if (!isSafeUrl(url)) return { ok: false, reason: 'bad-url' }
	try {
		await shell.openExternal(String(url))
		return { ok: true }
	} catch (e) {
		return { ok: false, reason: e.message }
	}
})

// ------------------------------------------------------------------ 存档

/**
 * 存档放在 userData 目录下。
 *
 * 选它的理由：这是 Electron 给每个应用划的专属目录，卸载重装、覆盖安装都不会动它
 * （package.json 里也显式写了 deleteAppDataOnUninstall: false），
 * 而且不需要用户先选一个位置。代价是它在 C 盘的 AppData 里 ——
 * 不过整个存档也就一两百 KB，和动辄几百 MB 的 node_modules 不是一个量级。
 */
function saveFile() {
	// 自检读写的是另一个文件。自检里跑的是临时造出来的世界，
	// 让它写进真存档的话，玩家养了半天的生态会被一个假世界顶掉。
	const name = SELFTEST ? 'save.selftest.json' : 'save.json'
	return path.join(app.getPath('userData'), name)
}

function backupFile() {
	const name = SELFTEST ? 'save.selftest.bak' : 'save.bak'
	return path.join(app.getPath('userData'), name)
}

/**
 * 图鉴 + 彩蛋 + 成就的进度，**单独一个文件**。装三样：
 *
 *   `star`          —— 彩蛋（星空苹果 / 星云）解锁了没有
 *   `seen`          —— 图鉴里「见过」的突变 id（出生过就算，见 world.seenGenes）
 *   `achievements`  —— 已经拿到的成就 id（见 CONFIG.achievements）
 *
 * ⚠ **它现在不跨局了。** 这个文件曾经被刻意保护成「跨过『重新开始』」，
 *   注释里写的理由是「重开一局之后彩蛋又锁上，玩家会觉得坏了」。
 *   用户后来明确要了反过来的行为：**重置 = 真的从 0**，图鉴全灰、
 *   彩蛋锁回去、罐子还要重新点十下（见 ui.clearProgress）。
 *
 *   所以它现在的作用只是「把这两样从 R 里单独捞出来放一个文件」，
 *   方便一起清、也方便自检隔离。**别再按「永久解锁」去理解它** ——
 *   玩家点一次重置，这个文件就空了。
 *
 * ⚠ 单独一个文件的**真正**理由变成了：主进程能一次把它删干净，
 *   不用去动存档结构；而且自检读写的是另一个文件，碰不到玩家的真状态
 *
 * ⚠ 自检读写的是另一个文件，理由和 saveFile 一字不差：
 *   自检跑的是临时造出来的世界，不能把玩家的真状态顶掉
 */
function unlockFile() {
	const name = SELFTEST ? 'unlock.selftest.json' : 'unlock.json'
	return path.join(app.getPath('userData'), name)
}

function readSaveFile(file) {
	const raw = fs.readFileSync(file, 'utf8')
	const data = JSON.parse(raw)
	// 主进程只负责「这是个合法的 JSON」，版本号认不认识由渲染进程判断 ——
	// 版本语义属于世界状态，不该散落到主进程里
	if (!data || typeof data !== 'object' || !data.world) throw new Error('存档结构不对')
	return data
}

/**
 * 写存档。先写临时文件再 rename —— 同一个目录下的 rename 是原子操作，
 * 所以不会出现「写到一半断电，读出来是半个 JSON」这种情况。
 *
 * 旧存档先留一份 .bak：整份存档丢掉的代价是「养了半天的生态没了」，
 * 而这个备份只要一次复制，太便宜了，不值得省。
 */
function writeSave(json) {
	const file = saveFile()
	const tmp = file + '.tmp'

	fs.writeFileSync(tmp, json, 'utf8')

	try {
		fs.copyFileSync(file, backupFile())
	} catch {
		// 第一次存档时还没有旧文件，复制失败是正常的
	}

	fs.renameSync(tmp, file)
	return { ok: true, bytes: Buffer.byteLength(json, 'utf8') }
}

ipcMain.handle('pet:save', (_e, json) => {
	if (typeof json !== 'string' || !json) return { ok: false, reason: '存档内容为空' }
	try {
		return writeSave(json)
	} catch (e) {
		console.error('[save] 写入失败:', e.message)
		return { ok: false, reason: e.message }
	}
})

ipcMain.handle('pet:load', () => {
	try {
		return { ok: true, data: readSaveFile(saveFile()) }
	} catch (e) {
		// 主存档读不出来时退到备份再试一次
		try {
			const data = readSaveFile(backupFile())
			console.warn('[save] 主存档损坏，已改用备份:', e.message)
			return { ok: true, data, recovered: true }
		} catch {
			return { ok: false, reason: fs.existsSync(saveFile()) ? 'corrupt' : 'empty', detail: e.message }
		}
	}
})

// 文件不存在就是「还没解锁 / 还没见过任何突变」—— 这是**正常路径**，
// 不是错误。每个新玩家第一次启动都会走到这里，所以不打日志
ipcMain.handle('pet:load-unlock', () => ({ ok: true, data: readUnlock() }))

ipcMain.handle('pet:save-unlock', (_e, data) => {
	// ⚠ 只认白名单里的键。这是全项目**唯一**一条「渲染进程给什么就写什么」的路，
	//   不筛的话它可以被拿来往这个文件里塞任意结构（渲染进程是页面，
	//   页面是会被 XSS 影响的那一层 —— 主进程不该无条件相信它）
	//
	// ⚠ 白名单不完整是**静默失败**：这里漏掉一个键，渲染进程照写不误、
	//   拿不到任何错误，只有那个字段永远存不下来。加字段时**必须同步改这里**
	//
	// ⚠ 单个键的写入**保留文件里已有的值**（下面是「载荷里没有就沿用旧的」）。
	//   因为写是整个文件覆写：只发 {star} 的调用点会把 seen 抹成空。
	//   渲染侧已经收敛成 _persistUnlock() 一处、两个键一起发，
	//   这里再兜一道 —— 它守的是「以后有人加了第三个调用点」这种情况
	const old = readUnlock()
	const safe = {
		star: data && 'star' in data ? !!data.star : !!old.star,
		seen: Array.isArray(data && data.seen)
			? cleanIdList(data.seen)
			: Array.isArray(old.seen)
				? cleanIdList(old.seen)
				: [],
		achievements: Array.isArray(data && data.achievements)
			? cleanIdList(data.achievements)
			: Array.isArray(old.achievements)
				? cleanIdList(old.achievements)
				: [],
	}
	try {
		fs.writeFileSync(unlockFile(), JSON.stringify(safe), 'utf8')
		return { ok: true }
	} catch (e) {
		console.error('[unlock] 写入失败:', e.message)
		return { ok: false, reason: e.message }
	}
})

/** 读 unlock.json。读不出来就是空的 —— 那是**正常路径**，不打日志 */
function readUnlock() {
	try {
		const d = JSON.parse(fs.readFileSync(unlockFile(), 'utf8'))
		return d && typeof d === 'object' ? d : {}
	} catch {
		return {}
	}
}

/**
 * 洗一遍「一串 id」—— `seen`（见过的突变）和 `achievements`（成就）共用。
 *
 * ⚠ 上限 64：这是渲染进程递过来的数组，不封顶的话它可以被拿来
 *   往这个文件里灌一个几百 MB 的字符串数组
 */
function cleanIdList(list) {
	return list.filter((id) => typeof id === 'string' && id && id.length <= 64).slice(0, 64)
}

ipcMain.handle('pet:clear-save', () => {
	for (const f of [saveFile(), backupFile(), saveFile() + '.tmp']) {
		try {
			fs.rmSync(f, { force: true })
		} catch {
			// 删不掉也无所谓，下一次存档就覆盖了
		}
	}
	return { ok: true }
})

/**
 * 退出前让渲染进程把世界存一次。
 *
 * 主进程手里没有世界状态（它全在渲染进程里），只能反过来问。
 * 所以这是个握手：发个请求过去，等它回话；等不到就超时放行 ——
 * 绝不能因为渲染进程卡住就让用户关不掉这个程序。
 */
let flushState = 'idle' // 'idle' | 'done'

function flushRendererThen(proceed) {
	if (SELFTEST || flushState === 'done') return proceed()

	if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
		flushState = 'done'
		return proceed()
	}

	let fired = false
	const go = () => {
		if (fired) return
		fired = true
		flushState = 'done'
		proceed()
	}

	ipcMain.once('pet:flush-done', go)
	win.webContents.send('pet:flush-save')
	setTimeout(go, FLUSH_TIMEOUT)
}

// ------------------------------------------------------------------ 生命周期

app.whenReady().then(() => {
	createWindow()

	if (!SELFTEST) {
		// 全局快捷键：即使窗口被置底、或者穿透状态下点不到按钮，也救得回来
		// Ctrl+Shift+F  切换穿透
		globalShortcut.register('CommandOrControl+Shift+F', () => {
			setClickThrough(!clickThroughEnabled)
		})
		// Ctrl+Shift+T  切换置顶
		globalShortcut.register('CommandOrControl+Shift+T', () => {
			setAlwaysOnTop(!alwaysOnTop)
		})
		// Ctrl+Shift+Q  退出（穿透状态下没法点关闭按钮，给条退路）
		globalShortcut.register('CommandOrControl+Shift+Q', () => {
			app.quit()
		})
	}

	screen.on('display-metrics-changed', refitToScreen)
	screen.on('display-added', refitToScreen)
	screen.on('display-removed', refitToScreen)

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

/**
 * 退出前存档。
 *
 * 和 win.on('close') 那处是同一个握手的两个入口：走「退出」按钮 / Ctrl+Shift+Q
 * 会先到这里，走 Alt+F4 / 任务栏关闭则先到 close。两边都拦一次，
 * flushState 保证只有第一次真的去等，第二次直接放行 —— 否则会互相拦成死循环。
 *
 * 注意拦截的前提是窗口还在：如果渲染进程已经崩了，flushRendererThen 会
 * 立刻放行，不耽误退出。
 */
app.on('before-quit', (e) => {
	if (SELFTEST || flushState === 'done') return
	e.preventDefault()
	flushRendererThen(() => app.quit())
})

app.on('will-quit', () => {
	globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
	app.quit()
})
