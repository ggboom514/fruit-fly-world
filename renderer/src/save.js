/**
 * save.js — 存档：启动时的「继续 / 重新开始」，以及后台自动存档
 *
 * 分工：
 *   world.serialize() / restore()   世界状态 ↔ 纯数据（world.js）
 *   本文件                          什么时候存、存到哪儿、启动时问不问
 *   主进程（main.js）               真正的文件读写 —— 渲染进程碰不到 fs
 *
 * 为什么要有自动存档而不是「退出时存一次」：
 *   桌宠是那种开着就不管的程序，被杀掉的原因五花八门 ——
 *   断电、任务管理器、系统更新重启。只在退出时存的话，这些情况全都会丢。
 *   定期存 + 退出前补一次，最坏情况只丢十几秒。
 */

const SAVE_VERSION = 1

/** 自动存档间隔。存档一百多 KB，写一次几毫秒，这个频率完全无感 */
const AUTOSAVE_INTERVAL = 15 * 1000

/**
 * 自检模式（主进程带了 ?selftest=1）：
 *   不弹启动选择框 —— 那个要等人点，会把自检永远卡在启动界面上；
 *   也不写盘 —— 自检里是个临时造出来的世界，写下去就把玩家的真存档覆盖了。
 */
const SELFTEST = new URLSearchParams(location.search).has('selftest')

export class SaveManager {
	/**
	 * @param {import('./world.js').World} world
	 * @param {import('./ui.js').UI} ui
	 */
	constructor(world, ui) {
		this.world = world
		this.ui = ui

		this.bridge = window.pet ?? null
		// preload 桥断了（或者正在自检）就整个停用。桌宠照常能玩，
		// 只是不存档 —— 总好过每次操作都抛一个没人看的异常
		this.available =
			!SELFTEST &&
			typeof this.bridge?.saveGame === 'function' &&
			typeof this.bridge?.loadGame === 'function' &&
			typeof this.bridge?.clearSave === 'function'

		this.timer = null
		this.lastSavedAt = 0
		this.lastBytes = 0
		this.lastError = null
		this._resolveChoice = null

		this._cacheDom()
		this._bindFlush()
	}

	_cacheDom() {
		const $ = (id) => document.getElementById(id)
		this.el = {
			boot: $('boot'),
			sub: $('boot-sub'),
			stats: $('boot-stats'),
			note: $('boot-note'),
			cont: $('boot-continue'),
			fresh: $('boot-new'),
		}
	}

	// ---------------------------------------------------------- 启动

	/**
	 * 启动流程。有存档就问一句，没有就直接开新局。
	 * @returns {Promise<'continued'|'fresh'>} 走了哪条路（给日志和自检看）
	 */
	async begin() {
		if (!this.available) {
			if (!SELFTEST) console.warn('[save] 存档不可用（preload 桥缺失），本次不存档')
			return 'fresh'
		}

		let res
		try {
			res = await this.bridge.loadGame()
		} catch (e) {
			console.error('[save] 读存档时出错，按新局开始:', e)
			return 'fresh'
		}

		if (!res?.ok) {
			if (res?.reason === 'corrupt') {
				// 存档坏了不能默默当新局 —— 玩家会以为「又白玩了」，
				// 而实际上备份可能还能救。至少把话说清楚。
				console.error('[save] 存档损坏，无法读取:', res.detail)
				this.lastError = '存档损坏，已按新局开始'
			}
			return 'fresh'
		}

		const data = res.data
		if (data.version !== SAVE_VERSION) {
			console.warn(`[save] 存档版本 ${data.version} ≠ 当前 ${SAVE_VERSION}，按新局开始`)
			return 'fresh'
		}

		// 调试开关：带 --autocontinue 启动时直接当「继续」，不弹选择框。
		//
		// 存在的理由是「继续」这条链路**没法无头验证** —— 它需要一个真人点按钮。
		// `--selftest` 走的是另一条路（它把存档功能整个关掉了），
		// 所以这块逻辑一直是测试盲区。有了这个开关就能真的跑一遍：
		//   electron . --autocontinue
		// 选「继续」是不丢数据的那个分支，所以误用它的代价也只是「少问一句」。
		const autoContinue = new URLSearchParams(location.search).has('autocontinue')
		const choice = autoContinue ? 'continue' : await this._ask(data)

		if (choice === 'continue') {
			try {
				this.world.restore(data.world)
				return 'continued'
			} catch (e) {
				// 存档在结构上过关、恢复却炸了：不留一个半死不活的世界，直接清掉重开
				//
				// ⚠ **reset() 不能省，只 clear() 是不够的。** clear() 删的是磁盘上那份
				//   文件，而 restore() 是「先把所有数组清空、再逐个往里填」——
				//   它在半路抛出的话，内存里留下的是一个**空的或者填了一半**的世界。
				//   只 clear() 就直接返回的话，玩家拿到的是一局「日志写着新局、
				//   场上是残骸」的游戏：开局那几只不会回来（构造函数早就跑过了），
				//   屏幕上一个生物都没有，而且不报任何错。
				console.error('[save] 恢复世界失败，按新局开始:', e)
				this.lastError = '存档恢复失败，已按新局开始'
				await this.clear()
				this.world.reset()
				return 'fresh'
			}
		}

		// 选了「重新开始」：把旧存档删掉。
		// 不删的话，下次打开还会问「要不要继续」一个已经被放弃的世界，很烦。
		await this.clear()
		return 'fresh'
	}

