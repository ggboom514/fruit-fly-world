/**
 * preload.js — 渲染进程与主进程之间唯一的桥
 *
 * 开了 contextIsolation，渲染进程拿不到 Node，只能通过这里暴露的几个方法
 * 去操作窗口。暴露面刻意收得很窄：窗口控制 + 存档读写。
 *
 * 存档相关的四个方法传的都只是**字符串**，路径完全由主进程决定 ——
 * 渲染进程递不进来任何路径，也就没法拿它去写别的文件。
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

	// —— 存档 ——

	/** 把整个世界写进存档（json 字符串）。返回 {ok, bytes} 或 {ok:false, reason} */
	saveGame: (json) => ipcRenderer.invoke('pet:save', json),

	/** 读存档。没有存档返回 {ok:false, reason:'empty'} */
	loadGame: () => ipcRenderer.invoke('pet:load'),

	/** 删掉存档（「重新开始」时用） */
	clearSave: () => ipcRenderer.invoke('pet:clear-save'),

	/** 主进程要退出了，让渲染进程赶紧存一次 */
	onFlushSave: (callback) => {
		ipcRenderer.on('pet:flush-save', () => callback())
	},

	/** 存完了，可以退出了 */
	flushDone: () => ipcRenderer.send('pet:flush-done'),
})
