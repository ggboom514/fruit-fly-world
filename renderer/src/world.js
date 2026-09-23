/**
 * world.js — 世界状态机
 *
 * 这里集中管理所有「生命周期转折点」：孵化、羽化、自然死亡、配对、产卵。
 * 实体自己不会销毁自己，全部由这一层统一裁决，好处是：
 *   - 不会有某个实体在别处被删掉、这里还在引用它
 *   - 统计数字只有一个来源，不会算重或算漏
 */

import { CONFIG, clamp, rand, randInt, foodZoneRect, FOOD_DRAW_RADIUS } from './config.js'
import { TAU, dist2, pick, angleLerp } from './utils.js'
import { rollDeNovo, hasMutation, isGoldAuraSource, cleanGenes } from './mutations.js'
import { chainOf, keeperOptions, valueTierOf, magnifierDefaultTiers, sanitizeTiers } from './market.js'
import {
	Fly,
	Egg,
	Larva,
	Food,
	Jar,
	Shell,
	Remains,
	Oven,
	Particle,
	FloatText,
	snapshot,
	revive,
} from './entities.js'
import { shopItem, foodPrice, flyPrice, bulkPrice, formatMoney } from './market.js'

/**
 * 读档时取一个数值：不是有限数就退回默认值。
 *
 * 存档是磁盘上的文件，可能被手改过、也可能是写到一半断电留下的。
 * 一个 undefined 或 NaN 混进计时器，会让整个世界在几步之内烂掉，
 * 而且现象是「果蝇乱飞」这种和存档八竿子打不着的样子 —— 所以在入口就拦住。
 */
function safeNum(v, fallback) {
	return Number.isFinite(v) ? v : fallback
}

export class World {
	constructor(width, height) {
		this.w = width
		this.h = height

		this.flies = []
		this.larvae = []
		this.eggs = []
		this.foods = []
		this.jars = [] // 玻璃罐。罐里的果蝇挂在各自的 jar.flies 上，不在 this.flies 里
		this.shells = [] // 羽化后留下的蛹壳，只能用「手套」拖进垃圾桶
		this.remains = []
		this.ovens = [] // 烤炉。炉里的果蝇挂在 oven.items 上，只在 lv3 解锁后才会有

		// 设置。**进存档** —— 玩家切到烦人模式之后重开，不该悄悄退回正常的
		this.settings = { annoying: false }

		/**
		 * 鼠标「挥手」的惊扰状态，由 UI 每帧写入（见 ui.update）。
		 *
		 * power 0~1：0 = 手没动，1 = 全速甩。x / y 是指针位置。
		 * ⚠ 它是**纯表现层**的输入，不进存档 —— 存档里躺着一个「鼠标正在甩」
		 * 是说不通的，读档回来也没有那只手了
		 */
		this.startle = { x: 0, y: 0, power: 0 }

		/**
		 * 当前工具的特效状态。由 `ui.update()` 每帧写，`_emitToolFx` 读。
		 *
		 * ⚠ 和 startle 同一套：**不进存档**，而且初始必须是「什么都没有」——
		 *   存档里存着一只早就放下的打火机是说不通的
		 */
		this.toolFx = {
			on: false,
			tool: 'none',
			x: 0,
			y: 0,
			// 大火焰还是小火焰（喷火枪 = true）。⚠ 这里以前是个 `level` 数字，
			// 因为烤制链当时有三档；现在只有打火机 / 喷火枪两档，
			// 一个布尔比一个「只能取 1 或 2 的数字」贴切
			big: false,
			len: 0, // 水线长度
			angle: 0, // 水线角度
			radius: 0, // 扫帚半径
			scrub: 0, // 抹布这一帧擦了多远
			down: false, // 左键按着没有
			rate: 0, // 每秒几颗（由 UI 按上面的状态算好）
			acc: 0, // 时间累加器
		}

		/**
		 * 烧着的蝇身上的火苗的时间累加器。
		 *
		 * ⚠ 和 toolFx.acc 一样是**纯表现层**，不进存档；
		 *   而且它是**全场共用一个**而不是每只蝇一个 —— 理由见 `_emitBurnFx`
		 */
		this.burnAcc = 0

		this.particles = []
		this.wipeTrail = [] // 抹布拖尾 { x, y, life }
		this.floatTexts = [] // 往上飘的字（烤炉卖出 +$x）。纯表现层，不进存档

		this.swarm = { active: false, timer: rand(CONFIG.swarm.idleMin, CONFIG.swarm.idleMax), x: 0, y: 0, left: 0 }
		this.mateScanTimer = 0
		this.foodTimer = 0

		this.timeScale = 1
		this.paused = false
		this.elapsed = 0

		// 窝号的发号器。只增不减，所以同一窝的幼虫永远认得彼此，
		// 而不同窝的绝不会撞号。0 是保留值（= 没有窝：手动投放的、老存档里的）
		this.nextClutch = 1

		// 经济。和生态完全分开：生态那边不知道有钱这回事，照常繁殖死亡。
		// shop 用**对象**而不是布尔字段，是为了以后加商品不用改结构
		this.money = 0
		this.shop = {}

		/**
		 * 养蝇人的配置（买了之后玩家自己调的：投什么、卖什么……）。
		 *
		 * ⚠ **不塞进 this.shop**。那个袋子是「键 → 数字等级 / true」的扁平结构，
		 *   shopLevel 靠 Number.isFinite 过滤；往里面塞字符串和对象虽然不会崩，
		 *   但两套语义混在一个袋子里，下一个读代码的人一定会误判。
		 *
		 * 形状跟着 this.settings 走（另一个「形状不同的持久偏好袋」）：
		 * 存档时整份存，读档时**合并到默认值上**，所以以后加新字段老存档自动兼容
		 */
		this.keeper = this._freshKeeper()
		// 养蝇人的检查计时器。⚠ 不进存档 —— 它只有 2 秒量级，
		// 读档时归零 = 立刻查一次，正是想要的
		this.keeperTimer = 0

		/**
		 * 放大镜高亮哪几档**价值档**（valueTiers 的 id 数组）。
		 *
		 * ⚠ 和 this.keeper 一样**不塞进 this.shop**：那个袋子是
		 *   `shop[id] = 等级 / true` 的扁平结构，`hasShopItem` 是 `!!` 语义 ——
		 *   往里塞一个数组会让放大镜看起来「已拥有」，于是买不了。
		 *
		 * ⚠ 用**数组**不用 Set：snapshot() 只认「原始值 / Array / 纯对象」，
		 *   Set 会从三条分支中间掉下去、字段静默不进存档（同 mutation 那个坑）
		 */
		this.magnifierTiers = magnifierDefaultTiers()

		this.stats = this._freshStats()

		/**
		 * 这一局里**出现过**的突变 id（图鉴拿它决定哪一格点亮）。
		 *
		 * ⚠ 名字叫 seen 而不是 owned：一只带「疯狂」的虫只要**出生**过就算数，
		 *   哪怕它当场就被同类咬死 —— 图鉴记的是「这个世界里有这种东西」，
		 *   不是「你现在养着一只」。
		 *
		 * ⚠ **不是世界状态，不进 serialize()**（那份字段表是手写的，不加就进不去）。
		 *   它的真身在 UI 那边、落在 unlock.json 里。这里只是个**当场的收件箱**：
		 *   世界往里丢，app.js 每帧把它抽干、交给 ui 去合并和落盘
		 *
		 * ⚠ 必须是普通 Array，不能是 Set —— 同 config.js 里那条注释
		 *
		 * ⚠ **在 reset() 里清掉**。它是「这个世界的观察记录」，
		 *   而重置就是换一个世界 —— 留着的话，重置前一帧出生的那只虫
		 *   还躺在收件箱里，重置完立刻被抽干、把新世界的图鉴点亮一格。
		 *   用户要的是「重置之后图鉴从 0 开始」，所以这里必须断干净
		 */
		this.seenGenes = []

		this.reset()
	}

	/**
	 * 记下「这些基因在这个世界里出现过」。认不出来的 id 照收 ——
	 * 过滤是 UI 那边的事（它只管点亮配置里存在的格子）。
	 */
	_noteGenes(genes) {
		if (!Array.isArray(genes)) return
		for (const id of genes) {
			if (typeof id !== 'string' || !id) continue
			if (!this.seenGenes.includes(id)) this.seenGenes.push(id)
		}
	}

	/**
	 * 养蝇人配置的默认值。
	 *
	 * ⚠ 读档时是**合并到这份默认值上**的（见 restore），
	 * 所以以后往这里加字段，老存档会自动拿到默认值，不用改存档版本号。
	 */
	_freshKeeper() {
		return {
			food: 'apple', // 自动投什么
			foodN: 3, // 一次投几个
			sell: false, // 自动出售总开关（Lv2 才有意义）
			// 卖哪一档**价值档**（valueTiers 的 id），不是体重档。
			//
			// ⚠ 这个键以前叫 rarity（存的是 'normal'/'mutant'/'extreme'）。
			//   改名之后老存档里那个旧键会变成一个**多余的字段** ——
			//   restore 是 Object.assign 到这份默认值上的，多出来的键不会报错，
			//   而 tier 会拿到默认值 'common'。所以**不用升存档版本号**
			tier: 'common',
			// ⚠ 这里原来还有个 `minValue`（「价值 ≥ 某个数才卖」）。
			//   配套的那根价格滑条删掉之后，这个字段也删了 ——
			//   留着它就是一个**看不见的筛选条件**：界面上没有任何地方
			//   能看出它存在，也没法改，可它照样在 _keeperSell 里拦人。
			//   老存档里那个键会变成一个多余字段，restore 是 assign 上去的，
			//   不会报错也不会有影响，所以**不用升存档版本号**
			mutants: false, // 要不要把带突变的也一起卖
			fed: 0, // 累计自动投放次数（只用于显示）
			sold: 0, // 累计自动卖出只数（只用于显示）
		}
	}

	_freshStats() {
		return {
			deaths: 0, // 总死亡数（UI 显示这个）
			natural: 0, // 其中自然老死
			swatted: 0, // 其中被拍死
			starved: 0, // 其中幼虫饿死（抢不到进食名额，见 CONFIG.larva.starveMin）
			killed: 0, // 其中被疯狂蝇咬死（成虫和幼虫都算）
			eggsLaid: 0, // 累计产卵数
			emerged: 0, // 累计羽化数
			sold: 0, // 累计卖掉的成虫数（经济那一条回路）
			// 累计**赚到**过多少钱（金额，不是只数）。食物的解锁门槛和成就的
			// 财富档位都读它 —— 见 `lifetime` getter。
			//
			// ⚠ 它和 `money` 是**两回事**：`money` 会因为你买东西而减少，
			//   而这个只增不减。用 `money` 当门槛的话，玩家花 $0.01 买个苹果
			//   就可能把刚拿到的成就「退回去」，下一次再涨回来又会重放一遍横幅
			earned: 0,
		}
	}

	/**
	 * 「总财富」—— 从开局到现在一共赚到过多少钱。
	 *
	 * ⚠ **不是 `money`。** `money` 是「现在手里还有多少」，买工具会把它花掉；
	 *   这个只认进账，所以成就和食物门槛不会因为花钱而倒退。
	 *   用户明确选的就是这个口径（现金那个口径会因为买工具而缩水）。
	 *
	 * ⚠ 只统计 `_creditSale()` 那一处 —— 也就是**真的卖了东西**。
	 *   `buyFood` / `buyFlies` / `buyOven` 里那三次 `this.money +=` 是
	 *   「没放下的退钱」，不是收入，**不该**算进来
	 */
	get lifetime() {
		return this.stats.earned ?? 0
	}

	// ================================================================
	//  重置 / 投放
	// ================================================================

	reset() {
		this.flies.length = 0
		this.larvae.length = 0
		this.eggs.length = 0
		this.foods.length = 0
		this.jars.length = 0
		this.shells.length = 0
		this.remains.length = 0
		this.ovens.length = 0
		this.particles.length = 0
		this.wipeTrail.length = 0
		this.floatTexts.length = 0

		this.stats = this._freshStats()
		this.elapsed = 0
		this.swarm.active = false
		this.swarm.timer = rand(CONFIG.swarm.idleMin, CONFIG.swarm.idleMax)
		this.foodTimer = rand(CONFIG.food.autoIntervalMin, CONFIG.food.autoIntervalMax)

		// 「重置」是清空重来，钱和已购道具也一起清掉 ——
		// 留着钱的话，重置就变成了「刷钱」按钮
		this.money = 0
		this.shop = {}
		// 养蝇人的配置也一起清 —— 它和 shop 一样是「买了才存在」的，
		// 属于这一局养成的东西。（和 settings 不同，那是个**偏好**，
		// 见下面那条注释）
		this.keeper = this._freshKeeper()
		this.keeperTimer = 0
		// ⚠ 放大镜的档位也要清回默认。忘了的话「重置」之后
		//   上一局勾的档位会留着 —— 那和「钱和道具都清了、档位没清」一样莫名其妙
		this.magnifierTiers = magnifierDefaultTiers()
		// ⚠ settings **不在这里清**。它是个**偏好**，不是这一局养成的东西 ——
		// 顺手把模式退回正常的话，玩家在烦人模式下每重置一次就得回去重设一次

		// ⚠ 「本场观察到的事件」收件箱也一起清。
		//   不清的话，重置**前一帧**刚出生的那只虫还躺在里面，
		//   重置完立刻被主循环抽干、把图鉴又点亮一格 —— 而那个世界已经没了
		this.seenGenes.length = 0

		// 开局的这几只**不骰突变**，全是野生型。
		//
		// ⚠ 这里**曾经**是反的：那几只各骰一次 rollDeNovo()，理由是
		//   「不然玩家要等整整一代才见得到第一个变异，新功能开局看不见」。
		//   改成不骰是因为用户要「重置之后图鉴从 0 开始」——
		//   开局就白送一格点亮的话，那句话就是假的
		//   （实测：这批骰出至少一个变异的概率约六成，重置完图鉴往往是花的）
		//
		//   代价：重置后想见到第一个变异要等一整代，或者自己去喂星空苹果。
		//   这是刻意的，别按「开局要有东西看」把它改回去
		const W = CONFIG.world
		for (let i = 0; i < W.initialFemales; i++) {
			this.addFly(rand(0, this.w), rand(0, this.h), 'F')
		}
		for (let i = 0; i < W.initialMales; i++) {
			this.addFly(rand(0, this.w), rand(0, this.h), 'M')
		}
		for (let i = 0; i < W.initialLarvae; i++) {
			this.addLarva(rand(0, this.w), rand(0, this.h))
		}

		// 开局先摆一份食物，不然前十几分钟屏幕是空的、也没什么可看的
		this.dropFood()
	}

	/**
	 * 「投放」面板里的投蝇：一次补 n 只，尽量保证有雌有雄。
	 * 返回**实际加进去的只数**（撞上 maxAdults 时会少于 n）。
	 *
	 * 性别仍然交替，但**从哪一性开始是随机的**：
	 * 原来写死 `i % 2 === 0 ? 'F' : 'M'`，n=2 时确实一雌一雄，
	 * 但 n=1 就永远出雌性 —— 面板上「投 1 只」是个常规选项，不能有这种偏向。
	 */
	spawnBatch(n = CONFIG.world.spawnBatch) {
		const first = Math.random() < 0.5 ? 'F' : 'M'
		let placed = 0
		for (let i = 0; i < n; i++) {
			const sex = i % 2 === 0 ? first : first === 'F' ? 'M' : 'F'
			// ⚠ 明确传**空数组**（野生型），不要让它顺手骰一次新发突变。
			//   投放是花固定价钱买的，能骰出变异就等于「买彩票」——
			//   价格是按野生型的价值定的，出了变异就是正期望，可以无限刷钱。
			//   想要变异体，得自己养一代（这正是突变系统的意义）
			if (!this.addFly(rand(0, this.w), rand(0, this.h), sex, null, [])) break
			placed++
		}
		return placed
	}

	/**
	 * 花钱。钱不够时返回 false **且不扣款** —— 和 buyShopItem 同一条规矩：
	 * 失败的操作不该留下任何痕迹。
	 */
	spend(amount) {
		if (!Number.isFinite(amount) || amount < 0) return false
		if (this.money < amount) return false
		this.money -= amount
		return true
	}

	/** 窗口尺寸变了 */
	resize(w, h) {
		this.w = w
		this.h = h
		// 别让实体卡在新边界外面
		for (const list of [this.flies, this.larvae, this.eggs, this.remains]) {
			for (const e of list) {
				e.x = clamp(e.x, 0, w)
				e.y = clamp(e.y, 0, h)
			}
		}
		// 罐子是个矩形，横竖两个方向要分别按半宽 / 半高来夹 ——
		// 只夹中心点的话，能有大半个罐子留在屏幕外，而玩家拖不回来
		// （拖动的 clamp 用的是同一个边界）
		for (const j of this.jars) {
			j.x = clamp(j.x, j.halfW, Math.max(j.halfW, w - j.halfW))
			// ⚠ 上边界用 topHalfH（含盖子），下面才是 halfH ——
			// 盖子坐在罐身上沿之上，用 halfH 夹的话它会露到屏幕外面去
			j.y = clamp(j.y, j.topHalfH, Math.max(j.topHalfH, h - j.halfH))
		}
		// 烤炉没有盖子，横竖都是对称的，直接按半宽半高夹
		for (const o of this.ovens) {
			o.x = clamp(o.x, o.halfW, Math.max(o.halfW, w - o.halfW))
			o.y = clamp(o.y, o.halfH, Math.max(o.halfH, h - o.halfH))
		}
	}

	// ================================================================
	//  生成（带软上限）
	// ================================================================

	/**
	 * @param {string} [rarity] 稀有度 id。不传就让 Fly 自己抽 ——
	 *   所有的成虫来源（开局、投放、羽化）都不传，所以稀有度是**统一**的，
	 *   不存在「只有繁殖出来的才会变异」这种隐藏规则
	 * @param {string[]} [mutations] 基因。**由调用方决定**，这个函数自己骰 ——
	 *   羽化时传幼虫那套（遗传），开局投放传 null（现骰），
	 *   花钱买的那两只**明确传空数组**（见 buyFlies 里为什么）
	 */
	addFly(x, y, sex, rarity = null, mutations = null) {
		if (this.flies.length >= this.maxAdults) return null
		if (this.atPopCap) return null
		const f = new Fly(x, y, sex, rarity, mutations)
		this.flies.push(f)
		// ⚠ 在撞上限的 early return **之后**才记：没真正生出来的不算「见过」。
		//   这一句是成虫的唯一入口，买来的 / 网进罐子的 / 开局那几只都从这里过
		this._noteGenes(f.mutations)
		return f
	}

