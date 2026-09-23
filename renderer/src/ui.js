/**
 * ui.js — 工具栏、计数、工具操作、鼠标穿透调度
 *
 * 穿透策略（这块是整个桌宠能不能日常使用的关键）：
 *   窗口默认是穿透的 —— 你在桌面上该干嘛干嘛，果蝇只是飘在上面。
 *   只有两种情况会「收起穿透、接管鼠标」：
 *     1. 指针压在工具栏面板上
 *     2. 手里拿着工具（手套 / 查看 / 苍蝇拍 / 捕虫网 / 抹布 / 烤制）
 *   第 2 条意味着：拿着工具时整块屏幕都是你的操作区，
 *   这时候点桌面上任何地方都会被当成挥拍 / 下网 / 抓取 / 查看，这是符合直觉的。
 *   想还给桌面，按 Esc 或点「观察」即可。
 *
 * ⚠ **拖动物件一律要戴手套**（食物、玻璃罐、蛹壳）。观察模式是纯看：
 *   不接管鼠标、也拖不动任何东西。这条规则是特意统一的 ——
 *   早先「观察模式就能拖」，结果是观察模式会在物件上方偷偷接管鼠标，
 *   和「观察 = 不打扰桌面」的定位自相矛盾。
 *
 *   于是手套成了唯一「拿着它才有用、放下就没用」的工具：
 *   它的作用范围不是某个半径，而是「你能拖到什么」。
 */

import { CONFIG, clamp, foodZoneRect, swatterHeadAt } from './config.js'
import { dist2 } from './utils.js'
import {
	formatMoney,
	valueTierOf,
	foodPrice,
	flyPrice,
	ovenPrice,
	bulkPrice,
	keeperOptions,
	chainOf,
	shopItem,
} from './market.js'
import { badgesOf } from './mutations.js'
import { drawFoodIcon } from './render.js'

/** 投放面板上每一行给的两档数量。想加「投 100 个」就往这里加一个数 */
const FEED_QUANTITIES = [1, 10]

/**
 * 食物 id → 中文名。
 *
 * ⚠ 这**一张表**要伺候四个地方：投放的提示语、投放面板那一行、
 *   图鉴的格子、养蝇人卡片的「投什么」。以前它们各写一份三元表达式
 *   （`id === 'gold' ? '金苹果' : '苹果'`），加第三种食物时改漏一处，
 *   界面上就会出现「投下 3 个苹果」而实际投的是星空苹果 —— 不报错，只是假话
 *
 * ⚠ 名字**只在这里定义**。config 里那几个 name（market.shop 的、_feedRowFor
 *   TABLE 的）是各自面板自己的说法，短一点长一点都行；这一张是「这东西叫什么」
 */
const FOOD_NAME = { apple: '苹果', gold: '金苹果', star: '星空苹果' }

export class UI {
	/**
	 * @param {import('./world.js').World} world
	 * @param {{tool:string, mouse:{x:number,y:number}, showCursor:boolean}} view
	 */
	constructor(world, view) {
		this.world = world
		this.view = view

		this.mouseDown = false
		this.lastSwat = 0
		this.lastNet = 0

		// —— 抹布：累计「滑过的路程」——
		//
		// 擦东西靠的是这个数，不是按住的时间。详见 _onMove：指针每移动一次就往
		// 这里加一段距离，_useTool 把它交给 world.wipe 之后清零。
		// 按住不动 = 一直是 0 = 一点都擦不掉。
		this.wipeScrub = 0
		// 这一帧抹布真的擦到了没有。给水渍粒子用 —— `_useTool` 会在交出
		// wipeScrub 之后把它清零，而 `_updateToolFx` 跑在那之后，读不到那个数了
		this.clothScrubbed = false
		this.lastPointer = { x: 0, y: 0 }

		/**
		 * 商店 / 投放弹窗里被折起来的分类，元素是 `'shop:tool'` 这样的键。
		 *
		 * ⚠ 存成**实例上的 Set**，不能靠 DOM 上的 class —— `_renderCats` 每次
		 *   都重建整块 DOM，而 `refreshStats()` 在钱一变时就同时调
		 *   refreshShop + refreshFeed。挂在 DOM 上的话，钱一动折叠就自己弹回去，
		 *   而这个 bug 只在「玩着玩着卖了一只蝇」的时候出现，看着完全随机
		 *
		 * 纯 UI 状态，不进存档 —— 和工具 / 倍速那两个折叠面板同一条规矩：
		 * 它不影响模拟，也不需要跨会话记住
		 */
		this.collapsedCats = new Set()
		this.clothDownAt = 0 // 这一次「按住」开始于什么时候（用来提示「要来回滑」）
		this.clothHinted = false

		/**
		 * 星空苹果解没解锁（彩蛋）。**未解锁的初始值** ——
		 * 真正的值由 app.js 启动时从 unlock.json 读回来，走 setStarUnlocked。
		 *
		 * ⚠ 唯一的真值来源是这里的 `_starUnlocked`（外面只准通过 getter
		 *   `starUnlocked` 读）。投放面板、图鉴、罐子配色全部读它，
		 *   别各自去翻存档 —— 两份状态总有一天会变成「图鉴里有、投放里没有」
		 */
		this._starUnlocked = false
		/**
		 * 这一轮连点了几下捐款罐子。**只在内存里** ——
		 * 它问的是「刚才连点了几下」，跨会话记住没有意义
		 * （也没人会关掉程序之后接着点）
		 */
		this.starTaps = 0
		this.starTimer = null

		// 这里原本有一个 roastHold / roastTarget / roastHinted ——
		// 打火机和喷火枪当年要「按住烤满 N 秒」。改成**接触即烤**之后
		// 计时就没有意义了，三个字段一起去掉（见 _useTool 的烤制分支）。
		// 烤炉（lv3）的 8 秒是**炉子自己**在烘，不需要这里记

		// —— 挥手惊蝇：鼠标甩得有多快 ——
		//
		// 0（手没动）→ 1（全速甩）。每帧在 update() 里按**位移 ÷ 时间**算，
		// 再和「上一次衰减后的值」取大的 —— 取大是为了让「甩一下然后停住」
		// 还能继续惊一小会儿（见 startleDecay），而不是松手瞬间就归零
		this.startle = 0
		this.lastMouseSample = { x: -999, y: -999 }

		// 数据面板：现在钉着哪只虫、有没有被点开。
		//
		// ⚠ inspectPinned 是**必需的**，不是可有可无的优化：_updateInspect 每帧都跑，
		//   而它看到「指针底下没虫」就会把卡片关掉。没有这个标志的话，
		//   点开的卡片会在**下一帧**就消失 —— 表现是「点了没反应」
		this.inspectTarget = null
		this.inspectPinned = false
		// 指针当前算不算「压在能点开的虫上」。用来给判定半径做迟滞，见 _inspectableAt
		this.inspectHover = false
		this.statTimer = 0
		this.interactive = false
		// 面板是不是收起了（屏幕上只剩飞的虫 + 右下角那个把手）。
		// 和「三条杠开着还是关着」一样是纯界面状态，不存档
		this.panelAway = false

		// 拖动状态。drag 是被拎着的那个东西（食物或玻璃罐），
		// dragKind 说明它是哪种 —— 松手时往哪儿结算、夹边界留多少余量都靠它。
		// dragOffset 记录「按下时物件中心相对指针的偏移」，
		// 这样拎起来的时候东西不会「跳」到指针正下方。
		this.drag = null
		this.dragKind = null // 'food' | 'jar'
		this.dragOffset = { x: 0, y: 0 }

		// 罐中果蝇列表的行缓存：果蝇对象 → 那一行的 DOM 引用。
		// 见 refreshJarList()，作用是避免每 0.15 秒重建整块列表。
		this.jarRows = new Map()

		// 罐中果蝇小窗的位置。null = 还没摆过，_placeJarWindow 会给个默认（右上角）。
		// 记在这里而不是读 DOM：窗口没有罐子时会整个 display:none，
		// 那时读 offsetLeft 只会读到 0
		this._jarPos = null
		this._jarPlaced = null // 上一次真正写进 style 的位置，没变就不碰 DOM
		this._jarSkipClick = false // 刚拖完，下一次 click 不算「点标题条」

		this._cacheDom()
		this._bindEvents()
		this._syncWindowState()
		this._syncSpeedUI() // 让按钮和 world 的初始状态对齐，别只靠 HTML 里写死的高亮
		this.refreshShop() // 商店列表是按配置渲染的，得先铺一次
		this.refreshToolButtons() // 捕虫网的锁定态 / 烤制按钮的档位名
		this.refreshFeed() // 投放面板同理
		this.refreshFoodZone() // 投放区参考框（默认隐藏，只摆位置）
		this.refreshStats()
	}

	// ---------------------------------------------------------- 初始化

	_cacheDom() {
		const $ = (id) => document.getElementById(id)
		this.el = {
			hud: $('hud'),
			panel: $('panel'),
			titlebar: $('titlebar'),
			btnMin: $('btn-min'),
			handle: $('panel-handle'),
			toolsBox: $('tools-box'),
			btnTools: $('btn-tools'),
			toolsCurrent: $('tools-current'),
			tools: $('tools'),
			btnStats: $('btn-stats'),
			statsDetail: $('stats-detail'),
			value: $('s-value'),
			living: $('s-living'),
			adults: $('s-adults'),
			larvae: $('s-larvae'),
			eggs: $('s-eggs'),
			food: $('s-food'),
			deaths: $('s-deaths'),
			top: $('btn-top'),
			speedBox: $('speed-box'),
			btnSpeed: $('btn-speed'),
			speedCurrent: $('speed-current'),
			speeds: $('speeds'),
			through: $('btn-through'),
			btnJar: $('btn-jar'),
			btnNet: $('btn-net'),
			btnLighter: $('btn-lighter'),
			btnFlamer: $('btn-flamer'),
			jarWindow: $('jar-window'),
			jarHead: $('jar-head'),
			jarList: $('jar-list'),
			jarSellAll: $('jar-sell-all'),
			jarReleaseAll: $('jar-release-all'),
			jarred: $('s-jarred'),
			trash: $('trash'),
			hint: $('hint'),
			hintText: $('hint-text'),
			btnSettings: $('btn-settings'),
			settingsPop: $('settings-pop'),
			settingsClose: $('settings-close'),
			modeList: $('mode-list'),
			btnDonate: $('btn-donate'),
			keeperPop: $('keeper-pop'),
			keeperClose: $('keeper-close'),
			keeperRows: $('keeper-rows'),
			keeperNote: $('keeper-note'),
			resetPop: $('reset-pop'),
			resetOk: $('reset-ok'),
			resetCancel: $('reset-cancel'),
			sellAllPop: $('sellall-pop'),
			sellAllOk: $('sellall-ok'),
			sellAllCancel: $('sellall-cancel'),
			sellAllBody: $('sellall-body'),
			donatePop: $('donate-pop'),
			donateClose: $('donate-close'),
			// 解锁彩蛋那一下的星尘。⚠ 它**不参与**鼠标接管判定 ——
			// 见 _updateInteractive 那段注释：铺满整屏的装饰一旦吃掉鼠标，
			// 桌面上会整整 10 秒点不动东西
			starfield: $('starfield'),
			btnReset: $('btn-reset'),
			quit: $('btn-quit'),
			swarm: $('swarm-badge'),
			pause: $('pause-badge'),

			// —— 经济 ——
			money: $('s-money'),
			sold: $('s-sold'),
			btnFeed: $('btn-feed'),
			feedPop: $('feed-pop'),
			feedClose: $('feed-close'),
			feedMoney: $('feed-money'),
			feedList: $('feed-list'),
			foodZone: $('food-zone'),
			btnShop: $('btn-shop'),
			shopPop: $('shop-pop'),
			shopClose: $('shop-close'),
			shopMoney: $('shop-money'),
			shopList: $('shop-list'),
			sell: $('sell'),

			// —— 图鉴 ——
			btnCodex: $('btn-codex'),
			codexPop: $('codex-pop'),
			codexClose: $('codex-close'),
			codexBody: $('codex-body'),

			// —— 喷水枪 ——
			btnSquirt: $('btn-squirt'),

			// 数据面板（观察模式点击弹出）。
			//
			// ⚠ 卡片本体**不进** _updateInteractive，它必须始终穿透。
			//   进列表的是「指针底下有能点开的虫」那条**另外**的谓词
			//   （_overInspectable）—— 两者别合并，见 _updateInteractive 的注释
			inspect: $('inspect'),
			inspectSex: $('inspect-sex'),
			inspectRarity: $('inspect-rarity'),
			inspectBuild: $('inspect-build'),
			inspectBar: $('inspect-bar'),
			inspectPct: $('inspect-pct'),
			inspectWeight: $('inspect-weight'),
			inspectValue: $('inspect-value'),
			inspectHp: $('inspect-hp'),
			inspectGenes: $('inspect-genes'),
		}
		this.toolButtons = Array.from(this.el.tools.querySelectorAll('[data-tool]'))
		this.speedButtons = Array.from(this.el.speeds.querySelectorAll('[data-speed]'))
	}

