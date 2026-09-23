/**
 * preload.js — 渲染进程与主进程之间唯一的桥
 *
 * 开了 contextIsolation，渲染进程拿不到 Node，只能通过这里暴露的几个方法
 * 去操作窗口。暴露面刻意收得很窄：窗口控制 + 存档读写 + 检查更新。
 *
 * 存档相关的四个方法传的都只是**字符串**，路径完全由主进程决定 ——
 * 渲染进程递不进来任何路径，也就没法拿它去写别的文件。
 *
 * ⚠ 检查更新那两个方法也是同一条规矩：`checkUpdate` 传进去的是**网址**，
 *   但发请求、解析、比较版本号**全在主进程**（见 main.js 的 fetchManifest），
 *   渲染进程拿回来的只是一句结论。`openExternal` 则只认 http/https ——
 *   不然页面那一层能拿它去开任何本地文件
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
	/** 告诉主进程：现在要不要接管鼠标（指针在 UI 上 / 手持工具时为 true） */
	setInteractive: (value) => ipcRenderer.send('pet:set-interactive', !!value),

	/** 切换置顶，返回切换后的状态 */
	toggleAlwaysOnTop: () => ipcRenderer.invoke('pet:toggle-always-on-top'),

	/** 切换鼠标穿透，返回切换后的状态 */
	toggleClickThrough: () => ipcRenderer.invoke('pet:toggle-click-through'),

	/** 查询当前窗口状态（启动时同步一次 UI） */
	getState: () => ipcRenderer.invoke('pet:get-state'),

	/** 订阅主进程状态变化（全局快捷键改了状态时，UI 要跟着变） */
	onState: (callback) => {
		ipcRenderer.on('pet:state', (_event, state) => callback(state))
	},

	quit: () => ipcRenderer.send('pet:quit'),

	// —— 检查更新 ——

	/**
	 * 查一次版本清单。
	 *
	 * ⚠ **请求是主进程发的，不是这里发的。** 渲染进程跑在 `file://` 上，
	 *   从这儿 fetch 一个 https 地址算跨域，得指望对方站点发
	 *   `Access-Control-Allow-Origin: *` —— 换个托管就可能整条路断掉，
	 *   而症状只是「检查更新失败」。主进程是 Node，没有这回事。
	 *
	 * 永远 resolve：没网 / 地址错 / 对方挂了都是**正常情况**，
	 * 返回 {ok:false, reason} 由 UI 决定要不要说话
	 */
	checkUpdate: (url, fallbackPage) => ipcRenderer.invoke('pet:check-update', url, fallbackPage),

	/**
	 * 在系统浏览器里打开链接（「去下载」按钮）。
	 * 主进程只认 http/https，别的一律拒绝
	 */
	openExternal: (url) => ipcRenderer.invoke('pet:open-external', url),

	// —— 存档 ——

	/** 把整个世界写进存档（json 字符串）。返回 {ok, bytes} 或 {ok:false, reason} */
	saveGame: (json) => ipcRenderer.invoke('pet:save', json),

	/** 读存档。没有存档返回 {ok:false, reason:'empty'} */
	loadGame: () => ipcRenderer.invoke('pet:load'),

	/** 删掉存档（「重新开始」时用） */
	clearSave: () => ipcRenderer.invoke('pet:clear-save'),

	// —— 图鉴 + 彩蛋的进度 ——
	//
	// ⚠ 和存档**分开两个文件**只是为了方便一起清、以及让自检能隔离，
	//   **不是**因为要跨局：重置会把这两样连同存档一起清掉（真的是从 0）。
	//   详见主进程里 unlockFile() 那段注释

	/** 读跨局进度。没解锁过返回 {ok:true, data:{}} */
	loadUnlock: () => ipcRenderer.invoke('pet:load-unlock'),

	/**
	 * 写跨局进度。主进程会筛白名单，**只认 `star` / `seen` / `achievements`
	 * 三个键**，其余的丢掉 —— 而且**不报错**：加了新字段却没同步改主进程
	 * 那张白名单的话，表现是「写进去了但读不回来」，很难查。
	 *
	 * ⚠ 三个键**一起发**，别只发一部分：主进程是整份覆写，只发 `star`
	 *   会把另外两个抹掉。渲染侧统一走 `ui._persistUnlock()`
	 */
	saveUnlock: (data) => ipcRenderer.invoke('pet:save-unlock', data),

	/** 主进程要退出了，让渲染进程赶紧存一次 */
	onFlushSave: (callback) => {
		ipcRenderer.on('pet:flush-save', () => callback())
	},

	/** 存完了，可以退出了 */
	flushDone: () => ipcRenderer.send('pet:flush-done'),
})