	/**
	 * 领一个新的窝号。每产一窝领一次。
	 *
	 * 这个号会一路跟着这一窝：卵带上它 → 孵出来的幼虫继承它。
	 * 「同窝的卵差不多同时孵」和「同窝的幼虫更容易凑到一起」都靠它。
	 */
	newClutch() {
		return this.nextClutch++
	}

	/**
	 * @param {{length:number, slim:number}|null} shape 这一批的体型性状（从母体一路传下来）
	 * @param {number} clutch 窝号（从那枚卵继承下来）
	 * @param {string[]} [mutations] 基因（从那枚卵继承下来）。
	 *   ⚠ 只能**追加在末尾** —— tools/simulate.js 有好几处按位置传
	 *   `(x, y, null, clutch)`，插在 clutch 前面的话窝号会被当成基因数组
	 */
	addLarva(x, y, shape = null, clutch = 0, mutations = null) {
		if (this.larvae.length >= this.maxLarvae) return null
		if (this.atPopCap) return null
		const l = new Larva(x, y, shape, clutch, mutations)
		this.larvae.push(l)
		this._noteGenes(l.mutations) // 同上：幼虫也带基因，见 addFly 那段
		return l
	}

	/**
	 * 产下一颗卵。由母体的产卵流程调用。
	 * @param {number} scale 尺寸倍率，来自母体的「卵大小」个性
	 * @param {{length:number, slim:number}|null} shape 这一批的幼虫体型性状
	 * @param {number} clutch 窝号
	 * @param {number} hatchBase 这一窝共用的基准孵化时间（毫秒）
	 * @param {string[]} [mutations] 这颗卵的基因 —— 由母体在 _lay 里**为它单独骰一次**
	 *   （`rollDeNovo()`）。⚠ 和父母的基因没有任何关系，见 mutations.js 文件头
	 */
	spawnEgg(x, y, scale = 1, shape = null, clutch = 0, hatchBase = null, mutations = null) {
		if (this.eggs.length >= this.maxEggs) return null
		if (this.atPopCap) return null
		const e = new Egg(x, y, scale, shape, clutch, hatchBase, mutations)
		this.eggs.push(e)
		this.stats.eggsLaid++
		// 卵也算 —— 「养成过」包括了还没孵出来的那一段。
		// 不放这一句的话，一窝刚产下就被吃掉的卵会整窝漏记
		this._noteGenes(e.mutations)
		return e
	}

	/**
	 * @param {object|null} [fly] 留下这具尸体的那只果蝇。传了就顺手把它的
	 *   售价 / 稀有度 / 性别抄进尸体 —— 尸体现在能烤能卖，靠的就是这几个值。
	 *   汁渍（stain）不传，它永远卖不掉
	 */
	addRemains(x, y, kind, size, angle, fly = null) {
		// 残留物是唯一会无限堆积的东西，超上限就丢最老的
		if (this.remains.length >= CONFIG.remains.maxCount) this.remains.shift()
		const r = new Remains(x, y, kind, size, angle, fly)
		this.remains.push(r)
		return r
	}

	/**
	 * 在指定位置放一份食物。
	 *
	 * @param {number|null} [size] 指定尺寸。⚠ **只有测试会传**——正常路径
	 *   （投放 / 开局 / 自动投食）一律走 `dropFoods`，尺寸是随机抽的。
	 *   测试传它是为了让断言确定：size 牵动 durability / maxEaters / 各种判定半径，
	 *   随机尺寸会让同一套代码这次抽到 24、下次抽到 190，断言只能时红时绿
	 */
	addFood(x, y, type, size = null) {
		if (this.foods.length >= CONFIG.food.maxCount) return null
		const food = new Food(x, y, type ?? pick(CONFIG.food.types), size)
		this.foods.push(food)
		return food
	}

	/**
	 * 一次投放 n 份水果，位置在**投放区**里随机撒。
	 *
	 * 这是**免费**的内部投放：开局的见面礼和 autoSpawn 走这里，
	 * 它们是系统给的，不该找玩家收钱。玩家点按钮走的是 buyFood()。
	 *
	 * 返回实际放下几份 —— 上限卡住时会少于 n，调用方要靠这个数决定收多少钱、
	 * 要不要给提示。早先这个函数返回 null 而按钮丢掉返回值，
	 * 于是「点了没反应」，看着像按钮坏了。
	 */
	dropFoods(type, n) {
		const F = CONFIG.food
		let placed = 0
		for (let i = 0; i < n; i++) {
			if (this.foods.length >= F.maxCount) break

			// 投放区用**归一化**坐标存，所以这里换算一次就同时适配了任何分辨率。
			// 再按最大果子的半径内缩，免得苹果有一半挂在区外。
			//
			// ⚠ 内缩量用的是**绘制半径**，不是 size/2。
			//   drawAppleScrap 的顶点半径是 `size/2 × (0.66~1.22)`，
			//   也就是最大 `size × 0.61` —— 早先按 `sizeMax * 0.5` 内缩，
			//   在 30px 的果子年代差 3px 看不出来，到 200px 就是差 22px，
			//   最坏情况果子会压出投放区、甚至切到屏幕外
			const z = foodZoneRect(this.w, this.h)
			const pad = F.sizeMax * FOOD_DRAW_RADIUS
			const zw = Math.max(0, z.w - pad * 2)
			const zh = Math.max(0, z.h - pad * 2)
			// ⚠ zw/zh 被 Math.max 夹成 0 时（窗口太小，装不下一个最大果子），
			//   所有食物都会落在 `z.x + pad` 这**同一个点**上。不会崩，
			//   但看起来像「一次投 10 个只出来 1 个」。这是小窗口下的必然结果，
			//   不额外兜底 —— 想避免就把 sizeMax 调小，或者把窗口开大
			const x = z.x + pad + rand(0, zw)
			const y = z.y + pad + rand(0, zh)

			const food = new Food(x, y, type ?? pick(F.types))
			this.foods.push(food)
			placed++
		}
		return placed
	}

	/** 丢一份水果。开局和 autoSpawn 用的薄包装 */
	dropFood(type) {
		return this.dropFoods(type, 1) > 0
	}

	/**
	 * 花钱买 n 份水果。返回**实际买到的份数**（0 = 没买成）。
	 *
	 * ⚠ 按**实际放下的份数**收费，不是按请求数量：上限只剩 3 个空位时点「投 10 个」，
	 * 只收 3 份的钱、把剩下 7 份退回来。先全额扣再退，比「先算能放几个再扣」少一次
	 * 重复的上限推算 —— 上限只在 dropFoods 里判一次，不会两处算法漂移。
	 */
	buyFood(type, n) {
		const unit = foodPrice(type)
		if (!this.spend(bulkPrice(unit, n))) return 0
		const placed = this.dropFoods(type, n)
		if (placed < n) this.money += bulkPrice(unit, n - placed) // 没放下的退钱
		return placed
	}

	/**
	 * 花钱补 n 只果蝇。返回实际补到的只数（0 = 没买成）。
	 *
	 * 和买食物一样：按**实际补到的只数**收费，撞上 maxAdults 没补上的部分退钱。
	 *
	 * ⚠ 这里**没有**「场上没蝇了就免费」那类保底（早先有过一版）。
	 * 后果是：钱花光之后如果又断了代（没有成虫可卖），就真的动不了了，
	 * 只能点重置。这是有意接受的 —— 保底会让「留一手钱」这件事失去意义。
	 */
	buyFlies(n) {
		const unit = flyPrice()
		if (!this.spend(bulkPrice(unit, n))) return 0
		const placed = this.spawnBatch(n)
		if (placed < n) this.money += bulkPrice(unit, n - placed) // 没补上的退钱
		return placed
	}

	/**
	 * 把一份食物直接销毁（玩家把它拖进垃圾桶）。
	 *
	 * 刻意**不留污渍** —— 它是被扔掉的，不是烂在地上被啃光的，
	 * 两者不该混为一谈，否则垃圾桶就成了「制造垃圾」的按钮。
	 */
	discardFood(food) {
		if (!food || food.dead) return false
		food.dead = true
		this.burstDust(food.x, food.y, 8) // 一点点灰尘，给个「扔掉了」的反馈
		return true
	}

	// ================================================================
	//  玻璃罐
	//
	//  罐中果蝇挂在 jar.flies 上，**不在 this.flies 里** —— 所以交配、苍蝇拍、
	//  生命周期结算这些只遍历 this.flies 的地方，天然碰不到它们。
	//  需要单独照顾的只有三件事：更新、死亡结算、存档。
	// ================================================================

	addJar(x, y) {
		if (this.jars.length >= CONFIG.jar.maxCount) return null
		const jar = new Jar(x, y)
		this.jars.push(jar)
		return jar
	}

	/** 「玻璃罐」按钮：在屏幕上随便找个地方摆一个（保证整个罐子都在屏内） */
	dropJar() {
		if (this.jars.length >= CONFIG.jar.maxCount) return null
		const mx = CONFIG.jar.width / 2 + 12
		const my = CONFIG.jar.height / 2 + 12
		const x = rand(Math.min(mx, this.w / 2), Math.max(this.w - mx, this.w / 2))
		const y = rand(Math.min(my, this.h / 2), Math.max(this.h - my, this.h / 2))
		return this.addJar(x, y)
	}

	/**
	 * 扔掉一个罐子。**里面的果蝇全部放出来，不会跟着消失。**
	 *
	 * ⚠ 早先这里是 `jar.flies.length = 0` —— 一拖进垃圾桶，整罐的蝇就没了。
	 * 那条规则在「罐子只是临时关押」的年代还说得过去，现在不行了：
	 * 罐子能存稀有品种、寿命还是外面的两倍，误删一整罐的代价太大。
	 * 而且玩家拖罐子进垃圾桶的本意几乎总是「腾个位置摆新的」，
	 * 不是「把我存的这些全杀了」。
	 *
	 * 放出来的蝇会散落在罐子周围（见 releaseFly），所以不会一出来就挤成一坨。
	 */
	discardJar(jar) {
		if (!jar || jar.dead) return false

		// 先把里面的放出来。releaseFly 会从 jar.flies 里 splice，
		// 所以必须遍历**快照** —— 直接遍历原数组会跳着走、漏掉一半
		for (const f of jar.flies.slice()) this.releaseFly(jar, f)

		jar.dead = true

		// 立刻从数组里摘掉，而不是只打个 dead 标记等 _updateJars 来收。
		// 等下一帧的话，这一帧里 counts.jars 和面板上的罐中列表都还看得见它 ——
		// 表现是「拖进垃圾桶了，但罐子还在列表里闪一下」。
		// 别的实体可以慢慢收是因为它们不影响 UI 结构，罐子会。
		const i = this.jars.indexOf(jar)
		if (i >= 0) this.jars.splice(i, 1)

		this.burstDust(jar.x, jar.y, 10)
		return true
	}

	// ================================================================
	//  烤制：牙签 → 烤串 → 出售
	//
	//  牙签串起一只**活**成虫，它就从 this.flies 里摘出去了（不再飞、
	//  不再老化、拍不到也网不到），售价在那一刻冻结。烤过之后牙签消失，
	//  剩一具烤好的果蝇躺在地上，戴手套拖进出售区换钱。
	//
	//  ⚠ 烤炉里的果蝇挂在 oven.items 上（同样不在 this.flies 里）。
	//  需要单独照顾的仍然只有那三件事：更新、死亡结算、存档。
	// ================================================================

	/**
	 * 当前手里那档点火器（打火机 / 喷火枪），没买是 null。
	 *
	 * 档位查找走 `chainTier`，不在 world 里写死等级上限 —— 加一档只改 config
	 */
	burnTier() {
		return this.chainTier('roast', this.shopLevel('roast'))
	}

	/**
	 * **手里这一把**点火器的判定半径（px）。
	 *
	 * 喷火枪比打火机大一圈 —— 那是它「有一小圈范围」的表达方式：
	 * 仍然是单目标（只点着半径内最近的那一只），但够得着得多。
	 * 数值住在 `market.roastChain[].pickRadius` 上，和 burnMs / mul 一处。
	 *
	 * ⚠ 和 `ignite(fly, tool)` 一样按 **tool id** 查，不是按当前等级 ——
	 *   买到喷火枪之后玩家完全可能回头拿打火机，那时候半径要跟着手里那把走。
	 *   按等级取的话两把枪的半径永远一样，而症状只是「喷火枪好像没变大」
	 *
	 * ⚠ 查不到就返回 0，**不要留一个 fallback 半径** —— 0 会让
	 *   `_flyAt(m.x, m.y, 0)` 一个都点不着，一眼就能发现；
	 *   fallback 的话是「悄悄用了旧值」，没人会去查
	 */
	burnRadiusFor(tool) {
		const chain = chainOf('roast') ?? []
		const t = chain.find((x) => x.id === tool)
		return t && Number.isFinite(t.pickRadius) ? t.pickRadius : 0
	}

	/**
	 * 把一只**活着的成虫**点着。
	 *
	 * 从 1.18.0 起，打火机和喷火枪干的是这件事 —— 不再是烤地上的尸体。
	 * 点着之后它会带着火焰惊慌乱飞，烧满 `burnMs` 之后按 `mul` **自动卖掉**
	 * （见 `_updateBurning`）。
	 *
	 * @param {object} fly
	 * @param {string} tool **手里拿着哪一把**（`'lighter'` / `'flamer'`，就是那两颗
	 *   按钮的 `data-tool`）。
	 *
	 *   ⚠ 这个参数不能省，也不能改成「取当前最高档」—— 玩家买到喷火枪之后
	 *     工具栏上是**两颗**按钮，他完全可能回头去拿打火机。
	 *     按「最高档」算的话，拿打火机点出来的也是 3 秒 ×1.5，
	 *     两颗按钮变成同一把，而界面上看不出任何异常。
	 *     这个 bug 是靠自检抓出来的：模拟器里每次都用满级，档位恰好等于最高档，
	 *     所以它一直绿 —— 只有「拥有高档、却选了低档」才会露出来
	 *
	 * ⚠ 只认 `this.flies` 里的。罐中 / 烤炉里的**点不着** —— 那一整条机制的前提是
	 *   「它要飞、要慌、要冒火」，三条都长在这个数组的遍历上。
	 *   这和 `sellFly` 那条「罐子必须显式再查一遍」**刚好相反**，别照抄那边的形状
	 *
	 * ⚠ 「每只只吃一次倍率」的判重（`fly.burning`）**必须在这里**，不能放到 UI 层：
	 *   UI 按住工具时会**每帧**调一次 ignite，判重放那边的话，
	 *   来回蹭同一只会反复把倒计时重置回满 —— 表现是「怎么烧都烧不完」，
	 *   而那种 bug 极难归因（看起来像火焰时长配错了）
	 *
	 * @returns {boolean} 真点着了才 true
	 */
	ignite(fly, tool) {
		const chain = chainOf('roast') ?? []
		const idx = chain.findIndex((t) => t.id === tool)
		// 认不出这把工具、或者还没买到这一档 —— 两种都拒绝。
		// 拥有权在这里也判一道：UI 的闸门拦的是「切换工具」，
		// 而这里是「真的点着了火」，两边都得拦
		if (idx < 0 || idx >= this.shopLevel('roast')) return false
		const tier = chain[idx]

		if (!fly || fly.dead || fly.burning) return false
		if (this.flies.indexOf(fly) < 0) return false

		fly.burnLeft = tier.burnMs
		fly.burnMul = tier.mul
		fly.burnBig = tier.id === 'flamer'

		// 点着那一下先补一把火，不然「点着了没有」要等下一帧才看得出来 ——
		// 和 burstRing 存在的理由是同一个（动作那一下要立刻有反馈）
		for (let i = 0; i < 5; i++) this._emitFlameParticle(fly.x, fly.y, fly.burnBig)
		return true
	}

	/**
	 * 灭火。**只摘计时器和倍率**，死没死、在哪儿都不管。
	 *
	 * 四条路要调它：被拍死、进罐子、进烤炉、被卖掉。
	 * 不灭的话那只虫会带着一个「烧到一半」的倒计时进容器，
	 * 而容器里的虫不在 `this.flies` 里 —— `_updateBurning` 永远走不到它，
	 * 那个倒计时就永久悬在存档里了。
	 *
	 * ⚠ 写成「`burnLeft` 为假就什么都不做」而不是无条件赋值：
	 *   `swat` 的 tryKill 是**三种实体共用**的（成虫 / 幼虫 / 卵），
	 *   无条件写的话会给幼虫和卵挂上两个 burnLeft / burnMul 自有字段，
	 *   而自有字段会跟着 snapshot() 进存档 —— 存档里凭空多出几千个没意义的键
	 */
	extinguish(fly) {
		if (fly && fly.burnLeft) {
			fly.burnLeft = 0
			fly.burnMul = 1
		}
	}

	addOven(x, y) {
		if (this.ovens.length >= CONFIG.roast.oven.maxCount) return null
		const oven = new Oven(x, y)
		this.ovens.push(oven)
		return oven
	}

	/** 「烤炉」按钮：随便找个地方摆一个（保证整个炉子都在屏内） */
	dropOven() {
		const O = CONFIG.roast.oven
		const mx = O.width / 2 + 12
		const my = O.height / 2 + 12
		const x = rand(Math.min(mx, this.w / 2), Math.max(this.w - mx, this.w / 2))
		const y = rand(Math.min(my, this.h / 2), Math.max(this.h - my, this.h / 2))
		return this.addOven(x, y)
	}