	_bindEvents() {
		for (const btn of this.toolButtons) {
			// ⚠ 这里原来有一段特判：`data-tool === 'roast'` 且等级 ≥3 时，
			//   点一下变成「摆一个烤炉」而不是 setTool。
			//   炉子挪进投放弹窗之后它没有存在理由了 —— 留着的话，
			//   玩家点「打火机」会凭空摆出一个炉子
			btn.addEventListener('click', () => this.setTool(btn.dataset.tool))
		}
		for (const btn of this.speedButtons) {
			btn.addEventListener('click', () => this.setSpeed(btn.dataset.speed))
		}

		// 点完按钮就取消聚焦，否则之后按空格会重复触发这个按钮
		document.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('button')
			if (btn) btn.blur()
		})

		// —— 窗口控制 ——
		this.el.btnMin.addEventListener('click', () => this.setPanelAway(true))
		// 收起之后右下角那个把手：点一下叫回来。
		//
		// ⚠ 用 click 而不是 mouseenter —— 鼠标扫过屏幕右下角（关窗口、点托盘）
		//   是常事，扫一下就弹一整个面板出来会很烦
		this.el.handle.addEventListener('click', () => this.setPanelAway(false))
		this._enableDrag()
		this._enableJarDrag()

		this.el.top.addEventListener('click', () => window.pet?.toggleAlwaysOnTop())
		this.el.through.addEventListener('click', () => window.pet?.toggleClickThrough())
		this.el.quit.addEventListener('click', () => window.pet?.quit())
		// 三条杠：展开 / 收起细分数量。
		// 和别的折叠块一样，「开着还是关着」只存在 DOM 的 class 上 ——
		// 它不影响模拟，也不需要跨会话记住
		this.el.btnStats.addEventListener('click', () => {
			const open = this.el.statsDetail.classList.toggle('collapsed')
			this.el.btnStats.classList.toggle('on', !open)
			this._updateInteractive() // 面板高度变了，指针可能就不在上面了
		})

		// ⚠ 「玻璃罐」原来在这里挂了一颗工具栏按钮，**已经撤掉** ——
		// 它挪进了投放弹窗的「其他」组（走下面那条 [data-jar] 委托）。
		// 同一个功能留两个入口的话，工具栏那一行更挤，而且玩家得记两个地方

		// —— 投放 / 商店：屏幕正中的弹窗，和设置卡同一套开合 ——
		this.el.btnFeed.addEventListener('click', () => this.setFeedOpen(!this.view.feedOpen))
		this.el.feedClose.addEventListener('click', () => this.setFeedOpen(false))
		this.el.btnShop.addEventListener('click', () => this.setShopOpen(!this.view.shopOpen))
		this.el.shopClose.addEventListener('click', () => this.setShopOpen(false))

		// —— 图鉴 ——
		this.el.btnCodex.addEventListener('click', () => this.setCodexOpen(!this.view.codexOpen))
		this.el.codexClose.addEventListener('click', () => this.setCodexOpen(false))

		// 投放：按钮由 refreshFeed() 渲染，监听用委托。
		//
		// ⚠ 「钱不够」是靠**置灰 + title** 表达的，不是靠点了之后弹提示。
		// 因为置灰的按钮点不动，下面那句 `btn.disabled` 会直接挡掉点击，
		// 所以「钱不够」的 _flashHint 分支在这里**到不了** —— 商店那边也有同一个
		// 到不了的 '钱不够' 分支（ui.js 里买道具那一处）。
		// 留着它只是兜底；真正会说话的是「撞上限」那几种失败。
		// 玻璃罐那一行。**单独一条委托** —— 它不是买东西，没有 data-kind，
		// 走的是 world.dropJar()（免费），而不是前面那条 buyXxx 的路
		this.el.feedList.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-jar]')
			if (!btn || btn.disabled) return
			// ⚠ dropJar() 撞上限时返回 null，早先是**静默**的 ——
			// 玩家点了没反应，只能猜。这里必须给一句话
			const jar = this.world.dropJar()
			this._flashHint(jar ? '摆了一个玻璃罐' : `罐子最多摆 ${CONFIG.jar.maxCount} 个`)
			this.refreshStats()
		})

		this.el.feedList.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-kind]')
			if (!btn || btn.disabled) return
			const n = Number(btn.dataset.n)
			const kind = btn.dataset.kind

			// 烤炉：一次只买一个，钱和上限的闸门都在 world.buyOven 里。
			// ⚠ 放在最前面并 return —— 它和下面「投 N 个」的语义完全不同
			//   （那个按份数乘单价、还能部分成功退钱），混在 if/else 里会被误读。
			//   ⚠ 按钮上的 disabled 只是**提示**，真正的闸门在 world.buyOven
			if (kind === 'oven') {
				if (this.world.buyOven()) this._flashHint('摆了一个烤炉')
				else if (this.world.ovens.length >= CONFIG.roast.oven.maxCount) {
					this._flashHint(`烤炉最多摆 ${CONFIG.roast.oven.maxCount} 个`)
				} else this._flashHint('钱不够')
				this.refreshStats()
				return
			}

			if (kind === 'fly') {
				const placed = this.world.buyFlies(n)
				if (placed < n) this._flashHint('果蝇到上限了')
				else this._flashHint(`投下 ${placed} 只果蝇`)
			} else {
				const placed = this.world.buyFood(kind, n)
				if (placed === 0) this._flashHint('食物放不下了，先收拾一下')
				else if (placed < n) this._flashHint(`只放得下 ${placed} 个，剩下的没算钱`)
				else this._flashHint(`投下 ${placed} 个${FOOD_NAME[kind] ?? kind}`)
			}
			this.refreshStats()
		})

		// 捐款：小罐子是开关，✕ 和 Esc 关，点面板别处也关。
		// 没有「点空白处关闭」—— 它没有全屏背板（见 style.css 那段注释），
		// 关法就是上面这三种
		// 点面板别处就关掉所有居中小卡。⚠ 用 closest 逐个判，不能只看
		// 是不是捐了几张卡之一 —— 那样点在设置卡上会把设置卡自己关掉
		const inAnyCard = (t) =>
			!!(t.closest && (t.closest('#donate-pop') || t.closest('#settings-pop') || t.closest('#reset-pop')))
		// ⚠ 这一次点击**同时也是彩蛋的计数器**（点十下解锁星空苹果）。
		//   两件事共用一次点击是有意的：那颗罐子本来就长在那儿、本来就在发光，
		//   不必再加第二颗藏起来的按钮 —— 藏起来的东西没人会去找。
		//   副作用是连点时会开关卡片十下，10 是偶数所以最后停在「关」上；
		//   玩家在连点的时候本来也看不清卡片
		this.el.btnDonate.addEventListener('click', () => {
			this._tapDonate()
			this.setDonateOpen(!this.view.donateOpen)
		})
		this.el.donateClose.addEventListener('click', () => this.setDonateOpen(false))

		// —— 设置卡片：正常 / 烦人模式 ——
		this.el.btnSettings.addEventListener('click', () => this.setSettingsOpen(!this.view.settingsOpen))
		this.el.settingsClose.addEventListener('click', () => this.setSettingsOpen(false))

		// —— 养蝇人配置卡 ——
		//
		// ⚠ 委托到**卡片容器**上、并且一律用 e.target.closest 认按钮。
		//   上一轮刚踩过这个坑：按钮里套了图标 span 时 e.target 是 span 不是
		//   button，拿 `e.target !== button` 去判会判错，症状是「点了没反应」。
		//   这里目前全是纯文字按钮，但模式要统一，免得下次加图标时重演
		this.el.keeperClose.addEventListener('click', () => this.setKeeperOpen(false))
		this.el.keeperPop.addEventListener('click', (e) => {
			const t = e.target
			const pick = (attr) => (t.closest ? t.closest('[' + attr + ']') : null)

			const b = pick('data-k-feed') || pick('data-k-n') || pick('data-k-sell') ||
				pick('data-k-tier') || pick('data-k-mut')
			if (!b || b.disabled) return

			// 把 dataset 里的字符串映射回 setKeeperOption 认的键和值
			let key = null
			let value = null
			if (b.dataset.kFeed !== undefined) {
				key = 'food'
				value = b.dataset.kFeed
			} else if (b.dataset.kN !== undefined) {
				key = 'foodN'
				value = Number(b.dataset.kN)
			} else if (b.dataset.kSell !== undefined) {
				key = 'sell'
				value = b.dataset.kSell === '1'
			} else if (b.dataset.kTier !== undefined) {
				key = 'tier'
				value = b.dataset.kTier
			} else if (b.dataset.kMut !== undefined) {
				key = 'mutants'
				value = b.dataset.kMut === '1'
			}
			if (!key) return

			// 世界层会按 config 的白名单校验，认不出来的值原样拒绝 ——
			// 无论成没成都重画一次，选中态永远跟着 world 的真实状态走
			this.world.setKeeperOption(key, value)
			this.refreshKeeperCard()
		})

		// ⚠ 这里原来还有一条给养蝇人价格滑条挂的 **input** 监听。
		//   滑条整条删掉之后它也没有存在的理由了 ——
		//   现在这张卡上**没有任何输入控件**，全是按钮，走上面那条委托点击
		this.el.modeList.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-mode]')
			if (!btn) return
			this.setAnnoying(btn.dataset.mode === 'annoying')
		})

		// —— 重置：二次确认 ——
		//
		// ⚠ 重置会连存档一起清掉，而工具栏那颗按钮和「重开一局」只差一次误触。
		// 所以点它**只开确认卡**，真正清空在 #reset-ok 上
		this.el.btnReset.addEventListener('click', () => this.setResetOpen(true))
		this.el.resetCancel.addEventListener('click', () => this.setResetOpen(false))
		this.el.resetOk.addEventListener('click', () => {
			this.setResetOpen(false)
			this.world.reset()
			this.refreshStats()
			this._flashHint('已经重置了')
		})
		this.el.panel.addEventListener('click', (e) => {
			if (inAnyCard(e.target)) return
			// ⚠ 这两条判的是「点在不在那颗按钮上」，所以必须用 closest 往上找 ——
			//   **不能写 `e.target !== this.el.btnDonate`**。
			//
			//   两颗按钮里都套了一个图标 span（`.jar-icon` / `.gear-icon`）来画图案，
			//   而 span 铺满了整颗按钮 —— 于是玩家实际点到的是 **span**，不是 button。
			//   那样写的话：按钮自己的 click 先把卡片打开，事件冒泡到这里，
			//   `e.target`（span）!== btnDonate 成立 → 同一次点击里又把它关掉。
			//   症状就是「点设置 / 点捐款都没反应」，而且**卡片其实闪开了一下**，
			//   只是同一帧内又被关了 —— 非常难从现象联想到是这里
			const onDonateBtn = !!(e.target.closest && e.target.closest('#btn-donate'))
			const onSettingsBtn = !!(e.target.closest && e.target.closest('#btn-settings'))
			// 养蝇人那张配置卡的入口在商店列表里，不在 #panel 的直属按钮上 ——
			// 判据和上面两条一样，用 closest 往上找
			const onKeeperBtn = !!(e.target.closest && e.target.closest('[data-keeper-cfg]'))
			// ⚠ 投放 / 商店 / 图鉴的入口按钮**都在 #panel 里**，所以也必须在这里排除。
			//   不排除的话：按钮自己的 click 先打开弹窗，事件冒泡到 #panel，
			//   这一行判「不在入口按钮上」→ 同一次点击里又把刚打开的弹窗关掉。
			//   症状是「点投放没反应」，而卡片其实闪开了一下 —— 就是上面那段注释
			//   写的那个坑，换了个位置重演
			const onFeedBtn = !!(e.target.closest && e.target.closest('#btn-feed'))
			const onShopBtn = !!(e.target.closest && e.target.closest('#btn-shop'))
			const onCodexBtn = !!(e.target.closest && e.target.closest('#btn-codex'))
			if (this.view.keeperOpen && !onKeeperBtn) this.setKeeperOpen(false)
			if (this.view.donateOpen && !onDonateBtn) this.setDonateOpen(false)
			if (this.view.feedOpen && !onFeedBtn) this.setFeedOpen(false)
			if (this.view.shopOpen && !onShopBtn) this.setShopOpen(false)
			if (this.view.codexOpen && !onCodexBtn) this.setCodexOpen(false)
			// 重置确认**不**在这里关 —— 它是个岔路口，得明确选一边。
			// 点面板就悄悄关掉的话，玩家会以为「已经重置过了」
			if (this.view.settingsOpen && !onSettingsBtn) this.setSettingsOpen(false)
		})

		// 商店里的商品按钮是 refreshShop() 按配置渲染出来的，
		// 所以监听挂在这里（委托），而不是给每件商品单独绑
		this.el.shopList.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-buy]')
			if (!btn || btn.disabled) return
			const id = btn.dataset.buy
			if (this.world.buyShopItem(id)) {
				this._flashHint(`买下了${btn.dataset.name ?? '道具'}`)
				this.refreshShop()
				this.refreshStats()
			} else {
				this._flashHint('钱不够')
			}
		})

		// 商店里那条**升级链**。单独委托一道，因为它走的是
		// upgradeShopItem 而不是 buyShopItem —— 已拥有语义在那边是「买过了」，
		// 而这里「已经有 lv1 了，还要再买 lv2」
		this.el.shopList.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-chain]')
			if (!btn || btn.disabled) return
			const id = btn.dataset.chain
			if (this.world.upgradeShopItem(id)) {
				this._flashHint(`升级到${btn.dataset.name ?? '下一级'}`)
				this.refreshShop()
				this.refreshStats()
			} else {
				this._flashHint('钱不够')
			}
		})

		// 养蝇人那颗「配置」—— 打开居中的配置卡。
		// 单独一道委托，和上面两条并列，因为它既不买东西也不升级
		this.el.shopList.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-keeper-cfg]')
			if (!btn || btn.disabled) return
			this.setKeeperOpen(!this.view.keeperOpen)
		})

		// 放大镜的档位勾选。又是一条独立委托 —— 它既不买东西也不算升级。
		//
		// ⚠ 必须是**委托**，不能给六个按钮各挂一条：refreshShop() 会整块重建
		//   商店列表，而它在钱一变就会跑（卖一只蝇就变一次），
		//   逐按钮挂的监听会被下一次重建整个冲掉
		this.el.shopList.addEventListener('click', (e) => {
			const btn = e.target.closest && e.target.closest('[data-magnify-tier]')
			if (!btn || btn.disabled) return
			this.world.toggleMagnifierTier(btn.dataset.magnifyTier)
			this.refreshShop()
		})

		// 两个折叠：工具组、倍速。
		// 状态只在 DOM 的 class 上，不需要进 view —— 它们纯粹是「面板怎么摆」，
		// 既不影响模拟，也不需要跨会话记住
		//
		// ⚠ 这里原来还有第三、四个折叠（投放 / 商店），它们搬去弹窗之后，
		//   「开合状态只活在 DOM class 上」这条规律对它们不再成立 ——
		//   那两张卡进 view 了（feedOpen / shopOpen），和设置卡一个待遇
		this.el.btnTools.addEventListener('click', () => {
			this.el.toolsBox.classList.toggle('collapsed')
			// 收起 / 展开会改面板高度，指针可能因此不再压在面板上 ——
			// 重新判定一次要不要继续接管鼠标
			this._updateInteractive()
		})
		this.el.btnSpeed.addEventListener('click', () => {
			this.el.speedBox.classList.toggle('collapsed')
			this._updateInteractive()
		})
		// 罐中果蝇小窗：点标题条展开 / 收起。
		// ⚠ 拖完那一下**不算点击** —— 否则挪个位置就会顺手把列表收起来。
		// 标志位在 _enableJarDrag 的 mouseup 里置上，这里消费掉。
		// mousedown → mousemove → mouseup → click 的顺序是规范保证的，
		// 所以这里一定能读到刚置上的值
		this.el.jarHead.addEventListener('click', () => {
			if (this._jarSkipClick) {
				this._jarSkipClick = false
				return
			}
			this.el.jarWindow.classList.toggle('collapsed')
			this._placeJarWindow() // 收起 / 展开会改高度，夹回屏幕内的结果可能不一样
			this._updateInteractive()
		})
		// —— 罐子：一键出售 / 一键放逐 ——
		//
		// ⚠ 全部出售走**二次确认**，全部放逐不走。理由见 index.html 里那段：
		//   卖是不可撤销的，而罐子是玩家特意存下来的地方；放逐只是把虫子
		//   放回屏幕上，随时能再网回去
		this.el.jarSellAll.addEventListener('click', () => this.setSellAllOpen(true))
		this.el.jarReleaseAll.addEventListener('click', () => {
			const n = this.world.releaseAllInJars()
			if (n > 0) this._flashHint(`放走了 ${n} 只`)
			this.refreshStats()
		})
		this.el.sellAllCancel.addEventListener('click', () => this.setSellAllOpen(false))
		this.el.sellAllOk.addEventListener('click', () => {
			this.setSellAllOpen(false)
			const { count, gain } = this.world.sellAllInJars()
			if (count > 0) this._flashHint(`卖掉 ${count} 只，+${formatMoney(gain)}`)
			this.refreshStats()
		})

		// —— 鼠标 ——
		window.addEventListener('mousemove', (e) => this._onMove(e))
		window.addEventListener('mousedown', (e) => this._onDown(e))
		window.addEventListener('mouseup', () => {
			if (this._endDrag()) return
			this.mouseDown = false
			// 松开时把这半下攒的路程丢掉。留着的话，下一次按住的第一帧
			// 会把上一笔一次性结算掉 —— 表现就是「点一下就擦掉一大块」
			this.wipeScrub = 0
		})
		// 切走窗口时把按住状态和拖动都清掉，
		// 不然回来会发现拍子一直在挥、或者食物黏在指针上
		window.addEventListener('blur', () => {
			this.mouseDown = false
			this.wipeScrub = 0
			this._cancelDrag()
		})
		window.addEventListener('contextmenu', (e) => e.preventDefault())

		// —— 喷水枪：滚轮调水线 ——
		//
		// ⚠ 这是整个项目里**唯一**一个 wheel 监听，而且必须写成 `{ passive: false }`：
		//   默认的 passive 监听里 `preventDefault()` 是**无效**的（浏览器只在控制台
		//   抱怨一句，滚轮照样把底下的桌面滚了）。这是个不报错的静默失效。
		//
		// ⚠ **不要**另外维护 Shift 的按下状态。`WheelEvent` 自带 `e.shiftKey`，
		//   在回调里直接读就行 —— 装一套 keydown/keyup 追踪只是多一处会不同步的状态
		//   （切窗口、丢焦点时都可能卡住），而这里根本不需要它
		//
		// ⚠ 滚轮只在窗口**接管鼠标**时才被转发进来，而「手里拿着工具」正好会让
		//   窗口接管（见 _updateInteractive 的第一条）。所以不用再判一次 ——
		//   但这也意味着：**拿着别的工具时滚轮改不了水线**，这是预期的
		window.addEventListener(
			'wheel',
			(e) => {
				// 往上滚 = 变大 / 变长 / 逆时针转，和「往上=增加」的直觉一致
				const step = e.deltaY > 0 ? -1 : 1

				if (this.view.tool === 'squirt') {
					e.preventDefault()
					if (e.shiftKey) {
						this.view.squirt.angle += step * CONFIG.tools.squirtTurnStep
					} else {
						const T = CONFIG.tools
						this.view.squirt.len = clamp(
							this.view.squirt.len + step * T.squirtLenStep,
							T.squirtLenMin,
							T.squirtLenMax,
						)
					}
					return
				}

				// —— 扫帚：滚轮改半径 ——
				//
				// ⚠ 和上面的水线共用**同一个**监听（全项目只有这一个 wheel），
				//   所以是「先看手里拿着什么，再决定这一步给谁」，
				//   而不是各挂各的 —— 挂两个的话两个回调都会跑，两个都 preventDefault，
				//   表现是「拿着扫帚滚轮，水线也跟着变了」
				if (this.view.tool === 'broom') {
					e.preventDefault()
					const B = CONFIG.tools.broom
					this.view.broom.r = clamp(
						this.view.broom.r + step * B.radiusStep,
						B.radiusMin,
						B.radiusMax,
					)
				}
			},
			{ passive: false },
		)

		// —— 键盘 ——
		window.addEventListener('keydown', (e) => this._onKey(e))

		// 主进程状态变化（全局快捷键也能改状态，按钮要跟着走）
		window.pet?.onState((state) => this._applyWindowState(state))
	}

	async _syncWindowState() {
		const state = await window.pet?.getState?.()
		if (state) this._applyWindowState(state)
	}

	// ---------------------------------------------------------- 窗口行为

	setPanelAway(away) {
		const on = !!away
		if (on === this.panelAway) return
		this.panelAway = on

		// 类挂在 #hud 上，面板和罐子小窗由 CSS 一起收 —— 见 style.css 那段注释
		this.el.hud.classList.toggle('panel-away', on)
		// 把手反过来：收起时才出现
		this.el.handle.classList.toggle('hidden', !on)

		// ⚠ 收起 / 展开都会改变「指针底下有没有东西」，必须重新判定要不要接管鼠标。
		//   少了这一句，收起之后那一下点击会穿到桌面上；展开之后面板反而点不动
		this._updateInteractive()
	}

	/** 现在是不是收起状态（自检要查） */
	get panelAwayState() {
		return !!this.panelAway
	}

	/**
	 * 拖标题栏搬动这扇小窗。
	 *
	 * Electron 窗口本身铺满整屏、不能移，所以这里移的是 DOM 元素。
	 * 第一次拖动时把「居中 + 贴底」的自由布局换算成写死的 left/top，
	 * 之后完全按像素走；同时夹在屏幕内，免得拖出去找不回来。
	 */
	_enableDrag() {
		const bar = this.el.titlebar
		const win = this.el.panel
		let dragging = false
		let startX = 0
		let startY = 0
		let origLeft = 0
		let origTop = 0

		bar.addEventListener('mousedown', (e) => {
			if (e.button !== 0) return
			if (e.target.closest('button')) return // 点标题栏上的按钮不算拖动

			const r = win.getBoundingClientRect()
			win.style.left = r.left + 'px'
			win.style.top = r.top + 'px'
			win.style.bottom = 'auto'
			win.classList.add('detached') // 去掉 CSS 里那个 translateX(-50%)

			origLeft = r.left
			origTop = r.top
			startX = e.clientX
			startY = e.clientY
			dragging = true
			document.body.classList.add('dragging')
			e.preventDefault()
		})

		window.addEventListener('mousemove', (e) => {
			if (!dragging) return
			const left = clamp(origLeft + (e.clientX - startX), 0, window.innerWidth - win.offsetWidth)
			const top = clamp(origTop + (e.clientY - startY), 0, window.innerHeight - win.offsetHeight)
			win.style.left = left + 'px'
			win.style.top = top + 'px'
		})

		window.addEventListener('mouseup', () => {
			if (!dragging) return
			dragging = false
			document.body.classList.remove('dragging')
		})
	}

	/**
	 * 罐中果蝇小窗：拖标题条挪位置。
	 *
	 * 和 _enableDrag（工具栏面板）同一套写法，只有两点不同：
	 *
	 * 1. 位置**记在 this._jarPos 里**，而不是读 DOM 的 style。
	 *    因为窗口会在「没有罐子」时整个 display:none —— 那时 offsetLeft 之类
	 *    全变成 0，读 DOM 的话下次出现就跳回左上角了。
	 * 2. 挪过之后**要把那一下点击吃掉**（this._jarSkipClick）。
	 *    面板那边没这个问题：它的标题条上没有 click 处理，而这边点一下是
	 *    「展开 / 收起」，拖完顺手收起列表会让人莫名其妙。
	 */
	_enableJarDrag() {
		const bar = this.el.jarHead
		const win = this.el.jarWindow
		let dragging = false
		let moved = false
		let startX = 0
		let startY = 0
		let origLeft = 0
		let origTop = 0

		bar.addEventListener('mousedown', (e) => {
			if (e.button !== 0) return
			const r = win.getBoundingClientRect()
			origLeft = r.left
			origTop = r.top
			startX = e.clientX
			startY = e.clientY
			dragging = true
			moved = false
			document.body.classList.add('dragging')
			e.preventDefault() // 别让它变成选文字
		})

		window.addEventListener('mousemove', (e) => {
			if (!dragging) return
			// 3px 以内不算拖 —— 手抖一下不该让「点一下展开」失灵
			if (!moved && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 3) return
			moved = true
			this._jarPos = { x: origLeft + (e.clientX - startX), y: origTop + (e.clientY - startY) }
			this._placeJarWindow()
		})

		window.addEventListener('mouseup', () => {
			if (!dragging) return
			dragging = false
			document.body.classList.remove('dragging')
			this._jarSkipClick = moved
		})
	}

	/**
	 * 把罐中果蝇小窗摆到 this._jarPos，并夹在屏幕内。
	 *
	 * 第一次出现时给一个默认位置：**右上角**。
	 * 左下有工具栏面板、正中是捐款卡片，右上角是唯一不会和它们打架的角落。
	 *
	 * ⚠ 位置不写死在 CSS 里，也不存进存档 —— 它是纯界面状态，
	 * 和「三条杠开着还是关着」一样只活在这次运行里。
	 */
	_placeJarWindow() {
		const win = this.el.jarWindow
		if (win.classList.contains('hidden')) return

		// 收起 / 展开会改高度，所以每次都重新读
		const w = win.offsetWidth
		const h = win.offsetHeight
		if (!this._jarPos) this._jarPos = { x: window.innerWidth - w - 16, y: 16 }

		const left = clamp(this._jarPos.x, 0, Math.max(0, window.innerWidth - w))
		const top = clamp(this._jarPos.y, 0, Math.max(0, window.innerHeight - h))
		if (this._jarPlaced && this._jarPlaced.x === left && this._jarPlaced.y === top) return
		this._jarPlaced = { x: left, y: top }
		win.style.left = left + 'px'
		win.style.top = top + 'px'
	}

	// ---------------------------------------------------------- 鼠标

	_onMove(e) {
		// 抹布擦的是「滑过的路程」，所以这里要**每次 mousemove 都累加**，
		// 而不是每帧取一次位置差 —— 一帧里鼠标可能移动了好几次，
		// 取位置差会把中间的路程全丢掉，擦起来就变成「只有慢慢挪才有效」
		if (this.view.tool === 'cloth' && this.mouseDown) {
			this.wipeScrub += Math.hypot(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y)
		}
		this.lastPointer.x = e.clientX
		this.lastPointer.y = e.clientY

		this.view.mouse.x = e.clientX
		this.view.mouse.y = e.clientY

		if (this.drag) this._dragTo()

		this._updateInteractive()
	}

	_onDown(e) {
		if (e.button !== 0) return
		// 点在工具栏上不算「使用工具」，否则想换工具会先误拍一下
		if (e.target.closest && e.target.closest('#panel')) return

		// 按在一个「现在拎得动」的东西上 → 把它拎起来。
		//
		// ⚠ 这里**不能**再写 `if (tool === 'glove')` 了。拎得动什么由
		// _grabbableAt() 自己判：手套 → 四种都行，观察模式 → 只有玻璃罐。
		// 两边共用同一个真值来源，将来再放开什么，这里和 _updateInteractive
		// 会自动跟上，不会漏掉一处
		const hit = this._grabbableAt()
		if (hit) {
			this.drag = hit.item
			this.dragKind = hit.kind
			this.dragOffset.x = hit.item.x - this.view.mouse.x
			this.dragOffset.y = hit.item.y - this.view.mouse.y
			// ⚠ 这个名字只管着全局 cursor: grabbing，其实也用于罐子和蛹壳，
			// 不是「只拖食物」。别按名字去猜它的覆盖面
			document.body.classList.add('dragging-food')
			return
		}
		// 手套抓空了就什么也不做 —— 它没有「点一下」的动作，
		// 不像拍子那样会误触发一次挥拍。
		//
		// ⚠ 这个 return 必须在下面 `mouseDown = true` **之前**：
		// 否则观察模式下手套空抓会让 update() 每帧空跑一次 _useTool()
		if (this.view.tool === 'glove') return

		// —— 查看工具：点一下虫，弹出它的数据面板 ——
		//
		// ⚠ 位置必须在**这里**：不能放在 _useTool 里。
		//   查看工具在 _useTool 里是不匹配任何分支的（一路 return 到底），
		//   而且 _useTool 是**按住每帧都调**的 —— 放那儿会变成
		//   「按住不放时每帧重新打开一次卡片」，白白刷 DOM
		//
		// ⚠ 点空白处要关掉卡片，所以这里**无论命不命中都要 return**，
		//   不能落到下面的 mouseDown = true ——
		//   那会让查看工具的每次点击都变成「按住使用工具」，
		//   而查看工具没有按住时要做的事
		if (this.view.tool === 'inspect') {
			this.openInspect(this._inspectableAt())
			return
		}

		this.mouseDown = true
		// 抹布的「按住了但没动」计时，每次按下重新开始
		this.clothDownAt = performance.now()
		this.clothHinted = false
		this.wipeScrub = 0
		this._useTool()
	}

	// ---------------------------------------------------------- 拖动食物 / 玻璃罐

	/** 指针底下有没有能拎起来的食物。多个重叠时取最近的一个 */
	_foodAt(x, y) {
		let best = null
		let bestD = Infinity
		for (const f of this.world.foods) {
			if (f.dead) continue
			// 判定半径跟着食物大小走，再放宽一点，手感松一些
			const r = f.size * 0.6 + CONFIG.food.grabPad
			const d = Math.hypot(f.x - x, f.y - y)
			if (d <= r && d < bestD) {
				bestD = d
				best = f
			}
		}
		return best
	}

	/** 指针底下有没有能拎起来的玻璃罐 */
	_jarAt(x, y) {
		let best = null
		let bestD = Infinity
		for (const j of this.world.jars) {
			if (j.dead) continue

			// 罐子是矩形，判定就是「点有没有落在框里」——
			// 不能像食物那样比距离，否则罐子四角外面一大圈也会被误判成命中
			const dx = Math.abs(x - j.x)
			const dy = Math.abs(y - j.y)
			if (dx > j.halfW || dy > j.halfH) continue

			// 多个罐子重叠时取中心最近的那个
			const d = dx * dx + dy * dy
			if (d < bestD) {
				bestD = d
				best = j
			}
		}
		return best
	}

	/** 指针底下有没有能拎起来的蛹壳 */
	_shellAt(x, y) {
		let best = null
		let bestD = Infinity
		for (const sh of this.world.shells) {
			if (sh.dead) continue
			// 壳是细长的米粒，判定按外接椭圆算 —— 圆形判定会有两个够不到的角。
			// 半轴直接问 Shell.radii，和画出来的那一个用同一套公式；
			// 各边再放宽 5px —— 壳本身就小，而且塌陷还会往里凹，
			// 严格贴着轮廓判会变得很难点到。宁可放宽一点，别让人抓不住
			const { pl: rl, pw: rw } = sh.radii
			const pl = rl + 5
			const pw = rw + 5
			const dx = x - sh.x
			const dy = y - sh.y
			// 转到壳自己的坐标系里再判椭圆
			const c = Math.cos(-sh.angle)
			const sn = Math.sin(-sh.angle)
			const lx = dx * c - dy * sn
			const ly = dx * sn + dy * c
			const e = (lx * lx) / (pl * pl) + (ly * ly) / (pw * pw)
			if (e > 1) continue
			const d = dx * dx + dy * dy
			if (d < bestD) {
				bestD = d
				best = sh
			}
		}
		return best
	}

	/**
	 * 指针底下能拎起来的东西。
	 *
	 * **玻璃罐是个例外：它不要求戴手套。** 观察模式下直接就能拖。
	 * 理由是这个方法同时也是 _updateInteractive 的判据（见 _overGrabbable）——
	 * 而观察模式的窗口是鼠标穿透的，「先悬停接管、才谈得上收到按下」是
	 * Electron 下唯一的通路，所以要放开拖动就必须连接管一起放开。
	 * 那就要挑一个「接管起来最不心疼」的东西：
	 *
	 *   - 罐子**大**（194×246）、**静止**、**数量少**（最多 4 个），
	 *     而且是玩家自己摆的，通常摆在他不常点的地方
	 *   - 食物 / 蛹壳 / 成虫都不行：它们小、数量多，成虫还满屏乱飞，
	 *     一旦在观察模式放开，整块屏幕会被几十个判定区打成筛子
	 *
	 * 其余的一律**只有戴着手套才能拖**，想动手就先切手套。
	 *
	 * 罐子先判：它比食物大一圈，两者重叠时玩家想拎的显然是罐子 ——
	 * 而且罐子可能是压在食物上的，只判食物的话那个罐子就再也拖不动了。
	 *
	 * **成虫最后判**，而且判定半径给得比别的物件大 —— 它一直在飞，
	 * 判定苛刻就没法玩了。放最后也是因为这个：成虫满屏都是，
	 * 先判它的话，压在果蝇底下的罐子和食物就再也拎不起来了。
	 *
	 * @returns {{item:object, kind:'food'|'jar'|'shell'|'fly'}|null}
	 */
	_grabbableAt() {
		const m = this.view.mouse

		// ⚠ 罐子判定必须在下面那道手套闸门**之前**，这是「观察模式也能拖罐子」的全部实现。
		// 位置一挪，功能就没了 —— 而症状只是「拖不动」，不会有任何报错
		//
		// ⚠⚠ 但它**必须带工具条件**，这曾经是个真实的 bug：
		//   早先这一条什么工具都放行，于是拿着**任何**工具（连苍蝇拍都算）
		//   点在罐子上都是「拖罐子」。两个后果：
		//     · 罐子压在虫子上时，虫子永远点不开 —— 罐子先返回了，压根轮不到查看
		//     · 拿着拍子点罐子是拖罐子，而不是挥拍
		//   限定成「观察模式 + 手套」之后两条一起好了。
		//   而这两档**都要留着** —— 观察模式能拖罐子是特意做的功能（见上面的文档），
		//   手套是通用拖动工具，删掉哪个都会少一条路
		const canGrabJar = this.view.tool === 'none' || this.view.tool === 'glove'
		if (canGrabJar) {
			const jar = this._jarAt(m.x, m.y)
			if (jar) return { item: jar, kind: 'jar' }
		}

		if (this.view.tool !== 'glove') return null

		// 烤炉排在食物之前：它比食物大一圈，两者重叠时玩家想拎的是炉子
		const oven = this._ovenAt(m.x, m.y)
		if (oven) return { item: oven, kind: 'oven' }

		const food = this._foodAt(m.x, m.y)
		if (food) return { item: food, kind: 'food' }

		const shell = this._shellAt(m.x, m.y)
		if (shell) return { item: shell, kind: 'shell' }

		// 烤串排在成虫之前，理由和罐子一样：它静止、个头不小，
		// 而成虫满屏乱飞，先判成虫的话压在烤串上的那只永远拎不到烤串
		// 尸体排在成虫之前：它静止、个头不小，而成虫满屏乱飞 ——
		// 先判成虫的话，压在某具尸体上的那只永远拎不到尸体
		const corpse = this._corpseAt(m.x, m.y)
		if (corpse) return { item: corpse, kind: 'corpse' }

		const fly = this._flyAt(m.x, m.y, CONFIG.tools.grabFlyRadius)
		if (fly) return { item: fly, kind: 'fly' }

		return null
	}

	/**
	 * 指针底下的烤炉。矩形判定，和罐子同一套（取中心最近的那个）。
	 *
	 * ⚠ 只有**戴手套**才拖得动 —— 观察模式放开的只有玻璃罐那一种，
	 * 原因见 _grabbableAt 的文档
	 */
	_ovenAt(x, y) {
		let best = null
		let bestD = Infinity
		for (const o of this.world.ovens) {
			if (o.dead) continue
			const dx = Math.abs(x - o.x)
			const dy = Math.abs(y - o.y)
			if (dx > o.halfW || dy > o.halfH) continue
			const d = dx * dx + dy * dy
			if (d >= bestD) continue
			best = o
			bestD = d
		}
		return best
	}

	/**
	 * 指针底下**能烤的尸体**。
	 *
	 * ⚠ 只挑 corpse，而且只挑 value > 0 的（`roastable`）——
	 * 汁渍是拍击溅出来的，没有价钱，烤它没有意义，也不该让指针
	 * 在满地汁渍时一直「抓到东西」。
	 *
	 * 判定半径按果蝇体型走，给一个下限：小只果蝇的尸体很小，
	 * 纯按 size 算的话几乎点不到。
	 */
	_corpseAt(x, y) {
		let best = null
		let bestD = Infinity
		for (const r of this.world.remains) {
			// ⚠ 判的是 kind 而不是 `r.sellable`：戴手套能拖的是**所有**尸体，
			//   包括值 0 的那种（虽然正常玩法里生不出来）。`sellable` 还要求
			//   value > 0，拿它当判据会让一部分尸体突然拖不动
			if (r.dead || r.kind !== 'corpse') continue
			const rad = Math.max(12, r.size * 0.95)
			const d = dist2(x, y, r.x, r.y)
			if (d > rad * rad || d >= bestD) continue
			best = r
			bestD = d
		}
		return best
	}

	/**
	 * 指针底下的成虫。
	 *
	 * 只找 `world.flies`（屏幕上自由飞行的）—— 罐里的果蝇坐标是相对罐心的，
	 * 要另外换算，而且它们已经在「罐中果蝇」列表里有了自己的 UI。
	 * 拿罐里的果蝇去卖，得先放逐出来。
	 *
	 * @param {number} radius 判定半径。悬停检视用小值、戴手套抓用大值
	 */
	_flyAt(x, y, radius) {
		let best = null
		let bestD = radius * radius
		for (const f of this.world.flies) {
			if (f.dead) continue
			const d = dist2(x, y, f.x, f.y)
			if (d <= bestD) {
				bestD = d
				best = f
			}
		}
		return best
	}

	_dragTo() {
		const it = this.drag
		// 拖到一半被幼虫啃光了（食物）或者被别的途径销毁了，收手
		if (!it || it.dead) {
			this._cancelDrag()
			return
		}

		// ⚠ 被拎着的成虫必须**每帧清零速度**。
		//
		// 位置是每帧钉住的（见 update 里为什么），但果蝇自己还会继续积分速度 ——
		// 不清的话，松手那一瞬间它会带着「被拖行时攒下的惯性」窜出去，
		// 看起来像被甩出去的。清零之后松手就是原地起飞，符合直觉
		if (this.dragKind === 'fly') {
			it.vx = 0
			it.vy = 0
		}

		// 夹在屏幕内，别拖出去找不回来。
		// 留的余量按物件大小走，而且罐子横竖不一样 —— 用食物那个 14px 的话，
		// 能把它大半个拖到屏幕外，只露出一条边。蛹壳很小，14px 就够。
		//
		// ⚠ 罐子上边要留 topHalfH（罐身 + 盖子），不是 halfH ——
		// 盖子坐在罐身上沿之上，按 halfH 夹的话拖到最上面时盖子会露到屏幕外
		// 罐子和烤炉都按半宽 / 半高夹（两个都是矩形），其余一律 14px。
		// 烤炉没有盖子，所以上下都用 halfH，不像罐子要用 topHalfH
		const isJar = this.dragKind === 'jar'
		const isOven = this.dragKind === 'oven'
		const mx = isJar ? it.halfW : isOven ? it.halfW : 14
		const myTop = isJar ? it.topHalfH : isOven ? it.halfH : 14
		const myBottom = isJar ? it.halfH : isOven ? it.halfH : 14
		const tx = clamp(this.view.mouse.x + this.dragOffset.x, mx, Math.max(mx, this.world.w - mx))
		const ty = clamp(
			this.view.mouse.y + this.dragOffset.y,
			myTop,
			Math.max(myTop, this.world.h - myBottom),
		)

		// 石化蝇拖起来**沉**：不直接吸附到指针，而是朝目标做阻尼插值，
		// 于是它总是「被拽着、慢半拍地跟上来」。
		//
		// ⚠ 原话是「鼠标速度会强行变慢」。**那做不到** ——
		//   我们只能控制这个窗口里画什么，改不了操作系统的光标速度，
		//   真去劫持光标（setPosition）会把它变成一块不受控的砖头。
		//   所以落点改成「被拖的虫落后于指针」：手感上是同一件事
		//   （拽一块石头走），而且完全是窗口内部的、可逆的。
		//
		// ⚠ 用固定的每帧插值系数而不是按 dt 积分：这个方法在
		//   update() 和 mousemove 里**都**会被调，一帧可能调两次，
		//   按 dt 算的话快慢会和帧率 / 鼠标采样率绑在一起。
		//   按帧插值虽然也不精确，但至少是稳定的、可预期的
		if (this.dragKind === 'fly' && it.hasMutation && it.hasMutation('stone')) {
			const k = CONFIG.tools.stoneDragFollow
			it.x += (tx - it.x) * k
			it.y += (ty - it.y) * k
		} else {
			it.x = tx
			it.y = ty
		}

		// 两个投放区各自高亮：垃圾桶收物件、出售区收果蝇。
		// 拖错了的那一边压暗 —— 光靠文字提示不够，松手前得能看出来
		const inTrash = this._pointInTrash(this.view.mouse)
		const inSell = this._pointInSell(this.view.mouse)
		const isFly = this.dragKind === 'fly'
		// 出售区**收成虫也收尸体**（尸体就是「死了但还值钱的果蝇」，
		// 烤过的更值钱）。
		// ⚠ 这个布尔同时喂给高亮和 _endDrag 的结算，两处必须一致 ——
		// 只改一处的话，会出现「拖过去亮了、松手却没卖出去」
		const sellable = isFly || this.dragKind === 'corpse'
		this._setTrashHot(inTrash && !isFly && !sellable)
		this._setSellHot(inSell && sellable, !sellable)

		// 拎着成虫压在罐子上时把那个罐子点亮。
		// 没有这个提示的话，「能不能放进去」全靠松手试一次 ——
		// 而试错的代价是那只稀有的蝇又被扔回屏幕上飞走了。
		// 优先级和 _endDrag 保持一致：投放区亮着的时候不算瞄准罐子
		const overJar = isFly && !inSell && !inTrash ? this._jarAt(this.view.mouse.x, this.view.mouse.y) : null
		const overOven =
			isFly && !inSell && !inTrash ? this._ovenAt(this.view.mouse.x, this.view.mouse.y) : null
		this.view.dropJar = overJar
		// 烤炉用的是**另一个**高亮位：同一时刻只有一种是「松手会发生的事」，
		// 两个都亮会让玩家以为两件事都会发生
		this.view.dropOven = overJar ? null : overOven
	}

	/**
	 * 松手：落在投放区上就结算，否则就地放下。
	 *
	 * 两个区**收的东西不一样**：垃圾桶销毁物件（食物 / 罐子 / 蛹壳 / 烤炉），
	 * 出售区收**成虫和烤串**。成虫扔进垃圾桶不算数 —— 那是「放走」，不是「销毁」。
	 *
	 * ⚠ `sellable` 这个布尔必须和 _dragTo 里那个**完全一致**，
	 * 两边不一致的症状是「拖过去亮了、松手却没卖出去」
	 *
	 * @returns {boolean} 是否吃掉了这次松手
	 */
	_endDrag() {
		if (!this.drag) return false

		const it = this.drag
		const kind = this.dragKind
		const isFly = kind === 'fly'
		const sellable = isFly || kind === 'corpse'
		const intoTrash = !sellable && this._pointInTrash(this.view.mouse)
		const intoSell = sellable && this._pointInSell(this.view.mouse)
		// 罐子 / 烤炉**排在垃圾桶 / 出售区之后**：那两个是画在工具栏上的投放区，
		// 悬停时会高亮，玩家瞄的就是它们。罐子只是画布上的一个物体，
		// 万一压在投放区底下，优先判投放区才不会出现
		// 「出售区亮着，松手却进了罐子」这种对不上的反馈
		const intoJar = isFly && !intoSell && !intoTrash ? this._jarAt(this.view.mouse.x, this.view.mouse.y) : null
		const intoOven =
			isFly && !intoSell && !intoTrash && !intoJar
				? this._ovenAt(this.view.mouse.x, this.view.mouse.y)
				: null
		this._cancelDrag()

		if (intoSell) {
			const gain = this.world.sellFly(it)
			this._flashHint(`卖掉了，+${formatMoney(gain)}`)
			this.refreshStats()
		} else if (intoTrash) {
			if (kind === 'jar') this.world.discardJar(it)
			else if (kind === 'shell') this.world.discardShell(it)
			else if (kind === 'oven') this.world.discardOven(it)
			else this.world.discardFood(it)
		} else if (intoOven) {
			if (this.world.putInOven(intoOven, it)) {
				this._flashHint(intoOven.roasting ? '烤炉装满了，开始烤' : '放进烤炉了')
				this.refreshStats()
			} else {
				this._flashHint(intoOven.roasting ? '这个烤炉正在烤' : '这个烤炉满了')
			}
		} else if (intoJar) {
			// 手套拖成虫进罐子。
			//
			// ⚠ 这条路径以前**根本不存在** —— 罐子一直只能靠捕虫网（N）进蝇，
			// 而网是按半径一网打尽的，没法「只留下那一只稀有的」。
			// 存稀有品种靠网是碰运气，靠手套才是精确操作，所以必须补上。
			//
			// 顺带一提，这条路径和 world.paused 无关：拖拽全程走的是 UI，
			// 时停时照样能拖（_dragTo 每帧把被拖的那只钉在指针上）。
			if (this.world.putInJar(intoJar, it)) {
				this._flashHint('装进罐子了')
				this.refreshStats()
			} else {
				this._flashHint('这个罐子满了')
			}
		}

		this._updateInteractive()
		return true
	}

	_cancelDrag() {
		if (!this.drag) return
		this.drag = null
		this.dragKind = null
		document.body.classList.remove('dragging-food')
		this._setTrashHot(false)
		this._setSellHot(false, false)
		this.view.dropJar = null
		this.view.dropOven = null
		// ⚠ 必须重算。_cancelDrag 有一条调用路径是「拖到一半被拖的东西死了」
		// 和「窗口失焦」，那两条后面**没有** _updateInteractive() ——
		// 不补的话 drag 已经清了、interactive 还停在 true，
		// 窗口会继续吞桌面点击，直到鼠标再动一下为止
		this._updateInteractive()
	}

	_pointInTrash(p) {
		const r = this.el.trash.getBoundingClientRect()
		return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
	}

	_pointInSell(p) {
		const r = this.el.sell.getBoundingClientRect()
		return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
	}

	_setTrashHot(on) {
		this.el.trash.classList.toggle('hot', on)
	}

	/** @param {boolean} reject 拖的是不能卖的东西时压暗，明确表示这里不收 */
	_setSellHot(on, reject) {
		this.el.sell.classList.toggle('hot', on)
		this.el.sell.classList.toggle('reject', reject)
	}

	/** 执行一次当前工具的动作（带冷却） */
	_useTool() {
		const m = this.view.mouse

		// 手套没有「点一下」的动作 —— 它只在按住拖动时起作用（见 _onDown）。
		// 放在这里显式返回，好过让它掉到下面的分支里去
		if (this.view.tool === 'glove') return

		if (this.view.tool === 'swatter') {
			const now = performance.now()
			if (now - this.lastSwat < CONFIG.tools.swatCooldown) return
			this.lastSwat = now
			// ⚠ 打的是**拍面**那一点，不是指针。拍子斜着拿，拍面在指针左上方 ——
			// 直接传 m.x / m.y 的话，虚线圈画在拍面上、杀伤却落在指针上，
			// 表现就是「明明拍中了却没死」。和渲染共用 swatterHeadAt()
			const head = swatterHeadAt(m.x, m.y)
			this.world.swat(head.x, head.y)
			return
		}

		if (this.view.tool === 'net') {
			// setTool 已经拦过一道，这里再拦一次是防「拿着网的时候点重置」——
			// reset() 会把已购道具清空，但**不会**动 view.tool，
			// 于是手里还攥着一张已经不该存在的网
			if (!this.world.hasShopItem('net')) {
				this.setTool('none')
				this._flashHint('捕虫网被重置掉了，要重新买')
				return
			}
			const now = performance.now()
			if (now - this.lastNet < CONFIG.tools.netCooldown) return
			this.lastNet = now

			const caught = this.world.catchFlies(m.x, m.y)
			// 一只都没网到时给个明确反馈。最常见的两种原因是「没放罐子」和
			// 「罐子全满了」，但玩家看到的现象都是「点了没反应」——
			// 不提示的话根本不知道要去点「玻璃罐」
			if (caught === 0) this._flashHint(this.world.jars.length === 0 ? '先摆一个玻璃罐' : '罐子满了，或者附近没有成虫')
			return
		}

		// 点火（打火机 / 喷火枪）：**碰到活蝇就点着**。
		//
		// 从 1.18.0 起这两把烧的是**活着的成虫**，不再是地上的尸体。
		// 点着之后它带着火焰惊慌乱飞，烧满 burnMs 秒后自动按倍率卖掉
		// （见 world._updateBurning）。
		//
		// 这里是**接触就点着**，不是「按住 N 秒」。按住扫过去一片就全点着了，
		// 因为 _useTool 在按住时每帧都跑。
		//
		// ⚠ 「每只只吃一次倍率」这条守卫**不在**这里，在 `world.ignite` 里
		//   （`fly.burning` 判重）。放这一层的话，按着不放来回蹭同一只
		//   会把倒计时反复重置回满 —— 表现是「怎么烧都烧不完」，
		//   而且那种 bug 极难归因。别把判重移上来
		if (this.view.tool === 'lighter' || this.view.tool === 'flamer') {
			// ⚠ 半径**按手里这一把**取（喷火枪大一圈），不写死在 CONFIG.roast 里 ——
			//   见 world.burnRadiusFor 那段注释。
			//   仍然是**单目标**：只点着半径内最近的那一只。
			//   想改成「圈里全点着」，把这一行换成遍历 world.flies 收集再逐个 ignite，
			//   但那样喷火枪会变成清屏工具，得连倍率一起重调
			const f = this._flyAt(m.x, m.y, this.world.burnRadiusFor(this.view.tool))
			// ⚠ 把**手里这一把**传进去。传「当前最高档」的话，
			//   买了喷火枪之后回头拿打火机，点出来的还是 3 秒 ×1.5
			if (f) this.world.ignite(f, this.view.tool)
			// 点着那一下的反馈是**火焰粒子**（ignite 里直接撒了一把），
			// 所以这里不再闪提示条 —— 满屏点火时提示条会被刷成一片
			return
		}

		// 喷水枪：**按住左键才喷**，水线扫过的可清洁物直接消失。
		//
		// ⚠ 和烤制同一套「按住才生效」。不按住就一直生效的话，鼠标扫过屏幕
		//   就是一片清空 —— 而这是一把会**永久销毁**东西的工具（冲掉的尸体
		//   不给钱、不留痕），太容易误伤
		//
		// ⚠ 水线以**指针为中心向两头**伸，所以两端点是 ±len/2，
		//   判定整段（见 world.squirt 里那个投影）
		if (this.view.tool === 'squirt') {
			const s = this.view.squirt
			const half = s.len / 2
			const dx = Math.cos(s.angle) * half
			const dy = Math.sin(s.angle) * half
			const cleaned = this.world.squirt(m.x - dx, m.y - dy, m.x + dx, m.y + dy)
			if (cleaned > 0) this.refreshStats()
			return
		}

		// 扫帚：**按住左键才扫**。
		//
		// ⚠ 和抹布 / 喷水枪同一套「按住才生效」，理由更强一点：
		//   扫帚不销毁任何东西，但它会把幼虫**赶得到处都是** ——
		//   划过屏幕就一路推的话，想「把这一坨赶到那边去」反而做不到，
		//   因为鼠标从工具栏移到目标的一路上已经把沿途的全推飞了
		//
		// ⚠ 半径从 view 读，不在 world 里存。滚轮是**松开鼠标时**调的，
		//   而 view 是纯表现层状态（不进存档）—— 半径本来就不该被存档，
		//   重开一局回到 radiusStart 才对
		if (this.view.tool === 'broom') {
			this.world.broom(m.x, m.y, this.view.broom.r)
			return
		}

		if (this.view.tool === 'cloth') {
			// 攒下来的路程交出去，然后清零 —— 没动过就是 0，
			// world.wipe 收到 0 什么也不会做
			const scrub = this.wipeScrub
			this.wipeScrub = 0
			this.world.wipe(m.x, m.y, scrub)
			// 这一帧真的擦到了没有。给水渍粒子用（见 _updateToolFx）——
			// 它跑在本函数**之后**，那时 wipeScrub 已经清零了
			this.clothScrubbed = scrub > 0

			// 「按住不动擦不掉」是这个机制里唯一会让人以为抹布坏了的地方，
			// 所以按住一小会儿还没滑动过就提示一次（每次按下只提示一次）。
			// 不做成常驻的一行字 —— 面板本来就窄，为一条一次性提示占一行不划算
			const now = performance.now()
			// 注意这里**不会**把 mouseDown 置回 false：玩家可能只是先按住了，
			// 提示完接着滑动，就该照常擦 —— 中途把按住状态清掉等于让他重按一次
			if (!this.clothHinted && scrub < 1 && now - this.clothDownAt > 700) {
				this.clothHinted = true
				this._flashHint('抹布要按住来回滑动才擦得掉')
			}
		}
	}

	/**
	 * 在提示条上闪一句话，两秒后自动恢复。
	 * 网不到东西时用 —— 工具类的操作没有别的反馈渠道。
	 */
	_flashHint(text) {
		// ⚠ 写的是 #hint-text 而不是 #hint —— 提示条那一行里还钉着捐款按钮，
		// 写到外层会把按钮一起抹掉（按钮不是文字，textContent 一赋就没了）
		if (!this.hintText) this.hintText = this.el.hintText.textContent

		// 同一句话正在显示就什么都不做。
		//
		// ⚠ 这不是省事，是必需的：_useTool 在**按住时每帧都跑**，
		//   而接触即烤之下指针会一直压在同一具尸体上。没有这道去重的话，
		//   那句话会被一秒重写 60 次（顺带把 2 秒的计时器一直顶回去，
		//   于是提示条卡死在那句话上，永远不恢复）
		if (this.el.hint.classList.contains('alert') && this.el.hintText.textContent === text) return

		clearTimeout(this.hintTimer)
		this.el.hintText.textContent = text
		this.el.hint.classList.add('alert')
		this.hintTimer = setTimeout(() => {
			this.el.hintText.textContent = this.hintText
			this.el.hint.classList.remove('alert')
		}, 2000)
	}

	/**
	 * 决定现在要不要让窗口接管鼠标。
	 * 状态没变就不发 IPC —— 这个方法每帧都会被 mousemove 调用，别刷爆主进程。
	 */
	_updateInteractive() {
		// 七条要接管鼠标的情况：手里有工具、指针压在工具栏上、正拎着东西、
		// 启动选择框开着、指针压在**居中小卡**（捐款 / 设置 / 重置确认）或
		// 罐中果蝇小窗上、以及**观察模式下指针压在玻璃罐上**（_overGrabbable）。
		//
		// ⚠ 最后那条是「观察模式也能拖罐子」的另一半。窗口穿透时只有 mousemove
		// 会被转发进来（见 main.js 的 setIgnoreMouseEvents forward:true），
		// 所以**必须先接管，才谈得上收到按下** —— 没有这条，罐子拖不动，
		// 而且不会有任何报错，只是「按住没反应」。
		//
		// 这条以前是被刻意省掉的（「能拖东西的前提是戴着手套」），
		// 现在手套不再是前提了，所以必须显式加回来。
		// 好在 _grabbableAt 在非手套模式下只放行玻璃罐 —— 接管面就是那 4 个罐子。
		//
		// ⚠ 捐款卡片 / 罐中果蝇小窗 / 玻璃罐走的都是**命中判定**而不是
		// 「开着就接管」—— 它们只是屏幕上的一块区域，不是模态，
		// 没必要开着就吃掉整块屏幕的点击。
		// 这几条互不排斥，重叠时也不会彼此盖掉 ——
		// 不管是哪一个先返回 true，结论都是「接管鼠标」
		// ⚠ 检视卡片**本身**不在这个列表里，它必须始终穿透（pointer-events: none）。
		// 但「指针底下有只能点开的虫」是**另一条**谓词（_inspectableAt），
		// 它要进列表 —— 否则观察模式下根本收不到那一下点击。
		// 两者的区别写在这里免得被后来的人合并掉：
		//   _overInspectable() —— 一块**会吞点击**的判定区（很小，随虫移动）
		//   卡片本体          —— 纯显示，永不接管
		const overGrabbable = this._overGrabbable()
		const overInspectable = this._overInspectable()
		const need =
			// ⚠ 这里**原来还有一条 `this.view.tool !== 'none'`** —— 「只要手里拿着工具，
			//   整扇窗口就接管鼠标」。它被删掉了，因为「穿透」现在才是那个主开关：
			//
			//     穿透开（默认）→ 只有指针压在下面这些 UI 上才接管，画布一律穿透。
			//                     手里拿什么工具都能正常点桌面上任何地方
			//     穿透关         → main.js 那句 `passThrough = clickThroughEnabled && …`
			//                     恒为 false，整扇窗口接管鼠标，工具照常能用
			//
			//   代价：穿透开着时工具是「按不动」的（点画布会点到桌面）。这不是漏掉了 ——
			//   是这套开关的必然结果。玩家选中工具那一刻会闪一句提示告诉他去关穿透，
			//   见 setTool()
			this._overPanel() ||
			this._overHandle() ||
			overGrabbable ||
			overInspectable ||
			this.drag !== null ||
			!!this.view.bootOpen ||
			this._overCard() ||
			this._overJarWindow()

		// 观察模式悬停罐子时给个手型。**必须让玩家看得见** ——
		// 这块区域现在会吞掉桌面点击，没有任何提示的话，那一下点击
		// 会显得莫名其妙。
		// `!this.drag` 是必需的：拖动中要靠 body.dragging-food 给 grabbing，
		// 两条规则特异性相同，不加这个条件会互相打架
		document.body.classList.toggle(
			'over-grabbable',
			overGrabbable && this.view.tool === 'none' && this.drag === null,
		)
		// 同理，能点开数据面板的虫也给个手型
		document.body.classList.toggle(
			'over-inspectable',
			overInspectable && this.drag === null,
		)

		if (need === this.interactive) return
		this.interactive = need
		window.pet?.setInteractive(need)
	}

	/**
	 * 指针底下有没有「点得开数据面板」的虫。
	 *
	 * 只在**拿着查看工具**时才有意义 —— 别的时候点击是「用那个工具」，
	 * 或者是「纯看不打扰」，都不是查看。
	 *
	 * ⚠ 这里以前判的是 `tool === 'none'`（观察模式点一下弹面板）。
	 *   改成专用工具之后，**吞桌面点击**这个代价就没有了 ——
	 *   拿着查看工具时整块屏幕本来就是你的操作区，和拿拍子时一样。
	 *   所以 `_creatureAt` 里那条「只接管不飞的」限制也一并去掉了（见那边）。
	 *
	 * ⚠ 这里**不加 ±4px 的图手感外扩**（别的地方都有）。
	 *   外扩多少就多吞多少桌面点击，而虫本来就在动，判定已经够宽松了。
	 */
	_inspectableAt(x, y) {
		if (this.view.tool !== 'inspect') {
			this.inspectHover = false
			return null
		}
		const m = x === undefined ? this.view.mouse : { x, y }
		// 迟滞：已经在圈里了就用大一圈的半径判定，直到虫真的走远才松手。
		// 没有这一条的话，虫在半径边界上挪动会让窗口的穿透状态每帧翻转
		const r = this.inspectHover ? CONFIG.tools.inspectReleaseRadius : CONFIG.tools.hoverRadius
		const hit = this._creatureAt(m.x, m.y, r)
		this.inspectHover = hit !== null
		return hit
	}

	_overInspectable() {
		return this._inspectableAt() !== null
	}

	/**
	 * 指针底下能查看的活物：**只有成虫**。
	 *
	 * ⚠ 幼虫**故意不认** —— 这是用户定的：蛆满屏都是（上限 45 只，
	 *   烦人模式还要 ×50），点一下弹一张卡片出来会把屏幕糊满。
	 *   而且卡片上能填的东西，幼虫基本都没有：不卖钱、没有体格
	 *   （`rarity` 是羽化那一刻才抽的）、成长和体重对它也没意义。
	 *   所以幼虫那条路是从根上删掉的，不是「藏起来」——
	 *   别哪天觉得漏了又把它加回来
	 *
	 * ⚠ 这里**曾经**只认「不在飞的」成虫（`f.mode !== 'fly'`）。
	 *   那条限制是为观察模式加的：当时查看的判定区和桌面共用点击，
	 *   果蝇满屏飞，指针扫过任何一只都会吃掉那一下桌面点击。
	 *   换成专用查看工具之后这个理由不成立了 —— 拿着工具时整块屏幕
	 *   本来就是操作区（和拿拍子、拿网一样），所以**飞行中的也能点**。
	 *   用户明确要的就是这个：追着飞虫点得开
	 */
	/**
	 * ⚠ **罐子里的也能点开。**
	 *   罐中果蝇的 x / y 是**相对罐心的偏移**，不是屏幕坐标 ——
	 *   这里要加上 jar.x / jar.y 才是它真正画在哪儿（和 magnifierTargets
	 *   同一个换算，漏了的话表现为「指在虫身上却点不开」）。
	 *
	 * ⚠ **烤箱里的依然不认**：炉子是「正在加工」的中间态，里面那几只
	 *   既不参与生态也马上要被卖掉，弹卡片没有意义。这是**刻意**的，
	 *   不是漏了 —— 真要加，照下面第二段循环再补一段即可
	 */
	_creatureAt(x, y, radius) {
		let best = null
		let bestD = radius * radius

		const consider = (f, fx, fy) => {
			if (f.dead) return
			const d = dist2(x, y, fx, fy)
			if (d <= bestD) {
				bestD = d
				best = f
			}
		}
		for (const f of this.world.flies) consider(f, f.x, f.y)
		for (const jar of this.world.jars) {
			for (const f of jar.flies) consider(f, jar.x + f.x, jar.y + f.y)
		}
		return best
	}

	/**
	 * 启动选择框开 / 关时调用。
	 *
	 * 必须显式把鼠标接管过来：窗口默认是穿透的，而启动那一刻指针通常
	 * 停在屏幕中间、既不在工具栏上也不在食物上，_updateInteractive 靠
	 * 悬停判定永远不会认为是 true —— 结果就是「继续 / 重新开始」
	 * 两个按钮看着在那儿，点下去却穿到桌面上去了。
	 */
	setBootOpen(open) {
		this.view.bootOpen = !!open
		this._updateInteractive()
	}

	/**
	 * 捐款卡片开 / 关。
	 *
	 * ⚠ 和悬停卡片、食物投放区**正好相反**：那两个必须保持穿透，这一个必须能点。
	 * 但和启动选择框那种模态也不同 —— 它只是屏幕正中一张小卡，
	 * 所以接管鼠标的范围**仅限卡片自己**（见 _overDonate），不是整块屏幕。
	 *
	 * 位置全在 CSS 里（50% / 50% + translate），这里**不碰 left / top**。
	 */
	setDonateOpen(open) {
		const on = !!open
		if (on === this.view.donateOpen) return
		this.view.donateOpen = on
		this.el.donatePop.classList.toggle('hidden', !on)
		this._updateInteractive()
	}

	// ---------------------------------------------------------- 彩蛋

	/**
	 * 捐款罐子被点了一下。够 tapsToUnlock 下就解锁星空苹果。
	 *
	 * ⚠ 已经解锁之后直接返回：**不解锁了还继续数**，否则每点十下就重放一次星尘，
	 *   罐子会变成一个「点着玩」的按钮，彩蛋变成噪声
	 */
	_tapDonate() {
		if (this._starUnlocked) return
		this.starTaps++

		// 一缩一放的反馈。**不给任何文字** ——
		// 弹一句「已点 3/10」就等于把彩蛋写在脸上，前九下的乐趣全没了
		const btn = this.el.btnDonate
		if (btn) {
			btn.classList.remove('tap')
			// ⚠ 读一次布局把重排逼出来。不读的话，同一个元素连着两次点击
			//   class 没变化 → 动画不会重放，表现是「第二下没反应」
			void btn.offsetWidth
			btn.classList.add('tap')
		}

		if (this.starTaps >= CONFIG.easterEgg.tapsToUnlock) this.setStarUnlocked(true)
	}

	/** 星空苹果解没解锁。**请一律读这个**，不要去翻 world.settings / unlock.json */
	get starUnlocked() {
		return !!this._starUnlocked
	}

	/**
	 * 设置解锁状态。
	 *
	 * @param {boolean} on
	 * @param {{silent?: boolean}} [opt] silent：启动时按已存的状态恢复，**不放星尘** ——
	 *   开程序的一瞬间屏幕边上闪一下星空，玩家会以为点到了什么
	 */
	setStarUnlocked(on, opt = {}) {
		const v = !!on
		if (v === this._starUnlocked) return
		this._starUnlocked = v

		// 落盘（单独一个小文件，跨得过「重新开始」）。
		// ⚠ 不写进 world.settings：那个虽然扛得住「重置」，
		//   但「重新开始」会把整个存档文件删掉（save.js 里 clear()），
		//   彩蛋会跟着一起没 —— 而用户要的是「永久解锁」
		try {
			window.pet?.saveUnlock?.({ star: v })
		} catch (e) {
			console.error('[unlock] 写解锁状态失败:', e)
		}

		// 罐子的流光配色。⚠ 默认态写在 index.html 的 class="donate locked" 上，
		// 不是启动时由 JS 补 —— 补的话读到状态之前那一两帧罐子是金色的，
		// 正好是「未解锁应当是蓝紫」的反面
		this.el.btnDonate?.classList.toggle('locked', !v)

		// 投放面板和图鉴都是**整块重建**的，重建一次就跟着变了
		this.refreshFeed()
		if (this.view.codexOpen) this.refreshCodex()

		if (opt.silent) return
		this._playStarfield()
		this._flashHint(v ? '罐子亮回了金色 —— 投放里多了一样东西' : '')
	}

	/**
	 * 放一遍解锁星尘（屏幕四周，10 秒淡入淡出）。
	 *
	 * ⚠ 走 class + 强制重排，不能直接改 style.opacity：同一个元素上连着解锁两次时，
	 *   第二次 class 没变化 → 动画不会重放，表现是「第二次解锁屏幕上什么都没有」。
	 *   `void el.offsetWidth` 就是读一次布局、把重排同步逼出来
	 */
	_playStarfield() {
		const el = this.el.starfield
		if (!el) return
		clearTimeout(this.starTimer)
		el.classList.remove('hidden', 'on')
		void el.offsetWidth
		el.classList.add('on')
		// 动画本身 10 秒（见 style.css），这里多留半秒再收，
		// 免得动画最后一帧还没落地就被 display:none 掐掉
		this.starTimer = setTimeout(() => {
			el.classList.add('hidden')
			el.classList.remove('on')
		}, 10500)
	}

	/**
	 * 设置卡片开 / 关。和捐款卡片完全同一套 —— 同样是屏幕正中一张小卡，
	 * 同样**只接管卡片自己**那点面积（见 _overCard）。
	 */
	setSettingsOpen(open) {
		const on = !!open
		if (on === this.view.settingsOpen) return
		this.view.settingsOpen = on
		this.el.settingsPop.classList.toggle('hidden', !on)
		if (on) this.refreshSettings()
		this._updateInteractive()
	}

	/**
	 * 重置确认卡开 / 关。
	 *
	 * ⚠ 这张卡**没有右上角的 ✕** —— 它是个「你确定吗」的岔路口，
	 * 不是一张随便看看的信息卡。想关就明确点「取消」或者按 Esc。
	 * （Esc 那条在 _onKey 里，和捐款 / 设置一起处理）
	 */
	setResetOpen(open) {
		const on = !!open
		if (on === this.view.resetOpen) return
		this.view.resetOpen = on
		this.el.resetPop.classList.toggle('hidden', !on)
		this._updateInteractive()
	}

	/**
	 * 罐子「全部出售」的二次确认卡开 / 关。
	 *
	 * 和重置确认卡同一套（居中、只接管卡片自己那点面积、Esc 能关）。
	 * 打开时**现算一次**罐子里有几只、一共值多少 —— 写在卡上给玩家看清楚
	 * 「我要卖掉的是什么」，而不是一句干巴巴的「确定吗」。
	 *
	 * ⚠ 这里算的钱**只是给玩家看的**。真正结算的是 sellAllInJars()，
	 *   它按每只那一刻的 value 现加 —— 两次读数之间果蝇还在罐里变老变重，
	 *   所以两边的数字允许有一点点出入。别为了「对得上」把价格冻结在这里：
	 *   那样卖掉的就真成了卡片上那个过时的价钱
	 */
	setSellAllOpen(open) {
		const on = !!open
		if (on === this.view.sellAllOpen) return
		this.view.sellAllOpen = on
		if (on) {
			let count = 0
			let worth = 0
			for (const jar of this.world.jars) {
				for (const f of jar.flies) {
					count++
					worth += f.value
				}
			}
			this.el.sellAllBody.textContent = count
				? `罐子里现在有 ${count} 只，一共能换 ${
						formatMoney(Math.round(worth * 1000) / 1000)
					}。卖掉之后它们就回不来了。`
				: '罐子里一只都没有。'
			this.el.sellAllOk.disabled = count === 0
		}
		this.el.sellAllPop.classList.toggle('hidden', !on)
		this._updateInteractive()
	}

	/**
	 * 养蝇人配置卡开 / 关。和设置卡完全同一套 —— 屏幕正中一张小卡，
	 * 只接管卡片自己那点面积（见 _overCard）。
	 *
	 * ⚠ 卡片**必须**加进 _overCard() 的那个数组。漏了的话卡片长得完全正常，
	 *   只是点上去会穿到桌面，关都关不掉，而且不会有任何报错
	 */
	setKeeperOpen(open) {
		const on = !!open
		if (on === this.view.keeperOpen) return
		this.view.keeperOpen = on
		this.el.keeperPop.classList.toggle('hidden', !on)
		if (on) {
			this.refreshKeeperCard()
			// ⚠ 必须先把别的居中小卡关掉。这张卡的入口**就在商店列表里**，
			//   而六张卡全是 left:50% top:50%、位置完全重合；#keeper-pop 在
			//   DOM 里又排在 #shop-pop **前面**，同 z-index 下后出现的画在
			//   上面 —— 商店自己不关的话，玩家看到的是「点了配置，什么都没
			//   发生」，其实卡片已经开了，只是被商店整张盖住
			this._closeCenterCards(this.el.keeperPop)
		}
		this._updateInteractive()
	}

	/**
	 * 投放卡片开 / 关。
	 *
	 * 打开时刷一次列表 —— 钱和已购道具可能在卡片关着的时候变了，
	 * 而 `refreshStats()` 只在**钱变化时**才重建列表（见那边的注释）。
	 * 不刷的话，关着卡片这一段时间里买的东西不会体现在「已拥有」上
	 */
	setFeedOpen(open) {
		const on = !!open
		if (on === this.view.feedOpen) return
		this.view.feedOpen = on
		this.el.feedPop.classList.toggle('hidden', !on)
		if (on) {
			this.refreshFeed()
			this._closeCenterCards(this.el.feedPop)
		}
		this._updateInteractive()
	}

	/** 商店卡片开 / 关。理由同 setFeedOpen */
	setShopOpen(open) {
		const on = !!open
		if (on === this.view.shopOpen) return
		this.view.shopOpen = on
		this.el.shopPop.classList.toggle('hidden', !on)
		if (on) {
			this.refreshShop()
			this._closeCenterCards(this.el.shopPop)
		}
		this._updateInteractive()
	}

	/** 图鉴卡片开 / 关。内容只在打开时渲染一次（它是静态的，不会变） */
	setCodexOpen(open) {
		const on = !!open
		if (on === this.view.codexOpen) return
		this.view.codexOpen = on
		this.el.codexPop.classList.toggle('hidden', !on)
		if (on) {
			this.refreshCodex()
			this._closeCenterCards(this.el.codexPop)
		}
		this._updateInteractive()
	}

	/**
	 * 关掉所有**居中小卡**，只留下 keep 那一张。
	 *
	 * 为什么需要它：这些卡全都是 `left:50% top:50%`，**位置完全重合**。
	 * 只要有两张开着，上面那张会把下面那张盖住，而玩家看到的是
	 * 「点了按钮，弹出来一张别的卡」。
	 *
	 * ⚠ 最容易踩的一对是**商店 → 养蝇人配置**：配置按钮就长在商店列表里，
	 *   点下去如果商店自己不关，两张卡会叠在屏幕正中，而 #keeper-pop 在
	 *   DOM 里排在 #shop-pop **前面** —— 同 z-index 下后出现的画在上面，
	 *   于是商店把养蝇人卡整张盖住，玩家看到的是「点配置没反应」。
	 *   这一对现在由 setKeeperOpen 调用本方法来处理
	 *
	 * ⚠ 重置确认和「全部出售」确认**不在这里关** —— 它们是岔路口，
	 *   必须明确选一边（和 `#panel` 那条「点别处就关」的规矩一致）
	 */
	_closeCenterCards(keep) {
		const all = [
			[this.el.donatePop, this.view.donateOpen, (v) => this.setDonateOpen(v)],
			[this.el.settingsPop, this.view.settingsOpen, (v) => this.setSettingsOpen(v)],
			[this.el.keeperPop, this.view.keeperOpen, (v) => this.setKeeperOpen(v)],
			[this.el.feedPop, this.view.feedOpen, (v) => this.setFeedOpen(v)],
			[this.el.shopPop, this.view.shopOpen, (v) => this.setShopOpen(v)],
			[this.el.codexPop, this.view.codexOpen, (v) => this.setCodexOpen(v)],
		]
		for (const [pop, isOpen, set] of all) {
			if (pop === keep) continue
			if (isOpen) set(false)
		}
	}

	/**
	 * 渲染养蝇人配置卡。
	 *
	 * 选项本身来自 CONFIG.market.keeperOptions（经 market.keeperOptions() 取），
	 * 所以加一档数量、换一组金额都不用动这里 —— 和 refreshShop / refreshFeed
	 * 一样是「按配置渲染」。
	 *
	 * ⚠ 整块重建是可以的：这张卡只在**打开时**和**点选项时**刷新，
	 *   不像罐中列表那样 6.7 Hz 地跑
	 */
	refreshKeeperCard() {
		const O = keeperOptions()
		const K = this.world.keeper
		const lv = this.world.shopLevel('keeper')
		this.el.keeperRows.innerHTML = ''

		const addRow = (label, options, current, attr, enabled, hint) => {
			const row = document.createElement('div')
			row.className = 'keeper-row'

			const lab = document.createElement('span')
			lab.className = 'keeper-label'
			lab.textContent = label

			const opts = document.createElement('div')
			opts.className = 'keeper-opts'
			for (const o of options) {
				const b = document.createElement('button')
				b.className = 'keeper-opt'
				b.dataset[attr] = String(o.value)
				b.textContent = o.label
				const on = String(o.value) === String(current)
				b.classList.toggle('active', on && enabled)
				b.disabled = !enabled
				if (!enabled) b.title = hint
				opts.append(b)
			}

			row.append(lab, opts)
			this.el.keeperRows.append(row)
		}

		// FOOD_NAME 是模块级的那一张（见文件上方）—— 投放提示、投放面板、
		// 图鉴、养蝇人卡片都读它。以前这里另有一份，改一个食物名字要改三处
		// 「卖哪档」的名字取自 **valueTiers**（售价分档），
		// 不是 market.rarity（体重档）。和数据面板上显示的是同一份定义 ——
		// 各抄一份的话迟早会出现「面板写着稀有、这里找不到稀有」
		const TIER_NAME = {}
		for (const t of CONFIG.market.valueTiers) TIER_NAME[t.id] = t.name

		addRow(
			'投什么',
			O.foods.map((f) => ({ value: f, label: FOOD_NAME[f] ?? f })),
			K.food,
			'kFeed',
			true,
		)
		addRow(
			'投几个',
			O.counts.map((n) => ({ value: n, label: String(n) })),
			K.foodN,
			'kN',
			true,
		)

		// 下面四行都只有 Lv2 才可用。**不藏起来**，只压暗 ——
		// 藏着的话玩家不知道升级之后会多出什么
		const lv2 = lv >= 2
		const hint = '养蝇人升到 Lv.2 才能用'

		addRow(
			'自动出售',
			[
				{ value: '1', label: '开' },
				{ value: '0', label: '关' },
			],
			K.sell ? '1' : '0',
			'kSell',
			lv2,
			hint,
		)
		addRow(
			'卖哪档',
			O.tiers.map((t) => ({ value: t, label: TIER_NAME[t] ?? t })),
			K.tier,
			'kTier',
			lv2,
			hint,
		)
		addRow(
			'含突变',
			[
				{ value: '0', label: '不含' },
				{ value: '1', label: '含' },
			],
			K.mutants ? '1' : '0',
			'kMut',
			lv2,
			hint,
		)

		this.el.keeperNote.textContent =
			`已自动投放 ${K.fed} 次 · 已自动卖出 ${K.sold} 只`
	}

	// ⚠ 这里原来还有 _buildKeeperSlider / _syncKeeperSliderLabel（那根
	//   「价值 ≥」的价格滑条）。整条删掉了，连带：
	//     · config.market.keeperOptions 的 valueMin / valueMax
	//     · market.priceFromSlider / sliderFromPrice
	//     · world.keeper.minValue 和 _keeperSell 里的门槛比较
	//     · style.css 的 .keeper-slider / .keeper-value / .keeper-scale
	//   筛选现在只剩「卖哪档」+「含突变」两条，和玩家在数据面板上
	//   看得见的东西一一对应

	/** 把两档模式的选中态刷到设置卡上 */
	refreshSettings() {
		const annoying = this.world.annoying
		for (const btn of this.el.modeList.querySelectorAll('[data-mode]')) {
			btn.classList.toggle('on', (btn.dataset.mode === 'annoying') === annoying)
		}
	}

	/**
	 * 切模式。**立刻生效**，不需要重启也不需要重置。
	 *
	 * ⚠ 从烦人切回正常时，场上多出来的那些**不会被杀掉** ——
	 * 上限只拦「新增」，不管「已经存在的」。这是刻意的：
	 * 切一下模式就凭空蒸发几百只果蝇，比留着它们更让人困惑。
	 * 想立刻回到清静状态，点重置
	 */
	setAnnoying(on) {
		const want = !!on
		if (this.world.settings.annoying === want) return
		this.world.settings.annoying = want
		this.refreshSettings()
		this.refreshStats()
		this._flashHint(
			want
				? `烦人模式：上限 ×${CONFIG.world.annoyingMul}（总数封顶 ${CONFIG.world.annoyingTotalCap}）`
				: '回到正常模式',
		)
	}

	/**
	 * 指针压在某张居中小卡上 —— 只有这种时候才为它接管鼠标。
	 *
	 * 捐款 / 设置 / 重置确认三张卡共用这一条：它们的定位、层级、
	 * 「只吃自己那点面积」的做法完全一样，分开写三份迟早会漂移
	 * （漏掉一张的症状是「卡片看着正常，点上去却穿到桌面」）。
	 */
	_overCard() {
		// ⚠ 新加一张居中小卡就要往这个数组里补一个 ——
		//   漏了的话卡片画得完全正常，只是点上去会穿到桌面、关都关不掉
		//
		// ⚠ 量的是**卡片**，不是外面那层 .donate-pop。
		//   `.donate-pop` 的宽度写在 CSS 里，卡片理论上撑满它 —— 但那是
		//   约定，不是保证：卡片一旦比盒子宽（历史上真的发生过，宽度写在
		//   卡片上、撑出容器），多出来的那一段**看得见、也本该点得着**，
		//   可按盒子的矩形算就是「不在卡片上」→ 这里返回 false →
		//   窗口不接管鼠标 → 那一下点击直接穿到桌面。
		//   三张新卡的 ✕ 恰好贴在卡片右上角，整颗落在探出区里，
		//   症状就是「叉叉怎么点都关不掉」，而且没有任何报错。
		//
		//   所以这里认元素：卡片自己那圈矩形才是玩家眼里的「卡片」
		const pops = [
			this.el.donatePop,
			this.el.settingsPop,
			this.el.resetPop,
			this.el.keeperPop,
			this.el.sellAllPop,
			this.el.feedPop,
			this.el.shopPop,
			this.el.codexPop,
		]
		const m = this.view.mouse
		for (const pop of pops) {
			if (pop.classList.contains('hidden')) continue
			const card = pop.querySelector('.donate-card') || pop
			const r = card.getBoundingClientRect()
			if (m.x >= r.left - 4 && m.x <= r.right + 4 && m.y >= r.top - 4 && m.y <= r.bottom + 4) {
				return true
			}
		}
		return false
	}

	/**
	 * 指针压在罐中果蝇小窗上 —— 和捐款卡片同一条路子（矩形命中，不是「出现就接管」）。
	 *
	 * ⚠ 必须显式查 .hidden。窗口没有罐子时是 display:none，
	 * getBoundingClientRect() 会给出一个 0×0、位于 (0,0) 的矩形 ——
	 * 不查的话屏幕左上角 4px 见方的一小块会莫名其妙地吃掉桌面点击。
	 */
	_overJarWindow() {
		if (this.el.jarWindow.classList.contains('hidden')) return false
		const r = this.el.jarWindow.getBoundingClientRect()
		const m = this.view.mouse
		return m.x >= r.left - 4 && m.x <= r.right + 4 && m.y >= r.top - 4 && m.y <= r.bottom + 4
	}

	/**
	 * 指针压在「收起面板之后右下角那个把手」上。
	 *
	 * ⚠ 这条**必须存在**，理由和 _overJarWindow 一字不差：窗口平时是穿透的，
	 *   穿透时只有 mousemove 会被转发进来、**按下**会直接落到桌面上。
	 *   不进 _updateInteractive() 的 need，把手就是「看得见但点不动」，
	 *   而且不报任何错 —— 面板收起之后就再也叫不回来了。
	 *
	 * ⚠ 同样要显式查 .hidden：收起状态之外它是 display:none，
	 *   getBoundingClientRect() 会给一个 0×0、(0,0) 的矩形，
	 *   不查的话屏幕左上角会有一小块莫名吃掉桌面点击
	 */
	_overHandle() {
		if (this.el.handle.classList.contains('hidden')) return false
		const r = this.el.handle.getBoundingClientRect()
		const m = this.view.mouse
		return m.x >= r.left - 4 && m.x <= r.right + 4 && m.y >= r.top - 4 && m.y <= r.bottom + 4
	}

	_overPanel() {
		const r = this.el.panel.getBoundingClientRect()
		const m = this.view.mouse
		// 外扩 4px，让指针刚碰到边缘就开始接管，手感更跟手
		return m.x >= r.left - 4 && m.x <= r.right + 4 && m.y >= r.top - 4 && m.y <= r.bottom + 4
	}

	/**
	 * 指针压在一个「现在就能拎起来」的东西上 —— 只有这种时候才为它接管鼠标。
	 *
	 * ⚠ 故意**复用 _grabbableAt()**，而不是直接写 `_jarAt(...) !== null`。
	 * 这样「能拖什么」和「为谁接管鼠标」共用**同一个**真值来源：将来谁再往
	 * _grabbableAt 里放一种观察模式能拖的东西，接管会自动跟上，不会漏。
	 * 分开写的话，两边迟早会漂移，症状是「看着能拖，按下去没反应」。
	 *
	 * ⚠ **判定区不外扩，一个像素都不行。** 上面的 _overPanel / _overDonate /
	 * _overJarWindow 都写了 ±4px 图手感，这里**不能抄** ——
	 * 指针停在这块区域里的每一帧，窗口都是非穿透的，桌面点击会被整个吃掉。
	 * 外扩多少，就多吞多少。罐子本身已经是 194×246（屏幕的 2.3%），
	 * 最多 4 个，这个代价是「观察模式也能拖罐子」的固有成本，不该再放大。
	 *
	 * ⚠ 也**不要**加「悬停 N 毫秒才接管」的防抖。接管一旦晚于按下，
	 * 那一下就穿到桌面上去了 —— 拖动直接失效，用可靠性换一点误触不划算。
	 */
	_overGrabbable() {
		return this._grabbableAt() !== null
	}

	// ---------------------------------------------------------- 键盘

	_onKey(e) {
		switch (e.code) {
			case 'Escape':
				// 弹窗开着时，Esc 先关弹窗，**不**顺手把工具也放掉 ——
				// 「按一下 Esc 只撤销最上面那一层」是通用的直觉，
				// 一下把两样都取消掉很容易让人多按一次
				//
				// ⚠ 顺序有讲究：重置确认是**最上面**那一层（它是从设置之外
				// 的另一条路弹出来的），所以排在前面。三张卡同时开着是不可能的，
				// 但顺序写清楚比依赖「反正只会开一张」稳
				if (this.view.resetOpen) {
					this.setResetOpen(false)
					break
				}
				// 卖光确认和重置确认是同一层的岔路口，排在别的卡片之前
				if (this.view.sellAllOpen) {
					this.setSellAllOpen(false)
					break
				}
				if (this.view.keeperOpen) {
					this.setKeeperOpen(false)
					break
				}
				// 投放 / 商店 / 图鉴，和上面几张同一个待遇。
				// ⚠ 顺序无所谓（同一时刻只会开着一张 —— 见 _closeCenterCards），
				//   但必须**各占一条 break 分支**，漏一条那张卡就 Esc 关不掉
				if (this.view.feedOpen) {
					this.setFeedOpen(false)
					break
				}
				if (this.view.shopOpen) {
					this.setShopOpen(false)
					break
				}
				if (this.view.codexOpen) {
					this.setCodexOpen(false)
					break
				}
				if (this.view.settingsOpen) {
					this.setSettingsOpen(false)
					break
				}
				if (this.view.donateOpen) {
					this.setDonateOpen(false)
					break
				}
				// 钉住的数据面板也是「一层」，排在拖动之前关掉。
				// 它是一直显示到玩家主动收掉的那种，必须有个键盘出口 ——
				// 全靠再点一下空白处的话，指针底下正好有虫时就关不掉了
				if (this.inspectPinned) {
					this._hideInspect()
					break
				}
				// ⚠ 先取消拖动。mouseup 万一丢了（窗口失焦、被别的程序抢走鼠标捕获），
				// drag 会一直是非 null → interactive 恒 true → **窗口永久接管鼠标**，
				// 而 Esc 是玩家唯一会去按的救命键。缺了这一行它就救不回来，
				// 只能重启。_cancelDrag 内部会把鼠标还回去
				this._cancelDrag()
				this.setTool('none')
				break
			case 'KeyF':
				this.setTool(this.view.tool === 'swatter' ? 'none' : 'swatter')
				break
			case 'KeyN':
				this.setTool(this.view.tool === 'net' ? 'none' : 'net')
				break
			case 'KeyG':
				this.setTool(this.view.tool === 'glove' ? 'none' : 'glove')
				break
			case 'KeyC':
				this.setTool(this.view.tool === 'cloth' ? 'none' : 'cloth')
				break
			case 'KeyV':
				this.setTool(this.view.tool === 'inspect' ? 'none' : 'inspect')
				break
			case 'KeyB':
				// 扫帚（**B**room）。免费工具，没有「先买」那一层，直接切
				this.setTool(this.view.tool === 'broom' ? 'none' : 'broom')
				break
			case 'KeyW':
				// 喷水枪（**水**枪）。⚠ 和 KeyR 的烤制（喷**火**枪）不是一回事，
				// 两个名字只差一个字，别按错
				this.setTool(this.view.tool === 'squirt' ? 'none' : 'squirt')
				break
			case 'KeyR': {
				// R = 「举起点火器」。连着按两下是开→关（和别的快捷键一致）。
				// 升到喷火枪之后再按 R 举的是**喷火枪** —— 和上一版
				// 「一颗按钮跟着档位改名」是同一套手感，只是现在鼠标点工具栏
				// 那颗可以直接指定要哪一把
				//
				// ⚠ 「已经举着」要认**两个 id**：只判最高档的话，
				//   玩家拿着打火机按 R 会跳到喷火枪，而不是把手里的收起来
				const lv = this.world.shopLevel('roast')
				if (lv < 1) {
					this._flashHint('先去商店买打火机')
					break
				}
				const held = this.view.tool === 'lighter' || this.view.tool === 'flamer'
				this.setTool(held ? 'none' : lv >= 2 ? 'flamer' : 'lighter')
				break
			}
			case 'Space':
				e.preventDefault()
				this.togglePause()
				break
		}
	}

	// ---------------------------------------------------------- 操作

	setTool(tool) {
		// 捕虫网要先买。不拦的话它会切过去、标题行显示「捕虫网」，
		// 但按下去什么都不发生 —— 得让玩家知道是没买，不是坏了
		if (tool === 'net' && !this.world.hasShopItem('net')) {
			this._flashHint('先去商店买捕虫网（$1.2）')
			return
		}
		// 喷水枪同理。价格从配置里读，别在提示语里写死 ——
		// 写死的话改了 shop 里的 price，这句话就成了假话
		if (tool === 'squirt' && !this.world.hasShopItem('squirt')) {
			this._flashHint(`先去商店买喷水枪（${formatMoney(shopItem('squirt')?.price ?? 0)}）`)
			return
		}

		// 点火器那两颗同理。⚠ 喷火枪的提示要把「两步」说清楚 ——
		// 玩家看到一颗灰着的「喷火枪」时最容易以为是钱不够，
		// 其实是得先有打火机（它俩是一条升级链，不是两件并列的商品）
		const burnChain = chainOf('roast') ?? []
		if (tool === 'lighter' && this.world.shopLevel('roast') < 1) {
			const t0 = burnChain[0]
			if (!t0) return
			this._flashHint(`先去商店买${t0.name}（${formatMoney(t0.price)}）`)
			return
		}
		if (tool === 'flamer' && this.world.shopLevel('roast') < 2) {
			const t0 = burnChain[0]
			const t1 = burnChain[1]
			if (!t0 || !t1) return
			this._flashHint(`要先买${t0.name}，再花 ${formatMoney(t1.price)} 升级到${t1.name}`)
			return
		}

		// 换工具就收掉数据面板：拿着拍子还杵着一张虫的档案卡很怪，
		// 而且那张卡会一直挡着。
		//
		// ⚠ 判的是 `!== 'inspect'` 而不是 `!== 'none'`：**查看工具自己不清卡片**。
		//   不然拿着查看工具连点第二只虫时，第一次 setTool 会先把刚开的那张收掉 ——
		//   而 setTool 在点同一个工具时也会被调用（快捷键按两下就是「开→关」），
		//   那样「点开一只、再点开另一只」的中间会闪一下空白
		if (tool !== 'inspect') this._hideInspect()

		this.view.tool = tool

		/*
		 * 穿透开着的时候，工具是**按不动**的 —— 画布全区穿透，点下去会点到桌面。
		 *
		 * 这是「穿透才是主开关」的必然结果（见 _updateInteractive 那段注释），
		 * 但玩家不会自己想到这一层：他会觉得「工具坏了」。
		 * 所以选中一个真工具的那一刻闪一句，把「去哪儿关」说清楚。
		 *
		 * ⚠ 只在**选中**时闪，不要每帧闪 —— _flashHint 自己带同句去重，
		 *   但这里连调用都不该发生（选中是一次性的动作，不是每帧的）。
		 * ⚠ 观察（none）不闪：它本来就该穿透。
		 * ⚠ clickThrough 是主进程的状态，渲染进程这边只有 _applyWindowState 收到过 ——
		 *   用 this.view.clickThrough 那份缓存，别去问 IPC（这是每选一次工具才跑一次的路径，
		 *   异步问一下也不是不行，但没必要）
		 */
		if (tool !== 'none' && this.view.clickThrough) {
			this._flashHint('穿透开着 —— 工具点不动，按 Ctrl+Shift+F 或点面板上的「穿透」关掉')
		}

		for (const btn of this.toolButtons) {
			const on = btn.dataset.tool === tool
			btn.classList.toggle('active', on)
			// 收起状态下唯一能看出「现在拿着什么」的地方，就是标题行那个名字。
			// 名字直接从按钮上取，不再维护一份「工具 → 中文名」的对照表 ——
			// 那样加一个工具就得记着改两处
			if (on) this.el.toolsCurrent.textContent = btn.textContent
		}
		// ⚠ 这里原来有个 `drawsOwnCursor` 白名单（拍子 / 网 / 抹布 / 烤 / 查看 / 喷水枪），
		//   它会给 body 加 `tool-active`，那条 CSS 是 `cursor: none` ——
		//   藏掉系统指针、由 canvas 自绘一个工具图案。
		//
		//   工具图案**全部删掉**之后这个类必须一起删：留着的话，拿着工具时
		//   画布上什么都不画、系统指针又被藏了，屏幕上会**一个指针都没有**。
		//   这是这一整块改动里最容易漏、又最要命的一处
		document.body.classList.toggle('tool-glove', tool === 'glove')
		this._updateInteractive()
	}

	/**
	 * 设定时间流速。**0 = 时停**，1 是正常速度，2 / 5 / 10 是加速档。
	 *
	 * 时停和倍速是同一根轴的两端（都是「世界推进得多快」），所以走同一个入口。
	 * 分成两个按钮的话会出现「暂停着、倍速按钮却还亮着 5×」这种自相矛盾的状态。
	 *
	 * ⚠ 时停只翻转 `world.paused`，**不动 world.timeScale** ——
	 * 于是从时停里出来时还能回到原来的档位，而不是每次都掉回 1×。
	 *
	 * 加速也只改 timeScale，物理本身不动：world.update() 是分步积分的，
	 * 每步最长 1/30 秒，所以 10× 只是「一帧里多跑几步」，
	 * 不会出现果蝇一帧瞬移出去、或者穿过罐壁。
	 */
	setSpeed(mult) {
		const n = Number(mult)
		if (!Number.isFinite(n) || n < 0) return

		if (n === 0) {
			this.world.paused = true
		} else {
			this.world.paused = false
			this.world.timeScale = n
		}
		this._syncSpeedUI()
	}

	/**
	 * 时停开 / 关。Space 走这条路。
	 *
	 * 恢复时用的是 `world.timeScale` —— 它全程没被动过，
	 * 所以「5× 之下按空格 → 再按一次」回到的还是 5×，不是 1×。
	 */
	togglePause() {
		this.setSpeed(this.world.paused ? this.world.timeScale : 0)
		this.refreshStats()
	}

	/**
	 * 把当前的时间状态画到按钮上：哪个档高亮、标题行显示什么、"不在常态"要不要点亮。
	 *
	 * 单独抽出来是因为有**三个**改状态的入口（点档位、按空格、读档恢复），
	 * 每个都手写一遍「更新按钮」迟早会漏掉一个 ——
	 * 表现就是「按钮显示的和实际跑的对不上」，而且很难注意到。
	 */
	_syncSpeedUI() {
		const paused = this.world.paused
		const now = paused ? 0 : this.world.timeScale

		for (const btn of this.speedButtons) {
			const on = Number(btn.dataset.speed) === now
			btn.classList.toggle('active', on)
			// 收起状态下唯一能看出「现在几倍速 / 停没停」的地方，就是标题行那个词。
			// 和工具栏一样，名字直接从按钮上取，不另维护一份对照表
			if (on) this.el.speedCurrent.textContent = btn.textContent
		}

		// 1× 是常态，不该亮成一个「开着的开关」；时停和加速都算「不在常态」。
		// 加速时点亮是为了提醒「忘了自己还开着 10×，难怪果蝇老得这么快」，
		// 时停时点亮同理 —— 忘了它停着，会以为程序卡死了
		this.el.btnSpeed.classList.toggle('on', paused || this.world.timeScale !== 1)
	}

	_applyWindowState(state) {
		this.el.top.classList.toggle('on', !!state.alwaysOnTop)
		this.el.through.classList.toggle('on', !!state.clickThrough)
		// 缓存一份给 setTool() 用 —— 它要在「选中工具」那一刻判断要不要闪提醒。
		// 主进程才是真值来源，这边只是把推过来的状态记下来
		this.view.clickThrough = !!state.clickThrough
	}

	// ---------------------------------------------------------- 每帧

	/**
	 * 挥手惊蝇：把「鼠标甩得多快」换算成 0~1 的惊扰强度，写进 world.startle。
	 *
	 * 强度 = max(这一帧的瞬时值, 上一次衰减之后的值)，两路取大：
	 *
	 *   - 瞬时值让它**跟手** —— 甩得越快，当下就越慌
	 *   - 衰减那一路让它**有余韵** —— 手停下了，果蝇还在窜一小会儿，
	 *     像真的躲开了一只刚挥过来的手。没有这一路的话，鼠标一停
	 *     它们就瞬间恢复悠闲，看着像「按住了暂停键」
	 *
	 * ⚠ **观察模式和查看工具**整个关掉，连 world.startle 也一起清零。
	 *   观察模式的定位是「纯看不打扰」——鼠标扫过去炸开一屏果蝇的话，
	 *   观察模式就没法看了。
	 *
	 *   查看工具同样要关，理由更实际：查看是**点虫**用的，而惊飞是
	 *   「鼠标一动它们就窜走」。开着的话你会看见一屏果蝇在你够到之前
	 *   全飞了，根本点不着任何一只 —— 一个走位就把要查看的目标赶跑。
	 *
	 *   关的时候必须**写 0** 而不是直接 return，
	 *   否则切进这两档的那一刻，world 里还留着上一帧的强度
	 */
	_updateStartle(rawDt) {
		const m = this.view.mouse
		const dt = Math.max(rawDt, 1e-4) // 防 0 除
		const moved = Math.hypot(m.x - this.lastMouseSample.x, m.y - this.lastMouseSample.y)
		this.lastMouseSample.x = m.x
		this.lastMouseSample.y = m.y

		if (this.view.tool === 'none' || this.view.tool === 'inspect') {
			this.startle = 0
		} else {
			// ⚠ 先减掉一个**死区**：慢于 startleWakeSpeed 的手完全不算「挥手」。
			//
			// 死区必须在**这里**做，不能在 world 那边按倍率截断 ——
			// 那样「慢慢挪过去」仍然会得到一个略大于 1 的倍率，
			// 而玩家瞄准时手会一直小幅抖动，等于全程给果蝇加速。
			// 在这里减掉，慢速移动就是干干净净的 0
			const T = CONFIG.tools
			const speed = moved / dt
			const span = Math.max(1, T.startleFullSpeed - T.startleWakeSpeed)
			const instant = clamp((speed - T.startleWakeSpeed) / span, 0, 1)

			// 回落走的是**上一次的值**，所以甩完那一下之后
			// 还会维持一小会儿（见 startleDecay），不会松手瞬间归零
			const decayed = this.startle - rawDt / T.startleDecay
			this.startle = Math.max(instant, decayed, 0)
		}

		this.world.startle.x = m.x
		this.world.startle.y = m.y
		this.world.startle.power = this.startle
	}

	update(rawDt) {
		this._updateStartle(rawDt)

		// 按住不放 → 连续挥拍 / 连续擦 / 一路烤过去
		//
		// 抹布的「擦掉多少」按**路程**计，路程在 mousemove 里累加（见 _onMove）；
		// 烤制不再计任何东西 —— 接触即烤，每帧这一趟就是「指针底下那具熟没熟」
		if (this.mouseDown) {
			this._useTool()
		}

		// ⚠ 拖动必须**每帧**重新钉一次位置，不能只在 mousemove 里做。
		//
		// 食物 / 罐子 / 蛹壳自己不会动，所以在 mousemove 里钉一次就够了。
		// 但**果蝇每帧都在自己飞** —— 只在 mousemove 时钉的话，
		// 鼠标一停，被拎着的那只就继续往原方向飞走了，根本拖不到出售区。
		if (this.drag) this._dragTo()

		// 数据面板：钉住的那张卡片要跟着目标走、目标没了要收掉
		this._updateInspect()

		// ⚠⚠ 这一行**必须**在每帧的 update 里，不能只靠 mousemove。
		//
		// 窗口默认是鼠标穿透的，而 _updateInteractive 决定要不要解除穿透。
		// 它以前只在 mousemove 里被调用 —— 那对玻璃罐够用（罐子不会动），
		// 但对**会走的虫**两个方向都会坏：
		//
		//   · 鼠标不动、虫自己走到指针底下 → 没有 mousemove → 窗口仍然穿透
		//     → 那一下点击直接落到桌面上，「点开数据面板」静默失效。
		//     而这恰恰是这个游戏的常态：虫一直在动，玩家的手是停着的
		//   · 虫走开了、鼠标不动 → 窗口**继续**吞桌面点击，
		//     直到玩家晃一下鼠标为止
		//
		// 每帧调不会刷爆 IPC：_updateInteractive 里有 `need === this.interactive`
		// 的相等守卫，只有状态真的翻转时才会发那一次 setInteractive
		this._updateInteractive()

		// 工具特效的**状态**交给 world，由它按时间发粒子（见 world._emitToolFx）。
		//
		// ⚠ 这里是「谁拿着什么、按没按下去」的**唯一**写入点 —— 渲染层不自己
		//   判断鼠标按键，不然「按住喷水」在两处各有一套真相，迟早对不上
		this._updateToolFx()

		// ⚠ 捐款卡片**不在这里摆位**。它是屏幕正中的一张固定卡片，
		// 位置完全由 CSS 的 50% / 50% 决定，和面板在哪儿无关 ——
		// 所以既不用在这里每帧校一次，也不用管面板被拖到了哪里

		// 计数没必要每帧刷 DOM，6~7 Hz 足够，也省得数字闪
		this.statTimer -= rawDt
		if (this.statTimer <= 0) {
			this.statTimer = 0.15
			this.refreshStats()
		}
	}

	// ---------------------------------------------------------- 数据面板（观察模式点击）
	//
	// ⚠ 早先是「悬停 1 秒自动弹」。改成点击之后有三处必须一起处理，
	//   少一处的症状都在下面各条注释里：
	//
	//   1. 窗口默认鼠标穿透，**收不到 mousedown**。
	//      所以 _updateInteractive 里多了一条 _overInspectable ——
	//      没有它，点击会直接落到桌面上，而屏幕上什么都不会发生
	//   2. 窗口穿透时**只有 mousemove 被转发**，所以判定区必须每帧重算。
	//      见 update() 末尾那次 _updateInteractive()：虫会自己走到一个
	//      不动的指针底下来，光靠 mousemove 永远等不到那一下
	//   3. 卡片是**钉住**的（inspectPinned）。不钉的话，
	//      update() 每帧的 _updateInspect 会看到指针底下没虫了、
	//      直接把它关掉 —— 点开的卡片活不过一帧

	/**
	 * 把「手里拿着什么、按没按下去」写进 `world.toolFx`，由 world 去发粒子。
	 *
	 * ⚠ **每个工具都要有「空转」发射率**，不能只在按住时发：
	 *   喷水枪的长度/角度、扫帚的半径都是**松开鼠标时**用滚轮调的。
	 *   只在按下时发粒子的话，滚轮会变成「按了没反应」—— 而那正是
	 *   这个项目最怕的那种静默失效（界面上什么都不报，只是没用）
	 *
	 * ⚠ 查表要按 `tool` 给出对应的空转率，别写成一串 if ——
	 *   加一个工具时漏掉分支的话，那个工具就完全没有反馈
	 */
	_updateToolFx() {
		const fx = this.world.toolFx
		const tool = this.view.tool
		const F = CONFIG.tools.fx
		const idle = { squirt: F.squirtIdleRate, broom: F.broomIdleRate }

		fx.tool = tool
		fx.x = this.view.mouse.x
		fx.y = this.view.mouse.y
		// 大火焰还是小火焰。⚠ 这里以前推的是一个 `level` 数字（档位 0~3），
		//   因为烤制链当时有三档；现在只有打火机 / 喷火枪两档，
		//   而它们各自是一个 tool id —— 一个布尔就够了
		fx.big = tool === 'flamer'
		fx.len = this.view.squirt ? this.view.squirt.len : 0
		fx.angle = this.view.squirt ? this.view.squirt.angle : 0
		fx.radius = this.view.broom ? this.view.broom.r : 0
		fx.scrub = this.clothScrubbed ? 1 : 0
		fx.down = this.mouseDown
		this.clothScrubbed = false

		if (tool === 'lighter' || tool === 'flamer') {
			// 火苗：**举着就冒**（那是「手里有个火源」本身的样子）。
			// 两档的差别只有大小和密度，由 fx.big 一个布尔表达
			fx.on = true
			fx.rate = fx.big ? F.flameRateBig : F.flameRate
		} else if (tool === 'squirt') {
			fx.on = true
			fx.rate = this.mouseDown ? F.squirtRate : F.squirtIdleRate
		} else if (tool === 'broom') {
			fx.on = true
			fx.rate = this.mouseDown ? F.broomRate : F.broomIdleRate
		} else if (tool === 'cloth') {
			// 抹布只在**真的在擦**时冒水珠（按住且这一帧划过距离）
			fx.on = this.mouseDown && fx.scrub > 0
			fx.rate = F.clothRate
		} else {
			// 拍子 / 网 / 查看 / 手套 / 观察 —— 没有持续特效，
			// 它们的反馈是**动作那一下**的一次性粒子（见 world.swat / catchFlies）
			fx.on = false
			fx.rate = idle[tool] ?? 0
		}
		this.scrubDist = 0
	}

	/**
	 * 每帧维护那张钉住的卡片。
	 *
	 * 卡片一旦被点开就**一直显示**，直到玩家主动关掉 ——
	 * 所以这里只做两件事：目标死了要收掉、位置跟着目标走。
	 */
	_updateInspect() {
		// 拖着东西的时候不弹 —— 那时候玩家在看投放区，卡片只会挡路
		if (this.drag) {
			this._hideInspect()
			return
		}
		if (!this.inspectPinned || !this.inspectTarget) return

		// 目标被卖掉 / 拍死 / 羽化掉了，卡片就该消失。
		// 幼虫羽化之后那个对象还在 world 里但已经 dead —— 一并覆盖到
		const t = this.inspectTarget
		// 能被查看的只有**成虫**（`_creatureAt` 已经把幼虫排除掉了，两边说的是同一件事）。
		// 成虫可能在屏幕上，也可能在罐子里 —— 所以「还在不在」要两处都查。
		//
		// ⚠ 这里必须和 `_creatureAt` 认的范围**完全一致**：宽了的话卡片会
		//   钉在一只已经无处可寻的虫上；窄了的话点开罐中虫的那一瞬间卡片就没了。
		//   （烤箱同样不在两边之内，见 `_creatureAt` 的注释）
		if (t.dead || (!this.world.flies.includes(t) && this.world.jarOf(t) === null)) {
			this._hideInspect()
			return
		}

		this._placeInspect(t)
	}

	/**
	 * 点开某只虫的数据面板。
	 *
	 * 只由观察模式下的 mousedown 调用（见 _onDown）。
	 */
	openInspect(creature) {
		if (!creature) {
			this._hideInspect()
			return
		}
		this.inspectTarget = creature
		this.inspectPinned = true
		this._showInspect(creature)
	}

	/**
	 * 把一只**成虫**的数据填进卡片。
	 *
	 * ⚠ 这个函数**只收成虫**（`_creatureAt` 也只返回成虫）。
	 *   这里原来有一个 `isLarva` 分支，幼虫走的是「只显示基因徽章」那一套；
	 *   幼虫不能再查看之后整块删掉了 —— 连带 `larva-card` 那套 CSS。
	 *   所以这里不再判 kind，也不再有第二条路径
	 */
	_showInspect(f) {
		const el = this.el
		el.inspect.classList.remove('hidden')

		const tier = valueTierOf(f.value)
		// 类名换成 tier-<id>；顺带把「要不要流动 / 反光」两个特效类也切了。
		// 特效开关来自 CONFIG.market.valueTiers，所以调档位不用改 CSS。
		// ⚠ 这是**整体覆盖**赋值，卡片上的类全靠这一行，别在别处再 add
		// `fx` = 描边会流动。⚠ 它**曾经**是「内侧再套一圈用 mask 挖出来的光环」，
		// 那套在四个角上根本没画出来；现在改成把渐变画进边框本身了，
		// 类名没变，怎么实现的全在 style.css 的 `.inspect.fx` 里
		el.inspect.className = `inspect tier-${tier.id}${tier.flow ? ' fx' : ''}${tier.sheen ? ' sheen' : ''}`

		el.inspectSex.textContent = f.sex === 'F' ? '♀' : '♂'
		// 上面那行大字是**价值档**（这只值多少钱）。
		// ⚠ 别再改回去读 f.rarityInfo.name —— 那是**体重档**，
		//   两套词、两套边界，见 config.js。体重档在下面那行小字里
		el.inspectRarity.textContent = tier.name
		// 下面那行小字是**体重档**（这只长得多沉：轻盈 / 超重 / 巨兽）。
		// 就是 f.rarityInfo.name —— 和「体重」那一行是同一个来源，
		// 所以两处永远不会互相矛盾
		el.inspectBuild.textContent = '体格 ' + f.rarityInfo.name

		const pct = Math.round(f.growth * 100)
		el.inspectBar.style.width = pct + '%'
		el.inspectPct.textContent = pct + '%'

		// 体重按量级换单位：轻盈成虫是零点几毫克，巨兽是几克 ——
		// 统一用 mg 的话会出现「10000.000 mg」这种读不出量级的数字
		el.inspectWeight.textContent =
			f.weight >= 1000 ? (f.weight / 1000).toFixed(2) + ' g' : f.weight.toFixed(3) + ' mg'
		el.inspectValue.textContent = formatMoney(f.value)
		el.inspectHp.textContent = `${f.hp} / ${f.hpMax}`

		this._renderGenes(f)
		this._placeInspect(f)
	}

	/**
	 * 基因徽章。
	 *
	 * 用几何字符（⚡ ◆ ▣ ◇）而不是 emoji：emoji 的字体可用性看运气，
	 * 而这个应用是打包发给别人用的，缺字体会变成豆腐块。
	 */
	_renderGenes(f) {
		const box = this.el.inspectGenes
		box.textContent = ''
		const badges = badgesOf(f.mutations)

		if (badges.length === 0) {
			const s = document.createElement('span')
			s.className = 'gene-badge wild'
			s.textContent = '野生型'
			box.appendChild(s)
			return
		}

		for (const b of badges) {
			const s = document.createElement('span')
			s.className = 'gene-badge'
			s.style.color = b.color
			s.style.borderColor = b.color
			// 这里原来还有一条「幼虫身上的携带者标淡一点」——
			// 幼虫不能再查看之后它就没有落脚点了（`carrier` 那个类和 CSS 一起删了）。
			// ⚠ 注意**别**顺手把 `adultOnly` 也删掉：那个字段决定的是
			//   「这个基因在幼虫身上表不表达」（点石成金 / 石化只在成虫显形），
			//   和「能不能查看」是两码事，mutation.types 里还在用
			s.textContent = b.icon + ' ' + b.name
			s.title = b.adultOnly ? b.name + '（只在成虫身上显形）' : b.name
			box.appendChild(s)
		}
	}

	/** 把卡片摆在目标旁边；贴到屏幕边就翻到另一侧，别被切掉 */
	_placeInspect(f) {
		const el = this.el
		const w = el.inspect.offsetWidth || 150
		const h = el.inspect.offsetHeight || 96
		// 摆在被查看的**那只虫**旁边，不是指针旁边 ——
		// 卡片是钉住的，指针早就移开了，跟着指针会跑到屏幕另一头
		//
		// ⚠ 位置要用 world.screenPosOf()：罐中果蝇的 x / y 是**相对罐心**的偏移。
		//   直接拿 f.x 的话卡片会飞到屏幕左上角，而虫子好好地待在罐子里 ——
		//   放大镜那边踩过同一个坑
		const p = this.world.screenPosOf(f)
		const x = p.x + 18 + w > this.world.w ? p.x - 18 - w : p.x + 18
		const y = p.y + 18 + h > this.world.h ? p.y - 18 - h : p.y + 18
		el.inspect.style.left = Math.max(4, x) + 'px'
		el.inspect.style.top = Math.max(4, y) + 'px'
	}

	_hideInspect() {
		this.inspectTarget = null
		this.inspectPinned = false
		this.el.inspect.classList.add('hidden')
	}

	refreshStats() {
		const c = this.world.counts
		this.el.living.textContent = c.living
		this.el.adults.textContent = c.adults
		this.el.larvae.textContent = c.larvae
		this.el.eggs.textContent = c.eggs
		this.el.deaths.textContent = c.deaths

		// 食物那格顺便显示「有几只幼虫正趴在上面啃」，比单看食物数量有意思
		this.el.food.textContent = c.eating > 0 ? `${c.foods}·${c.eating}啃` : c.foods

		// 钱只在**变化时**写 DOM。这个方法是 6~7 Hz 跑的，而钱绝大部分时间是 0，
		// 无条件写会让它在没变化时也一直触发重排（并且数字等宽也没用，浏览器照样标脏）
		const moneyText = formatMoney(c.money)
		if (this.el.money.textContent !== moneyText) {
			this.el.money.textContent = moneyText
			this.el.shopMoney.textContent = moneyText
			this.el.feedMoney.textContent = moneyText
			// 钱变了，两个面板里的按钮「买得起 / 买不起」都要跟着变
			this.refreshShop()
			this.refreshFeed()
		}
		// ⚠ 工具按钮**不能**塞进上面那个「钱变了」的分支里。
		// 它跟的是**等级**不是钱：升级之后钱当然也变了，所以正常情况下
		// 塞进去也能跑 —— 但读档恢复时等级变了、钱可能恰好没变，
		// 那时候按钮就会停在错误的档位上。这个方法本身很便宜（两次 class 切换），
		// 直接无条件调，别为了省这一点点去赌
		this.refreshToolButtons()
		this.el.sold.textContent = c.sold
		// 总价值和钱一样用 formatMoney，单位是游戏币 —— 它不是「第几个」而是一笔钱
		this.el.value.textContent = formatMoney(c.value)

		this.el.swarm.classList.toggle('hidden', !c.swarm)
		this.el.pause.classList.toggle('hidden', !this.world.paused)

		this.refreshJarList()
	}

	/**
	 * 造一行商品：**名字 + 说明 + 右侧按钮区**。
	 *
	 * 三种商品形态（一次性道具 / 可升级链 / 消耗品投放）本来各写了一遍这套 DOM，
	 * 三份几乎一模一样、只有按钮部分不同。抽出来之后，
	 * 「行长什么样」只有这一处，改样式不用改三遍。
	 *
	 * @param {{name:string, desc:string, buttons:HTMLElement[], gold?:boolean, extra?:HTMLElement}} spec
	 *   `extra` 是可选的**第二行**（放大镜那六个档位小按钮在用）。
	 *   给了就换行显示 —— 那一行是「这一件商品的设置」，不是又一件商品
	 */
	_shopRow({ name, desc, buttons, gold = false, arcane = false, extra = null }) {
		const row = document.createElement('div')
		// `.wrap` 让 `extra` 掉到下一行（见 style.css）
		// `arcane` 和 `gold` 是同一件事的两种配色（紫 / 金），互斥 ——
		// 真同时给了也只会叠两个 class，CSS 里后者赢，不会画出第三种颜色
		row.className =
			'shop-item' + (gold ? ' feed-item-gold' : '') + (arcane ? ' feed-item-arcane' : '') + (extra ? ' wrap' : '')

		const nameEl = document.createElement('span')
		nameEl.className = 'shop-name'
		nameEl.textContent = name

		const descEl = document.createElement('span')
		descEl.className = 'shop-desc'
		descEl.textContent = desc
		descEl.title = desc

		const box = document.createElement('div')
		// ⚠ 两颗以上按钮时必须包一层：`.shop-desc` 是 `flex: 1 1 auto`，
		//   直接并排会被它挤扁（`.feed-btns` / `.shop-btns` 就是为这件事存在的）
		box.className = buttons.length > 1 ? 'shop-btns' : 'feed-btns'
		for (const b of buttons) box.append(b)

		row.append(nameEl, descEl, box)
		if (extra) row.append(extra)
		return row
	}

	/**
	 * 放大镜的**档位勾选行**：六个价值档，勾哪几档就亮哪几档。
	 *
	 * ⚠ 只在**买过之后**才造出来（和养蝇人「买了才出配置按钮」同一条先例）：
	 *   没买就摆一排按不动的按钮，比不摆更让人困惑。
	 *
	 * ⚠ 名字取自 `CONFIG.market.valueTiers` —— 和数据面板上那行大字、
	 *   养蝇人的「卖哪档」是**同一份定义**。另抄一套的话，
	 *   改了档位名这里就成了假话
	 */
	_magnifierTiers() {
		const box = document.createElement('div')
		box.className = 'tier-pick'
		for (const t of CONFIG.market.valueTiers) {
			const b = document.createElement('button')
			b.className = 'keeper-opt'
			b.dataset.magnifyTier = t.id
			b.textContent = t.name
			b.classList.toggle('active', this.world.magnifierTiers.includes(t.id))
			b.title = `价值档「${t.name}」的成虫会亮起来`
			box.append(b)
		}
		return box
	}

	/**
	 * 按分类表把若干行分组渲染进某个列表容器。**商店和投放共用这一个**。
	 *
	 * @param {string} group 这一块是谁（`'shop'` / `'feed'`）。只用来给折叠状态
	 *   拼一个键 —— 两张表的 `cat.id` 目前不重叠，但那是巧合不是契约
	 */
	_renderCats(container, cats, rowFor, group) {
		container.innerHTML = ''
		for (const cat of cats) {
			const key = group + ':' + cat.id
			const groupEl = document.createElement('div')
			groupEl.className = 'shop-cat'
			// 分类名挂个 dataset，自检靠它核对「商品有没有落在正确的组里」
			groupEl.dataset.cat = cat.id

			// 标题现在是**折叠按钮**，不再是纯文字。
			//
			// ⚠ 用 `.cat-toggle` 这个**新类**，不要直接改 `.shop-cat-name` ——
			//   图鉴那两张小标题（`_codexSection`）用的是同一个类名，
			//   改了的话图鉴的标题会跟着多出悬停底色和手指指针
			const title = document.createElement('button')
			title.type = 'button'
			title.className = 'shop-cat-name cat-toggle'
			const label = document.createElement('span')
			label.textContent = cat.name
			const caret = document.createElement('span')
			caret.className = 'caret'
			caret.textContent = '▾'
			title.append(label, caret)

			// ⚠ 点一下**只切 class、不重建**。重建的话 `.shop-cats` 的滚动位置
			//   会跳回顶端（它有 max-height + overflow-y: auto）——
			//   玩家折一个靠下的分类，视野会突然弹回最上面那一条
			title.addEventListener('click', () => {
				if (this.collapsedCats.has(key)) this.collapsedCats.delete(key)
				else this.collapsedCats.add(key)
				this._applyCatFold(groupEl, key)
			})

			const rows = document.createElement('div')
			rows.className = 'shop-cat-rows'

			let any = false
			for (const id of cat.items) {
				const row = rowFor(id)
				if (!row) continue // 认不出来的 id（配置写错了）—— 跳过，别让整块渲染炸掉
				rows.append(row)
				any = true
			}
			// 空分类不显示标题 —— 一个只有标题、下面什么都没有的分组
			// 看起来像「加载失败了」
			if (!any) continue

			// 建的时候就带上折叠态 —— 状态在 UI 实例上，不在 DOM 上
			this._applyCatFold(groupEl, key)
			groupEl.append(title, rows)
			container.append(groupEl)
		}
	}

	/**
	 * 把折叠状态写进 DOM。**唯一**的写入点 —— 建的时候和点的时候都走它。
	 *
	 * ⚠ 折叠状态存在 `this.collapsedCats`（一个 Set）里，**不能挂在 DOM class 上**：
	 *   `_renderCats` 每次都 `container.innerHTML = ''` 重建，而 `refreshStats()`
	 *   在**钱一变**就同时调 `refreshShop()` + `refreshFeed()`。
	 *   状态挂 class 上的话，钱一动折叠就自己弹回去 ——
	 *   而这个 bug 只在「玩着玩着卖了一只蝇」的时候出现，看着完全随机
	 */
	_applyCatFold(groupEl, key) {
		groupEl.classList.toggle('collapsed', this.collapsedCats.has(key))
	}

	/**
	 * 渲染商店弹窗。商品分两类（工具类 / 帮手类），分类和顺序都来自
	 * `CONFIG.market.shopCats` —— 加商品只需要往那张表里补一个 id。
	 *
	 * 整块重建是可以的：商品只有几件，而且这个方法只在**钱变化时**和
	 * **卡片打开时**才被调用 —— 和罐中列表那种每 0.15 秒刷一次的情况不一样。
	 */
	refreshShop() {
		this._renderCats(this.el.shopList, CONFIG.market.shopCats, (id) => this._shopRowFor(id), 'shop')
	}

	/** 按 id 造出商店里的一行。认不出来返回 null */
	_shopRowFor(id) {
		if (id === 'roast') return this._chainRow('roast')
		if (id === 'keeper') return this._chainRow('keeper')
		const item = CONFIG.market.shop.find((it) => it.id === id)
		if (!item) return null

		const owned = this.world.hasShopItem(id)
		const afford = this.world.money >= item.price
		const buy = document.createElement('button')
		buy.className = 'shop-buy'
		buy.dataset.buy = id
		buy.dataset.name = item.name
		buy.textContent = owned ? '已拥有' : formatMoney(item.price)
		buy.disabled = owned || !afford
		if (!owned && !afford) buy.title = '钱不够'

		// 放大镜买过之后多一行档位勾选（没买就不给 —— 见 _magnifierTiers 的注释）
		const extra = id === 'magnifier' && owned ? this._magnifierTiers() : null

		return this._shopRow({ name: item.name, desc: item.desc, buttons: [buy], extra })
	}

	/**
	 * 一条**可升级链**的一行：烤制链和养蝇人链共用。
	 *
	 * 和一次性道具长得不一样：名字带等级、按钮写的是**下一级**的价格
	 * 而不是「已拥有」，而且永远不会禁用（满级除外）。
	 *
	 * ⚠ 状态是 world.shop 里的**数字等级**，不是布尔 —— 所以走
	 * world.shopLevel / world.upgradeShopItem，不能碰 buyShopItem
	 * （那条路径对已拥有的东西直接返回 false，升级永远升不动）。
	 */
	_chainRow(id) {
		const chain = chainOf(id)
		if (!chain) return null
		const lv = this.world.shopLevel(id)
		const next = lv < chain.length ? chain[lv] : null

		const buttons = []

		// 养蝇人买过之后多一颗「配置」——没买就没得配，
		// 摆一颗按下去什么都不做的按钮比不摆更让人困惑
		if (id === 'keeper' && lv >= 1) {
			const cfg = document.createElement('button')
			cfg.className = 'shop-buy'
			cfg.dataset.keeperCfg = '1'
			cfg.textContent = '配置'
			cfg.title = '设置自动投什么 / 卖什么'
			buttons.push(cfg)
		}

		const buy = document.createElement('button')
		buy.className = 'shop-buy'
		buy.dataset.chain = id
		buy.dataset.name = next ? next.name : ''
		if (next) {
			const afford = this.world.money >= next.price
			// 按钮上写的是**下一级**的价钱，不是这一级的
			buy.textContent = formatMoney(next.price)
			buy.disabled = !afford
			buy.title = afford ? `升级到${next.name}：${next.desc}` : '钱不够'
		} else {
			buy.textContent = '满级'
			buy.disabled = true
		}
		buttons.push(buy)

		// 还没买时显示第一级的名字，买了就显示当前档的 ——
		// 「打火机 Lv.1」比光写「打火机」更能说明这是条升级链
		//
		// ⚠ 取当前档走 `chainTier`（越界返回 null），**不要直接写 `chain[lv - 1]`**。
		//   等级是存档里的裸数字，链被改短之后它可能越界；而这一行跑在
		//   渲染循环里（ui.update → refreshStats → refreshShop），
		//   抛出去会连整个主循环一起打死 —— 1.18.0 的「读档后空屏」就是这么来的
		const cur = this.world.chainTier(id, lv)
		return this._shopRow({
			name: cur ? `${cur.name} Lv.${lv}` : chain[0].name,
			desc: next ? next.desc : '已经是最好的了',
			buttons,
		})
	}

	/**
	 * 工具栏上和烤制链相关的那两颗按钮。
	 *
	 * - 捕虫网：没买之前是 .locked（置灰 + 说明要先买）
	 * - 烤制：没买时整颗藏起来；买了之后文字跟着档位变成 打火机 / 喷火枪 / 烤炉
	 *
	 * ⚠ 名字是从 CONFIG 里取的，不是写死在 HTML 上的 ——
	 * 三档的名字在 config 里，改名字不用回来改这里
	 */
	refreshToolButtons() {
		const world = this.world
		const lv = world.shopLevel('roast')

		const hasNet = world.hasShopItem('net')
		this.el.btnNet.classList.toggle('locked', !hasNet)
		this.el.btnNet.title = hasNet
			? '点一下把附近的成虫网进最近的玻璃罐（N）'
			: '要先在商店买下捕虫网（$1.2）才能用'

		// 喷水枪和捕虫网同一套：没买之前 `.locked`（置灰 + 虚线框）但**仍然可点** ——
		// 点下去 setTool 会拦下来并提示去商店。做成 disabled 的话玩家会以为
		// 这颗按钮坏了，而不是「还没买」
		const hasSquirt = world.hasShopItem('squirt')
		this.el.btnSquirt.classList.toggle('locked', !hasSquirt)
		this.el.btnSquirt.title = hasSquirt
			? '按住左键喷水，冲掉地面上的尸体 / 污渍 / 蛹壳。滚轮改水线长短，Shift+滚轮转方向（W）'
			: `要先在商店买下喷水枪（${formatMoney(shopItem('squirt')?.price ?? 0)}）才能用`

		// —— 点火的两颗（打火机 / 喷火枪）——
		//
		// ⚠ 两颗**一直显示**，没买是 `.locked`（置灰 + 虚线框）但**仍然可点** ——
		//   点下去 setTool 会拦下来并说明原因。做成 disabled 或 hidden 的话，
		//   玩家会以为按钮坏了、或者根本不知道自己错过了什么。
		//   这和捕虫网 / 喷水枪是同一套
		//
		// ⚠ 名字和价格一律从 CONFIG.market.roastChain 取，不在这里另抄一份 ——
		//   抄了的话改了配置界面就成了假话
		const burnChain = chainOf('roast') ?? []
		const burnPairs = [
			[this.el.btnLighter, lv >= 1, burnChain[0], 0],
			[this.el.btnFlamer, lv >= 2, burnChain[1], 1],
		]
		for (const [btn, owned, tier, idx] of burnPairs) {
			if (!btn || !tier) continue
			btn.classList.toggle('locked', !owned)
			btn.title = owned
				? `${tier.desc}。按住左键对着成虫扫过去（R）`
				: idx === 0
					? `要先在商店买下${tier.name}（${formatMoney(tier.price)}）才能用`
					: `要先买下${burnChain[0].name}，再花 ${formatMoney(tier.price)} 升级到${tier.name}`
		}
	}

	/**
	 * 渲染投放弹窗。分两组 —— 食物类（苹果 / 金苹果）和其他（果蝇 / 玻璃罐），
	 * 分组和顺序来自 `CONFIG.market.feedCats`。
	 *
	 * 和 refreshShop 一样整块重建，理由也一样（行数很少，且只在钱变化时才调用）。
	 * 但**状态的语义完全不同**：商店的道具买了就变「已拥有」并从此禁用，
	 * 这里的消耗品可以反复买，按钮永远不会变成「已拥有」。
	 */
	refreshFeed() {
		// ⚠ 只改**食物那一组**的 items，其他组原样透传。
		//   `_renderCats` 靠 `group + ':' + cat.id` 拼折叠状态的键，
		//   重建一个新对象没问题；但把 jar / oven 那几组也过一遍 filter，
		//   迟早会漏掉一个 —— 而漏掉的表现是那一整组**静默消失**
		const cats = CONFIG.market.feedCats.map((c) =>
			c.id === 'food' ? { ...c, items: this.unlockedFoodIds() } : c,
		)
		this._renderCats(this.el.feedList, cats, (id) => this._feedRowFor(id), 'feed')
	}

	/**
	 * 现在该出现在**投放面板和图鉴**里的食物 id。
	 *
	 * ⚠ 抽成一个方法而不是在两边各写一次 filter：这是「什么算已解锁」的
	 *   **唯一定义**。抄一份的话，自检里那两条「图鉴画了几格 = 配置里有几项」
	 *   的断言会跟着一起漂 —— 而它们恰恰就是用来抓这种漂移的
	 */
	unlockedFoodIds() {
		return CONFIG.market.feedCats[0].items.filter((id) => id !== 'star' || this.starUnlocked)
	}

	/** 按 id 造出投放弹窗里的一行。认不出来返回 null */
	_feedRowFor(id) {
		// ⚠ desc 分「短」和「全」两份：这一行里还要塞两个带价格的按钮，
		// 留给说明文字的地方只有十来个字。只写全的那版会被 CSS 截成
		// 「进食时成长...」这种说了等于没说的东西 —— 短的那版保证看得完，
		// 全的那版挂在 title 上，鼠标停一下就能读到整句
		const TABLE = {
			apple: {
				name: '苹果',
				short: '虫都爱吃',
				desc: '幼虫和成虫都爱吃。烂了还会招来成虫',
				unit: foodPrice('apple'),
			},
			gold: {
				name: '金苹果',
				short: '成长 ×1.5',
				desc: '进食时成长快 1.5 倍 —— 但寿命也同比缩短，等于老得更快',
				unit: foodPrice('gold'),
				gold: true,
			},
			// 星空苹果：彩蛋解锁之后才出现（过滤在 unlockedFoodIds 里，不在这里）。
			// 概率从 config 现算，不写死 —— 调了 nebulaFromStar 这里跟着变
			star: {
				name: '星空苹果',
				short: '幼虫吃出「星云」',
				desc:
					`只有**幼虫**吃得出「星云」：每只幼虫一辈子只骰一次，` +
					`${(CONFIG.mutation.nebulaFromStar * 100).toFixed(0)}% 会带上。` +
					`成虫吃它没有任何事`,
				unit: foodPrice('star'),
				// 紫色而不是金色 —— 和它自己的配色一致
				arcane: true,
			},
			fly: {
				name: '果蝇',
				short: '补一批',
				desc: '补一批果蝇，尽量有雌有雄。场上 0 只成虫时免费',
				unit: flyPrice(),
			},
			// 玻璃罐：**不花钱**，所以没有 unit，按钮也不是「投 N 个」而是「摆一个」。
			// 它原来在工具栏上是一颗独立按钮，挪进来之后那儿撤掉了 ——
			// 同一个功能留两个入口的话，玩家得记两个地方
			jar: {
				name: '玻璃罐',
				short: '罐中寿命 ×2',
				desc: `摆一个透明玻璃罐，最多同时摆 ${CONFIG.jar.maxCount} 个。用捕虫网把果蝇网进去，在罐子里它们活得比外面久一倍`,
				free: true,
			},
			// 烤炉：**花钱，但一次只买一个** —— 这是第三种形态（见下面的 single 分支）。
			// 它从 1.18.0 起从烤制链里独立出来，挪到了这里：炉子不是「点火器的一档」，
			// 它是一条独立的赚钱路子（装 5 只 → 进度条 → 整炉卖钱）
			oven: {
				name: '烤炉',
				short: '整炉卖 ×' + CONFIG.roast.oven.mul,
				desc:
					`在屏幕上随便摆一个。戴手套抓最多 ${CONFIG.roast.oven.capacity} 只成虫放进去，` +
					`进度条满了自动按 ×${CONFIG.roast.oven.mul} 卖成钱（不留尸体）。` +
					`最多同时摆 ${CONFIG.roast.oven.maxCount} 个`,
				unit: ovenPrice(),
				single: true,
			},
		}

		const r = TABLE[id]
		if (!r) return null

		const buttons = []

		if (r.free) {
			const b = document.createElement('button')
			b.className = 'shop-buy'
			b.dataset.jar = '1'
			// ⚠ 上限是**看得到的**：满 4 个时置灰，而不是点了没反应。
			//   早先这颗按钮在工具栏上，撞上限是静默的 —— 玩家只能猜
			const full = this.world.jars.length >= CONFIG.jar.maxCount
			b.textContent = full ? '摆满了' : '摆一个'
			b.disabled = full
			if (full) b.title = `最多同时摆 ${CONFIG.jar.maxCount} 个`
			buttons.push(b)
		} else if (r.single) {
			// —— 第三种形态：花钱，但一次只买一个 ——
			//
			// ⚠ 复用下面那条 `[data-kind]` 委托，**不为它另开一条 [data-oven]**：
			//   那条委托已经是「投放里的东西怎么买」的**唯一**入口，
			//   再开一条的话「钱不够要置灰 / 撞上限要置灰」这两条规则会长出第二份
			const cost = r.unit
			const afford = this.world.money >= cost
			const full = this.world.ovens.length >= CONFIG.roast.oven.maxCount
			const b = document.createElement('button')
			b.className = 'shop-buy'
			b.dataset.kind = id // ⚠ 没有 data-n —— 它不是「投 N 个」
			b.textContent = full ? '摆满了' : '摆一个 ' + formatMoney(cost)
			b.disabled = full || !afford
			// 「撞上限」和「钱不够」是两件事，提示要分开说 ——
			// 早先罐子撞上限是静默的，玩家只能猜（见上面 free 分支那段注释）
			if (full) b.title = `最多同时摆 ${CONFIG.roast.oven.maxCount} 个`
			else if (!afford) b.title = '钱不够'
			buttons.push(b)
		} else {
			for (const n of FEED_QUANTITIES) {
				const cost = bulkPrice(r.unit, n)
				const afford = this.world.money >= cost
				const b = document.createElement('button')
				b.className = 'shop-buy'
				b.dataset.kind = id
				b.dataset.n = n
				b.textContent = '投' + n + ' ' + formatMoney(cost)
				b.disabled = !afford
				if (!afford) b.title = '钱不够'
				buttons.push(b)
			}
		}

		return this._shopRow({ name: r.name, desc: r.short, buttons, gold: !!r.gold, arcane: !!r.arcane })
	}

	/**
	 * 渲染图鉴：**格子式**列出这个世界里全部的食物和基因。
	 *
	 * ⚠ 内容**全部从 config 现算**，不在 UI 里另抄一份文案。
	 *   抄一份的话，改了数值界面就成了假话 —— 而图鉴恰恰是玩家用来
	 *   「查这个世界有什么」的地方，说假话比不说还糟。
	 *   所以倍数（×1.3 / ×2）和概率（2.9%）都是现场从
	 *   `CONFIG.mutation.types` 里读出来拼的。
	 *
	 * ⚠ 食物格子是**真的画出来的**（每格一个小 canvas），不是色块。
	 *   画法与场上那一份共用 `render.drawFoodIcon` —— 图鉴存在的意义就是
	 *   「让我认得出屏幕上那个是什么」，画得不一样就白做了。
	 *
	 * 只渲染一次（打开时），内容不会变。
	 *
	 * ⚠ 这里**有**一套「解锁」机制，只有一样东西：彩蛋解锁之前的星空苹果
	 *   和星云基因格都**不出现**。理由是剧透 —— 图鉴一打开就写着「星云：
	 *   吃星空苹果获得」，彩蛋在第一次开图鉴的时候就没了。
	 *   所以它们跟着 `unlockedFoodIds()` 一起进来，走的是同一个判据。
	 */
	refreshCodex() {
		const body = this.el.codexBody
		body.innerHTML = ''

		body.append(this._codexSection('食物', this.unlockedFoodIds(), (id) => this._codexFoodCell(id)))
		body.append(
			this._codexSection(
				'基因',
				CONFIG.mutation.types.map((t) => t.id).filter((id) => id !== 'nebula' || this.starUnlocked),
				(id) => this._codexGeneCell(id),
			),
		)
	}

	/** 图鉴里的一段：小标题 + 格子网格 */
	_codexSection(title, ids, cellFor) {
		const wrap = document.createElement('div')

		const head = document.createElement('div')
		head.className = 'shop-cat-name'
		head.textContent = title
		wrap.append(head)

		const grid = document.createElement('div')
		grid.className = 'codex-grid'
		grid.dataset.codex = title
		for (const id of ids) {
			const cell = cellFor(id)
			if (cell) grid.append(cell)
		}
		wrap.append(grid)
		return wrap
	}

	/** 一格食物：左边画出来，右边名字 + 说明 */
	_codexFoodCell(id) {
		const V = CONFIG.visual
		if (!V.food[id]) return null // 认不出来的食物类型

		const cell = document.createElement('div')
		cell.className = 'codex-cell'
		cell.dataset.food = id

		// ⚠ canvas 的**位图尺寸**要乘 dpr，CSS 尺寸由 .codex-icon 给。
		//   只设属性不设样式的话，高分屏上会显示成一个巨大的方块
		const css = 34
		const dpr = window.devicePixelRatio || 1
		const cv = document.createElement('canvas')
		cv.className = 'codex-icon'
		cv.width = Math.floor(css * dpr)
		cv.height = Math.floor(css * dpr)
		const ctx = cv.getContext('2d')
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.translate(css / 2, css / 2)
		// 种子固定：图鉴里的苹果每次打开都该是同一个形状
		drawFoodIcon(ctx, id, css * 0.72, 7)

		const text = document.createElement('div')
		text.className = 'codex-text'
		const name = document.createElement('div')
		name.className = 'codex-name'
		name.textContent = FOOD_NAME[id] ?? id
		const desc = document.createElement('div')
		desc.className = 'codex-desc'
		// 文字也从 config 现算：成长倍率是唯一的区别，价格也是配置里的。
		// ⚠ 成长倍率是**普通食物**之间的区别，星空苹果不吃这一套
		//   （它的倍率就是 1，写「成长 ×1」等于没说），所以那一种改说真正的用途
		const bonus = CONFIG.food.growthBonus[id] ?? 1
		desc.textContent =
			id === 'star'
				? `${formatMoney(foodPrice(id))} · 幼虫吃了有 ${(CONFIG.mutation.nebulaFromStar * 100).toFixed(0)}% 长出星云`
				: `${formatMoney(foodPrice(id))} · 成长 ×${bonus}`
		text.append(name, desc)

		cell.append(cv, text)
		return cell
	}

	/** 一格基因：胶囊 + 一句效果说明 + 出现概率 */
	_codexGeneCell(id) {
		const t = CONFIG.mutation.types.find((m) => m.id === id)
		if (!t) return null

		const cell = document.createElement('div')
		cell.className = 'codex-cell'
		cell.dataset.gene = id

		const badge = document.createElement('span')
		badge.className = 'gene-badge'
		badge.style.color = t.color
		badge.style.borderColor = t.color
		badge.textContent = t.icon + ' ' + t.name

		const text = document.createElement('div')
		text.className = 'codex-text'
		const name = document.createElement('div')
		name.className = 'codex-name'
		name.textContent = this._mutationEffect(t)
		const desc = document.createElement('div')
		desc.className = 'codex-desc'
		// ⚠ 概率那一行只对**会新发**的突变成立。星云的新发概率是 0，
		//   写「0.0%」是个看着精确的谎：玩家会读成「几乎抽不到」，
		//   而真相是「根本不在抽奖池里，只能吃出来」。
		//   所以它换一条判据，把来历写明。
		//   自检里那条配对的断言用的是同一个 t.chance > 0 分支
		const how = t.adultOnly ? '只在成虫显形' : '幼虫和成虫都显形'
		desc.textContent =
			t.chance > 0
				? `${(t.chance * 100).toFixed(1)}% · ${how}`
				: `${t.fromStar ? '吃星空苹果获得' : '无法自然获得'} · ${how}`
		text.append(name, desc)

		cell.append(badge, text)
		return cell
	}

	/**
	 * 把一条突变的配置**翻译成一句人话**。
	 *
	 * ⚠ 逐字段拼，不写死整句 —— 加一种突变、或者调了某个倍率，
	 *   这里自动跟着变。写死的话改了数值图鉴就开始说假话，
	 *   而假话没人会去核对（图鉴是最容易被当成「文档」的东西）
	 */
	_mutationEffect(t) {
		const bits = []
		if (t.lifespanMul) bits.push(`寿命 ×${t.lifespanMul}`)
		if (t.weightMul) bits.push(`体重 ×${t.weightMul}`)
		if (t.valueMul) bits.push(`价值 ×${t.valueMul}`)
		// 速度。⚠ 上面两个都是「越大越亏」的（寿命砍半、体重涨），
		// 这个是唯一一个**纯粹的好处**，所以单独排在价值后面
		if (t.speedMul) bits.push(`移动速度 ×${t.speedMul}`)
		if (t.auraMul) bits.push(`附近成虫价值 ×${t.auraMul}`)
		if (t.adultDamageMin) {
			bits.push(`随机咬死附近的同伴（${t.adultDamageMin}~${t.adultDamageMax} 点伤害）`)
		} else if (t.larvaDamage) {
			bits.push('随机咬死同伴')
		}
		if (t.id === 'stone') bits.push('失去飞行')
		if (t.id === 'crystal') bits.push('全身透明只剩描边')
		if (t.id === 'golden') bits.push('通体金色、带闪光')
		if (t.id === 'nebula') bits.push('身体是星云上的一扇窗（星空钉在屏幕上不动）')
		return bits.length ? bits.join(' · ') : t.name
	}

	/**
	 * 摆好食物投放区参考框。
	 *
	 * 位置**只由 CONFIG.food.zone 决定**，和 world 撒点用的是同一个 foodZoneRect() ——
	 * 各算各的话迟早会出现「框画在这儿、苹果落在那儿」。
	 *
	 * ⚠ 这个元素不进 _updateInteractive()：它是常驻的视觉元素，
	 * 参与进去的话整块区域的桌面点击都会被吞掉（和悬停卡片同一个教训）。
	 */
	refreshFoodZone() {
		const show = !!CONFIG.food.zone.show
		this.el.foodZone.classList.toggle('hidden', !show)
		if (!show) return

		const z = foodZoneRect(window.innerWidth, window.innerHeight)
		const s = this.el.foodZone.style
		s.left = z.x + 'px'
		s.top = z.y + 'px'
		s.width = z.w + 'px'
		s.height = z.h + 'px'
	}

	/**
	 * 刷新「罐中果蝇」列表。
	 *
	 * 刻意**不整块重建 DOM**：这个方法每 0.15 秒跑一次，而列表里的进度条和
	 * 剩余寿命是实时在变的。整块重建的话，一秒要销毁重建两百多个节点，
	 * 还会把玩家正悬停 / 正要点击的那一行换掉（手一抖就点空了）。
	 *
	 * 所以按「果蝇对象」缓存每一行的 DOM 引用：进出的果蝇才动结构，
	 * 留在罐里的只改进度条宽度和文字。
	 */
	refreshJarList() {
		const world = this.world

		// 场上一只罐子都没有 → 整扇窗都不出现（连标题条一起）。
		// 启动选择框开着时同理 —— 那是一个全屏模态，别让这个小窗浮在它上面
		const show = world.jars.length > 0 && !this.view.bootOpen
		const wasHidden = this.el.jarWindow.classList.contains('hidden')
		this.el.jarWindow.classList.toggle('hidden', !show)

		if (!show) {
			if (this.jarRows.size) {
				this.jarRows.clear()
				this.el.jarList.innerHTML = ''
			}
			// 窗没了，指针可能还「压」在它原来的位置上 —— 重新判一次
			if (!wasHidden) this._updateInteractive()
			return
		}

		// ⚠ 只在**刚出现**时摆位。已经摆过就别动 ——
		// 玩家可能已经把它拖到自己顺手的地方了，每次刷新都摆回右上角会很难受
		this._placeJarWindow()
		if (wasHidden) this._updateInteractive()

		const multi = world.jars.length > 1
		const alive = new Set()
		// 目标顺序。**先不要碰 DOM** —— 见方法末尾那段「顺序没变就一个节点都不碰」
		const desired = []

		for (let ji = 0; ji < world.jars.length; ji++) {
			const jar = world.jars[ji]
			for (const f of jar.flies) {
				alive.add(f)
				let row = this.jarRows.get(f)

				if (!row) {
					row = this._buildJarRow(f, jar)
					this.jarRows.set(f, row)
				}
				// 换过罐子（或是新建的行）要更新归属显示
				if (row._jarIndex !== (multi ? ji : -1)) {
					row._jarIndex = multi ? ji : -1
					row.idx.textContent = multi ? String(ji + 1) : ''
				}

				// 成长进度 = age / lifespan。体型就是按这个插值的，
				// 所以这个百分比同时也就是「长到多大了」
				const p = clamp(f.age / f.lifespan, 0, 1)
				row.bar.style.width = (p * 100).toFixed(1) + '%'
				row.pct.textContent = Math.round(p * 100) + '%'

				// 剩余寿命要**换算回真实时间**：罐中年龄推进只有 1/1.5 快，
				// 所以剩下的「果蝇时间」在外面相当于 1.5 倍。直接显示
				// lifespan - age 的话，数字会比玩家实际等待的时间少三分之一
				const leftMs = Math.max(0, (f.lifespan - f.age) * CONFIG.jar.lifespanBonus)
				row.life.textContent = this._mmss(leftMs)

				// 售价：和悬停卡片、出售区用的是同一个 fly.value，所以三处数字永远一致
				row.worth.textContent = formatMoney(f.value)

				row.el.classList.toggle('old', p > 0.75)
				row.el.title =
					`${f.sex === 'F' ? '雌' : '雄'}性 · 已活 ${this._mmss(f.age / CONFIG.jar.lifespanBonus)}` +
					`（寿命 ${this._mmss(f.lifespan / CONFIG.jar.lifespanBonus)}）· 售价 ${formatMoney(f.value)}` +
					` · 第 ${ji + 1} 个罐子`

				desired.push(row.el)
			}
		}

		// 收掉已经不在罐里的（被放逐、老死、或者连罐子一起被扔了）
		for (const [f, row] of this.jarRows) {
			if (alive.has(f)) continue
			row.el.remove()
			this.jarRows.delete(f)
		}

		this.el.jarred.textContent = alive.size

		// 顺序可能因为放逐 / 换罐子变了。appendChild 会把已在文档里的节点**移动**过去，
		// 所以这里一次性重排，不会有重复节点。
		//
		// ⚠ **顺序没变就一个节点都别碰。**
		// 这里原来是每 0.15 秒无条件重排一整批，等于把所有行「摘下 → 插回」一遍，
		// 两个后果都很难看：
		//
		//   1. 节点一离开文档 `:hover` 就丢了，而**在原处重新插入不会重新触发**
		//      hover 判定（鼠标没动）。于是指针停在某一行上时，行底色以 6.7Hz 闪。
		//   2. 「摘下 → 插回」那一瞬间如果正好赶上 mouseup，`click` 的落点会算到
		//      mousedown / mouseup 的**公共祖先**（列表容器）上，而不是按钮上 ——
		//      按钮的监听器根本不会被调用。表现就是「出售 / 放逐点了没反应」。
		//
		// 正常情况下顺序压根不会变（果蝇没进出罐子），所以这两件事本来就不该发生
		const cur = this.el.jarList.children
		let same = cur.length === desired.length
		if (same) {
			for (let i = 0; i < desired.length; i++) {
				if (cur[i] !== desired[i]) {
					same = false
					break
				}
			}
		}
		if (!same) {
			const fragment = document.createDocumentFragment()
			for (const el of desired) fragment.appendChild(el)
			this.el.jarList.appendChild(fragment)
		}

		if (alive.size === 0) {
			if (!this.el.jarList.querySelector('.jar-empty')) {
				const tip = document.createElement('div')
				tip.className = 'jar-empty'
				tip.textContent = '罐子是空的 —— 拿捕虫网（N）去网几只'
				this.el.jarList.appendChild(tip)
			}
		} else {
			const tip = this.el.jarList.querySelector('.jar-empty')
			if (tip) tip.remove()
		}
	}

	/** 造一行「罐中果蝇」。只在果蝇刚进罐时调用一次，之后都是原地改内容 */
	_buildJarRow(fly, jar) {
		const el = document.createElement('div')
		el.className = 'jar-row'

		const idx = document.createElement('span')
		idx.className = 'jar-idx'

		const sex = document.createElement('span')
		sex.className = 'jar-sex ' + (fly.sex === 'F' ? 'female' : 'male')
		sex.textContent = fly.sex === 'F' ? '♀' : '♂'

		const barBox = document.createElement('span')
		barBox.className = 'jar-bar'
		const bar = document.createElement('i')
		barBox.appendChild(bar)

		const pct = document.createElement('span')
		pct.className = 'jar-pct'

		const life = document.createElement('span')
		life.className = 'jar-life'

		// 售价：金色，和游戏币 / 出售区同一套语言。
		// 罐子里的是你特意存下来的，值多少钱是这一刻最该看到的信息
		const worth = document.createElement('span')
		worth.className = 'jar-worth'

		// 快捷出售：不用先放逐、再抓住、再拖到出售区 —— 一步到位。
		// 存稀有的品种本来就是「养大了卖」，「先放出来再卖」中间那一步纯属白费
		const sell = document.createElement('button')
		sell.className = 'jar-sell'
		sell.textContent = '出售'
		sell.title = '直接卖掉这只，立刻换游戏币'
		// 用闭包里的 fly，而不是每次重新查 —— 行是被缓存的，
		// 靠下标去数组里找的话，卖掉一只之后所有行都会指错
		sell.addEventListener('click', () => {
			const gain = this.world.sellFly(fly)
			if (gain <= 0) return
			this._flashHint(`卖掉了，+${formatMoney(gain)}`)
			this.refreshStats()
		})

		const drop = document.createElement('button')
		drop.className = 'jar-drop'
		drop.textContent = '放逐'
		drop.title = '把这只放回屏幕，恢复自由（寿命加成同时取消）'
		drop.addEventListener('click', () => {
			const jarNow = this.world.jarOf(fly)
			if (jarNow) this.world.releaseFly(jarNow, fly)
		})

		el.append(idx, sex, barBox, pct, life, worth, sell, drop)
		return { el, idx, bar, pct, life, worth }
	}

	/** 毫秒 → m:ss */
	_mmss(ms) {
		const total = Math.max(0, Math.round(ms / 1000))
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
	}
}