	/**
	 * 弹出启动选择框，等用户点。
	 *
	 * 这一步会**暂停世界**（调用方负责不推进 update），并且强制接管鼠标 ——
	 * 窗口默认是穿透的，不接管的话这两个按钮根本点不到，会直接穿到桌面上。
	 *
	 * @returns {Promise<'continue'|'new'>}
	 */
	_ask(data) {
		return new Promise((resolve) => {
			const w = data.world ?? {}
			const s = w.stats ?? {}
			const adults = w.flies?.length ?? 0
			const larvae = w.larvae?.length ?? 0
			const eggs = w.eggs?.length ?? 0

			this.el.sub.textContent = `${this._ago(data.savedAt)}存的档`
			this.el.stats.innerHTML = ''
			for (const [label, value, cls] of [
				['成虫', adults, 'adult'],
				['幼虫', larvae, 'larva'],
				['卵', eggs, 'egg'],
			]) {
				const box = document.createElement('div')
				box.className = 'boot-stat'
				box.innerHTML = `<i class="dot ${cls}"></i><b></b><span></span>`
				box.querySelector('b').textContent = value
				box.querySelector('span').textContent = label
				this.el.stats.appendChild(box)
			}

			// 把「这个档值不值得继续」讲清楚：养的时长和累计产出比数量更有说服力
			const mins = Math.round((w.elapsed ?? 0) / 60000)
			const bits = [`已养 ${mins} 分钟`, `累计产卵 ${s.eggsLaid ?? 0}`, `羽化 ${s.emerged ?? 0}`]
			this.el.note.textContent = bits.join(' · ')

			const finish = (choice) => {
				if (this._resolveChoice !== finish) return // 只认第一次点击
				this._resolveChoice = null
				window.removeEventListener('keydown', onKey, true)
				this.el.boot.classList.add('hidden')
				document.body.classList.remove('booting')
				this.ui.setBootOpen(false)
				resolve(choice)
			}

			// Esc 当作「继续」：这是不丢数据的那个选项，
			// 万一玩家按了 Esc 想关掉什么，不该因此把世界重置掉
			const onKey = (e) => {
				if (e.code !== 'Escape') return
				e.preventDefault()
				finish('continue')
			}
			window.addEventListener('keydown', onKey, true)

			this.el.cont.addEventListener('click', () => finish('continue'), { once: true })
			this.el.fresh.addEventListener('click', () => finish('new'), { once: true })
			this._resolveChoice = finish

			document.body.classList.add('booting')
			this.el.boot.classList.remove('hidden')
			this.ui.setBootOpen(true)
			this.el.cont.focus()
		})
	}

	/** 把时间戳说成人话：「刚刚 / 12 分钟前 / 3 小时前 / 2 天前」 */
	_ago(ts) {
		if (!Number.isFinite(ts)) return '上次'
		const d = Date.now() - ts
		if (d < 60 * 1000) return '刚刚'
		if (d < 60 * 60 * 1000) return `${Math.floor(d / 60000)} 分钟前`
		if (d < 24 * 60 * 60 * 1000) return `${Math.floor(d / 3600000)} 小时前`
		return `${Math.floor(d / 86400000)} 天前`
	}

	// ---------------------------------------------------------- 存档

	/**
	 * 立刻存一次。
	 * @returns {Promise<{ok:boolean, bytes?:number, reason?:string}>}
	 */
	async saveNow() {
		if (!this.available) return { ok: false, reason: 'disabled' }

		let json
		try {
			json = JSON.stringify({
				version: SAVE_VERSION,
				savedAt: Date.now(),
				world: this.world.serialize(),
			})
		} catch (e) {
			// 循环引用之类的序列化错误：报出来，但绝不能让主循环跟着挂掉
			console.error('[save] 序列化失败:', e)
			this.lastError = e.message
			return { ok: false, reason: e.message }
		}

		try {
			const res = await this.bridge.saveGame(json)
			if (res?.ok) {
				this.lastSavedAt = Date.now()
				this.lastBytes = res.bytes
			} else {
				console.error('[save] 写入失败:', res?.reason)
				this.lastError = res?.reason
			}
			return res ?? { ok: false, reason: 'no-response' }
		} catch (e) {
			console.error('[save] 写存档时出错:', e)
			return { ok: false, reason: e.message }
		}
	}

	/** 删掉存档（「重新开始」用） */
	async clear() {
		if (!this.available) return
		try {
			await this.bridge.clearSave()
		} catch (e) {
			console.error('[save] 删除存档失败:', e)
		}
	}

	/** 开始定期自动存档。重复调用无害 */
	startAutosave() {
		if (!this.available || this.timer) return
		// 立刻存一次：万一这次开完就崩了，至少留下一份「刚打开时」的世界
		this.saveNow()
		this.timer = setInterval(() => this.saveNow(), AUTOSAVE_INTERVAL)
	}

	stopAutosave() {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
	}

	/**
	 * 主进程要退出了，赶紧存一次再放它走。
	 *
	 * 这里的 flushDone() 必须放在 finally 里 —— 存档失败也要让主进程退出，
	 * 否则窗口会卡在「关不掉」的状态，比丢存档还糟糕。
	 */
	_bindFlush() {
		if (!this.available) return
		this.bridge.onFlushSave(async () => {
			try {
				await this.saveNow()
			} finally {
				this.bridge.flushDone()
			}
		})
	}
}