	/**
	 * 手套把一只成虫放进烤炉。满了返回 false，由 UI 去提示。
	 *
	 * ⚠ 从 1.21.0 起是**每只各自计时、各自到账**：放进去的那一刻它就开始烤，
	 *   烤满 `CONFIG.roast.oven.roastMs` 之后**自己**冒钱走人，
	 *   不用等炉子装满，也不会被同炉的其他几只拖住。
	 *
	 *   原来是「装满 5 只 → 整炉一起开烤 → 一起结账」。改掉它是因为
	 *   那个版本里「炉子里有几只」和「还要等多久」是两件不相干的事：
	 *   放 1 只进去什么都不发生，玩家只能干等；而放满之后 5 只同时出锅，
	 *   钱一次性到账，看不出哪只在什么时候烤好的。
	 *
	 * ⚠ 所以 `oven.roasting` **不再拦着往里放**。它现在只是「有没有在烤」
	 *   （给火光用的读数）。用旧判据的话，炉子里烤着第一只时就再也放不进第二只，
	 *   而界面上什么提示都没有 —— 「炉子坏了」
	 */
	putInOven(oven, fly) {
		if (!oven || !fly || oven.full) return false
		const i = this.flies.indexOf(fly)
		if (i >= 0) this.flies.splice(i, 1)
		// 时长跟**炉子**走，不跟「等级」走 —— 炉子从 1.18.0 起是独立商品
		if (!oven.admit(fly, CONFIG.roast.oven.roastMs)) return false
		return true
	}

	/**
	 * 扔掉一个烤炉。**里面的果蝇全部放出来**，和 discardJar 同理 ——
	 * 拖进垃圾桶的本意是「腾个位置」，不是「把我存的这些全杀了」。
	 */
	discardOven(oven) {
		if (!oven || oven.dead) return false
		// 遍历快照：releaseOvenFly 会从 oven.items 里 splice
		for (const f of oven.items.slice()) this.releaseOvenFly(oven, f)
		oven.dead = true
		const i = this.ovens.indexOf(oven)
		if (i >= 0) this.ovens.splice(i, 1)
		this.burstDust(oven.x, oven.y, 10)
		return true
	}

	/** 把一只果蝇从炉里放回屏幕。和 releaseFly 一个套路 */
	releaseOvenFly(oven, fly) {
		const i = oven.items.indexOf(fly)
		if (i < 0) return false
		oven.items.splice(i, 1)

		// 落点在炉子外接椭圆上随机散开，免得一出来挤成一坨
		const a = rand(0, TAU)
		const r = rand(0.6, 1.1)
		fly.x = clamp(oven.x + Math.cos(a) * oven.halfW * r, 8, this.w - 8)
		fly.y = clamp(oven.y + Math.sin(a) * oven.halfH * r, 8, this.h - 8)
		fly.vx = 0
		fly.vy = 0
		// ⚠ 烤制倒计时也要清。它只在 oven.items 里被推，出来之后没人读 ——
		//   留着是「已经不存在的事实的存档字段」，和 admit 里清 burnLeft 同理。
		//   再放回炉子时 admit 会重新赋成满时长，所以清不清都不影响玩法，
		//   但不清的话存档里会躺着一堆半截的倒计时，读的人会以为它还在烤
		fly.roastLeft = null
		fly.roastTotal = 0
		// ⚠ 石化蝇从炉子里出来也还是在地上爬（「失去飞行」的第四个入口）
		fly.mode = fly.canFly ? 'fly' : 'walk'
		fly.modeTimer = 0
		this.flies.push(fly)
		return true
	}

	/**
	 * 烤炉每帧推进。
	 *
	 * 顺序：先推进倒计时，再出炉。
	 *
	 * **出炉 = 直接卖钱。** 炉里每一只当场按 `售价 × 烤制倍率` 换成钱进账，
	 * 地上**不留尸体**，每只在它自己在炉里的位置冒一个「+$x」飘上去。
	 *
	 * ⚠ 这条和「打火机烤尸体、再拖去出售区」是**两条不同的路**：
	 *   那条是手动的一具一具卖，这条是炉子整炉一次性结清。
	 *   早先炉子走的也是留下尸体的那条路 —— 一炉 5 只掉在地上，
	 *   还得一只只捡去卖，等于「点一次开烤」后面跟着五次重复劳动。
	 *   现在炉子的定位是**省事**：装进去，等进度条，钱自己到账
	 *
	 * ⚠ 因为不再有尸体，`decayFactor`（那 5 分钟不掉价的宽限）在这里**不参与** ——
	 *   出账那一刻就是全价。这是对的：宽限是给「掉在地上等你来捡」的尸体准备的，
	 *   而这里没有等待期
	 */
	_updateOvens(dtMs) {
		for (const oven of this.ovens) {
			if (oven.dead) continue

			// 炉里的果蝇照常老化 —— 炉子只是暂存区，不是罐子那种时间膨胀。
			// 用 updateJarred 是错的（那会把年龄推进减半），所以走普通 update
			for (const f of oven.items) f.update(dtMs, this)

			// —— 每只各自推进自己的倒计时，烤满了就**当场**结账 ——
			//
			// ⚠ **倒着遍历**：结账时要把这一只从 `oven.items` 里摘掉，
			//   正着 for...of 一边删一边走会漏掉紧跟着的那一只
			//
			// ⚠ 同一帧里可能有好几只同时烤满（比如连着拖进去的、或者存档读回来的），
			//   所以飘字还是要按顺序错开，否则几个数字叠在一起看不清。
			//   这里的 `i` 是**这一帧**里第几个结账的，不是炉子里的第几号
			const mul = CONFIG.roast.oven.mul
			const F = CONFIG.roast.oven.float
			let settled = 0

			for (let i = oven.items.length - 1; i >= 0; i--) {
				const f = oven.items[i]
				// ⚠ null = 没在烤（见 Fly.roastLeft 那段注释）。
				//   这里**不能**写成 `!(f.roastLeft > 0)` —— 那样会把
				//   「这一帧刚好烤满、roastLeft 归零」的那一只当成没在烤，
				//   于是它永远结不了账，卡在炉子里
				if (f.roastLeft === null) continue

				f.roastLeft -= dtMs
				if (f.roastLeft > 0) continue

				// ⚠ `f.value` 必须在标 dead **之前**读 —— 它是从 age 派生的 getter，
				//   顺序反了拿到的是死后的值（这里以前是「先给 addRemains 读、再标 dead」，
				//   换成直接算钱之后，那个隐式的顺序保证就只剩这一行注释了）
				const gain = f.value * mul

				this._creditSale(gain)
				// 飘字落在这只虫**自己在炉里的位置**上，而不是炉心 ——
				// 炉膛里本来就散落着几只，各冒各的才看得出「这只比那只值钱」
				this.addFloatText(oven.x + f.x, oven.y + f.y, '+' + formatMoney(gain), {
					delay: settled * F.delayStep,
				})

				f.dead = true
				f.causeOfDeath = 'roasted'
				f.roastLeft = null
				oven.items.splice(i, 1)
				settled++
			}
		}

		this.ovens = this.ovens.filter((o) => !o.dead)
	}

	/**
	 * 点火的每帧推进：惊慌 → 倒计时 → 烧完**自动出售**。
	 *
	 * ⚠ 结账**不走 `_resolveLifecycles`**，而是走 `sellFly`。理由要讲清楚：
	 *   那条路是按 `causeOfDeath` 分派的，而它的 else 分支把**任何没被显式列出的
	 *   死因都算成 natural，并且留一具尸体**（那个文件里警告过两次）。
	 *   留它来收的话，玩家会**同时**拿到钱 + 地上一具尸体 + 一个「+1 自然老死」的
	 *   计数 —— 三件事各自都不报错，只是数字全错。
	 *   `sellFly` 自己会从 `this.flies` 里摘掉、置 `dead` 和 `'sold'`、
	 *   钱走 `_creditSale`，而且**不留尸体** —— 正是「一次结算只写一份」的原路
	 *
	 * ⚠ 倒着遍历：`sellFly` 内部会 splice
	 *
	 * ⚠ 已知且**可以接受**的一个后果：正在产卵的母体被点着时不会乱飞
	 *   （`Fly.update` 的 laying 分支返回得很早，`_panic` 那几行轮不到），
	 *   它会安静地下满这几秒蛋然后被卖掉，没产完的那一窝就此消失。
	 *   这是玩家**主动**拿火去点的，和养蝇人那种自动出售不是一回事，所以不修
	 */
	_updateBurning(dtMs) {
		for (let i = this.flies.length - 1; i >= 0; i--) {
			const f = this.flies[i]
			if (f.dead || !(f.burnLeft > 0)) continue

			// 惊慌：复用挥手那一套（结束悬停 / 强制起飞 / 乱抽方向）。
			// ⚠ 传 null —— 着火没有「要背离的那个点」，它只是自己身上在烧
			this._panic(f, null)

			f.burnLeft -= dtMs
			if (f.burnLeft > 0) continue

			// —— 烧完了，结账 ——
			// ⚠ 先读 value 再卖：它是从 age 派生的 getter，sellFly 会把它标成 dead，
			//   顺序反了拿到的是死后的值（和炉子那段是同一个坑）
			const gain = this.sellFly(f, f.burnMul)
			if (gain > 0) this.addFloatText(f.x, f.y, '+' + formatMoney(gain))
		}
	}

	/**
	 * 捕虫网：把 (x, y) 附近的自由成虫装进最近的、还有空位的罐子。
	 *
	 * 罐中果蝇不在 this.flies 里，所以自动不会被重复捕捉 —— 不需要额外判断。
	 *
	 * @returns {number} 实际网住了几只
	 */
	catchFlies(x, y) {
		const R2 = CONFIG.tools.netRadius ** 2

		// 先挑罐子。没有空位就直接返回 0，让 UI 去提示玩家，
		// 而不是默默什么都没发生 —— 那种「点了没反应」最难排查
		const jar = this._nearestJarWithRoom(x, y)
		if (!jar) {
			this.burstRing(x, y, CONFIG.tools.netRadius, 8, 'rgba(150, 215, 255, 0.7)')
			return 0
		}

		let caught = 0
		// 倒着遍历：splice 会把后面的元素前移，正着走会跳过后一只
		for (let i = this.flies.length - 1; i >= 0; i--) {
			const f = this.flies[i]
			if (f.dead) continue
			if (dist2(x, y, f.x, f.y) > R2) continue
			if (!jar.admit(f)) break // 装满了

			this.flies.splice(i, 1)
			caught++
		}

		// 网圈图案删掉之后，这一圈粒子就是**唯一**能告诉你「网撒在哪儿、多大」的东西。
		// 所以**命中与否都放** —— 挥空时正是最需要知道范围的时候
		this.burstRing(
			x,
			y,
			CONFIG.tools.netRadius,
			10,
			caught > 0 ? 'rgba(170, 225, 255, 0.95)' : 'rgba(150, 190, 220, 0.6)',
		)
		if (caught > 0) this.burstDust(x, y, Math.min(6 + caught * 2, 16))
		return caught
	}

	/** 离 (x, y) 最近、且还有空位的罐子。全都满了就返回 null */
	_nearestJarWithRoom(x, y) {
		let best = null
		let bestD2 = Infinity
		for (const j of this.jars) {
			if (j.dead || j.full) continue
			const d2 = dist2(x, y, j.x, j.y)
			if (d2 < bestD2) {
				bestD2 = d2
				best = j
			}
		}
		return best
	}

	// ================================================================
	//  蛹壳 —— 羽化之后留在原地的空壳
	// ================================================================

	/**
	 * 在某个位置留下一枚蛹壳。
	 *
	 * 上限和残留物一样是道保险丝：玩家如果一直不收拾，壳会越积越多。
	 * 超了就丢最老的 —— 这是防挂机把内存撑爆，不是玩法机制。
	 */
	addShell(x, y, angle, size, lengthScale, slim) {
		if (this.shells.length >= CONFIG.pupa.maxShells) this.shells.shift()
		const sh = new Shell(x, y, angle, size, lengthScale, slim)
		this.shells.push(sh)
		return sh
	}

	/**
	 * 把一枚蛹壳丢进垃圾桶。
	 *
	 * 刻意不留污渍 —— 它是被扔掉的，不是烂在地上被擦掉的，
	 * 和 discardFood / discardJar 是同一套说法。
	 */
	discardShell(shell) {
		if (!shell || shell.dead) return false
		shell.dead = true
		this.burstDust(shell.x, shell.y, 6)
		return true
	}

	/** 这只果蝇在哪个罐子里；不在任何罐子里就返回 null */
	jarOf(fly) {
		for (const j of this.jars) {
			if (j.flies.includes(fly)) return j
		}
		return null
	}

	/**
	 * 一只果蝇在**屏幕坐标**下的位置。
	 *
	 * ⚠ jar.flies / oven.items 的 x / y 是**相对容器中心**的偏移，不是屏幕坐标
	 *   （见 Jar 构造函数的注释：那是为了「拖动罐子时全罐跟着走」）。
	 *   拿 f.x 直接当屏幕坐标的典型症状是「卡片 / 光环跑到屏幕左上角」，
	 *   而虫子好好地画在罐子里 —— 光看代码几乎发现不了。
	 *
	 * ⚠ 返回的是**新对象**，不要拿它回写 f.x / f.y —— 那会把偏移改成绝对坐标，
	 *   罐子一拖，这只虫就留在原地了
	 */
	screenPosOf(fly) {
		if (!fly) return { x: 0, y: 0 }
		const jar = this.jarOf(fly)
		if (jar) return { x: jar.x + fly.x, y: jar.y + fly.y }
		for (const oven of this.ovens) {
			if (oven.items.includes(fly)) return { x: oven.x + fly.x, y: oven.y + fly.y }
		}
		return { x: fly.x, y: fly.y }
	}

	/**
	 * 放逐：把一只果蝇从罐子里放回屏幕，恢复自由。
	 *
	 * 寿命加成不需要手动撤销 —— 它是按「谁在更新它」实时决定的：
	 * 回到 this.flies 之后由 Fly.update() 接管，年龄推进速度自动恢复成正常值。
	 * 这正是当初选时间膨胀、而不是给 lifespan 乘系数的原因。
	 */
	releaseFly(jar, fly) {
		if (!jar || !fly) return false
		const i = jar.flies.indexOf(fly)
		if (i < 0) return false

		jar.flies.splice(i, 1)

		// 从罐子外面一点散射出来。直接放在罐心的话，一放出来就贴在罐壁上，
		// 下一网又被捞回去，看着像根本没放出来
		// 按罐子的外接椭圆算落点：这样从哪条边放出去都能落到罐子外面
		const a = rand(0, TAU)
		const d = Math.max(jar.halfW, jar.halfH) * rand(1.2, 1.6)
		fly.x = clamp(jar.x + Math.cos(a) * d, 0, this.w)
		fly.y = clamp(jar.y + Math.sin(a) * d, 0, this.h)

		// ⚠ 放出来的石化蝇照样不能飞（「失去飞行」的第五个入口）
		fly.mode = fly.canFly ? 'fly' : 'walk'
		fly.modeTimer = fly.canFly
			? rand(CONFIG.behavior.flyMin, CONFIG.behavior.flyMax)
			: rand(CONFIG.behavior.walkMin, CONFIG.behavior.walkMax)
		fly.vx = 0
		fly.vy = 0
		fly.aim = a
		fly.angle = a
		fly.feeding = false
		fly.dead = false
		fly.causeOfDeath = null

		this.flies.push(fly)
		return true
	}

	/** 把一只自由果蝇放进指定罐子（存档恢复时用） */
	putInJar(jar, fly) {
		if (!jar || !fly || jar.full) return false
		const i = this.flies.indexOf(fly)
		if (i >= 0) this.flies.splice(i, 1)
		return jar.admit(fly)
	}

	/**
	 * 更新罐子和罐中果蝇。
	 *
	 * 顺序：先推进，再收尸。和 _resolveLifecycles 一个套路 ——
	 * 实体自己只负责 die()，从数组里摘出去、留尸体、记统计都在这里统一做，
	 * 这样统计数字只有一个来源，不会算重或算漏。
	 */
	_updateJars(dtMs) {
		for (const jar of this.jars) {
			if (jar.dead) continue

			const survivors = []
			for (const f of jar.flies) {
				if (!f.dead) f.updateJarred(dtMs, jar)

				if (f.dead) {
					// 罐中老死的果蝇也要留下尸体，和外面的规则一致。
					// 摆在罐子下方 —— 尸体不会穿过玻璃掉出来，但也不该凭空消失
					this.stats.deaths++
					this.stats.natural++
					this.addRemains(
						jar.x + rand(-jar.halfW * 0.45, jar.halfW * 0.45),
						jar.y + jar.halfH + rand(2, jar.halfH * 0.28),
						'corpse',
						f.size,
						f.angle,
						f, // 罐中老死的也能烤能卖 —— 售价在死这一刻抄进尸体
					)
					continue
				}
				survivors.push(f)
			}
			jar.flies = survivors

			// 产卵排在收尸**之后** —— 这一帧已经死掉的不该再参与。
			// （配对不在这里，它在外面的 60ms 闸门上，见 _tryJarMate 的注释）
			this._layJarPending(jar, dtMs)
		}

		this.jars = this.jars.filter((j) => !j.dead)
	}

	/**
	 * 罐中配对：同一个罐子里的一对异性凑上了就配一次。
	 *
	 * ⚠ **不做距离判定。** 外面的 `_tryMate` 要两只虫飞到 `mating.seekRadius`
	 *   （110px）以内才算遇上 —— 那在 194×246 的罐子里会漏掉斜对角的两个
	 *   （对角线约 294px），表现为「明明关了一对就是不生」。
	 *   罐子本来就小，同罐就算碰上了。
	 *
	 * ⚠ 这一路**不碰母体的 laying / laySite / x / y**：
	 *   · laying 同时是渲染的收翅标记和 canMate 的前置条件 —— 占上了，
	 *     罐中虫会一直收着翅膀，而且再也不能配对
	 *   · x / y 是**相对罐心的偏移**，改成屏幕坐标的话「拖动罐子全罐跟着走」当场就废
	 *   所以产卵交给罐子（jar.pending），母体只贡献一份「这一窝的内容」
	 *   和一次冷却（见 Fly.clutchPlan）
	 */
	_tryJarMate(jar) {
		if (!CONFIG.jar.mateInside) return
		if (jar.pending) return // 上一窝还没产完，不叠新的（叠了也只能记住一窝）
		if (this.eggs.length >= this.maxEggs) return

		// 调用点：step() 里那个 60ms 闸门，紧跟着 _tryMate（**不是** _updateJars，
		// 那里跑在闸门之前，用 mateScanTimer 当条件会永远不成立）

		let mother = null
		let father = null
		for (const a of jar.flies) {
			if (!a.canMate) continue
			for (const b of jar.flies) {
				if (a === b || !b.canMate || a.sex === b.sex) continue
				// 母体是谁不影响基因（父母各传一半），但产卵计数挂在母体那个性别上，
				// 和外面那条路保持一致：雌性是母亲
				if (a.sex === 'F') {
					mother = a
					father = b
				} else {
					mother = b
					father = a
				}
				break
			}
			if (mother) break
		}
		if (!mother || !father) return

		// ⚠ 用 clutchPlan() 而不是先往母体身上写一套产卵字段再调 startLaying ——
		//   那样会把母体身上那套字段写脏，而罐里这条路**永远不会**走到
		//   _endClutch 去清它
		//
		// ⚠ 没有 genes：遗传去掉之后每颗卵自己骰（见 _layJarPending）。
		//   clutchPlan 现在只算「卵多大 / 幼虫什么体型」
		const plan = mother.clutchPlan()
		const E = CONFIG.egg
		const M = CONFIG.mating

		jar.pending = {
			left: randInt(M.eggsMin, M.eggsMax),
			timer: 0, // 第一颗立刻产下，让玩家马上看到因果（和 startLaying 一致）
			scale: plan.scale,
			shape: plan.shape,
			hatch: rand(E.hatchMin, E.hatchMax),
			clutch: this.newClutch(),
		}
		mother.cooldown = M.cooldown
		father.cooldown = M.cooldown
	}

	/**
	 * 把罐子里攒下的那一窝，一颗颗产到**罐子外面的底部**。
	 *
	 * ⚠ 产在罐外是用户定的：罐子当种蝇房，孵出来的幼虫在屏幕上正常活动。
	 *   卵留在罐内的话，卵和幼虫都得再长一套「相对罐心的坐标」和罐内更新路径
	 *   （现在只有成虫有），那是另一个量级的改动。
	 *
	 * ⚠ 位置要**夹进 CONFIG.larva.margin** —— 和 _resolveLifecycles 里
	 *   幼体出界时的夹法同一个理由：罐子可能贴着屏幕边，卵不能生到屏幕外面去
	 */
	_layJarPending(jar, dtMs) {
		const p = jar.pending
		if (!p) return

		p.timer -= dtMs
		if (p.timer > 0) return
		p.timer += CONFIG.laying.eggInterval

		const J = CONFIG.jar
		const L = CONFIG.laying
		const margin = CONFIG.larva.margin
		const x = clamp(
			jar.x + rand(-jar.halfW * J.laySpreadX, jar.halfW * J.laySpreadX) + rand(-L.scatter, L.scatter),
			margin,
			this.w - margin,
		)
		const y = clamp(
			jar.y + jar.halfH * (1 + J.laySpreadY) + rand(-L.scatter, L.scatter),
			margin,
			this.h - margin,
		)

		// ⚠ 每颗卵**各骰一次**，和父母的基因无关 ——
		//   外面那条路在 Fly._lay 里有同样的注释，sim 里也有断言盯着
		this.spawnEgg(x, y, p.scale, p.shape, p.clutch, p.hatch, rollDeNovo())

		p.left--
		if (p.left <= 0) jar.pending = null
	}

	/**
	 * 找 (x, y) 附近最近的食物。
	 * @param {number} radius 感知半径
	 * @param {number} minRot 只找烂到一定程度以上的
	 *   —— 幼虫闻的是「能吃」，成虫闻的是「发酵」，所以两者传的门槛不一样
	 */
	nearestFood(x, y, radius, minRot = 0) {
		let best = null
		let bestD2 = radius * radius
		for (const f of this.foods) {
			if (f.dead || f.depleted || f.rot < minRot) continue
			const d2 = dist2(x, y, f.x, f.y)
			if (d2 < bestD2) {
				bestD2 = d2
				best = f
			}
		}
		return best
	}

	/**
	 * 结算进食：真正的扣营养在这里做。
	 * 幼虫的 update() 每帧会把 this.eating 指向它趴着的那份食物，
	 * 这里统一按数组顺序让前 maxEaters 只真的吃 —— 果子表面积有限，
	 * 剩下的幼虫虽然也在上面拱，但不再消耗，而且**吃不到就是吃不到**
	 * （幼虫那边按 hunger 计时，久了会饿死）。
	 *
	 * ⚠ 上限是**每份食物各自的**（= 它的 size × eatersPerSize），不是全局常数。
	 * 大果子能多供几只，小果子少几只。
	 */
	_updateFeeding(dtMs) {
		const F = CONFIG.food
		const dt = dtMs / 1000
		// 「一只幼虫独吞一整份要 larvaMealTime 毫秒」→ 换算成每秒掉多少
		const drainPerLarva = 1000 / F.larvaMealTime

		for (const f of this.foods) f.eaters = 0

		// ⚠ 「这一轮到底吃上没有」是**饥饿机制的唯一判据**，
		// 而它和 l.eating（贴没贴在果子上）是两回事：
		// 抢不到名额的幼虫位置照样在果子上，但一口都吃不到。
		//
		// 先全部清掉再逐个点亮，所以这个标记**只反映最近一次结算**。
		// Larva.update 在下一帧读它 —— 和 foodGrowthBonus(this.eating) 一样，
		// 都是「用上一帧的结算结果」，差一帧在这个尺度上看不出来，
		// 而且和 world 这边的统计口径天然一致
		for (const l of this.larvae) l.ateLastTick = false

		for (const l of this.larvae) {
			if (l.dead || !l.eating) continue
			const f = l.eating
			f.eaters++
			if (f.eaters <= f.maxEaters) {
				l.ateLastTick = true
				f.nutrition -= drainPerLarva * dt
				if (f.nutrition < 0) f.nutrition = 0

				// —— 星空苹果：给幼虫骰一次「星云」 ——
				//
				// 位置必须**在这个「已经确认吃到」的分支里**：外面那些
				// 抢不到位子的幼虫也贴在果子上，但它们一口都没啃到
				// （见上面 eaters / maxEaters 那段注释）
				//
				// 三个条件缺一不可：
				//   1. `f.type === 'star'` —— **成虫吃它没有任何事**，
				//      所以这条路只在这里有，Fly 那边一行都不用加
				//   2. `!l.starRolled` —— **一辈子只骰一次**，不是每口 10%。
				//      没有它的话一份 200px 的星空苹果会被啃上千口，必中
				//   3. 还没有星云 —— 已经有了就没什么可骰的
				//
				// ⚠ 用 `l.mutations = [...]` 换一个新数组，不 push 原地改：
				//   mutations 是 revive / copyGenes 出来的独立数组，
				//   原地改虽然也能跑，但一旦哪天有第二处共享了同一个数组引用，
				//   症状会是「不知从哪冒出来一只星云」—— 换新数组把这个可能性掐掉
				if (f.type === 'star' && !l.starRolled) {
					l.starRolled = true
					if (!hasMutation(l.mutations, 'nebula') && Math.random() < CONFIG.mutation.nebulaFromStar) {
						l.mutations = [...l.mutations, 'nebula']
						// ⚠ 这里也要记一笔：星云是**在一只已经存在的幼虫身上现场长出来的**，
						//   不走 addLarva / spawnEgg 那三个入口。漏了这一句的后果很隐蔽 ——
						//   玩家吃出星云、图鉴那一格却还是灰的，看起来像「彩蛋坏了」
						this._noteGenes(l.mutations)
					}
				}
			}
		}
	}

	/** 食物腐烂、被啃光后的收尾、以及自动投食 */
	_updateFood(dtMs) {
		const F = CONFIG.food

		for (const f of this.foods) {
			if (f.dead) continue
			f.update(dtMs)
			if (!f.depleted) continue

			// 啃光了：原地留下一片狼藉，等着被抹布收拾。
			// 这一步把「食物」和既有的清洁循环接上了。
			//
			// ⚠ 污渍的**尺寸要封顶**。本来是按 `size × (0.4~0.62)` 算的 ——
			//   30px 的果子留 18px 的渍很正常，但 200px 的果子会留下 124px 的
			//   巨型黑斑，比工具栏面板还大，三块叠在一起能糊掉小半个屏。
			//   封顶之后大果子留下的是「一大片狼藉」，不是「三坨巨物」。
			//   ⚠ 散布半径**不封顶**是刻意的：大果子啃光本来就该脏得更开
			f.dead = true
			for (let i = 0; i < F.huskStains; i++) {
				const a = rand(0, TAU)
				const d = rand(0, f.size * 0.45)
				const stainSize = Math.min(f.size * rand(0.4, 0.62), F.stainMaxSize)
				this.addRemains(f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, 'stain', stainSize, rand(0, TAU))
			}
		}

		this.foods = this.foods.filter((f) => !f.dead)

		if (!F.autoSpawn) return
		this.foodTimer -= dtMs
		if (this.foodTimer > 0) return
		this.foodTimer = rand(F.autoIntervalMin, F.autoIntervalMax)
		if (this.foods.length < F.maxCount) this.dropFood()
	}

	// ================================================================
	//  成虫飞出自己的「屏幕」时的处理
	// ================================================================

	/**
	 * 从一边飞出去 → 从中心对称的位置飞回来。
	 *
	 * 对称指的是「关于屏幕中心点对称」：(x, y) → (W - x, H - y)。
	 * 所以从左上角飞出去，会从右下角冒出来，而且保持原来的速度和方向，
	 * 看起来就像屏幕是首尾相接的。
	 */
	wrapFly(f) {
		const m = CONFIG.adult.edgeMargin
		const W = this.w
		const H = this.h

		if (f.x < -m) {
			f.x = W + m
			f.y = H - f.y
		} else if (f.x > W + m) {
			f.x = -m
			f.y = H - f.y
		}

		if (f.y < -m) {
			f.y = H + m
			f.x = W - f.x
		} else if (f.y > H + m) {
			f.y = -m
			f.x = W - f.x
		}
	}

	// ================================================================
	//  主循环
	// ================================================================

	/**
	 * @param {number} rawDt 真实经过的秒数（未乘倍速）—— 渲染循环传进来的原始值
	 *
	 * 进到这里就立刻换算成毫秒，之后整条链路（step / 实体 update）全部用毫秒，
	 * 和 CONFIG 里的时长单位保持一致。只有物理积分那几行才换回秒。
	 */
	update(rawDt) {
		if (this.paused) return

		// 分步积分：2 倍速时一帧的步长会翻倍，切成小步才不会让运动变形，
		// 也能扛住「窗口被盖住一段时间后突然恢复」造成的巨大 dt。
		let remaining = rawDt * 1000 * this.timeScale
		const MAX_STEP_MS = 1000 / 30

		while (remaining > 0) {
			const step = Math.min(MAX_STEP_MS, remaining)
			this.step(step)
			remaining -= step
		}
	}

	/** @param {number} dtMs 毫秒 */
	step(dtMs) {
		this.elapsed += dtMs

		this._updateSwarm(dtMs)

		// 配对扫描。
		// 这个间隔必须跟着飞行速度走：果蝇提速到 440px/s 之后，
		// 200ms 里能飞 88px —— 两只可能刚进范围又擦肩而过，扫描直接漏掉。
		// 60ms 下每步只移动 26px，相对 110px 的感知半径足够密。
		this.mateScanTimer -= dtMs
		if (this.mateScanTimer <= 0) {
			this.mateScanTimer = 60
			this._tryMate()
			// 罐中配对挂在**同一个闸门**上，而不是自己另开一个计时器。
			//
			// ⚠ 别把这个循环搬进 _updateJars —— 那里跑在**本行之前**，
			//   那时 mateScanTimer 还是上一帧重置出来的 60，用它当闸门
			//   会永远返回「还没到点」，罐里的虫一辈子配不上，而且不报错
			for (const jar of this.jars) this._tryJarMate(jar)
		}

		// 先算「谁被手惊到了」，再让它们飞 —— 顺序反了的话这一帧的加成
		// 要下一帧才生效，快速挥手时会慢半拍
		this._applyStartle()

		// 金蝇的光环同理，而且必须在下面那些 `f.value` 的读者**之前**跑：
		// _resolveLifecycles 会用 f.value 给尸体快照售价（addRemains 里的 fly 参数），
		// 排到它后面的话，尸体带的是上一帧的光环状态
		this._applyGoldAura()

		// 点火：惊慌 + 倒计时 + 烧完自动出售。
		//
		// ⚠ 排在 `_applyGoldAura` **之后** —— 结账读的是 `f.value`，
		//   而 value 里含金光光环那个 ×1.1（光环每帧重写）。
		//   排在它前面的话，卖出价用的是上一帧的光环状态
		//
		// ⚠ 排在成虫 update **之前**，理由和 `_applyStartle` 完全一样：
		//   先把「惊慌」挂上，再让它们飞 —— 反了的话这一帧的速度加成
		//   要等到下一帧才生效，着火的那一下会显得迟钝
		this._updateBurning(dtMs)

		// 疯狂蝇咬人。放在 update 循环**之前**：被打死的这一帧就不再更新了，
		// 比「先动后死」（死尸还走了一步）自然一点
		this._updateBerserk(dtMs)

		for (const f of this.flies) {
			if (!f.dead) f.update(dtMs, this)
		}

		for (const l of this.larvae) {
			if (!l.dead) l.update(dtMs, this)
		}

		// 罐中果蝇走自己的更新路径（寿命 1.5 倍、在罐内徘徊、不参与生态）。
		// 放在这里而不是并进上面那个循环：它们不在 this.flies 里
		this._updateJars(dtMs)

		// 烤炉里的果蝇也一样不在 this.flies 里。注意它走的是**普通** update
		// （照常老化），不像罐中那样时间膨胀 —— 炉子只是暂存区
		this._updateOvens(dtMs)

		// 顺序有讲究：幼虫在 update 里只负责「决定吃哪个」，
		// 扣营养统一放在后面结算，这样一份食物每步只会被扣一次，
		// 也才能限制「一颗果子最多同时供应几只」。
		this._updateFeeding(dtMs)
		this._updateFood(dtMs)

		// 养蝇人排在 _updateFood **之后**：那一节末尾才把啃光的果子 filter 掉，
		// 排前面的话「一份食物都没有」这个判断会把刚吃空的那份算成还在
		this._updateKeeper(dtMs)

		for (const e of this.eggs) e.update(dtMs)

		for (const sh of this.shells) sh.update(dtMs)
		for (const r of this.remains) r.update(dtMs)
		for (const p of this.particles) p.update(dtMs)
		for (const t of this.floatTexts) t.update(dtMs)

		// 工具特效的持续发射。排在 _updateEffects 之前 —— 新发出来的粒子
		// 本帧就会走一遍 update()，位置才是从发射点算起的
		this._emitToolFx(dtMs)
		// 烧着的蝇身上的火苗。和上面同一个理由排在 _updateEffects 之前；
		// 它读的是 _updateBurning 刚推进过的 burnLeft，所以对「这一帧刚好烧完
		// 被卖掉」的那些不会再发（sellFly 之后它们不在 this.flies 里了）
		this._emitBurnFx(dtMs)
		this._updateEffects(dtMs)
		this._resolveLifecycles()
		this._cleanup()
	}

	/**
	 * 挥手的惊吓：给指针附近的**自由成虫**算一个速度倍率。
	 *
	 * 越近越慌（中心 1、到 startleRadius 处降到 0），同时乘上「手甩得多快」
	 * （startle.power）。两个因素缺一不可 ——
	 * 只按距离算的话，手停在果蝇旁边不动也会让它们一直发疯；
	 * 只按速度算的话，屏幕另一头甩手会把全场点着。
	 *
	 * ⚠ 只写 this.flies。罐中果蝇走 updateJarred、烤炉里的走 _updateOvens，
	 * 两条路都不经过这里，所以它们天然不受影响 —— 被关着的东西
	 * 不该对外面的手有反应。代价是进罐/进炉前的那个倍率会留在身上，
	 * 所以 Jar.admit 和 Oven.admit 里要把它清回 1
	 */
	_applyStartle() {
		const R = CONFIG.tools.startleRadius
		const mul = CONFIG.tools.startleMaxMul
		const st = this.startle

		// 手没甩（或者压根没有手）→ 全部复位。
		// 归 1 而不是留着上一次的值：留在身上的话，果蝇会一直保持
		// 「刚才被吓到」的速度，而屏幕上什么都没有发生
		if (!(st.power > 0)) {
			for (const f of this.flies) f.startleMul = 1
			return
		}

		const R2 = R * R
		for (const f of this.flies) {
			const d2 = dist2(f.x, f.y, st.x, st.y)
			if (d2 >= R2) {
				f.startleMul = 1
				continue
			}
			// 中心 1 → 边缘 0。要开方，所以只对半径内的少数几只算
			const near = 1 - Math.sqrt(d2) / R
			const k = st.power * near
			f.startleMul = 1 + k * (mul - 1)

			// —— 光是「飞得更快」是不够的 ——
			//
			// ⚠ 这里踩过一次：只乘速度的话，**悬停中的蝇根本不会动** ——
			// _fly 里 `hoverTimer > 0 ? 0 : targetSpeed`，目标速度是 0，
			// 乘多少倍还是 0。趴在地上走的那批也一样，它们只会走快一点，
			// 不会起飞。玩家看到的是「手从它身上扫过去，它还在原地悬着」，
			// 完全不像被吓到。
			//
			// 所以受惊必须是**行为**上的改变，不只是数值：
			//   停下的 → 起飞   悬停的 → 结束悬停   走路的 → 转成飞
			//   并且朝**背离指针**的方向逃
			if (k <= CONFIG.tools.startleWakeAt) continue

			this._panic(f, Math.atan2(f.y - st.y, f.x - st.x))
		}
	}

	/**
	 * 让一只自由成虫进入「惊慌」：结束停滞、起飞、把朝向掰开。
	 *
	 * 抽出来是因为它现在有**两个**调用方：挥手惊蝇（指针附近的每一只）
	 * 和点火（烧着的每一只，见 `_updateBurning`）。
	 *
	 * ⚠ 抄一份的代价在这里：石化蝇「吓也飞不起来」那条规矩（见下）
	 *   会有一份被漏掉，而那种 bug 只在「挥鼠标时指针恰好扫过一只石化蝇」
	 *   或者「给石化蝇点了火」时才出现，几乎测不到
	 *
	 * @param {number|null} away 要背离的那个方向（弧度）。传 **null = 没有方向可躲** ——
	 *   着火就是这一种：它不是被什么东西吓到，只是自己身上在烧。
	 *   那时**不碰 aim**，让它照着自己的窜动节律乱飞，正是要的「慌」
	 */
	_panic(f, away) {
		f.pausing = false
		f.hoverTimer = 0

		// ⚠ 石化蝇（canFly = false）**烧着也飞不起来**，只是爬得更快 ——
		//   和「失去飞行」那五个入口是同一条规矩（见 Fly.canFly），
		//   别在这儿另开一个例外
		if (f.mode !== 'fly' && f.canFly) {
			f.mode = 'fly'
			f.modeTimer = rand(CONFIG.behavior.flyMin, CONFIG.behavior.flyMax)
			f.vx = 0
			f.vy = 0
		}

		if (away === null) return

		// 朝背离那个点的方向逃。
		// ⚠ 用 angleLerp 混一下而不是直接赋值：硬掰会让满屏果蝇
		// 在同一帧齐刷刷转向，像被同一个磁场推开；
		// 混一下各自保留一点原来的路线，才像各自在躲
		f.aim = angleLerp(f.aim, away, CONFIG.tools.startleTurn)

		// 别让它在窜动节律里马上又改主意，否则刚转过去就被重抽掉。
		// dartTimer 的单位是毫秒（和这个项目里所有时长一样）
		f.dartTimer = Math.max(f.dartTimer, CONFIG.tools.startleDartHold)
	}

	/**
	 * 点石成金的 proximity 加成：金蝇旁边一截范围内的成虫价值 ×1.1。
	 *
	 * 形状完全照抄上面的 _applyStartle，**包括两条复位路径** ——
	 * 这一点比光环本身重要：
	 *
	 * ⚠ goldAura 是**自有字段**，会跟着 snapshot() 进存档。
	 *   只设不复位的话，果蝇会带着一个「某一帧曾经蹭到过 1.1」的标记
	 *   永久留在存档里 —— 金蝇早就被卖掉了，加成还在，重启也在。
	 *   那是一笔查不出来的通胀，而且不可逆。
	 *   所以：没有金蝇时全复位、不在半径内的逐个复位，两条都不能省。
	 *
	 * ⚠ 光环**不叠加**。多只金蝇围着一只普通蝇，仍然是 ×1.1 ——
	 *   叠加的话一圈金蝇能把一只普通蝇抬到几倍，而玩家完全看不出
	 *   是哪几只贡献的。用户原话也是「增加 1.1 倍」。
	 *
	 * ⚠ 只写 this.flies。罐中 / 烤炉里的果蝇不在这个数组里，
	 *   它们各自的 admit() 里会把 goldAura 清回 1（理由同 startleMul）
	 */
	_applyGoldAura() {
		const G = CONFIG.mutation.types.find((t) => t.id === 'golden')
		if (!G) return

		// 先收集所有「发光源」。没收集到就全体复位 —— 这是最关键的一条
		const sources = []
		for (const f of this.flies) {
			if (!f.dead && isGoldAuraSource(f.mutations)) sources.push(f)
		}

		if (sources.length === 0) {
			for (const f of this.flies) f.goldAura = 1
			return
		}

		const R2 = G.auraRadius * G.auraRadius
		for (const f of this.flies) {
			// 金蝇**自己**不蹭自己的光环 —— 它已经拿了 1.3 的自身倍率，
			// 再乘 1.1 等于凭空多给一成，而面板上完全看不出来
			if (!f.dead && isGoldAuraSource(f.mutations)) {
				f.goldAura = 1
				continue
			}

			let near = false
			for (const s of sources) {
				if (s === f) continue
				if (dist2(f.x, f.y, s.x, s.y) <= R2) {
					near = true
					break
				}
			}
			f.goldAura = near ? G.auraMul : 1
		}
	}

	/**
	 * 疯狂：狂躁的个体定期攻击附近的同伴。
	 *
	 * ⚠⚠ **自限设计**。攻击目标里**包含其他疯狂个体** ——
	 *   这不是手滑，是整个突变系统能不能成立的关键。
	 *   如果疯狂只咬正常个体，带这个基因的谱系就有绝对生存优势
	 *   （自己不受伤、还能清掉竞争者），几代之内会把种群里其他果蝇杀光，
	 *   玩家的存档就自己崩了。让它自相残杀，它就会自己压住自己 ——
	 *   现实里有害等位基因被自然选择压住，是同一个道理。
	 *
	 * ⚠ 只扫 this.flies × (this.flies ∪ this.larvae)。
	 *   **绝对不要**把 jar.flies 或 oven.items 并进来：那两个数组里的
	 *   x / y 是**相对容器的偏移**，拿屏幕坐标去减它们会算出荒谬的距离，
	 *   而且一条「隔着半个屏幕咬到罐子里的虫」的 bug 极难看出来。
	 *   容器里的果蝇本来就该是安全的。
	 */
	_updateBerserk(dtMs) {
		const B = CONFIG.mutation.types.find((t) => t.id === 'berserk')
		if (!B) return

		const dt = dtMs / 1000
		const R2 = B.radius * B.radius

		// 攻击者：自由飞的疯狂成虫
		for (const a of this.flies) {
			if (a.dead || !hasMutation(a.mutations, 'berserk')) continue

			// 每只自己的节奏。初值用 seed 错开，
			// 否则开局那几只会在同一帧集体开咬，看起来像回合制
			a.berserkTimer = (a.berserkTimer ?? rand(0, B.intervalMax)) - dtMs
			if (a.berserkTimer > 0) continue
			a.berserkTimer = rand(B.intervalMin, B.intervalMax)

			const dmg = randInt(B.adultDamageMin, B.adultDamageMax)

			// 挑一个受害者。**成虫和幼虫都在候选里**，疯狂的不挑食 ——
			// 包括其他疯狂个体（自限）
			const victim = this._pickBerserkTarget(a, R2)
			if (!victim) continue

			const points = victim.kind === 'larva' ? B.larvaDamage : dmg
			victim.takeDamage(points)
			// 咬中的反馈。burstJuice 是按体型缩放的，幼虫小一点也说得过去
			this.burstJuice(victim.x, victim.y, victim.size ?? 12)
		}

		// 攻击者：疯狂幼虫。伤害固定 1（B.larvaDamage），
		// 但幼虫血量只有 1~2，所以咬谁都基本是一口的事
		for (const a of this.larvae) {
			if (a.dead || a.pupa || !hasMutation(a.mutations, 'berserk')) continue

			a.berserkTimer = (a.berserkTimer ?? rand(0, B.intervalMax)) - dtMs
			if (a.berserkTimer > 0) continue
			a.berserkTimer = rand(B.intervalMin, B.intervalMax)

			const victim = this._pickBerserkTarget(a, R2)
			if (!victim) continue
			victim.takeDamage(B.larvaDamage)
			this.burstJuice(victim.x, victim.y, victim.size ?? 10)
		}
	}

	/**
	 * 在攻击范围内随便挑一个活物。挑不到返回 null。
	 *
	 * 随机挑而不是挑最近的：挑最近的话所有疯狂蝇会**集火**同一只，
	 * 那只瞬间暴毙、其余的毫发无伤，看不出「狂躁」，只像点名。
	 * 随机挑才是一片混乱，也才让疯狂个体有机会咬到彼此
	 */
	_pickBerserkTarget(self, r2) {
		const cands = []
		for (const f of this.flies) {
			if (f === self || f.dead) continue
			if (dist2(self.x, self.y, f.x, f.y) <= r2) cands.push(f)
		}
		for (const l of this.larvae) {
			if (l === self || l.dead || l.pupa) continue
			if (dist2(self.x, self.y, l.x, l.y) <= r2) cands.push(l)
		}
		return cands.length ? pick(cands) : null
	}

	// ================================================================
	//  养蝇人
	// ================================================================

	/**
	 * 养蝇人：买了之后替玩家做两件重复劳动 —— 没食物了自动投、够值钱了自动卖。
	 *
	 * Lv1 只有自动投放，Lv2 才加自动出售。等级存在 world.shop.keeper 里，
	 * 走 shopLevel / upgradeShopItem（和烤制那条链同一套）。
	 *
	 * ⚠ 调用点在 step() 里 `_updateFood` **之后** —— 那里才把啃光的果子
	 *   filter 掉（见 _updateFood 末尾）。排到它前面的话，
	 *   `foods.length === 0` 会把「刚被吃空、还没清理」的那一份算成存在，
	 *   于是永远不投，而场上看确实一份能吃的都没有
	 */
	_updateKeeper(dtMs) {
		const lv = this.shopLevel('keeper')
		if (lv <= 0) return

		// ⚠ 每 checkMs 查一次，**不是每帧**。每帧调 buyFood 的话，
		//   钱不够时一秒会白跑 60 次失败分支 —— 不崩，但调试时很难看
		this.keeperTimer -= dtMs
		if (this.keeperTimer > 0) return
		this.keeperTimer = keeperOptions().checkMs

		// —— 自动投放：一份食物都没有的时候才投 ——
		//
		// ⚠ 判「有没有」用的是 `length === 0`，不是「有没有能吃的」。
		//   一份被啃光的果实在 _updateFood 里已经清掉了，所以这里看到的
		//   是干净的数组 —— 前提是调用点排在 _updateFood 后面（见上）
		if (this.foods.length === 0) {
			// 走 buyFood 而不是 dropFoods：照价扣钱、放不下退钱、
			// 钱不够返回 0 三条规则全都是现成的，重写一遍只会漏掉其中一条
			if (this.buyFood(this.keeper.food, this.keeper.foodN) > 0) this.keeper.fed++
		}

		// —— 自动出售：Lv2 才有 ——
		if (lv < 2 || !this.keeper.sell) return
		this._keeperSell()
	}

	/**
	 * 把符合筛选条件的自由成虫卖掉。
	 *
	 * ⚠ **只扫 this.flies**。罐中果蝇挂在 jar.flies 上、烤炉里的挂在 oven.items 上，
	 *   两个都不在 this.flies 里（见构造函数那两条注释）—— 所以它们天然够不着。
	 *   这正是想要的：罐子里的是玩家特意存的，炉子里的是正在烤的，
	 *   被自动卖掉都会很莫名其妙
	 */
	_keeperSell() {
		const K = this.keeper

		// ⚠ **倒着遍历**。sellFly 内部会从 this.flies 里 splice，
		//   正着走会跳掉被卖那只的下一只（catchFlies 在 jar 那一节也是这么写的）
		for (let i = this.flies.length - 1; i >= 0; i--) {
			const f = this.flies[i]
			if (f.dead) continue

			// 正在产卵的母体不动。把她卖掉会在场上留下一窝永远产不完的卵，
			// 而玩家看到的是「刚才还在下蛋的那只突然没了」
			if (f.laying) continue

			// 正在烧的也不动。自动出售是**玩家没在看的时候**发生的，
			// 而这一只再等几秒就能按 ×1.2 / ×1.5 结账 —— 现在按原价卖掉
			// 是一笔玩家看得见的损失（他刚点的火，回来发现蝇没了、钱还少了）
			if (f.burning) continue

			// 筛的是**价值档**（普通 / 罕见 / 稀有 / 极稀有 / 超级稀有），
			// 和数据面板上显示的那个词是同一个来源。
			//
			// ⚠ 这里以前比的是 `f.rarity`（**体重档**：normal / mutant / extreme）。
			//   两者的区别不是口味问题：体重档在抽到体重之前就定了，
			//   而一只 mutant 蝇具体落在「罕见」还是「稀有」要看它抽到的体重。
			//   既然面板上给玩家看的是价值档，筛选就必须跟着用价值档 ——
			//   否则会出现「面板写着稀有，按稀有筛却筛不出来」
			if (valueTierOf(f.value).id !== K.tier) continue

			// ⚠ 「不含突变」和上面的价值档是**两套完全独立的东西**：
			//   tier 是**售价分档**（由体重换算来的），
			//   mutations 是**基因**（berserk / golden / stone / crystal，遗传的）。
			//   一只「普通」档的果蝇完全可以带着石化基因 ——
			//   把它俩当成一件事是这个功能最容易犯的错
			if (!K.mutants && f.mutations.length > 0) continue

			if (this.sellFly(f) > 0) K.sold++
		}
	}

	/**
	 * 改养蝇人的一项配置，值按 keeperOptions 的白名单校验。
	 *
	 * ⚠ 校验不是走形式：`food` 如果被设成一个不存在的类型，
	 *   `market.foodPrice` 对认不出来的类型返回的是**最贵的那一档**
	 *   （那边注释写了理由：免得被拿来做无本买卖）。于是玩家会
	 *   莫名其妙被按金苹果的价钱扣钱，而界面上明明选的是苹果。
	 *
	 * 返回是否真的改成功了 —— 调用方（UI）拿它决定要不要重画选中态。
	 */
	setKeeperOption(key, value) {
		const K = this.keeper
		const O = keeperOptions()
		switch (key) {
			case 'food':
				if (!O.foods.includes(value)) return false
				K.food = value
				return true
			case 'foodN': {
				const n = Number(value)
				if (!O.counts.includes(n)) return false
				K.foodN = n
				return true
			}
			case 'sell':
				K.sell = !!value
				return true
			case 'tier':
				if (!O.tiers.includes(value)) return false
				K.tier = value
				return true
			case 'mutants':
				K.mutants = !!value
				return true
			default:
				return false
		}
	}

	/**
	 * 放大镜高亮哪几档。**唯一**的写入入口。
	 *
	 * ⚠ 一律走 sanitizeTiers：去重、丢掉认不出的 id、按 valueTiers 顺序排。
	 *   不洗的话，一个不存在的 id 会静默地什么都不高亮 ——
	 *   症状是「放大镜买完不亮」，而界面上六个按钮看着都好端端的。
	 *
	 * 非数组直接退回**默认**（而不是空集）：空集是合法的「一档都不勾」，
	 * 和「传了个乱七八糟的东西进来」必须分开 —— 后者是调用方的 bug，
	 * 让它表现为「什么都不亮」的话，玩家会以为是自己点错了
	 */
	setMagnifierTiers(next) {
		if (!Array.isArray(next)) {
			this.magnifierTiers = magnifierDefaultTiers()
			return false
		}
		this.magnifierTiers = sanitizeTiers(next)
		return true
	}

	/**
	 * 勾上 / 取消某一档。返回操作后它是不是**选中**的（UI 拿它决定按钮状态）。
	 *
	 * ⚠ 允许勾成空集 —— 「一个都不高亮」是个正当选择（等价于把放大镜关掉），
	 *   不要在这里偷偷留一档防止空集
	 */
	toggleMagnifierTier(id) {
		const cur = this.magnifierTiers
		const on = !cur.includes(id)
		const next = on ? [...cur, id] : cur.filter((t) => t !== id)
		// 认不出的 id 会在 sanitize 里被丢掉，于是 next 和 cur 一样，
		// 返回值也就诚实地是 false
		this.magnifierTiers = sanitizeTiers(next)
		return this.magnifierTiers.includes(id)
	}

	// ================================================================
	//  集群
	// ================================================================

	_updateSwarm(dtMs) {
		const S = CONFIG.swarm
		if (!S.enabled) return

		const s = this.swarm

		if (s.active) {
			s.left -= dtMs
			if (s.left > 0) return

			// 集群结束，各回各家
			s.active = false
			s.timer = rand(S.idleMin, S.idleMax)
			for (const l of this.larvae) l.swarming = false
			return
		}

		s.timer -= dtMs
		if (s.timer > 0) return

		// 屏幕上一只幼虫都没有的话，集群没有意义，直接等下一轮
		if (this.larvae.length === 0) {
			s.timer = rand(S.idleMin, S.idleMax)
			return
		}

		// 集群开始。中心点优先选食物 —— 幼虫成群结队本来就是冲着吃的去的，
		// 有了食物之后这个机制才真正说得通；没有食物时退回随机锚点。
		s.active = true
		s.left = rand(S.durationMin, S.durationMax)

		const bait = this.foods.length > 0 ? pick(this.foods) : null
		if (bait) {
			s.x = bait.x
			s.y = bait.y
		} else if (this.larvae.length > 0) {
			const anchor = pick(this.larvae)
			s.x = clamp(anchor.x + rand(-45, 45), 70, Math.max(70, this.w - 70))
			s.y = clamp(anchor.y + rand(-45, 45), 70, Math.max(70, this.h - 70))
		} else {
			s.x = rand(0.2, 0.8) * this.w
			s.y = rand(0.2, 0.8) * this.h
		}

		for (const l of this.larvae) {
			l.swarming = Math.random() < S.joinChance
		}
	}

	// ================================================================
	//  交配
	// ================================================================

	/**
	 * 交配判定：雌雄靠近即算交配成功，随后母体进入产卵状态。
	 *
	 * 这条链路上刻意没有任何可见的「交配过程」——
	 * 不再有两只绕着中点慢慢转圈几秒钟的表演。
	 * 玩家能观察到的只有：母体忽然慢下来停住，然后一颗颗卵出现，再飞走。
	 * 因果仍然是清楚的，只是把过程压缩掉了。
	 */
	_tryMate() {
		const R2 = CONFIG.mating.seekRadius * CONFIG.mating.seekRadius
		const list = this.flies

		for (let i = 0; i < list.length; i++) {
			const a = list[i]
			if (!a.canMate) continue

			for (let j = i + 1; j < list.length; j++) {
				const b = list[j]
				if (!b.canMate || a.sex === b.sex) continue
				if (dist2(a.x, a.y, b.x, b.y) > R2) continue

				const mother = a.sex === 'F' ? a : b
				const father = a.sex === 'F' ? b : a

				// 注意是 beginClutch 不是 startLaying：她还要先挑个安全的地方
				// 飞过去，到了才开始产（见 Fly.beginClutch）
				//
				// ⚠ 这里**曾经**还要把 father.mutations 交出去存起来。遗传去掉
				//   之后父本的基因对后代没有任何影响，那个参数也一起删了
				mother.beginClutch(this)
				mother.cooldown = CONFIG.mating.cooldown
				father.cooldown = CONFIG.mating.cooldown
				break
			}
		}
	}

	// ================================================================
	//  生命周期转折：孵化 → 幼虫 → 羽化 → 成虫
	// ================================================================

	_resolveLifecycles() {
		// —— 卵孵化 ——
		const stillEggs = []
		for (const e of this.eggs) {
			if (e.dead) {
				this.stats.deaths++
				this.stats.swatted++
				continue
			}
			if (e.age >= e.hatchAt) {
				// 位置要夹进幼虫的活动范围：卵是散落在母体周围的（最多偏 13px），
				// 而母体本身允许贴到离边 24px —— 两者一叠，卵就可能落在
				// 幼虫的边界之外，孵出来的幼虫一出生就在屏幕外。
				const m = CONFIG.larva.margin
				this.addLarva(
					clamp(e.x, m, Math.max(m, this.w - m)),
					clamp(e.y, m, Math.max(m, this.h - m)),
					e.shape, // 母体遗传下来的体型性状从这里交给幼虫
					e.clutch, // 窝号也一起交过去 —— 同窝的幼虫靠它认亲
					e.mutations, // 基因也是。⚠ 不传的话突变一出生就断了
				)
				continue
			}
			stillEggs.push(e)
		}
		this.eggs = stillEggs

		// —— 幼虫：蛹期结束后羽化 ——
		const stillLarvae = []
		for (const l of this.larvae) {
			if (l.dead) {
				this.stats.deaths++
				// ⚠ 幼虫有三种死法，必须**逐个显式**记：
				//   被拍死 —— 什么都不留（一拍下去就成渣了）
				//   饿死   —— **留下尸体**，和成虫一样要玩家拿抹布收拾
				//   被咬死 —— 也留尸体，死因和被拍死不是一回事
				//
				// ⚠ 这个 else 分支吞过东西：早先只有「饿死 / 其它」两支，
				//   新增 'killed' 之后如果不显式加一支，被疯狂蝇咬死的幼虫
				//   会被统计成**被拍死** —— 面板上的死因细分从此永远是错的，
				//   而玩家根本不会发现，因为两个数字都在动
				if (l.causeOfDeath === 'starved') {
					this.stats.starved++
					// kind 用 'grub' 而不是 'corpse'：蛆的尸体没有翅膀没有腿，
					// 画成一只小苍蝇是错的。而且它 value 为 0，
					// 所以既烤不了也卖不了，就是一堆要扫的垃圾
					this.addRemains(l.x, l.y, 'grub', l.size, l.angle)
					this.burstDust(l.x, l.y, 4)
				} else if (l.causeOfDeath === 'killed') {
					this.stats.killed++
					// 和被咬死同样留一具蛆的尸体：它是「死在这儿了」，
					// 不是「被拍成渣了」，玩家该看到证据
					this.addRemains(l.x, l.y, 'grub', l.size, l.angle)
					this.burstDust(l.x, l.y, 4)
				} else {
					this.stats.swatted++
					this.burstDust(l.x, l.y, 6)
				}
				continue
			}
			if (l.age >= CONFIG.larva.emergeAt) {
				const sex = Math.random() < 0.5 ? 'F' : 'M'
				// ⚠⚠ 这一行是整条遗传通路**最容易漏掉**的一环。
				//   羽化出来的是一个**全新的 Fly**，它从幼虫身上什么都不继承 ——
				//   体型、窝号都不传（有意的，成虫不用这两个）。
				//   但基因必须传：漏了的话，幼虫面板上还能看见基因徽章，
				//   羽化之后全部消失，成虫永远是野生型 ——
				//   而且**不报错、不崩溃**，看起来就像「突变根本没实现」
				const fly = this.addFly(l.x, l.y, sex, null, l.mutations)
				if (fly) {
					this.stats.emerged++
					this.burstDust(l.x, l.y, 10)
					// 成虫飞走了，原地留下一枚空壳 —— 得戴手套拖进垃圾桶。
					// 体型参数沿用幼虫那只，所以壳和刚才的蛹看起来是同一个东西
					this.addShell(l.x, l.y, l.angle, l.size, l.lengthScale, l.slim)
					continue
				}
				// 成虫数量到顶了：这只羽化失败，当作死亡处理，
				// 否则它会永远卡在「已经该羽化」的状态里反复触发
				this.stats.deaths++
				this.stats.natural++
				continue
			}
			stillLarvae.push(l)
		}
		this.larvae = stillLarvae

		// —— 成虫：自然老死 → 留下尸体 ——
		const stillFlies = []
		for (const f of this.flies) {
			if (f.dead) {
				this.stats.deaths++
				// ⚠ 这个 else 分支是「默认记成老死」。新增了 'killed' 之后
				//   必须显式加一支，否则被疯狂蝇咬死的成虫会**全都记成自然老死** ——
				//   而自然老死是玩家预期里最多的那一类，多出来一点完全看不出来。
				//   面板上「三条杠」的死因细分从此永远是错的
				if (f.causeOfDeath === 'swatted') this.stats.swatted++
				else if (f.causeOfDeath === 'killed') this.stats.killed++
				else this.stats.natural++

				// 不管老死还是被拍死，都留下尸体 —— 被拍死的果蝇不该凭空消失。
				// 它的身体会和汁渍一起留在屏幕上，同样要用抹布擦掉，
				// 而且和自然死亡的尸体一样越烂越难擦。
				//
				// ⚠ 把 f 传进去：尸体现在带着售价 / 稀有度 / 性别，
				// 是烤制和卖钱的凭据。不传的话拍死的果蝇就只是一堆卖不掉的渣
				this.addRemains(f.x, f.y, 'corpse', f.size, f.angle, f)
				continue
			}
			stillFlies.push(f)
		}
		this.flies = stillFlies
	}

	// ================================================================
	//  特效
	// ================================================================

	// 注意：wipeTrail 的生命周期是「秒」，
	// 因为它纯粹是表现层的动画时长，和 CONFIG 里的生态计时不是一回事。
	_updateEffects(dtMs) {
		const dt = dtMs / 1000
		for (const t of this.wipeTrail) t.life -= dt
		this.wipeTrail = this.wipeTrail.filter((t) => t.life > 0)
	}

	/**
	 * 往场上放一颗粒子。**唯一**的入口 —— 上限检查只在这一处。
	 *
	 * @returns {Particle|null} 已经到 maxParticles 就返回 null。
	 *   ⚠ 满了是**静默忽略**，不是错误：粒子纯表现，掉几颗无所谓，
	 *   而调用方（一次爆发 / 每帧发射）没有一个是能「重试」的
	 */
	spawnParticle(x, y, vx, vy, color, size, opts) {
		if (this.particles.length >= CONFIG.world.maxParticles) return null
		const p = new Particle(x, y, vx, vy, color, size, opts)
		this.particles.push(p)
		return p
	}

	/**
	 * 往屏幕上放一行往上飘的字。目前只有烤炉卖钱在用。
	 *
	 * ⚠ 满了是**丢最老的**，不是拒绝新的 —— 和 spawnParticle 的「满了静默忽略」
	 *   刻意不一样。理由：这个字写的是「你刚才赚了多少」，是**钱**。
	 *   一条卖出的通知被静默吞掉，玩家的感受是「钱莫名其妙多了/少了」，
	 *   而丢一个已经快飘完的旧数字，没人看得出来
	 */
	addFloatText(x, y, text, opts) {
		const F = CONFIG.floatText
		while (this.floatTexts.length >= F.maxCount) this.floatTexts.shift()
		const t = new FloatText(x, y, text, opts)
		this.floatTexts.push(t)
		return t
	}

	/** 拍死时炸出来的汁液 */
	burstJuice(x, y, size) {
		const T = CONFIG.tools
		const count = randInt(T.juiceParticlesMin, T.juiceParticlesMax)
		const power = clamp(size, 10, 28) * 11

		for (let i = 0; i < count; i++) {
			const a = rand(0, TAU)
			const spd = rand(0.25, 1) * power
			this.spawnParticle(
				x,
				y,
				Math.cos(a) * spd,
				Math.sin(a) * spd - rand(20, 110), // 稍微往上溅一点
				pick(CONFIG.visual.juiceColors),
				rand(0.9, 2.8),
			)
		}
	}

	/** 通用的小灰尘特效：擦掉东西、幼虫羽化时用 */
	burstDust(x, y, count) {
		for (let i = 0; i < count; i++) {
			const a = rand(0, TAU)
			const spd = rand(12, 55)
			this.spawnParticle(x, y, Math.cos(a) * spd, Math.sin(a) * spd - 12, 'rgba(210, 195, 165, 0.9)', rand(0.8, 2.0))
		}
	}

	/**
	 * 沿一个**圆环**撒一圈粒子。
	 *
	 * 这是「工具的范围圈被删掉之后，玩家怎么知道打得到哪儿」的答案：
	 * 挥拍 / 撒网的那一瞬间，用一圈粒子把判定半径勾出来约 0.3 秒，
	 * 然后自己散掉 —— 比一圈常驻的虚线更像「刚才那一下的动静」。
	 *
	 * ⚠ 半径必须传**判定用的那个半径**（swatRadius / netRadius），
	 *   别另给一个看着好看的数 —— 那就又变回「画的圈和判定的圈不是一回事」了
	 */
	burstRing(x, y, r, count, color) {
		for (let i = 0; i < count; i++) {
			const a = (i / count) * TAU + rand(-0.2, 0.2)
			const spd = rand(30, 70)
			this.spawnParticle(
				x + Math.cos(a) * r,
				y + Math.sin(a) * r,
				Math.cos(a) * spd,
				Math.sin(a) * spd,
				color,
				rand(0.9, 2.0),
				// ⚠ life 是**毫秒**（Particle.update 里 `life -= dtMs`），
				//   写 0.34 的话粒子第一次 update 就死了，这一圈会整个看不见
				{ life: CONFIG.tools.fx.ringLife, gravity: -8, drag: 3.2, grow: 0.8 },
			)
		}
	}

	/**
	 * 工具特效的发射器。由 `ui.update()` 每帧写 `this.toolFx`，这里按**时间**发粒子。
	 *
	 * ⚠ 和 burstJuice / burstDust 是两种东西：那两个是**事件**（拍死、擦掉），
	 *   一次爆一堆；这个是**状态**（举着打火机），只要状态在就一直冒。
	 *
	 * ⚠⚠ 按**秒**累加，不是「每帧几颗」。按帧算的话 10× 倍速下粒子会多十倍、
	 *   掉帧时会少一大截，而两个方向都不会报错。这个项目已经被
	 *   「把毫秒当成秒」咬过一次（见 Larva.update 里 sniffTimer 那段注释）
	 */
	_emitToolFx(dtMs) {
		const fx = this.toolFx
		if (!fx.on || !(fx.rate > 0)) {
			fx.acc = 0
			return
		}
		fx.acc += fx.rate * (dtMs / 1000)
		// 单帧补发上限：一帧卡了 500ms 的话，累加器里会攒下几十颗，
		// 一次全倒出来就是一团糊。宁可少发几颗，也不能让「卡一下」变成「炸一下」
		let n = Math.floor(fx.acc)
		if (n > CONFIG.tools.fx.maxPerTick) {
			n = CONFIG.tools.fx.maxPerTick
			fx.acc = 0
		} else {
			fx.acc -= n
		}
		for (let i = 0; i < n; i++) this._emitOneParticle(fx)
	}

	/**
	 * 一颗火苗粒子，从 (x, y) 往上蹿、越飘越小（grow 为负 = 收尖）。
	 *
	 * ⚠ 抽成方法而不是让两家各自 `spawnParticle`：这里六个参数
	 *   （向上的初速、`gravity: -40`、`drag: 3.4`、`grow: -0.5`、两档配色）
	 *   是**调出来的一组值**。抄一份出去之后，改了这边那边不会跟着动，
	 *   而症状只是「烧蝇的火苗和打火机的火苗看着不是同一种东西」——
	 *   它像审美问题，所以没人会往「两份代码漂移了」上想
	 *
	 * 两个调用方：手里的打火机 / 喷火枪（`_emitOneParticle`）、
	 * 被点着的蝇（`_emitBurnFx`）
	 */
	_emitFlameParticle(x, y, big) {
		const F = CONFIG.tools.fx
		this.spawnParticle(
			x + rand(-2, 2),
			y + rand(-2, 2),
			rand(-14, 14),
			-rand(26, big ? 90 : 58),
			big ? (Math.random() < 0.5 ? '#cfe9ff' : '#ffd08a') : Math.random() < 0.5 ? '#fff0c0' : '#ffb14a',
			rand(0.8, big ? 2.6 : 1.8),
			{ life: big ? F.flameLifeBig : F.flameLife, gravity: -40, drag: 3.4, grow: -0.5 },
		)
	}

	/**
	 * 烧着的蝇身上的火苗。由 `_updateBurning` 推进的状态驱动，这里只负责发粒子。
	 *
	 * ⚠ 和 `_emitToolFx` 最大的不同：那个是**指针单例**（全世界只有一个
	 *   `fx.x / fx.y`），这个是**从每一只烧着的蝇身上**发，所以不能复用它，
	 *   但下面两条规矩必须一模一样：
	 *
	 *     1. 按**秒**累加（`acc += rate × dtMs / 1000`），不是每帧几颗。
	 *        按帧算的话 10× 倍速下粒子会多十倍、掉帧时会少一大截，
	 *        而两个方向都不报错
	 *     2. 单帧封顶 `maxPerTick`。一帧卡了 500ms 之后累加器里会攒下几十颗，
	 *        一次全倒出来就是一团糊
	 *
	 * ⚠ 累加器 `burnAcc` 是**全场共用一个**，不是每只蝇一个。三个理由：
	 *   · 不用给 Fly 加一个会跟着存档走的字段（那个字段出了发射器毫无意义）
	 *   · 封顶封的是「这一帧总共发几颗」，正是 maxPerTick 的用意 ——
	 *     每只蝇各封一次的话，烧着 20 只就能在一帧里炸出 80 颗
	 *   · 代价是粒子落在**哪一只**身上是随机的，但视觉上反而更好：
	 *     火苗会在几只之间跳，比每只均匀分几颗更像一片火
	 */
	_emitBurnFx(dtMs) {
		const F = CONFIG.tools.fx
		const list = []
		for (const f of this.flies) {
			if (!f.dead && f.burnLeft > 0) list.push(f)
		}
		if (list.length === 0) {
			this.burnAcc = 0
			return
		}

		let rate = 0
		for (const f of list) rate += f.burnBig ? F.flameRateBig : F.flameRate

		this.burnAcc += rate * (dtMs / 1000)
		let n = Math.floor(this.burnAcc)
		if (n > F.maxPerTick) {
			n = F.maxPerTick
			this.burnAcc = 0
		} else {
			this.burnAcc -= n
		}

		for (let i = 0; i < n; i++) {
			const f = list[Math.floor(Math.random() * list.length)]
			// 落点散在**身体上**而不是一个点 —— 全挤在圆心像一根蜡烛
			const s = (f.size ?? 12) * 0.22
			this._emitFlameParticle(f.x + rand(-s, s), f.y + rand(-s, s), f.burnBig)
		}
	}

	/** 一颗粒子落在哪儿、长什么样 —— 按工具分 */
	_emitOneParticle(fx) {
		const F = CONFIG.tools.fx

		if (fx.tool === 'lighter' || fx.tool === 'flamer') {
			// 火苗：从指针尖往上蹿。两档的差别由 fx.big 表达
			this._emitFlameParticle(fx.x, fx.y, fx.big)
			return
		}

		if (fx.tool === 'broom') {
			// 灰尘。落点分两种，这是**唯一**能看出半径多大／扫没扫的东西：
			//
			//   · 举着没按（空转）→ 落在**圈边上**。范围圈被删掉之后，
			//     玩家就是靠这一圈灰在调半径的 —— 撒在圆心等于什么都没说
			//   · 按住真的在扫  → 落满**整个圆面**，看起来才像「这一片被扫过」
			const a = rand(0, TAU)
			const r = fx.down
				? fx.radius * Math.sqrt(Math.random()) // ⚠ 均匀取半径的话灰会全堆在圆心
				: fx.radius * rand(0.88, 1)
			this.spawnParticle(
				fx.x + Math.cos(a) * r,
				fx.y + Math.sin(a) * r,
				Math.cos(a) * rand(6, 26),
				Math.sin(a) * rand(6, 26) - rand(4, 16),
				'rgba(205, 192, 166, 0.85)',
				rand(0.8, 2.2),
				{ life: F.broomLife, gravity: -6, drag: 1.6, grow: 1.1 },
			)
			return
		}

		if (fx.tool === 'squirt') {
			// 水雾：沿着**整条水线**随机取点（线段以指针为中心，两半都要采到），
			// 稍微往法线方向散开一点，看起来像一道会飘的水
			const half = fx.len / 2
			const t = rand(-1, 1)
			const nx = -Math.sin(fx.angle)
			const ny = Math.cos(fx.angle)
			const off = rand(-4, 4)
			this.spawnParticle(
				fx.x + Math.cos(fx.angle) * half * t + nx * off,
				fx.y + Math.sin(fx.angle) * half * t + ny * off,
				nx * rand(-22, 22),
				ny * rand(-22, 22) - 8,
				'rgba(190, 232, 255, 0.85)',
				rand(0.7, 1.8),
				{ life: F.squirtLife, gravity: 40, drag: 5, grow: 0.4 },
			)
			return
		}

		if (fx.tool === 'cloth') {
			// 抹布只在**真的在擦**（scrub > 0）时才冒水珠 —— 按住不动不该出水
			if (!(fx.scrub > 0)) return
			this.spawnParticle(
				fx.x + rand(-5, 5),
				fx.y + rand(-5, 5),
				rand(-18, 18),
				rand(-24, 6),
				'rgba(200, 230, 255, 0.8)',
				rand(0.7, 1.7),
				{ life: F.clothLife, gravity: 120, drag: 4 },
			)
		}
	}

	// ================================================================
	//  经济：出售 / 商店
	//
	//  这一节完全不知道生态怎么运转 —— 它只做两件事：
	//  把一只成虫换成钱，把钱换成道具。所有数值都在 CONFIG.market 里。
	// ================================================================

	/**
	 * 卖掉一只成虫。**屏幕上的和罐子里的都能卖。**
	 *
	 * 摘掉它、标记 dead、加钱、记账。**不走 `die()`**，也不留尸体 ——
	 * 它不是死了，是被买走了。留下尸体的话，玩家会以为自己的果蝇莫名其妙死了。
	 *
	 * ⚠ 三只来源都要认。早先这里只查 `this.flies`，罐中列表里点到「出售」
	 * 会静默返回 0（按钮点了没反应）。罐中果蝇本来就不在 `this.flies` 里
	 * （「隔离」就是靠这个白送的），所以这里必须显式再查一遍罐子。
	 * 但**结算只写一份** —— 三条来源各自算一遍钱是最容易写歪的地方。
	 *
	 * @param {object} fly
	 * @param {number} [mul] 只作用在**活蝇**那一支上的倍率。点火器烧完自动出售时
	 *   传它冻结在虫身上的 `burnMul`。
	 *
	 *   ⚠ **玩家用手动拖进出售区时不给这个参数**，也就是按原价卖。
	 *     这是有意的：那笔倍率是「别去碰它、让它自己烧完」赚的，
	 *     抓住一只正在烧的蝇等于自己放弃了它 —— 不是漏传了参数
	 *
	 *   ⚠ 尸体那一支**不吃这个倍率**。地上的尸体从 1.18.0 起没有倍率这一档了
	 *     （`Remains.price` 里只乘掉价系数），传进来也会被忽略
	 *
	 * @returns {number} 这一只卖了多少钱（不存在、已经死了、哪儿都找不到就是 0）
	 */
	sellFly(fly, mul = 1) {
		if (!fly || fly.dead) return 0

		// 先认尸体。它在 remains 里，既不在 flies 也不在任何罐子里。
		// ⚠ 只有 corpse 有价（汁渍的 value 是 0，卖了也是 0 块钱）
		let gain
		if (fly.kind === 'corpse' || fly.kind === 'stain') {
			const ri = this.remains.indexOf(fly)
			if (ri < 0 || !(fly.price > 0)) return 0
			this.remains.splice(ri, 1)
			gain = fly.price
		} else {
			const i = this.flies.indexOf(fly)
			if (i >= 0) {
				this.flies.splice(i, 1)
			} else {
				const jar = this.jarOf(fly)
				if (!jar) return 0
				jar.flies.splice(jar.flies.indexOf(fly), 1)
			}
			// ⚠ value 是 getter（含金光光环），要在标 dead 之前读
			gain = fly.value * (Number.isFinite(mul) && mul > 0 ? mul : 1)
			// 卖掉就是结清了 —— 不能留一个还能 tick 的倒计时。
			// （本来也走不到了：dead 之后 _updateBurning 会跳过它，
			//   但留着一个悬着的 burnMul 进存档是没有意义的）
			this.extinguish(fly)
		}

		fly.dead = true
		fly.causeOfDeath = 'sold'

		this._creditSale(gain)
		return gain
	}

	// ⚠ 这里删掉过 `buyOven()`（每摆一个收 $5）。烤炉从 1.27.0 起是商店里的
	//   **一次性道具**：买断之后投放面板里出现一行免费的「摆一个」，
	//   和玻璃罐走的是同一条路 —— 直接调 `dropOven()`。
	//   上限的闸门因此只剩 `addOven()` 那一处，不再有「扣了钱没东西」要退钱的问题

	/**
	 * 记一笔卖出：钱进账 + 计数 +1。**只算钱、不碰任何实体**，
	 * 所以地上 / 罐里 / 炉子三条来源都能调它。
	 *
	 * ⚠ 抽这一层是刻意的。上面 sellFly 那段注释写着「结算只写一份 ——
	 *   三条来源各自算一遍钱是最容易写歪的地方」，而烤炉改成自动卖钱之后
	 *   就真的出现了**第四条**来源（它没有尸体、没有实体可以传进 sellFly，
	 *   钱是在 _updateOvens 的循环里直接算出来的）。与其把那两行抄过去，
	 *   不如让两边都走这里
	 */
	_creditSale(gain) {
		if (!(gain > 0)) return 0
		this.money += gain
		this.stats.sold = (this.stats.sold ?? 0) + 1
		// ⚠ 「累计总收入」**只在这里**累加。
		//   全项目还有两处 `this.money +=`（buyFood / buyFlies 里的退款），
		//   那两处是「没放下的钱还给你」，不是赚到的 —— 算进去的话
		//   玩家反复买一批放不下的东西就能把总财富刷上去
		//   （第三处 buyOven 的退款随烤炉改成买断道具一起没了，见上面那段）
		this.stats.earned = (this.stats.earned ?? 0) + gain
		return gain
	}

	/**
	 * 把所有罐子里的果蝇一次卖光。
	 *
	 * ⚠ 每个罐子**分别** `slice()`，不是把各罐的蝇拼成一个大数组再遍历。
	 *   `sellFly` 要先在 `this.flies` 里找、找不到才 `jarOf(fly)` 反查 ——
	 *   而 `jarOf` 是按 fly 去找**它所在的那个罐子**。拼成一个大数组不会立刻出错，
	 *   但只要将来 jarOf 的实现换一种写法，这里就会开始卖错罐子的蝇。
	 *   按罐遍历则天然没有这个问题，而且顺便保证「每个罐子里的每一只都恰好被处理一次」。
	 *
	 * ⚠ 必须遍历 `slice()` 的副本：sellFly 会从 jar.flies 里 splice，
	 *   正着遍历原数组会跳着走、漏掉一半（discardJar 也是这么写的）。
	 *
	 * @returns {{count:number, gain:number}} 卖掉几只、一共拿到多少钱
	 */
	sellAllInJars() {
		let count = 0
		let gain = 0
		for (const jar of this.jars) {
			for (const f of jar.flies.slice()) {
				const g = this.sellFly(f)
				if (g > 0) {
					count++
					gain += g
				}
			}
		}
		// 和 bulkPrice / formatMoney 同一个理由：一长串相加会攒出浮点尾巴，
		// 而这一笔是要直接加进 money、再显示给玩家看的
		return { count, gain: Math.round(gain * 1000) / 1000 }
	}

	/**
	 * 把所有罐子里的果蝇一次放回屏幕。
	 *
	 * 和上面同一套遍历方式（逐罐 slice）。**不加二次确认** ——
	 * 这一步是可逆的：虫子只是回到屏幕上，照样活着，随时能再网回去。
	 *
	 * @returns {number} 放走了几只
	 */
	releaseAllInJars() {
		let count = 0
		for (const jar of this.jars) {
			for (const f of jar.flies.slice()) {
				this.releaseFly(jar, f)
				count++
			}
		}
		return count
	}

	/**
	 * 买一件商店道具。
	 *
	 * ⚠ 钱不够时**既不扣款也不发货**，而且要先判「已经有了」——
	 * 重复购买会把钱扣掉而东西还是那一件，是最容易漏的一种坏法。
	 *
	 * @returns {boolean} 买成了没有
	 */
	buyShopItem(id) {
		const item = shopItem(id)
		if (!item || this.shop[id]) return false
		if (this.money < item.price) return false

		this.money -= item.price
		this.shop[id] = true
		return true
	}

	/** 这一件买过了没有 */
	hasShopItem(id) {
		return !!this.shop[id]
	}

	// —— 可升级道具链（烤制）——
	//
	// ⚠ 等级存在 this.shop 里，值是**数字**，不是 true。
	// 复用同一个对象是刻意的：serialize 是 `{...this.shop}`、restore 是
	// Object.assign，键值形态任意 —— 所以加这条链**不用改存档结构、
	// 也不用动 SAVE_VERSION**，老存档读进来只是等级 0。
	//
	// ⚠ 但 hasShopItem 是 `!!` 语义，等级 0 和「没买」分不开，
	// 所以升级链一律走下面这两个方法，别去碰 hasShopItem / buyShopItem
	// （tools/simulate.js 和自检都依赖它们现在的一次性道具语义）。

	/**
	 * 这条链升到几级了。没买过是 0。
	 *
	 * ⚠ **返回值必须夹在链长以内。** 等级是直接从存档里读回来的裸数字，
	 *   而链的长度会跟着版本变 —— 1.18.0 把烤制链从三档砍到两档
	 *   （烤炉出链、变成投放里 $5 的商品），老存档里那句 `shop.roast: 3`
	 *   当场就成了越界值。
	 *
	 *   不夹的话 `chain[lv - 1].name` 会读到 undefined 并抛异常，
	 *   而那个异常发生在**渲染循环里**（ui.update → refreshStats → refreshShop），
	 *   会把整个主循环打死：表现是「读档之后屏幕上一个生物都没有」，
	 *   而且不弹任何错误、面板还好好地挂在那儿 —— 极难归因。
	 *
	 *   夹住的代价只是「老玩家那一档作废」（烤炉现在是单独买的），
	 *   不夹的代价是整个屏幕空掉。
	 *
	 * ⚠ 认不出的 id（不在任何一条链里）**不要返回 0**，原样返回数字 ——
	 *   这个方法对一次性道具只是「顺手能读」，改变那部分语义会牵连别处
	 */
	shopLevel(id) {
		const v = this.shop[id]
		if (!Number.isFinite(v)) return 0
		const chain = chainOf(id)
		if (!chain) return Math.max(0, v)
		return clamp(v, 0, chain.length)
	}

	/**
	 * 这一级（1 起）的描述，越界返回 null。
	 *
	 * ⚠ 链的查找在 market.chainOf 里，**不在这里**。以前这里是写死的
	 *   `id === 'roast' ? ... : null`，加第二条链时忘了改的话，
	 *   upgradeShopItem 会永远返回 false —— 症状只是「点升级没反应」
	 */
	chainTier(id, level) {
		const chain = chainOf(id)
		return chain ? (chain[level - 1] ?? null) : null
	}

	/**
	 * 把这条链升一级。
	 *
	 * 和 buyShopItem 同一条规矩：**钱不够时不扣款、不升级**，
	 * 失败的操作不该留下任何痕迹。已经满级也返回 false。
	 */
	upgradeShopItem(id) {
		const next = this.chainTier(id, this.shopLevel(id) + 1)
		if (!next) return false // 满级，或者 id 根本不在任何一条链里
		if (this.money < next.price) return false

		this.money -= next.price
		this.shop[id] = next.level
		return true
	}

	// ================================================================
	//  工具
	// ================================================================

	/**
	 * 苍蝇拍：以 (x, y) 为中心，半径 swatRadius 内的生命体全部拍死，
	 * 每个都爆一次汁，并在落点留下一块需要擦的污渍。
	 * @returns {number} 拍死了几只
	 */
	swat(x, y) {
		const T = CONFIG.tools
		const R2 = T.swatRadius * T.swatRadius
		let killed = 0

		const tryKill = (list) => {
			for (const e of list) {
				if (e.dead) continue
				if (dist2(x, y, e.x, e.y) > R2) continue
				e.dead = true
				e.causeOfDeath = 'swatted'
				// 拍死 = 火也灭了。真正防「重复结算」的是 _updateBurning 里那句
				// `if (f.dead) continue`，这里灭火只是把状态收干净 ——
				// 不留一个悬着的 burnMul 在尸体上
				this.extinguish(e)
				killed++
				this.burstJuice(e.x, e.y, e.size ?? 14)
			}
		}

		tryKill(this.flies)
		if (T.swatKillAll) {
			tryKill(this.larvae)
			tryKill(this.eggs)
		}

		// 打空了就不脏屏幕。
		// 这里只留「汁渍」—— 被打死的果蝇本体由 _resolveLifecycles 统一结算成尸体，
		// 所以不必在这里再复制一份。两块足够了，再多屏幕会糊。
		if (killed > 0) {
			this.addRemains(x, y, 'stain', T.swatRadius * 0.7, rand(0, TAU))
		}

		// 挥拍反馈：**命中与否都放一圈**粒子，半径就是杀伤半径。
		//
		// ⚠ 这一圈以前是「画在拍头上的虚线圈」。工具图案全删之后，
		//   拍面（`swatterHeadAt`，在指针**左上方**）就看不见了 ——
		//   不放这一圈的话，玩家根本不知道那一下打到了哪儿。
		//   命中暖色、挥空灰色，和以前那圈挥拍动画是同一套语义
		this.burstRing(
			x,
			y,
			T.swatRadius,
			10,
			killed > 0 ? 'rgba(255, 210, 122, 0.95)' : 'rgba(205, 205, 205, 0.8)',
		)
		return killed
	}

	/**
	 * 扫帚：把 (x, y) 半径 r 内的**幼虫**朝外推。
	 *
	 * 形状和 swat / wipe / squirt 一样：立即执行、返回一个计数，所以无头模拟器
	 * 可以直接断言 —— 不需要 UI。
	 *
	 * 只推幼虫。三条边界的理由：
	 *   · 成虫 / 卵：扫帚不是武器也不是网，用户要的是「把这一坨蛆赶到别处去」
	 *   · 蛹：设定就是「化蛹后完全静止」——（`_advance` 根本不在蛹期那条路上）。
	 *     推得动的话蛹会满屏乱跑，整个蛹期的视觉语言就没了
	 *
	 * ⚠ **不清 `scentSpot`。** 抹掉记忆的扫帚等于洗脑：被扫开之后
	 *   又爬回果子才是对的表现（那也是它能被用来「赶开一坨蛆」而不是
	 *   「让蛆失忆」的原因）。清掉还会顺手搅乱 sim 里食物 / 结伴那几段断言
	 *
	 * @returns {number} 被推到的幼虫只数
	 */
	broom(x, y, r) {
		// 半径为 0 是空操作，不是「推 0 距离」。少了这一条，
		// 滚轮还没调过半径时（r 为 0）会走完整个循环再一只都推不动
		if (!(r > 0)) return 0

		const B = CONFIG.tools.broom
		const r2 = r * r
		let pushed = 0

		for (const L of this.larvae) {
			if (L.dead || L.pupa) continue
			const d2 = dist2(x, y, L.x, L.y)
			if (d2 > r2) continue

			const d = Math.sqrt(d2)
			let ax = L.x - x
			let ay = L.y - y
			if (d < 1e-6) {
				// 正好压在圆心上：没有「外侧」可言，随便挑一个方向。
				// 不挑的话下面会除以 0，得到 NaN 坐标 —— 那种虫子之后
				// 再也画不出来（canvas 遇到 NaN 直接跳过这一笔），而不会报错
				const a = rand(0, TAU)
				ax = Math.cos(a)
				ay = Math.sin(a)
			} else {
				ax /= d
				ay /= d
			}

			// 圆心最强、边缘为 0。**直接写目标速度**而不是往上累加 ——
			// 累加会让手感随帧率变，理由写在 CONFIG.tools.broom.pushSpeed 上面
			const spd = Math.min(B.pushSpeed * (1 - d / r), B.pushMaxSpeed)
			L.pushVx = ax * spd
			L.pushVy = ay * spd

			// 朝向也掰向外侧，否则它一边被推一边照着自己的游走方向往扫帚里爬。
			// wanderTimer 一起重置：不重置的话它可能下一帧就改主意转回来，
			// 转向这一步等于白做
			L.angle = angleLerp(L.angle, Math.atan2(ay, ax), B.turnMix)
			L.wanderTimer = rand(0.5, 1.5)
			L.wanderTarget = L.angle
			pushed++
		}
		return pushed
	}

	/**
	 * 抹布：擦掉 (x, y) 附近的东西。
	 *
	 * ⚠ `scrub` 是「这一次滑过了多少**像素**」，不是「几下」也不是毫秒。
	 * 传 0（按住不动）什么也不会发生 —— 「必须来回滑动才擦得掉」就是靠这一点
	 * 实现的，而不是另外写一条规则去卡。
	 *
	 * 擦得到的不只是残留物：蛹壳也能擦（早先只能戴手套拖进垃圾桶）。
	 *
	 * @param {number} scrub 这一次滑过的路程（像素）
	 * @returns {number} 擦掉了几处
	 */
	wipe(x, y, scrub = 0) {
		const R2 = CONFIG.tools.wipeRadius * CONFIG.tools.wipeRadius
		let cleaned = 0

		if (scrub > 0) {
			for (const r of this.remains) {
				if (r.dead) continue
				if (dist2(x, y, r.x, r.y) > R2) continue
				const before = r.clean
				r.wipe(scrub)
				if (r.clean > before) this.burstDust(r.x, r.y, 2)
				if (r.dead) cleaned++
			}

			for (const sh of this.shells) {
				if (sh.dead) continue
				if (dist2(x, y, sh.x, sh.y) > R2) continue
				const before = sh.clean
				sh.wipe(scrub)
				if (sh.clean > before) this.burstDust(sh.x, sh.y, 2)
				if (sh.dead) cleaned++
			}
		}

		// 拖尾是「手在动」的视觉反馈，按住不动不该拖出一条尾巴来
		if (scrub > 0) this.wipeTrail.push({ x, y, life: 0.4 })
		return cleaned
	}

	/**
	 * 喷水枪：一条线段扫过，「可清洁物」碰到就**直接消失**。
	 *
	 * 和 `wipe` 的区别就是「直接」两个字 —— 抹布要累计路程（越烂越难擦），
	 * 喷水枪一碰就没。所以这里**不要**去调 `r.wipe()`，置 `dead` 就够，
	 * 每步结算时 `this.remains` / `this.shells` 会被 filter 掉。
	 * 也不给钱、不留痕 —— 它不是「卖掉」，是「冲掉」。
	 *
	 * ⚠ **只碰 remains 和 shells 两个数组。** 它们就是抹布能擦的那两类。
	 *   食物 / 玻璃罐 / 烤炉 / 卵 / 幼虫 / 成虫一律不动（用户确认过）——
	 *   喷水枪是清洁工具，不是第二个垃圾桶。
	 *   ⚠ 尤其**别顺手把 `this.wipeTrail` 也清了**：那是抹布的拖尾，
	 *     纯表现（`{x, y, life}`，自己会消失），根本不是可清洁物
	 *
	 * 抽成 world 方法而不是写在 ui 里，理由和 `wipe` / `swat` 一样：
	 * **sim 能直接断言**，不用起 Electron。
	 *
	 * @param {number} x1 线段一端
	 * @param {number} y1
	 * @param {number} x2 线段另一端
	 * @param {number} y2
	 * @returns {number} 冲掉了几件
	 */
	squirt(x1, y1, x2, y2) {
		const pad = CONFIG.tools.squirtRadius
		let cleaned = 0

		// 线段长度的平方。退化成一个点时它是 0，下面的投影要防 0 除
		const dx = x2 - x1
		const dy = y2 - y1
		const len2 = dx * dx + dy * dy

		/** 点到线段的距离平方 —— 点落在线段外时退化成到最近那个端点的距离 */
		const segDist2 = (px, py) => {
			if (len2 <= 1e-9) return dist2(px, py, x1, y1)
			// 把点投影到线段上，t 夹在 [0,1] 之间，所以线段外会贴到端点上
			let t = ((px - x1) * dx + (py - y1) * dy) / len2
			t = t < 0 ? 0 : t > 1 ? 1 : t
			return dist2(px, py, x1 + dx * t, y1 + dy * t)
		}

		for (const r of this.remains) {
			if (r.dead) continue
			// 目标半径用**它自己画出来多大**，再加一个固定放宽量。
			// 纯按 size 判的话小污渍极难瞄准（和 _corpseAt 是同一个考虑）
			const rad = r.size * 0.5 + pad
			if (segDist2(r.x, r.y) > rad * rad) continue
			r.dead = true
			cleaned++
		}

		for (const sh of this.shells) {
			if (sh.dead) continue
			// 壳是细长的米粒，用它的长半轴当半径 —— 宁可判宽一点，
			// 也别让玩家「明明冲到了却没反应」
			const rad = Math.max(sh.radii.pl, sh.radii.pw) + pad
			if (segDist2(sh.x, sh.y) > rad * rad) continue
			sh.dead = true
			cleaned++
		}

		return cleaned
	}

	// ================================================================
	//  存档
	//
	//  分工：实体自己回答「我有哪些数据」（entities.js 的 snapshot / revive），
	//  这里负责「哪些数组要存、哪些状态不存」。文件读写在主进程（main.js），
	//  渲染进程碰不到 fs。
	// ================================================================

	/**
	 * 把整个世界拍成一份可以直接 JSON.stringify 的纯数据。
	 *
	 * 刻意**不存**两类东西：
	 *
	 *   particles / wipeTrail —— 纯表现层，寿命都不到 1 秒。
	 *     存下来再读出来它们也早该消失了，存了只是白白撑大存档。
	 *
	 *   paused / timeScale —— 这是「当前这一会儿你想怎么看」，不是生态本身的状态。
	 *     存了之后读档会连「暂停」一起继承，打开程序就是停住的，很困惑；
	 *     而且工具栏上那两个按钮的初始样式是写死在 HTML 里的，
	 *     真按存档恢复状态反而容易和按钮显示对不上。
	 */
	serialize() {
		return {
			w: this.w,
			h: this.h,
			elapsed: this.elapsed,
			nextClutch: this.nextClutch,
			money: this.money,
			shop: { ...this.shop },
			// ⚠ 这个方法是**按名字逐个写**的，新字段不会自动进来 ——
			//   忘了加这一行的话，养蝇人的配置每次读档都会退回默认值，
			//   而且完全不报错（玩家只会觉得「我设的怎么又变回去了」）
			keeper: { ...this.keeper },
			// ⚠ 数组要**拷一份**：slice() 之后写进 JSON 才是快照，
			//   直接给引用的话存档对象和世界共享同一个数组，
			//   之后玩家一勾档位，手里那份「旧存档」也跟着变了
			magnifierTiers: this.magnifierTiers.slice(),
			settings: { ...this.settings },
			stats: { ...this.stats },
			swarm: { ...this.swarm },
			mateScanTimer: this.mateScanTimer,
			foodTimer: this.foodTimer,
			flies: this.flies.map(snapshot),
			larvae: this.larvae.map(snapshot),
			eggs: this.eggs.map(snapshot),
			foods: this.foods.map(snapshot),
			shells: this.shells.map(snapshot),
			remains: this.remains.map(snapshot),

			// 罐子要连里面的果蝇一起存，而且要展开成**嵌套的 snapshot**。
			// 直接 snapshot(jar) 不行：它的 flies 是活实体数组，会被当成普通数组
			// 浅拷贝过去（entities.js 的 REF_FIELDS 里把 flies 挡掉了，正是为了逼出这一行）。
			// 罐中果蝇的 x/y 是相对罐心的偏移，原样存原样读，不需要换算。
			jars: this.jars.map((j) => ({
				...snapshot(j),
				flies: j.flies.map(snapshot),
			})),

			// 烤炉和罐子同理，items 也必须展开成嵌套 snapshot。
			// ⚠ 少写这个 map 的话，items 会以「活 Fly 对象的浅拷贝」进存档，
			// 读出来是一堆没有方法的空壳 —— 画得出来，一动就炸
			ovens: this.ovens.map((o) => ({
				...snapshot(o),
				items: o.items.map(snapshot),
			})),
		}
	}

	/**
	 * 用存档覆盖当前世界。数据不合法就抛异常，由调用方决定退回新局 ——
	 * 这里不做半途而废的「部分恢复」，那只会留下一个四不像的世界。
	 *
	 * @param {object} data serialize() 的产物（已经过 JSON 往返）
	 */
	restore(data) {
		if (!data || typeof data !== 'object') throw new Error('存档内容不是一个对象')

		// 数组一律先清空。不清的话就是「新开局那几只 + 存档那几只」叠在一起，
		// 而且新开局那几只是 World 构造函数里 reset() 放的，很容易被忽略。
		// ⚠ floatTexts 也在这一串里，虽然它**根本不在存档里**（纯表现层）——
		//   读档时「重新开始」的意思包括「把上一局飘在半空的金额清掉」，
		//   留着的话会在新局头上飘过一串上一个存档的价格
		for (const list of [
			this.flies,
			this.larvae,
			this.eggs,
			this.foods,
			this.remains,
			this.particles,
			this.wipeTrail,
			this.floatTexts,
		]) {
			list.length = 0
		}

		this.elapsed = safeNum(data.elapsed, 0)
		this.stats = Object.assign(this._freshStats(), data.stats)
		// swarm 只覆盖存档里有的键，其余保留构造函数的初值 ——
		// 少了 timer 的话集群会立刻触发一次，开局就看见幼虫集体暴走
		this.swarm = Object.assign({ active: false, timer: 0, x: 0, y: 0, left: 0 }, data.swarm)
		this.mateScanTimer = safeNum(data.mateScanTimer, 0)
		this.foodTimer = safeNum(data.foodTimer, 0)

		// ⚠ 世界级的字段要**逐个按名字读**，不读就等于没存 ——
		// 实体那边是自动的（revive 先造默认实例再覆盖），世界这边不是。
		// 漏掉这两行的话，钱和已购道具每次读档都会归零，而且不报错。
		this.money = Math.max(0, safeNum(data.money, 0))
		this.shop = Object.assign({}, data.shop)
		// 养蝇人的配置。和 settings 同一套：**合并到默认值上**，
		// 所以老存档（根本没有 keeper 字段）会自动拿到一份完整默认值，
		// 将来往 _freshKeeper 里加字段也一样兼容
		this.keeper = Object.assign(this._freshKeeper(), data.keeper)
		this.keeperTimer = 0
		// 放大镜的档位。⚠ **必须 sanitize**，不能 `data.magnifierTiers || 默认`：
		//   老存档根本没有这个字段（→ 默认），而手改过的存档可能塞进
		//   不存在的档位 id —— 高亮会静默失效，玩家只会觉得「放大镜坏了」。
		//   sanitizeTiers 会去重、丢掉认不出的、按 valueTiers 顺序排
		this.magnifierTiers = Array.isArray(data.magnifierTiers)
			? sanitizeTiers(data.magnifierTiers)
			: magnifierDefaultTiers()
		// 老存档没有 settings 字段 → 保留构造函数里的默认（正常模式）。
		// Object.assign 到默认对象上，所以将来加新设置项也是自动兼容的
		this.settings = Object.assign({ annoying: false }, data.settings)

		this.flies = this._loadList('adult', data.flies)
		this.larvae = this._loadList('larva', data.larvae)
		this.eggs = this._loadList('egg', data.eggs)
		this.foods = this._loadList('food', data.foods)
		this.shells = this._loadList('shell', data.shells)
		this.remains = this._loadList('remains', data.remains)

		// 窝号发号器。**不能只照搬存档里的数** ——
		// 老存档（还没有窝这个概念）根本没有这个字段，照搬会得到 0，
		// 于是接下来发的第一个号就是 0，而 0 是「没有窝」的保留值，
		// 一整窝幼虫会稀里糊涂地被当成「同一窝」和场上所有无主的幼虫认亲。
		// 所以取「存档值」和「现存实体用过的最大号 + 1」里大的那个
		let maxUsed = 0
		for (const e of [...this.eggs, ...this.larvae]) {
			if (e.clutch > maxUsed) maxUsed = e.clutch
		}
		this.nextClutch = Math.max(safeNum(data.nextClutch, 1), maxUsed + 1, 1)

		// 罐子和罐中果蝇要成对重建：造一个罐子，立刻把它的果蝇填进去。
		// 不能用 _loadList 分开造再用下标对齐 —— 那个方法会跳过 dead 的条目，
		// 一旦跳过一个，后面所有罐子和它的果蝇就全错位了。
		this.jars = []
		for (const jd of Array.isArray(data.jars) ? data.jars : []) {
			const jar = revive('jar', jd)
			if (!jar || jar.dead) continue

			for (const fd of Array.isArray(jd.flies) ? jd.flies : []) {
				const fly = revive('adult', fd)
				if (!fly || fly.dead) continue
				// 满员就丢掉多余的（正常存档不会超，防的是被手改过的存档）
				if (jar.flies.length >= jar.capacity) break

				// 直接 push，**不能走 jar.admit()** —— 那个方法是给「从屏幕上抓一只进来」
				// 用的，它会按极坐标重新随机一个罐内位置。在这里用就会把存档里
				// 存下来的坐标冲掉，读档后果蝇全挤成一团新的随机分布。
				// 这里要的是「原样放回去」，位置已经在 fd 里了。
				jar.flies.push(fly)
			}
			this.jars.push(jar)
		}

		// 烤炉和罐子一样要**成对重建**：造一个炉子，立刻把里面的果蝇填进去。
		// 同样不能用 _loadList 分开造 —— 它跳过 dead 条目之后会整体错位。
		// 同样**不能走 oven.admit()**：那个方法会重新随机炉内位置，
		// 把存档里存下来的坐标冲掉
		this.ovens = []
		for (const od of Array.isArray(data.ovens) ? data.ovens : []) {
			const oven = revive('oven', od)
			if (!oven || oven.dead) continue

			for (const fd of Array.isArray(od.items) ? od.items : []) {
				const fly = revive('adult', fd)
				if (!fly || fly.dead) continue
				if (oven.items.length >= oven.capacity) break

				// ⚠ 老存档（1.20.x 及以前）里的炉子是**整炉一个倒计时**
				//   （`Oven.roastTimer`），虫身上没有 `roastLeft`。那种档读进来
				//   之后每一只的 `roastLeft` 都是 null —— 也就是「没在烤」，
				//   而炉子**再也没有别的地方能给它开烤**了（1.21.0 起没有
				//   「开烤」这个动作，全靠 admit 时挂上）。
				//   不做这一步迁移的话，那些果蝇会**永远卡在炉子里**：
				//   不烤、不卖、也拿不出来，而且不报任何错。
				//
				//   顺带也兜住了「手改过的存档」和「字段被写坏」两种输入
				if (!Number.isFinite(fly.roastLeft) || !(fly.roastTotal > 0)) {
					fly.roastLeft = CONFIG.roast.oven.roastMs
					fly.roastTotal = CONFIG.roast.oven.roastMs
				}

				oven.items.push(fly)
			}
			this.ovens.push(oven)
		}

		// —— 一次性存档迁移：烤炉从「按次收费」改成「商店买断」——
		//
		// 1.27.0 之前烤炉不在商店里，老存档的 this.shop 里**没有 oven 这个键**。
		// 不迁的话，一个正摆着两三台炉子的玩家更新完打开投放面板会发现
		// **那一行凭空消失**（要重新去商店花 $15 买一次），
		// 而屏幕上明明还摆着他之前买的那几台。
		//
		// 判据用「已经摆着炉子」而不是版本号：那是**看得见的事实**，
		// 顺手也兜住了「手改存档塞了炉子但没 shop 键」这种怪状态。
		//
		// ⚠ 位置**必须在上面这个 ovens 重建循环之后** ——
		//   放到前面（挨着 _loadList 那几行）的话 this.ovens 还是构造函数里的
		//   空数组，这条永远不触发，而且是静默的
		if (this.ovens.length > 0 && !this.shop.oven) this.shop.oven = true

		// 存档时的窗口尺寸不一定和现在一样（换显示器、改分辨率、或者存档来自
		// 另一个屏幕）。坐标原样沿用的话，会有实体落在屏幕外回不来 ——
		// 借 resize() 把它们夹回可见范围。
		//
		// 只在尺寸真的变了时才夹。尺寸没变还夹一遍的话，正在飞出屏幕的果蝇
		// （它们本来就被允许待在 −8 ~ w+8 这段里等着绕回来）会被硬拽回边界上，
		// 存档就不再是「原样」的了 —— 往返一致性测试会当场发现这一点。
		if (data.w !== this.w || data.h !== this.h) this.resize(this.w, this.h)
	}

	/** 重建一个实体数组，顺手丢掉坏掉的条目 */
	_loadList(type, arr) {
		if (!Array.isArray(arr)) return []
		const out = []
		for (const data of arr) {
			const e = revive(type, data)
			// dead 的实体会在每一步末尾被 world 收走，本来就不该出现在存档里；
			// 万一是「存档写了一半」之类的产物，这里直接丢掉，不让它进来
			if (e && !e.dead) out.push(e)
		}
		return out
	}

	// ================================================================
	//  收尾 & 统计
	// ================================================================

	_cleanup() {
		this.particles = this.particles.filter((p) => !p.dead)
		this.floatTexts = this.floatTexts.filter((t) => !t.dead)
		this.remains = this.remains.filter((r) => !r.dead)
		this.shells = this.shells.filter((s) => !s.dead)
		// 烤串只会被卖走（sellFly 里直接 splice），本身不会 dead。
		// 这里还是过一道，免得将来加了别的销毁路径时漏收
		// ovens 在 _updateOvens 末尾已经收过，这里不重复
	}

	/** 罐中果蝇总数 */
	get jarredCount() {
		let n = 0
		for (const j of this.jars) n += j.flies.length
		return n
	}

	/**
	 * 还活着的生命体总数。
	 *
	 * 罐中果蝇也算 —— 它们确实活着，只是被关起来了。
	 * 不算的话会出现「罐子里明明有 8 只在动，存活却显示 0」这种矛盾。
	 */
	get livingCount() {
		return this.flies.length + this.larvae.length + this.eggs.length + this.jarredCount
	}

	// ================================================================
	//  模式：正常 / 烦人
	//
	//  烦人模式把「生态生物」的上限拉高 annoyingMul 倍。做成 getter 而不是
	//  在切换时改 CONFIG —— CONFIG 是**只读的调参表**，全局共享；
	//  在它上面写运行时状态的话，重置、读档、以及任何「恢复初始值」
	//  的地方都得记着还原，漏一处就会留下一个改不回去的世界。
	// ================================================================

	/** 现在是不是烦人模式 */
	get annoying() {
		return !!this.settings.annoying
	}

	/** 生物类上限的倍率。正常 1，烦人 50 */
	get capMul() {
		return this.annoying ? CONFIG.world.annoyingMul : 1
	}

	get maxAdults() {
		return Math.round(CONFIG.world.maxAdults * this.capMul)
	}

	get maxLarvae() {
		return Math.round(CONFIG.world.maxLarvae * this.capMul)
	}

	get maxEggs() {
		return Math.round(CONFIG.world.maxEggs * this.capMul)
	}

	/**
	 * 全场生命体总数的硬闸。**只有烦人模式才生效。**
	 *
	 * ⚠ 光靠「各项 ×50」是不够的：成虫、幼虫、卵三个上限会**同时**顶到，
	 * 而它们各自又都在自己那一套循环里跑（交配、羽化、孵化），
	 * 加起来是 2000+3250+2000。这里给一个总量天花板，先到先得 ——
	 * 既够烦人，又不会把帧率拖到没法玩。
	 *
	 * 正常模式下恒为 false：那条路线上一只都不该被这个闸拦下
	 */
	get atPopCap() {
		return this.annoying && this.livingCount >= CONFIG.world.annoyingTotalCap
	}

	get counts() {
		return {
			adults: this.flies.length,
			larvae: this.larvae.length,
			eggs: this.eggs.length,
			foods: this.foods.length,
			jars: this.jars.length,
			jarred: this.jarredCount,
			ovens: this.ovens.length,
			ovenItems: this.ovens.reduce((n, o) => n + o.items.length, 0),
			// 有价的尸体数量。`sellable` 排掉的是汁渍 —— 它 value 是 0
			//
			// ⚠ 这里原来是 `r.roastable`，而且下面还有一行 `roasted`。
			//   1.18.0 起尸体不能再烤，那两个成员一起删了；
			//   只删成员不删这里的话，`undefined ? 1 : 0` 会**静默地恒为 0** ——
			//   面板上的尸体数从此永远是 0，而不会报任何错
			corpses: this.remains.reduce((n, r) => n + (r.sellable ? 1 : 0), 0),
			shells: this.shells.length,
			eating: this.larvae.reduce((n, l) => n + (l.eating ? 1 : 0), 0),
			laying: this.flies.reduce((n, f) => n + (f.laying ? 1 : 0), 0),
			living: this.livingCount,
			remains: this.remains.length,
			deaths: this.stats.deaths,
			natural: this.stats.natural,
			swatted: this.stats.swatted,
			eggsLaid: this.stats.eggsLaid,
			emerged: this.stats.emerged,
			sold: this.stats.sold ?? 0,

			// 成虫总价值 = 屏幕上所有成虫的售价之和，
			// 也就是「现在把它们全拖去卖掉能拿多少钱」。
			// 比单看只数更能说明这局养得怎么样：40 只瘦蝇也顶不上一只 Extreme。
			// （注意不含罐子里的 —— 那些不在 world.flies 里，得先放逐才能卖）
			value: this.flies.reduce((n, f) => n + f.value, 0),

			// 经济。UI 只从这里读数字，和别的计数一个来源
			money: this.money,
			// 「总财富」= 累计赚到过多少钱（只增不减）。食物的解锁门槛和
			// 成就的财富档位都读它 —— 和 `money` 的区别见 get lifetime()
			lifetime: this.lifetime,
			shop: this.shop,
			// 养蝇人：等级（0 = 没买）和玩家调的配置。
			// 按**引用**给出去，和 shop 一样 —— UI 只读不写，
			// 写一律走 world.setKeeperOption()
			keeperLv: this.shopLevel('keeper'),
			keeper: this.keeper,
			// ⚠ 这里**删掉过** `swarm: this.swarm.active`。它唯一的读者是
			//   「幼虫集群中」那颗浮标，用户要求去掉之后就没有消费方了 ——
			//   留着它只会让下一个人以为界面上还有东西在看集群状态。
			//   ⚠ 注意这不影响 `this.swarm` 本身：集群行为一行没动，
			//   它照样进 serialize / restore
		}
	}
}
