/**
 * entities.js — 四种实体：成虫 Fly、卵 Egg、幼虫 Larva、残留物 Remains
 *
 * 职责划分（刻意分开的，改起来不容易互相踩）：
 *   实体自己只管「怎么动、长什么样」
 *   「什么时候出生、什么时候死、死了变成什么」全部交给 world.js
 *
 * 所以这里的 update() 只推进运动和年龄，不会自己销毁自己。
 */

import {
	CONFIG,
	clamp,
	rand,
	randInt,
	MIN,
	larvaSizeAt,
	inheritTrait,
	larvaProfileAt,
	larvaWidthRatio,
	foodGrowthBonus,
} from './config.js'
import { TAU, lerp, angleLerp, dist2 } from './utils.js'
import { rollRarity, rollWeightMax, weightAt, priceOf, rarityOf } from './market.js'
import {
	copyGenes,
	cleanGenes,
	hasMutation,
	valueMulOf,
	weightMulOf,
	inheritFrom,
	rollDeNovo,
	combineGenes,
	berserkLifespanMul,
	MUTATION_TYPES,
} from './mutations.js'

// ====================================================================
//  成虫 — 果蝇
// ====================================================================

export class Fly {
	/**
	 * @param {number} x
	 * @param {number} y
	 * @param {'M'|'F'} sex  'M' 雄性 / 'F' 雌性
	 * @param {string} [rarity] 稀有度 id（market.rarity 里的一档）。
	 *   不传就现抽一次 —— 手动投放 / 开局那几只是这么来的
	 * @param {string[]} [mutations] 这一只带的突变 id。**由调用方传入**，
	 *   构造函数自己不骰 —— 见下面「新发突变只在产卵时骰」那段
	 */
	constructor(x, y, sex, rarity = null, mutations = null) {
		const A = CONFIG.adult

		this.kind = 'adult'
		this.x = x
		this.y = y
		this.vx = 0
		this.vy = 0
		this.sex = sex

		// —— 体重 / 稀有度 ——
		//
		// 这两个都是构造函数的自有字段，所以 snapshot()/revive() 会**自动**存读，
		// 不用动 REF_FIELDS（那是个「引用字段」黑名单），也不用动存档版本号。
		// 规则见文件末尾 snapshot() 上面那段注释。
		this.rarity = rarity ?? rollRarity()
		// 满成长时的体重，出生抽一次就固定 —— 当前体重是它按成长进度插值出来的
		this.weightMax = rollWeightMax(this.rarity)

		// —— 基因 ——
		//
		// ⚠ 必须是**普通数组**，不能是 Set。snapshot()（文件末尾）只认
		//   「原始值 / Array / 纯对象」三种形态，Set 会从三条分支中间直接掉下去 ——
		//   字段静默不进存档，每次读档突变全部消失，不报错也不崩溃。
		//   那正是 snapshot 那段注释想挡的事，但它挡不住 Set
		//
		// ⚠ 拷一份而不是直接用传进来的数组：那个数组可能是母体的 layMutations，
		//   直接引用的话，给这只加突变会同时改到它的兄弟姐妹
		this.mutations = copyGenes(mutations)

		this.age = 0
		// 疯狂蝇寿命砍半（mutation.types 里 berserk 的 lifespanMul）。
		//
		// ⚠ 乘在**构造时**，不是做成 getter。lifespan 是个存下来的字段，
		//   growth / hpMax / 死亡判据 / 罐中列表全都直接读它 ——
		//   做成 getter 的话就等于把「寿命」这个概念拆成两套，
		//   而 `age + wounds >= lifespan` 那个死亡判据会和三处显示对不上
		this.lifespan = rand(A.lifespanMin, A.lifespanMax) * berserkLifespanMul(this.mutations)
		this.size = A.sizeBirth

		// —— 生命值 ——
		//
		// 伤害**不推进 age**，而是攒在这个单独的字段里，死亡判据是
		// `age + wounds >= lifespan`。
		//
		// ⚠ 为什么不能直接加 age：growth = age / lifespan → weight → value。
		//   加 age 就等于「被咬一口反而变重、变贵」，是个反向激励。
		//   而且吃金苹果会 1.5 倍加速 age，那样伤害也会跟着变成 1.5 倍
		this.wounds = 0

		// 附近有没有点石成金蝇在给自己加成。每帧由 world._applyGoldAura() 重写
		// （和 startleMul 同一个套路：**每帧无条件重写**，包括不在光环里的那些人）。
		//
		// ⚠ 它是自有字段，会跟着存档走。只设不复位的话，那个 1.1 会被永久
		//   写进存档、重启后依然生效，价值凭空通胀且再也回不来。
		//   进罐子 / 烤炉时也要重置（容器里跑不到那个 pass），见 Jar.admit
		this.goldAura = 1

		// 朝向：aim 是「想飞的方向」，angle 是身体实际朝向（渲染用）
		this.aim = rand(0, TAU)
		this.angle = this.aim
		this.targetSpeed = rand(A.speedMin, A.speedMax)
		// 被鼠标挥手惊到的临时速度倍率。1 = 没被吓到。
		// 每帧由 world._applyStartle() 重写，只写给自由飞的成虫
		this.startleMul = 1

		// 果蝇不是匀速飞，而是「窜一下、悬停一下」
		this.dartTimer = rand(0, A.dartIntervalMax)
		this.hoverTimer = 0
		this.bait = null // 嗅觉范围内最近的烂果子（每帧在 update 里统一判定一次）

		// 飞 / 走 两种状态。
		// 真实果蝇大部分时间落在地上爬，只有受惊或换地方时才飞 ——
		// 这个落差是「像活的」最主要的来源，比单纯调快飞行速度有效得多。
		// ⚠ 石化蝇（canFly = false）**出生就在地上**。这只是「失去飞行」的
		//   五个入口之一 —— 另外四个见 Fly.canFly 的注释，漏掉任何一个
		//   都会变成「它有时候还是会飞」
		this.mode = this.canFly && Math.random() < 0.5 ? 'fly' : 'walk'
		this.modeTimer = rand(CONFIG.behavior.flyMin, CONFIG.behavior.flyMax)
		this.gaitPhase = rand(0, TAU) // 腿部步态相位，跟着实际位移一起推进
		this.pausing = false // 「走一段」之间的那个停顿
		this.boutTimer = rand(CONFIG.walk.boutMin, CONFIG.walk.boutMax)
		this.wasInScent = false // 上一帧闻没闻到食物，用来抓「刚闻到的瞬间」

		// 进食：走到果子上的成虫在果实范围内随机踱步，而不是钉在圆心
		this.feeding = false // 这一帧是不是已经站在果子上了
		this.feedTarget = null // 当前挑中的那个落脚点
		this.feedTimer = 0

		// 纯装饰用的相位
		this.wingPhase = rand(0, TAU)
		this.legPhase = rand(0, TAU)
		// 身上那层颗粒质感的固定随机种子。必须存下来而不是每帧 Math.random()——
		// 否则颗粒会每个点都在跳，看着像一片沙沙响的噪点，比不做还糟
		this.seed = rand(0, 1000)

		// 繁殖状态
		this.cooldown = 0 // 交配冷却剩余时间（毫秒）
		// 每只雌性有自己的「卵大小」个性 —— 同样一窝卵，有的母体产得偏大、有的偏小，
		// 所以不同母体的后代看起来会不一样大。雄性用不到，但一并生成无所谓。
		this.eggTrait = rand(CONFIG.egg.scaleMin, CONFIG.egg.scaleMax)

		// 体型性状：决定她这一批幼虫偏「短胖椭圆」还是「细长米粒」，会遗传给后代。
		// 同一只母体产下的整批幼虫共享这个性状，所以不同批次看起来是一伙一伙的。
		this.shape = {
			length: rand(CONFIG.larva.lengthMin, CONFIG.larva.lengthMax),
			slim: rand(CONFIG.larva.slimMin, CONFIG.larva.slimMax),
		}

		// 产卵：先飞到一个挑好的地方，再停在原地一颗一颗把卵产下来
		this.laying = false
		this.layRemaining = 0 // 这一窝还剩几颗
		this.layTimer = 0 // 距离下一颗还有多久（毫秒）
		this.layScale = 1 // 这一窝的卵大小基准

		// —— 窝（clutch）——
		//
		// 同一个号会一路跟着这一窝：卵带上它 → 孵出来的幼虫继承它。
		// 「同窝的卵差不多同时孵」和「同窝的幼虫更容易凑到一起」都靠它。
		this.layClutch = 0
		this.layHatch = 0 // 这一窝共用的基准孵化时间（毫秒）
		this.laySite = null // 挑好的产卵点 { x, y }，飞到了才开始产
		this.laySeekTimer = 0

		// —— 这一窝的基因 ——
		//
		// 父本的突变在**交配那一刻**存下来，因为真正产卵的 startLaying()
		// 有四个调用点（就地开产 / 飞到产卵点 / devtools / sim），
		// 只有 beginClutch 那条路上手上才有父本。
		//
		// ⚠ fatherMutations 必须在 _endClutch() 里清掉。
		//   那个方法存在的原因本身就是「上一窝的字段漏到了下一窝」
		this.fatherMutations = []
		this.layMutations = [] // 这一窝每颗卵的基础基因（父母各传一半 + 新发）

		this.dead = false
		this.causeOfDeath = null
	}

	get mature() {
		return this.age >= CONFIG.adult.matureAge
	}

	/** 现在可以交配吗。正在飞去产卵点的也算「忙着」，不参与配对 */
	get canMate() {
		return this.mature && !this.laying && !this.laySite && this.cooldown <= 0 && !this.dead
	}

	// ---------------------------------------------------------- 体重 / 价值
	//
	// 全部做成 getter 而不是存储字段：它们都是由 age / lifespan / rarity / weightMax
	// 推出来的。存下来的话，任何没走到 update 的代码路径（以及所有外部想「催熟」它的地方）
	// 都会发现赋值被无声覆盖 —— Remains.rot 就是在这个坑上栽过一次，见那边的注释。

	/** 成长进度 0~1。和体型用的是同一个量，所以「长大」和「变重」永远同步 */
	get growth() {
		return clamp(this.age / this.lifespan, 0, 1)
	}

	/**
	 * 当前体重（mg）。
	 *
	 * 石化蝇重 ×1.5。⚠ 这不是纯装饰：value = priceOf(weight)，
	 * 所以它**顺带把售价也抬了 1.5 倍**。这是游戏本来的换算关系
	 * （重就是值钱），不是给石化额外开的价值加成 —— 石化同时也失去了飞行。
	 */
	get weight() {
		return weightAt(this.rarity, this.weightMax, this.growth) * weightMulOf(this.mutations)
	}

	/**
	 * 卖掉能换多少游戏币。
	 *
	 * 三段相乘：
	 *   · 体重换算 —— 本来就有
	 *   · 自身突变（点石成金 ×1.3 / 结晶 ×2，同时带就是连乘）
	 *   · 附近有没有点石成金蝇（×1.1，不叠加）
	 *
	 * ⚠ goldAura 写成 `|| 1` 是防老存档 / 手改存档里没有这个键 ——
	 *   不加这道的话 `undefined` 会让整只果蝇的价值变成 NaN，
	 *   而 NaN 会一路渗进 world.money 和面板
	 */
	get value() {
		return priceOf(this.weight) * valueMulOf(this.mutations) * (this.goldAura || 1)
	}

	/** 稀有度那一档的完整描述（名字、速度倍率……） */
	get rarityInfo() {
		return rarityOf(this.rarity)
	}

	/**
	 * 体重带来的速度倍率：普通 1×、变异 0.6×、极端变异 0.3×。
	 *
	 * ⚠ 按**档位**取，不按当前体重。重 10g 的极端变异从 0.2mg 起就是 0.3×，
	 * 不会「小时候灵活、长大变笨」—— 那样玩家就没法靠速度一眼认出变异了。
	 *
	 * 乘在**消费点**（wantSpeed / speed / want）而不是 targetSpeed 的赋值处：
	 * 赋值有三四处（构造函数、飞/走切换、窜的间歇、罐子），漏一处就会出现
	 * 「变异蝇在某些时候飞得和普通一样快」。消费点只有三处，且天然覆盖全部路径。
	 */
	get speedScale() {
		return this.rarityInfo.speedScale
	}

	// ---------------------------------------------------------- 基因

	/** 身上带没带某种突变 */
	hasMutation(id) {
		return hasMutation(this.mutations, id)
	}

	/**
	 * 还能不能飞。石化蝇不能。
	 *
	 * ⚠ 「失去飞行」有**五个**入口，只锁一个会变成「它有时候还是会飞」：
	 *   1. 构造函数里 mode 的初值（上面）
	 *   2. _updateMode() 的 walk → fly 转换
	 *   3. world._applyStartle() 受惊时强制起飞 —— **最难发现的那个**，
	 *      只在玩家挥鼠标时发生，平时测不到
	 *   4. world.releaseOvenFly()
	 *   5. world.releaseFly()
	 * 五处都读这个 getter，将来再加「不能飞」的变异也只用改这里
	 */
	get canFly() {
		return !this.hasMutation('stone')
	}

	// ---------------------------------------------------------- 生命值
	//
	// 生命值 = **剩余寿命**，单位是分钟。所以「伤害 1~3」的意思就是
	// 「让它少活 1~3 分钟」—— 不是另一套独立的血条。
	//
	// 这么做的好处是只有**一条**死亡线：老死和被打死在同一个判据上，
	// 面板上的数字就是现成的，不用维护两套计时器互相打架。

	/** 满血 = 寿命有多长（分钟）。成虫 16~25 */
	get hpMax() {
		return Math.max(1, Math.round(this.lifespan / MIN))
	}

	/**
	 * 当前生命值。
	 *
	 * ⚠ 两个取整必须一致。lifespan 是浮点（16.0~25.0 之间随机），
	 *   用 ceil 算当前、用 round 算上限的话，`lifespan = 16.4` 会算出
	 *   hp = 17 > hpMax = 16 —— 一只刚出生的果蝇显示超血。
	 *   所以两边都用 round，最后再夹一道
	 */
	get hp() {
		const used = Math.round((this.age + this.wounds) / MIN)
		return clamp(this.hpMax - used, 0, this.hpMax)
	}

	/**
	 * 挨一下。points 的单位是**分钟寿命**。
	 *
	 * ⚠ 绝不能写成 `f.hp -= n` —— hp 是原型上的 getter、没有 setter，
	 *   而 ES module 是严格模式，那样赋值会**直接抛 TypeError**（不是静默失效）。
	 *   伤害一律走这个方法
	 */
	takeDamage(points) {
		if (!(points > 0) || this.dead) return 0
		this.wounds += points * MIN
		const overkill = this.age + this.wounds - this.lifespan
		if (overkill >= 0) {
			this.dead = true
			this.causeOfDeath = 'killed'
		}
		return points
	}

	// startleMul —— 被鼠标「挥手」惊到的临时速度倍率，1 表示没被吓到。
	//
	// 由 world._applyStartle() 每帧写，只写给自由飞的成虫
	// （罐中和烤炉里的那两条路径不经过它，恒为 1）。
	//
	// ⚠ 和 speedScale 一样乘在**消费点**（_walk 的 speed、_fly 的 wantSpeed），
	// 不在 targetSpeed 的赋值处 —— 赋值点有三四处，漏一处就会
	// 「平时躲得开、某些时候突然不动了」，而那种 bug 只在挥手时出现，极难复现

	die(cause) {
		this.dead = true
		this.causeOfDeath = cause
	}

	/**
	 * 交配成功。由 world 在检测到雌雄靠近时调用。
	 *
	 * 这里没有任何「交配动画」：不再有两只绕着中点转圈的表演，
	 * 交配本身玩家是看不见的。
	 *
	 * 但要分两步走 —— 先挑地方、飞过去，到了才开始产：
	 *   beginClutch() 定下这一窝的「身份」（窝号、孵化时间）并挑好产卵点
	 *   startLaying() 到了地方，真正进入产卵
	 * 早先是就地开产，卵散落在「她那一刻恰好在的位置」上，看着就是走到哪儿下到哪儿。
	 */
	beginClutch(world, fatherGenes = null) {
		const E = CONFIG.egg
		const L = CONFIG.laying

		// 一窝一个号。这个号会一路跟到幼虫身上，是「同窝」的唯一依据
		this.layClutch = world.newClutch()
		// 一窝共用的基准孵化时间，每颗只在它附近抖 ±clutchJitter
		this.layHatch = rand(E.hatchMin, E.hatchMax)

		// 父本的基因在这里存下来 —— 产卵要飞到地方才开始，
		// 而那时 world._tryMate 早就返回了，父本对象也未必还在手边。
		// 存一份拷贝：父本之后可能被卖掉 / 拍死，留引用会读到一只死蝇的基因
		this.fatherMutations = copyGenes(fatherGenes)

		// 「偶尔也会分散开来」：这个概率下偷懒，就地开产，不挑地方。
		// 完全不偷懒的话，场上会渐渐变成「卵永远只出现在那几个完美点」，
		// 比乱下蛋还不自然
		if (Math.random() < L.scatterChance) {
			this.laySite = null
			this.startLaying()
			return
		}

		this.laySite = this._pickLaySite(world)
		this.laySeekTimer = L.seekTimeout
		if (!this.laySite) this.startLaying() // 一个候选点都挑不出来（理论上不会）
	}

	/**
	 * 真正进入产卵状态：定下这一窝的卵多大、幼虫什么体型。
	 * 位置由调用方保证（要么已经飞到产卵点，要么决定就地开产）。
	 */
	/**
	 * 一窝的**内容**：整窝共用的基础基因、卵多大、幼虫什么体型。
	 *
	 * ⚠ 返回**纯数据**、而且**不改自己身上任何字段** —— 这一点是刻意的：
	 *   罐中配对那条路（world._tryJarMate）里产卵的是**罐子**，母体根本没有
	 *   进入 laying 状态，不能顺手把她身上那套产卵字段写脏
	 *   （写脏了就会「上一窝的基因漏到下一窝」，_endClutch 那段注释讲的正是这个）。
	 *
	 * ⚠ 两条路**共用这一份公式**：外面那条走 startLaying()，罐里那条由 world
	 *   直接调。各写一份的话，罐里那窝会静默地少继承父亲的基因 —— 看不出来。
	 *
	 * @param {string[]|null} fatherGenes 父本的基因。不传就用身上存的那份
	 *   （外面那条路：交配那一刻存进 fatherMutations，产卵时再读）
	 */
	clutchPlan(fatherGenes = this.fatherMutations) {
		const grow = clamp(this.age / this.lifespan, 0, 1)
		const L = CONFIG.larva
		return {
			// 这一窝每颗卵的**基础基因**：母亲传一半、父亲传一半。
			//
			// ⚠ 算一次、整窝共用，而不是每颗卵各算一次。
			//   现实里每个卵是独立的一次减数分裂 + 受精，理论上该各抽各的 ——
			//   但那样同一窝的兄弟姐妹会各带一套完全不同的基因，
			//   玩家会看到「一窝里随机蹦出各种变异」，反而看不出**遗传**这条规律。
			//   整窝共用一份，「父母带什么，孩子就大概率带什么」才一眼看得出来。
			//
			// ⚠ 新发突变**不在这里**骰 —— 那个是每颗卵各骰一次（见 _lay）
			genes: cleanGenes([...inheritFrom(this.mutations), ...inheritFrom(fatherGenes)]),
			// 卵多大 = 个体个性 × 当前体型（越老的母体卵越大）
			scale: this.eggTrait * lerp(0.9, 1.08, grow),
			// 幼虫的体型性状：从她自己遗传下来（带向均值回归，避免逐代漂移）
			shape: {
				length: inheritTrait(this.shape.length, L.lengthMin, L.lengthMax),
				slim: inheritTrait(this.shape.slim, L.slimMin, L.slimMax),
			},
		}
	}

	startLaying() {
		const M = CONFIG.mating

		this.laying = true
		this.laySite = null
		this.layRemaining = randInt(M.eggsMin, M.eggsMax)
		this.layTimer = 0 // 第一颗立刻产下，让玩家马上看到因果

		const plan = this.clutchPlan()
		this.layScale = plan.scale
		this.layShape = plan.shape
		this.layMutations = plan.genes
	}

	/**
	 * 一个点离屏幕中心有多「外」，归一化成椭圆半径：
	 * 0 = 正中心，1 = 那块留白的边界，越大越靠边。
	 *
	 * 用**归一化**坐标（除以屏幕尺寸）而不是像素，所以换分辨率不变形：
	 * 1080p 上量的比例，4K 上一样成立。
	 */
	_siteOutwardness(world, x, y) {
		const L = CONFIG.laying
		const nx = (x - world.w / 2) / (world.w * L.centerClearRx)
		const ny = (y - world.h / 2) / (world.h * L.centerClearRy)
		return Math.hypot(nx, ny)
	}

	/**
	 * 挑一个产卵点。
	 *
	 * 做法是**在整个屏幕上**撒一把候选点、各自打个分，取最高的那个。
	 *
	 * ⚠ 候选点是撒满全屏的，不是撒在母体附近。
	 * 早先撒在她周围 260px 的一个圆里 —— 那在现在这条规则下会直接失效：
	 * 她要是正好停在屏幕中间，260px 之内**一个够靠边的点都没有**，
	 * 所有候选分数全是 0，等于没挑，卵照样落在正中间。
	 * 撒满全屏就没有这个死角（她多飞一段而已，1700px/s 也就一秒）。
	 *
	 * 之所以「撒点再挑」而不是算梯度或者找全局最优：
	 *   · 打分上带噪声，所以「偶尔也会分散开来」是白送的
	 *   · 每个母体各自独立撒点，所以不会所有母体都跑向同一个「最优点」
	 *
	 * @returns {{x:number,y:number}|null}
	 */
	_pickLaySite(world) {
		const L = CONFIG.laying
		const mx = Math.min(L.siteMargin, world.w / 2)
		const my = Math.min(L.siteMargin, world.h / 2)

		let best = null
		let bestScore = -Infinity
		for (let i = 0; i < L.siteCandidates; i++) {
			const x = rand(mx, Math.max(mx, world.w - mx))
			const y = rand(my, Math.max(my, world.h - my))

			const score = this._siteScore(world, x, y) + rand(0, L.siteNoise)
			if (score > bestScore) {
				bestScore = score
				best = { x, y }
			}
		}
		return best
	}

	/**
	 * 给一个点打分，越高越好。
	 *
	 * **第一项「靠屏幕边缘」是主导项，而且理由是产品性的、不是生态性的**：
	 * 这是个桌宠，屏幕正中间是玩家干活的地方，卵和幼虫堆在那儿会挡事。
	 * 所以中间留出一块空地（config 里的 centerClearRx/Ry），
	 * 卵尽量产在它外面的那一圈里 —— 见 README 的「产卵为什么靠边」。
	 *
	 * 后面两项只在那条圈里做微调，而且**都封了顶**：
	 * 不封的话，边上一堆尸体时扣分能到十几，盖过第一项，
	 * 卵又被推回屏幕正中间 —— 恰好是这条规则要避免的事。
	 */
	_siteScore(world, x, y) {
		const L = CONFIG.laying

		// ① 靠边。红圈以内是 0 分，到 edgeFull 倍半径就满分
		const e = this._siteOutwardness(world, x, y)
		let score = clamp((e - 1) / (L.edgeFull - 1), 0, 1) * L.edgeWeight

		// ② 离尸体 / 污渍远一点
		let danger = 0
		for (const r of world.remains) {
			const d = Math.hypot(r.x - x, r.y - y)
			if (d < L.siteDangerRadius) danger += (1 - d / L.siteDangerRadius) * L.siteDangerWeight
		}
		score -= Math.min(danger, L.siteDangerCap)

		// ③ 别压在别人的卵堆和幼虫堆上
		let crowd = 0
		const cr2 = L.siteCrowdRadius * L.siteCrowdRadius
		for (const egg of world.eggs) if (dist2(egg.x, egg.y, x, y) < cr2) crowd++
		for (const l of world.larvae) if (dist2(l.x, l.y, x, y) < cr2) crowd++
		score -= Math.min(crowd, L.siteCrowdCap) * L.siteCrowdWeight

		return score
	}

	/**
	 * 飞向产卵点。运动学仍然走 _fly / _walk 那一套（见那两处对 laySite 的处理），
	 * 这里只负责「到了没有」和「飞太久了没有」。
	 *
	 * @returns {boolean} 该开始产卵了吗
	 */
	_seekLaySite(dtMs) {
		const L = CONFIG.laying
		this.laySeekTimer -= dtMs
		if (this.laySeekTimer <= 0) return true // 兜底：被屏幕边界绕住了之类，别一直找下去
		return dist2(this.x, this.y, this.laySite.x, this.laySite.y) <= L.siteArriveRadius * L.siteArriveRadius
	}

	/**
	 * 产卵：母体原地减速停住，每隔一段时间落一颗卵。
	 * 靠阻尼自然滑停，而不是硬把速度清零 —— 那样看起来像被按了暂停键。
	 */
	_lay(dtMs, world) {
		const L = CONFIG.laying
		const dt = dtMs / 1000

		const drag = Math.exp(-L.settleDrag * dt)
		this.vx *= drag
		this.vy *= drag
		this.x += this.vx * dt
		this.y += this.vy * dt

		this.wingPhase += dt * 12 // 产卵时翅膀只是慢慢扇
		this.angle += Math.sin(this.age / 700) * dt * 0.9 // 像在找合适的位置

		// 别贴着屏幕边缘产卵。
		//
		// ⚠ 这里的边距必须和 walk.edgeMargin 用**同一个值**。
		// 早先这里写死过 24，而爬行的边距是 18 —— 于是「在边上走着、然后开始产卵」
		// 的果蝇会被这个钳制**瞬间弹进来 6px**，看着像是莫名其妙跳了一下。
		// 这个 bug 很难注意到：它只在屏幕边缘、且恰好是走路时配对成功的果蝇身上出现。
		const m = CONFIG.walk.edgeMargin
		this.x = clamp(this.x, m, Math.max(m, world.w - m))
		this.y = clamp(this.y, m, Math.max(m, world.h - m))

		this.layTimer -= dtMs
		if (this.layTimer > 0) return

		if (this.layRemaining <= 0) {
			this._endClutch()
			return
		}

		this.layTimer = L.eggInterval
		this.layRemaining--

		const a = rand(0, TAU)
		const d = rand(0, L.scatter)
		const jitter = 1 + rand(-CONFIG.egg.scaleJitter, CONFIG.egg.scaleJitter)
		world.spawnEgg(
			this.x + Math.cos(a) * d,
			this.y + Math.sin(a) * d,
			this.layScale * jitter,
			this.layShape,
			this.layClutch,
			this.layHatch,
			// ⚠ 每颗卵各骰一次新发突变，并且**发一份拷贝**。
			//   直接发 this.layMutations 的话，整窝卵会共享同一个数组 ——
			//   给其中一颗加上新发突变，等于给全部同胞都加上了。
			//   layShape 那个对象就是这么共享的（有意为之，体型整窝一致），
			//   但基因不行：突变本来就该是**每个配子各自**发生的事件
			cleanGenes([...this.layMutations, ...rollDeNovo()]),
		)

		if (this.layRemaining <= 0) this._endClutch()
	}

	/**
	 * 这一窝产完了。
	 *
	 * 窝号必须清掉：留着的话，她下一次产卵会走 beginClutch() 重新领一个号，
	 * 但**万一那条路径被绕过**（比如在 DevTools 里直接改 layRemaining 再触发），
	 * 残留的旧号会让两批隔了十几分钟的幼虫被认成同一窝，
	 * 隔着一个屏幕还互相「组队」——很难查，所以在这里主动断掉。
	 */
	_endClutch() {
		this.laying = false
		this.layClutch = 0
		this.layHatch = 0
		// ⚠ 父本的基因也要一起断掉，理由和窝号完全一样：
		//   留着的话，下一次交配万一是**就地开产**那条路径
		//   （beginClutch 里 scatterChance 命中的那支），
		//   或者干脆是被别处直接调 startLaying()，
		//   上一窝的父本基因就会混进新的一窝里 —— 孩子带着一个
		//   跟这次交配毫无关系的雄蝇的基因，而且完全看不出来
		this.fatherMutations = []
		this.layMutations = []
	}

	/**
	 * @param {number} dtMs 这一步经过了多少毫秒
	 *
	 * 单位约定（整个项目都遵守，踩过坑）：
	 *   CONFIG 里所有时长都是毫秒 → age / lifespan / cooldown 一律用毫秒累加
	 *   而速度是 px/秒          → 物理积分必须换算成秒
	 * 两者混用会让果蝇寿命凭空拉长 1000 倍，永远不死也永远不生。
	 */
	update(dtMs, world) {
		const A = CONFIG.adult
		const dt = dtMs / 1000 // 只给物理用

		// 被拍死的个体会在本帧稍后由 world 统一收走，
		// 这一步必须拦住，否则它会继续飞、甚至把死因覆盖成「老死」
		if (this.dead) return

		// 金苹果的时间膨胀：在果子上进食时年龄跑得快 1.5 倍。
		//
		// ⚠ 这里读的是**上一帧**的 feeding / bait —— age 在 update 开头累加，
		// 而这两个字段要到本帧后面（_walk → _forage）才重算。
		// 这不是将就：world._updateFeeding 统计「谁在吃」用的也是同一份状态，
		// 两边口径一致才不会出现「看着在吃、结算说没吃」的错位。1 帧延迟看不出来。
		//
		// 只动 age，lifespan 全程不改 —— 和 updateJarred 的时间膨胀是同一套写法，
		// 所以 size / growth / weight / value / 死亡判定全都自动跟着走
		this.age += dtMs * foodGrowthBonus(this.feeding ? this.bait?.type : null)
		this.wingPhase += dt * 70 // 翅膀扇得很快（飞行速度提上去之后也跟着加快）
		this.legPhase += dt * 5
		if (this.cooldown > 0) this.cooldown -= dtMs

		// 体型：一生从 sizeBirth 线性长到 sizeMax，死前达到上限
		this.size = lerp(A.sizeBirth, A.sizeMax, clamp(this.age / this.lifespan, 0, 1))

		// 寿终 = 活够的年龄 + 被打出来的伤。两者相加才是真正的「寿命用完了」，
		// 这样才能做到「伤害 N 点 = 少活 N 分钟」。
		//
		// ⚠ 罐中这条（updateJarred）也必须一起改。不改的话，一只被打到半死的
		//   果蝇网进罐子就**满血复活**了，而且罐中列表显示的剩余寿命比外面长
		if (this.age + this.wounds >= this.lifespan) {
			this.die('natural')
			return
		}

		// 嗅觉：飞行和爬行都要用（决定往哪走、要不要落地），所以在这里统一算一次
		const F = CONFIG.food
		this.bait =
			F.attractFlies && world.foods.length > 0
				? world.nearestFood(this.x, this.y, F.flyScentRadius, F.flyAttractMinRot)
				: null

		// —— 产卵：选址 → 飞过去 → 一颗颗产下 ——
		//
		// 顺序不能反。先判「是不是到了」并可能当帧转入产卵状态，
		// 再判 laying —— 这样她抵达产卵点的那一帧就开始产，
		// 不会先按普通果蝇飞一帧再停下来
		if (this.laySite && this._seekLaySite(dtMs)) this.startLaying()

		// 产卵中的母体停在原地，交给 _lay 接管
		if (this.laying) {
			this._lay(dtMs, world)
			return
		}

		this._updateMode(dtMs)

		// 「正在进食」这个标记必须每帧重算一遍，而且要在分派之前清掉。
		//
		// 早先只在 _walk() 里清零，于是有个隐蔽的漏洞：果蝇在果子上吃够了起飞之后，
		// _fly() 根本不碰这个字段，标记就一直是 true。飞行途中它可能已经窜出 900px，
		// 外面看这个字段却还是「正在进食」—— 模拟器就是这么误判成
		// 「果蝇跑到离食物 975px 的地方进食」的。
		// 真正在果子上踱步的判定只有 _forage() 那一处，这里负责把上一帧的结论作废。
		this.feeding = false

		if (this.mode === 'walk') this._walk(dtMs, world)
		else this._fly(dtMs, world)
	}

	/**
	 * 飞 / 走 的状态切换。
	 *
	 * 附近有腐烂食物时，落地的概率会大幅提高 ——
	 * 真实果蝇就是落在果子上边走边找产卵点的，
	 * 所以「食物周围爬满了果蝇」这个画面是自然涌现出来的，不是特判出来的。
	 */
	_updateMode(dtMs) {
		const B = CONFIG.behavior

		// —— 刚飞进食物的气味范围：立刻掷一次落地判定 ——
		//
		// 这一条不能并到下面那个计时器里。飞行速度提到 1700px/s 之后，
		// 果蝇穿过 420px 的嗅觉半径只要 0.25 秒，而模式计时器 1.2~6 秒才到期一次 ——
		// 等它到期时果蝇早就飞走了，判定永远撞不上，招蝇等于失效。
		// 真实果蝇也是闻到的当下就往食物上落，不会等「时机到了」再决定。
		const inScent = this.bait != null
		const justSmelled = inScent && !this.wasInScent
		this.wasInScent = inScent

		if (this.mode === 'fly' && justSmelled && Math.random() < B.landChanceNearFood) {
			this._land()
			return
		}

		this.modeTimer -= dtMs
		if (this.modeTimer > 0) return

		if (this.mode === 'walk') {
			// 爬够了，起飞。
			//
			// ⚠ 石化蝇（canFly = false）飞不起来 —— 这是「失去飞行」五个入口里的
			//   第二个。它不会卡住：下面那条 `this.mode === 'walk'` 之外的分支
			//   管不到它，它就一直是 walk，靠 _walk 那套爬行逻辑一直走下去。
			//   只是 modeTimer 会一直在到期，每秒钟重算一次「要不要起飞」，
			//   代价可以忽略（一次 rand + 一次比较）
			if (!this.canFly) {
				this.modeTimer = rand(B.walkMin, B.walkMax)
				return
			}
			this.mode = 'fly'
			this.modeTimer = rand(B.flyMin, B.flyMax)
			this.vx = 0
			this.vy = 0
			this.aim = rand(0, TAU)
			this.targetSpeed = rand(CONFIG.adult.speedMin, CONFIG.adult.speedMax)
			this.hoverTimer = 0
			return
		}

		// 天上飞够了：决定是继续飞还是落下来走。
		// 已经在食物附近的话，落地概率高得多，这样它会来回踱着不离开。
		if (Math.random() < (inScent ? B.landChanceNearFood : B.landChance)) this._land()
		else this.modeTimer = rand(B.flyMin, B.flyMax)
	}

	/** 落地，转入爬行 */
	_land() {
		const B = CONFIG.behavior
		this.mode = 'walk'
		// 为了找吃的而落地的，这一趟会走得更久，否则走不到食物跟前就又飞起来了
		this.modeTimer = this.bait ? rand(B.forageWalkMin, B.forageWalkMax) : rand(B.walkMin, B.walkMax)
		this.pausing = false
		this.boutTimer = rand(CONFIG.walk.boutMin, CONFIG.walk.boutMax)
		this.vx = 0
		this.vy = 0
		this.wingPhase = 0
	}

	/**
	 * 爬行。
	 *
	 * 位移始终是**连续**的 —— 这一点很重要。
	 * 早先版本试过按固定间隔把位置量化成「跳步」，想做出定格感，
	 * 结果观感就是掉帧，已经废弃，别再往回改。
	 *
	 * 真实果蝇走路的节奏感来自**走走停停**：连续走一小段 → 停住重新定向 → 再走。
	 * 停顿是行为层面的，不是把运动离散化。
	 */
	_walk(dtMs, world) {
		const W = CONFIG.walk
		const F = CONFIG.food
		const dt = dtMs / 1000

		// —— 走一段 / 停一下的节律 ——
		this.boutTimer -= dtMs
		if (this.boutTimer <= 0) {
			if (this.pausing) {
				this.pausing = false
				this.boutTimer = rand(W.boutMin, W.boutMax)
			} else if (Math.random() < W.pauseChance) {
				this.pausing = true
				this.boutTimer = rand(W.pauseMin, W.pauseMax)
			} else {
				this.boutTimer = rand(W.boutMin, W.boutMax)
			}
		}

		// 有食物就走过去（走到了就在果子上踱步），没有就慢慢改方向。
		// this.feeding 由 update() 每帧统一清零，这里只负责把它置回 true。
		//
		// 产卵点排在最前面：她是**特意**要去那儿的，路上闻到的果子不该把她拐走
		if (this.laySite) {
			this._steerTo(this.laySite.x, this.laySite.y, W.turnRate, dt)
		} else if (this.bait) {
			this._forage(dtMs)
		} else {
			// 停着的时候转得慢一些，像在原地打量四周
			const wander = this.pausing ? 0.7 : 1.9
			this.aim += rand(-1, 1) * wander * dt
		}

		// 朝向平滑跟上，不停顿时才走
		this.angle = angleLerp(this.angle, this.aim, clamp(7 * dt, 0, 1))

		if (!this.pausing) {
			// 在果子上觅食时慢下来 —— 赶路和拱食本来就不是一个速度。
			// 再乘上体重倍率（爬行这一路也要，否则变异蝇一落地就和普通一样快）
			const speed =
			W.speed * (this.feeding ? F.feedSpeedScale : 1) * this.speedScale * this.startleMul
			this.x += Math.cos(this.aim) * speed * dt
			this.y += Math.sin(this.aim) * speed * dt
			// 步态相位跟着**实际走过的距离**推进 ——
			// 走得快腿就倒得快，停下来腿也停，比按固定频率好看得多
			this.gaitPhase += speed * dt * 0.26
		}

		// 爬行时不保留飞行速度，否则下一次起飞会带着旧惯性窜出去
		this.vx = 0
		this.vy = 0

		// 在地上是不会穿墙的：撞到边就掉头
		const m = W.edgeMargin
		if (this.x < m) {
			this.x = m
			this._turnAround(Math.PI - this.aim)
		} else if (this.x > world.w - m) {
			this.x = world.w - m
			this._turnAround(Math.PI - this.aim)
		}
		if (this.y < m) {
			this.y = m
			this._turnAround(-this.aim)
		} else if (this.y > world.h - m) {
			this.y = world.h - m
			this._turnAround(-this.aim)
		}
	}

	_turnAround(a) {
		this.aim = a
		this.angle = a
	}

	/**
	 * 把意图方向朝某个点掰过去。
	 *
	 * 产卵前的「飞到一个挑好的地方」走的就是它 —— 用的是和平时完全一样的
	 * 飞行 / 爬行运动学，所以她只是「朝那边飞」，而不是切进某个专门的动画状态。
	 * 这一点是有意的：专门状态会让她在屏幕上明显「变了个人」。
	 */
	_steerTo(x, y, rate, dt) {
		const toward = Math.atan2(y - this.y, x - this.x)
		this.aim = angleLerp(this.aim, toward, clamp(rate * dt, 0, 1))
	}

	/**
	 * 朝食物走 → 在食物上进食。
	 *
	 * 分两段：
	 *   还在路上 → 直奔果子（和以前一样）
	 *   已经站上果子 → **在果实范围内随机挑落脚点**，走到一个再挑下一个
	 *
	 * 第二段是关键。以前是全程盯着食物圆心，于是果蝇到了之后会一直
	 * 往圆心挤、在圆心上反复掉头，几只叠在一起像在开会。
	 * 改成随机踱步之后，落到果子上的果蝇会各自散开、这里拱拱那里拱拱 ——
	 * 真果蝇在果子上觅食本来就是这么个走法。
	 *
	 * @param {number} dtMs
	 */
	_forage(dtMs) {
		const F = CONFIG.food
		const W = CONFIG.walk
		const dt = dtMs / 1000
		const bait = this.bait
		const R = bait.size * F.feedRadius // 进食活动范围（半径）
		const R2 = R * R

		// —— 还在路上：直奔果子 ——
		if (dist2(this.x, this.y, bait.x, bait.y) > R2) {
			const toward = Math.atan2(bait.y - this.y, bait.x - this.x)
			this.aim = angleLerp(this.aim, toward, clamp(W.turnRate * dt, 0, 1))
			this.feedTarget = null
			this.feedTimer = 0
			return
		}

		// —— 已经站上果子：在范围内随机挑落脚点 ——
		this.feeding = true
		this.feedTimer -= dtMs

		const arrived = !this.feedTarget || dist2(this.x, this.y, this.feedTarget.x, this.feedTarget.y) < 64 // 8px 内算走到了
		if (arrived || this.feedTimer <= 0) {
			// sqrt 是为了让点在圆内**均匀**铺开：直接用 rand(0, R) 会明显往圆心挤，
			// 那样又绕回「几只果蝇叠在正中」的老问题上了。
			const a = rand(0, TAU)
			const d = Math.sqrt(Math.random()) * R
			this.feedTarget = { x: bait.x + Math.cos(a) * d, y: bait.y + Math.sin(a) * d }
			this.feedTimer = rand(F.feedRetargetMin, F.feedRetargetMax)
		}

		const toward = Math.atan2(this.feedTarget.y - this.y, this.feedTarget.x - this.x)
		this.aim = angleLerp(this.aim, toward, clamp(F.feedTurnRate * dt, 0, 1))
	}

	/** @param {number} dtMs 毫秒（dart / hover 这些计时来自 CONFIG，也是毫秒） */
	_fly(dtMs, world) {
		const A = CONFIG.adult
		const F = CONFIG.food
		const dt = dtMs / 1000 // 只有物理积分用秒

		// 注：this.bait 已经在 update() 里统一算好了，飞和走共用同一个嗅觉结果

		// —— 决定接下来这段时间要干嘛 ——
		this.dartTimer -= dtMs
		if (this.dartTimer <= 0) {
			this.dartTimer = rand(A.dartIntervalMin, A.dartIntervalMax)
			if (Math.random() < A.hoverChance) {
				this.hoverTimer = rand(A.hoverDurationMin, A.hoverDurationMax)
			} else {
				// 有目标（果子 / 产卵点）时，新方向只在「朝着目标」的一个扇形里随机。
				// 如果这里给全随机方向，吸引力根本来不及生效 ——
				// 每隔一秒多就把意图推倒重来，果蝇只会乱窜着越飘越远。
				// 产卵点优先：她已经决定了要去那儿产卵
				const dest = this.laySite ?? this.bait
				if (dest) {
					const toward = Math.atan2(dest.y - this.y, dest.x - this.x)
					this.aim = toward + rand(-1, 1) * F.flyDartSpread
				} else {
					this.aim = rand(0, TAU)
				}
				this.targetSpeed = rand(A.speedMin, A.speedMax)
			}
		}
		if (this.hoverTimer > 0) this.hoverTimer -= dtMs

		// 悬停时目标速度归零，就停在原地扇翅膀。
		// 乘上体重倍率 —— 变异果蝇更重、也更迟钝（见 speedScale 那段注释）
		let wantSpeed = (this.hoverTimer > 0 ? 0 : this.targetSpeed) * this.speedScale * this.startleMul

		// —— 进场减速 ——
		//
		// ⚠ 没有这一条，选址就是白做的：她是靠阻力自然滑停的
		// （settleDrag，见 _lay），滑停距离 = v/k。以 1700px/s 冲到离产卵点
		// 26px 处才开始「落地」，实际会停在 400px 开外 —— 挑好的点上一颗卵都没有。
		// 这里把目标速度压到「当前速度下刚好能在剩余距离内停住」，
		// 她就自然减速、正好停在那个点附近
		if (this.laySite) {
			const L = CONFIG.laying
			const d = Math.hypot(this.laySite.x - this.x, this.laySite.y - this.y)
			wantSpeed = Math.min(wantSpeed, L.settleDrag * d * L.siteBrakeSafety)
		}

		// 飞行途中的轻微抖动，避免飞出完美的直线
		this.aim += rand(-1, 1) * 2.6 * dt

		// 持续把意图往目标方向掰：处理「果子刚进入嗅觉范围」和「果子被啃着缩小」这类变化。
		// 产卵点优先，且用 seekTurnRate —— 她是在「赶路」，比闲逛时果断
		if (this.laySite) {
			this._steerTo(this.laySite.x, this.laySite.y, CONFIG.laying.seekTurnRate, dt)
		} else if (this.bait) {
			const toward = Math.atan2(this.bait.y - this.y, this.bait.x - this.x)
			this.aim = angleLerp(this.aim, toward, clamp(F.flyPull * dt, 0, 1))
		}

		// 用指数趋近代替真实受力：稳定、不会在低帧率下炸开。
		// turnResponse 决定「多快能跑到目标速度」，也就是转向有多干脆。
		const k = clamp(A.turnResponse * dt, 0, 1)
		this.vx += (Math.cos(this.aim) * wantSpeed - this.vx) * k
		this.vy += (Math.sin(this.aim) * wantSpeed - this.vy) * k

		this.x += this.vx * dt
		this.y += this.vy * dt

		// 身体朝向跟随实际速度；速度太低（悬停）就跟着意图方向
		const spd = Math.hypot(this.vx, this.vy)
		const face = spd > 18 ? Math.atan2(this.vy, this.vx) : this.aim
		this.angle = angleLerp(this.angle, face, clamp(14 * dt, 0, 1))

		world.wrapFly(this)
	}

	/**
	 * 罐中果蝇的更新。和外面的 update() 是两条独立的路子。
	 *
	 * 不共用的原因：罐里的规则几乎全都不一样 ——
	 * 没有飞/走切换（罐里一直在飞）、没有嗅觉、不会交配产卵、
	 * 边界是罐子的矩形内壁而不是屏幕（而且屏幕是「绕回来」，罐子是「弹回来」）。
	 * 硬塞进 update() 会让那个方法变成一堆 if 堆叠，而它本来已经是整个项目里
	 * 最复杂的一段了（飞/走切换、产卵接管、嗅觉、边界回绕都在里面）。
	 *
	 * @param {number} dtMs
	 * @param {Jar} jar 所在的罐子。果蝇自己的 x / y 是相对它中心的偏移
	 */
	updateJarred(dtMs, jar) {
		const A = CONFIG.adult
		const J = CONFIG.jar
		const dt = dtMs / 1000

		// —— 寿命 1.5 倍：年龄推进速度变成 1/1.5 ——
		//
		// 用时间膨胀而不是给 lifespan 乘系数，是为了让进出罐子完全可逆：
		// lifespan 全程不动，反复进出也不会累积误差。
		this.age += dtMs / J.lifespanBonus

		// 交配冷却。⚠ 这条是罐中能配对之后补上的：
		//   原来只有外面的 update() 在递减它，罐里那只的冷却是**冻住的** ——
		//   配上一次就永久冷却，看着像「罐里的虫不会再生了」。
		//
		// ⚠ 用的是**未膨胀**的 dtMs，不是 dtMs / lifespanBonus：
		//   冷却是对玩家的实时闸门（90 秒），和寿命那个时间膨胀是两回事。
		//   外面那条（update 里）也是未膨胀的，这里跟着它走
		if (this.cooldown > 0) this.cooldown -= dtMs

		// 体型是按 age / lifespan 插值的，所以成长速度也跟着一起放慢 ——
		// 这正是「同一条命被拉长 1.5 倍」该有的样子，不是副作用
		this.size = lerp(A.sizeBirth, A.sizeMax, clamp(this.age / this.lifespan, 0, 1))

		// 寿终 = 活够的年龄 + 被打出来的伤。两者相加才是真正的「寿命用完了」，
		// 这样才能做到「伤害 N 点 = 少活 N 分钟」。
		//
		// ⚠ 罐中这条（updateJarred）也必须一起改。不改的话，一只被打到半死的
		//   果蝇网进罐子就**满血复活**了，而且罐中列表显示的剩余寿命比外面长
		if (this.age + this.wounds >= this.lifespan) {
			this.die('natural')
			return
		}

		// 翅膀快扇 —— 它们在飞，不是在爬
		this.wingPhase += dt * 46
		this.legPhase += dt * 5

		// —— 「窜一下 / 悬停一下」，和外面那套飞行节奏是一样的，只是慢得多 ——
		this.dartTimer -= dtMs
		if (this.dartTimer <= 0) {
			this.dartTimer = rand(J.dartMin, J.dartMax)
			if (Math.random() < J.hoverChance) {
				this.hoverTimer = rand(J.hoverMin, J.hoverMax)
			} else {
				// 罐子里不用像外面那样「朝食物方向收窄扇形」—— 没有目标，
				// 全向随机就是想要的：在玻璃罐里没头没脑地打转
				this.aim = rand(0, TAU)
				this.targetSpeed = rand(J.flySpeedMin, J.flySpeedMax)
			}
		}
		if (this.hoverTimer > 0) this.hoverTimer -= dtMs

		// 悬停时目标速度归零，就停在原地扇翅膀。
		// 罐里同样乘体重倍率 —— 不然把变异蝇关进罐子就「看不出它重」了
		const want = (this.hoverTimer > 0 ? 0 : this.targetSpeed) * this.speedScale

		// 用指数趋近代替真实受力，和外面 _fly 是同一套写法：
		// 稳定，低帧率下也不会炸开
		const k = clamp(J.turnResponse * dt, 0, 1)
		this.vx += (Math.cos(this.aim) * want - this.vx) * k
		this.vy += (Math.sin(this.aim) * want - this.vy) * k

		this.x += this.vx * dt
		this.y += this.vy * dt

		// 身体朝向跟随实际速度；速度太低（悬停）就跟着意图方向
		const spd = Math.hypot(this.vx, this.vy)
		const face = spd > 6 ? Math.atan2(this.vy, this.vx) : this.aim
		this.angle = angleLerp(this.angle, face, clamp(10 * dt, 0, 1))

		// —— 撞到玻璃就反弹 ——
		// 平面矩形要比四条边，和圆罐那种「按极坐标算半径」是两回事。
		// 反射的是**速度分量**（水平撞就翻 vx），而不是把角度掉头 180°——
		// 后者会让果蝇沿原路弹回去，轨迹看着像弹珠
		const hw = jar.innerHalfW
		const hh = jar.innerHalfH
		let bounced = false

		if (this.x < -hw) {
			this.x = -hw
			this.vx = Math.abs(this.vx)
			bounced = true
		} else if (this.x > hw) {
			this.x = hw
			this.vx = -Math.abs(this.vx)
			bounced = true
		}

		if (this.y < -hh) {
			this.y = -hh
			this.vy = Math.abs(this.vy)
			bounced = true
		} else if (this.y > hh) {
			this.y = hh
			this.vy = -Math.abs(this.vy)
			bounced = true
		}

		// 反弹之后要把「意图」也掰到新方向上，否则指数趋近会立刻把速度
		// 拉回原来那个朝墙的方向，果蝇就贴着玻璃一直抖
		if (bounced) {
			this.aim = Math.atan2(this.vy, this.vx)
			this.dartTimer = rand(J.dartMin, J.dartMax) // 刚撞过墙，让它先按新方向飞一会儿
		}
	}
}

// ====================================================================
//  卵
// ====================================================================

export class Egg {
	/**
	 * @param {number} scale 尺寸倍率。来自母体的「卵大小」个性 + 逐颗抖动，
	 *   所以不同母体产下的卵看起来会不一样大。
	 * @param {{length:number, slim:number}|null} shape 这一批的幼虫体型性状。
	 *   卵自己用不到，只是替还没孵出来的幼虫先存着。
	 * @param {number} clutch 窝号。孵化后原样交给幼虫 ——
	 *   「同窝的幼虫更容易凑到一起」全靠它认亲
	 * @param {number} hatchBase 这一窝共用的基准孵化时间；不传就自己抽一个
	 *   （手动投放的散卵走这条路）
	 * @param {string[]} [mutations] 这颗卵的基因。卵自己用不到，
	 *   和 shape 一样只是替还没孵出来的幼虫先存着 ——
	 *   但**必须存在卵上**，因为新发突变是产卵那一刻骰的，
	 *   从卵到孵化之间没有第二个可以骰的时机
	 */
	constructor(x, y, scale = 1, shape = null, clutch = 0, hatchBase = null, mutations = null) {
		const E = CONFIG.egg
		this.kind = 'egg'
		this.x = x
		this.y = y
		this.scale = scale
		this.shape = shape
		this.clutch = clutch
		this.mutations = copyGenes(mutations)
		// 胖瘦也逐颗不同：有的圆钝、有的细长。
		// 只有大小不一样的话，一窝卵看着还是像同一个模子刻的。
		this.aspect = rand(E.aspectMin, E.aspectMax)
		// 深浅也逐颗不同（0 = 偏深，1 = 偏浅）。区间开得很窄，只是让一窝卵
		// 不至于像同一个色号复制出来的，凑近才看得出来
		this.shade = rand(E.shadeMin, E.shadeMax)
		this.age = 0

		// 同一窝的卵**共用**一个基准孵化时间，每颗只在它附近抖一点点。
		// 早先是每颗各自 rand(hatchMin, hatchMax)，一窝卵能从第 3 分钟
		// 稀稀拉拉孵到第 14 分钟，「一窝」在视觉上根本立不住。
		// 抖动也不能取 0：那样一窝会同一帧全孵出来，像爆开一样
		const base = hatchBase ?? rand(E.hatchMin, E.hatchMax)
		this.hatchAt = clamp(base + rand(-E.clutchJitter, E.clutchJitter), E.hatchMin, E.hatchMax)

		this.angle = rand(0, TAU)
		this.wobble = rand(0, TAU) // 快孵化时轻微晃动
		this.dead = false
		this.causeOfDeath = null

		// 产在哪儿就永远在哪儿，不会跑
	}

	/** 距离孵化还有多远（0~1），用于渲染时表现「快孵出来了」 */
	get progress() {
		return clamp(this.age / this.hatchAt, 0, 1)
	}

	update(dtMs) {
		this.age += dtMs
		this.wobble += (dtMs / 1000) * (2 + this.progress * 8)
	}
}

// ====================================================================
//  幼虫 — 蛆
// ====================================================================

export class Larva {
	/**
	 * @param {{length:number, slim:number}|null} shape 这一批的体型性状（由母体遗传下来）。
	 *   传 null 就退回群体均值 —— 手动投放出来的幼虫走这条路。
	 * @param {number} clutch 窝号，从产下它的那枚卵一路继承下来。
	 *   「同窝的更容易凑到一起」只认这个号，不认距离以外的任何东西
	 * @param {string[]} [mutations] 从卵继承来的基因。
	 *
	 * ⚠ 参数只能**追加在末尾**。tools/simulate.js 有好几处按位置传
	 *   `(x, y, null, clutch)`，把 mutations 插在 clutch 前面的话，
	 *   窝号会被当成基因数组传进来 —— 不报错，只是所有幼虫的基因都变成一团乱码
	 */
	constructor(x, y, shape = null, clutch = 0, mutations = null) {
		const L = CONFIG.larva
		const F = CONFIG.food

		this.kind = 'larva'
		this.clutch = clutch
		this.x = x
		this.y = y
		this.age = 0
		this.angle = rand(0, TAU)
		this.size = larvaSizeAt(0)

		// 体型 = 整批共有的性状 + 一层个体抖动。
		// lengthScale 的均值是 1，所以虽然每只都不一样，
		// 整体上仍然贴着「20 分钟 20px」的原设定，只是有胖瘦长短之分。
		const j = L.traitJitterIndividual
		const meanLength = (L.lengthMin + L.lengthMax) / 2
		const meanSlim = (L.slimMin + L.slimMax) / 2
		this.lengthScale = clamp((shape?.length ?? meanLength) + rand(-1, 1) * j, L.lengthMin, L.lengthMax)
		this.slim = clamp((shape?.slim ?? meanSlim) + rand(-1, 1) * j, L.slimMin, L.slimMax)

		this.speedScale = rand(0.75, 1.35) // 个体快慢差异

		/**
		 * 体壁透不透 —— 纯外观，孵化那一刻按概率抽一次，之后一辈子不变。
		 *
		 * 为真时身体画成「外圈微透、中间实」（见 drawLarva）；
		 * 为假就是一条同色的实心蛆。两种都是正常的蛆，
		 * 这一条**不代表健康、年龄或任何数值**，只是让一窝里有点个体差异 ——
		 * 整批长得一模一样才是最容易看出「这是程序画的」的地方。
		 *
		 * ⚠ 抽在构造函数里而不是渲染时每帧算：每帧随机会让它在透与不透之间闪，
		 *   而且存档读回来之后会变成另一个样子
		 */
		this.translucent = Math.random() < CONFIG.larva.translucentChance

		/**
		 * 基因。**普通数组**，理由同 Fly.mutations（snapshot 会静默丢掉 Set）。
		 * 再拷一次是因为卵的数组是直接递过来的 —— 不拷的话，
		 * 一只幼虫被 mutation 改动会连带改到所有从同一颗卵出来的东西
		 */
		this.mutations = copyGenes(mutations)

		/**
		 * 生命值。幼虫**固定 1~2 点**（用户指定）。
		 *
		 * ⚠ 和成虫不一样：成虫的 hp 是从年龄推出来的 getter，
		 *   幼虫这个是**存储字段**。因为幼虫没有「寿命」这条线
		 *   （它要么化蛹要么饿死），没有一个现成的量可以拿来当血条。
		 *
		 * ⚠ 副作用要知道：成虫疯狂的伤害是 1~3 点，
		 *   而幼虫最多 2 点血 —— 所以**每一口都必然打死一只幼虫**。
		 *   这是「成虫 1~3 / 幼虫固定 1~2」这两套数值直接推出来的结果
		 */
		this.hpMax = randInt(1, 2)
		this.hp = this.hpMax
		/**
		 * 饿了多久（ms）。**只有真正吃到嘴里才清零** ——
		 * 「贴在果子上」不算，抢不到名额的那些位置照样在果子上，
		 * 但一口都吃不到（见 world._updateFeeding）。
		 *
		 * ⚠ 蛹期不累计（见 update 里的蛹分支）：蛹本来就不吃东西
		 */
		this.hunger = 0
		/**
		 * 出生就抽定的挨饿上限。每只不一样，所以不会整窝同时倒。
		 *
		 * ⚠ 疯狂幼虫这里**砍半**。幼虫没有「寿命」这条线 ——
		 *   它要么化蛹要么饿死，而饿死是唯一的死亡时钟，所以
		 *   「寿命减半」落在它身上就是「挨饿上限减半」：
		 *   本来 10~18 分钟才饿死，变成 5~9 分钟。
		 *   倍数和成虫的 lifespanMul 是同一个配置项
		 */
		this.starveAfter = rand(CONFIG.larva.starveMin, CONFIG.larva.starveMax) * berserkLifespanMul(this.mutations)
		/** 上一轮结算有没有吃到。由 world._updateFeeding 写，这里只读 */
		this.ateLastTick = true

		this.wanderTimer = 0
		this.wanderTarget = this.angle

		// —— 嗅觉：个体灵敏度 + 间歇采样 ——
		//
		// scentGain 让每只幼虫的嗅觉范围不一样（鼻子灵的远一点），
		// sniffTimer 是「下一次闻」的倒计时，初值就随机，
		// 所以一群幼虫从一开始就是错开的，不会同进同出。
		// 详见 config.food 里 sniffMin / scentGainMin 那两段注释。
		this.scentGain = rand(F.scentGainMin, F.scentGainMax)
		this.sniffTimer = rand(0, F.sniffMax)
		// 上一次闻到的那块地方 { x, y, r }。**不是**食物对象的引用 ——
		// 存引用会被通用 snapshot() 顺着写进存档（见 REF_FIELDS 那段）
		this.scentSpot = null

		// —— 组队徘徊 ——
		// buddy 是**另一只幼虫的引用**，和 Fly.bait 一样属于「每帧重算的引用」，
		// 所以它进了 REF_FIELDS，不进存档
		this.buddy = null
		// 初值随机，一群幼虫不会同时开始找伴
		this.buddyTimer = rand(0, L.buddyRetryMax)

		// 身体的「脊柱」：一串**世界坐标**的点，[0] 是头。
		//
		// 存世界坐标而不是相对头的偏移，是整套软身体的地基：
		// 头转弯时这些点还留在原处，换算回头的局部坐标就自然弯了 ——
		// 身体于是「跟不上」头，看着就是被拖着的。
		// 存成相对坐标的话，头一转整条身体立刻跟着转，那又变回硬棍子了。
		//
		// 初值沿身体反方向摊成一条直线，不然第一帧所有点都叠在头的位置上，
		// 距离约束会除以 0
		this.spine = []
		const seg0 = (this.size * this.lengthScale) / (CONFIG.larva.bodySamples - 1)
		for (let i = 0; i < CONFIG.larva.bodySamples; i++) {
			this.spine.push({
				x: x - Math.cos(this.angle) * seg0 * i,
				y: y - Math.sin(this.angle) * seg0 * i,
			})
		}

		this.eating = null // 正趴在哪个食物上啃（由 update 每帧重新判定）
		this.foodAngle = rand(0, TAU) // 从外面爬过去时，冲着食物的哪个方位
		// 趴在果子上啃的时候的位置：方位角 + 离食物中心多远。
		// 两个都每隔几秒重抽一次，而且初值就随机 —— 见 _graze
		this.grazeAngle = rand(0, TAU)
		this.grazeRing = 0
		this.grazeTimer = rand(0, CONFIG.food.grazeMax)
		// 壳面颗粒的固定随机种子（化蛹之后用）。必须存下来而不是每帧 Math.random()
		this.seed = rand(0, 1000)
		this.pupa = false // 进入蛹期后不再移动
		this.swarming = false // 本轮集群是否参与（由 world 指派）

		/**
		 * 扫帚推出来的额外速度（px/s）。**由 world.broom 直接写，这里只负责衰减**。
		 *
		 * ⚠ 自成一路，不并进 `angle` / `crawlSpeed`：那是「这只虫自己想往哪爬」，
		 *   而这是「被外面的东西推着走」。混在一起的话，
		 *   一只被扫开的幼虫会转头朝推力方向爬，松开手也不停 —— 看起来像它自己要走
		 *
		 * 衰减到 0 就停，所以是**瞬态**：不进存档也不会留下任何痕迹
		 * （真要进也无所谓，snapshot 认普通数字）
		 */
		this.pushVx = 0
		this.pushVy = 0

		this.dead = false
		this.causeOfDeath = null
	}

	/** 身上带没带某种突变。和 Fly 上那个同名同义，UI 和 world 可以一视同仁地调 */
	hasMutation(id) {
		return hasMutation(this.mutations, id)
	}

	/**
	 * 挨一下。points 是**点数**（不是分钟）—— 幼虫的血条本来就是 1~2 点的整数，
	 * 没有「寿命」这个可以折算的中间量。
	 *
	 * 和 Fly.takeDamage 的单位不同是有意的：成虫那边 1 点 = 1 分钟寿命，
	 * 因为它的血条就是剩余寿命；幼虫这边 1 点就是 1 点。
	 */
	takeDamage(points) {
		if (!(points > 0) || this.dead) return 0
		this.hp -= points
		if (this.hp <= 0) {
			this.hp = 0
			this.dead = true
			// ⚠ 用 'killed' 而不是 'swatted'。world._resolveLifecycles 里
			//   幼虫那段的分支是 `if (starved) {...} else { swatted++ }`，
			//   所以新增的 'killed' 必须**显式**加一个分支，
			//   否则被咬死的幼虫会被记成「被拍死」——面板上的死因细分从此永远是错的
			this.causeOfDeath = 'killed'
		}
		return points
	}

	/** 化蛹之后过了多久（毫秒）。没到蛹期就是负数 */
	get sincePupate() {
		const L = CONFIG.larva
		if (L.pupateAt == null) return -Infinity
		return this.age - L.pupateAt
	}

	/**
	 * 壳色「变硬」的进度 0~1：**前 tanTime（30 秒）之内**从幼虫的奶白变成褐色。
	 *
	 * 单独拿出来、而不是并进 pupaProgress，是因为这两件事的时间尺度差了十倍：
	 * 变色只占蛹期的头 30 秒，剩下 4 分半壳色基本不变。
	 * 「看着一条蛆在这几十秒里慢慢变成一粒褐色的蛹」本身就是有信息量的画面，
	 * 摊到整段蛹期去反而看不出来。
	 */
	get tanProgress() {
		if (!this.pupa) return 0
		return clamp(this.sincePupate / CONFIG.pupa.tanTime, 0, 1)
	}

	/** 蛹期总进度 0~1，用于临近羽化时再往深褐走一点 */
	get pupaProgress() {
		const L = CONFIG.larva
		if (!this.pupa || L.pupateAt == null) return 0
		const span = L.emergeAt - L.pupateAt
		return clamp(this.sincePupate / (span || 1), 0, 1)
	}

	update(dtMs, world) {
		const L = CONFIG.larva
		const F = CONFIG.food
		const dt = dtMs / 1000 // 只给物理用，年龄一律按毫秒累加

		// 同上：被拍死的幼虫不该再爬一步
		if (this.dead) return

		// —— 扫帚推力的衰减 ——
		//
		// ⚠ 放在蛹分支**之前**：一只幼虫被扫开之后立刻化蛹的话，
		//   推力要在这里衰减掉。放在后面的话它会一直留着，
		//   等羽化那天（推力字段还挂着旧值）冷不丁被推一下
		//
		// ⚠ 减到 1px/s 以下就直接归零，不是省事：留着 0.3px/s 这种
		//   永远衰减不完的残值，会让 `pushVx !== 0` 那类判断永远为真，
		//   而每帧的位移小到看不出来 —— 典型的「不报错但一直在算」
		if (this.pushVx !== 0 || this.pushVy !== 0) {
			const k = Math.exp(-CONFIG.tools.broom.pushDrag * dt)
			this.pushVx *= k
			this.pushVy *= k
			if (Math.abs(this.pushVx) < 1) this.pushVx = 0
			if (Math.abs(this.pushVy) < 1) this.pushVy = 0
		}

		// 金苹果的时间膨胀：趴在果子上啃的时候年龄跑得快 1.5 倍，
		// 于是更快跨过 pupateAt / emergeAt —— 但整条命也同比缩短。
		// 和成虫那边同源同写法，详见 Fly.update 里的注释
		this.age += dtMs * foodGrowthBonus(this.eating?.type)
		this.size = larvaSizeAt(this.age)

		// —— 蛹期：完全静止 ——
		if (L.pupateAt != null && this.age >= L.pupateAt) {
			this.pupa = true
			this.eating = null
			// ⚠ 蛹不吃东西，所以**也不能算挨饿** —— 放在饥饿那一段**之前**
			// 就是干这个的。顺序反了的话每一只蛹都会在羽化前饿死，
			// 而症状是「蛹全都活不到成虫」，看着像羽化逻辑坏了
			this.hunger = 0
			this._keepInBounds(world)
			this._updateSpine()
			return
		}

		// —— 饥饿 ——
		//
		// ateLastTick 是 world._updateFeeding 上一轮写的：只有**抢到进食名额**
		// 才是 true。贴在果子上但被挤掉的那些是 false —— 那正是这个机制的重点
		if (this.ateLastTick) this.hunger = 0
		else this.hunger += dtMs

		if (this.hunger >= this.starveAfter) {
			this.dead = true
			this.causeOfDeath = 'starved'
			// 尸体由 world._resolveLifecycles 统一留（和成虫一个套路：
			// 实体只负责死，从数组里摘出去、留尸体都归 world）
			return
		}

		// —— 找最近的食物 ——
		// 优先级高于集群和随机游走：有吃的就直奔吃的去。
		//
		// ⚠ 嗅觉是**间歇采样**的，不是每帧盯着食物看：每只幼虫按自己的节奏
		// 隔一阵「闻」一次，把当时的位置记进 scentSpot，两次之间按记住的位置爬。
		// 所以食物被拖走之后，它们不会同一帧集体掉头 —— 会先把老地方爬完，
		// 再各自在不同的时刻重新闻到、各自掉头。
		const food = world.nearestFood(this.x, this.y, F.scentRadius * this.scentGain)
		this.eating = null
		// 这一帧有没有「站在果子上但没座位」。每帧重算，见下面那个分支
		this.crowdedAt = null

		// 先判「是不是已经趴在果子上了」。
		//
		// ⚠ 这一条用的是**实时**的 food，不是记住的那个位置 ——
		// 吃到东西是身体挨着才算的，记忆里的坐标不构成「吃到了」。
		// 判据也是「离食物中心有多近」，不是「离我那个落点有多近」：
		// 后者会让幼虫为了够到落点而在果子上来回较劲，而且一挪动就掉出判定
		if (food) {
			const munch = food.size * F.munchRadius
			// ⚠ 有位子才准趴。位子 = food.maxEaters（= size × eatersPerSize）。
			//
			// atLastTick 是「上一帧我吃到了」，也就是**位子已经归我** —— 拿它做迟滞，
			// 边缘那几只才不会在「挤进去 / 被挤出来」之间每帧反复横跳。
			// 满员的果子上，老住户照吃，新来的挤不进去 → 往下走「游荡」那条分支。
			const seated = this.ateLastTick || food.eaters < food.maxEaters
			const onFruit = dist2(this.x, this.y, food.x, food.y) <= munch * munch
			if (seated && onFruit) {
				this.eating = food
				// 记忆要**一直刷成食物的当前位置**，不能清掉。
				//
				// ⚠ 这里清掉过一次，后果是整群幼虫会慢慢离开果子：
				// 它只要有一帧不在 eating 状态（被同伴挤开、在外围挪动时蹭出判定），
				// 而 sniffTimer 又刚被重置成 0.4~1.6 秒，这段时间它是「没闻到味道」的，
				// 于是掉进优先级更低的**组队**那条分支 —— 跟着同伴走。
				// 同伴要是在几百像素外，它就这么一路被带走，直到彻底走出嗅觉半径、
				// 再也闻不回来。实测 12 只围着果子，落在上面的平均只有 3 只。
				// 留着记忆的话，它一掉出 eating 就会立刻往回爬
				this.scentSpot = this._foodSpot(food)
				this.sniffTimer = rand(F.sniffMin, F.sniffMax)
				this._graze(dtMs, food)
				this._advance(dt, F.grazeSpeedScale)
				this._clampToFood(food)
				this._keepInBounds(world)
				this._updateSpine()
				return
			}

			// —— 站在果子上、但没抢到座位 ——
			//
			// ⚠ 光是「不吃」是不够的。实测（30 只幼虫、上限压到 6、跑 90 秒）：
			//   只解挂不驱赶的话，同一时刻仍有最多 **20 只**物理上贴在
			//   munchRadius 以内 —— 因为它们本来就是撒在果子边上出生的，
			//   而随机游走的净位移很小，不主动往外走就会一直磨蹭在原地。
			//   玩家看到的仍然是「一坨糊在果子上」，也就是「改了跟没改一样」。
			//
			// 所以这里记一笔，让下面游走时**朝背离果子的方向**挑目标
			if (onFruit) this.crowdedAt = food
		}

		// —— 到点了，重新闻一次 ——
		//
		// ⚠ 减的是 dtMs（毫秒），不是 dt（秒）。sniffMin/Max 和这个项目里
		// 所有时长一样是毫秒 —— 曾经这里写成 dt，于是「1.6 秒闻一次」变成了
		// 「1600 秒闻一次」：幼虫一生只会闻到一次味道。
		// 症状极具迷惑性：**看起来**只是「有的幼虫找得到食物、有的找不到」，
		// 像随机性，其实是**只有初值恰好接近 0 的那几只**才闻到过。
		// 这类单位错误不会崩、不会报错，只会让一个机制静悄悄地失效
		this.sniffTimer -= dtMs
		if (this.sniffTimer <= 0) {
			this.sniffTimer = rand(F.sniffMin, F.sniffMax)
			// ⚠ 满员的果子**不记**。记了的话，被挤出来的幼虫会一直朝着一个进不去的地方爬，
			// 卡在果子边缘原地打转 —— 看起来就是「一坨幼虫糊在果子上」。
			// 不记的话它就正常游荡走开，等下回再闻（闻的间隔只有零点几秒，有空位了会回来）
			this.scentSpot = food && food.eaters < food.maxEaters ? this._foodSpot(food) : null
		}

		// 爬到记住的位置了，但那儿什么都没有（上面那条「趴上去吃」没拦下来）
		// —— 说明果子在这期间被挪走了。忘掉它，回到随机游走，等下一次闻。
		// 少了这一条的话，幼虫会站在空地上反复朝脚底下那个点转向，
		// 看上去就是在原地抽风
		if (this.scentSpot && dist2(this.x, this.y, this.scentSpot.x, this.scentSpot.y) <= this.scentSpot.r * this.scentSpot.r) {
			this.scentSpot = null
		}

		// —— 随机游走：过一会儿换个方向 ——
		this.wanderTimer -= dt
		if (this.wanderTimer <= 0) {
			if (this.crowdedAt) {
				// 被挤开的：朝**背离果子**的方向走。
				//
				// ⚠ 这一条是「散开」能不能被看见的关键。不驱赶的话，
				//   它们虽然不吃，但会一直在果子边缘磨蹭（随机游走的净位移很小），
				//   画面上仍然是糊成一坨 —— 等于这个机制没做。
				//   抖动留 ±0.7 是为了别让一群虫呈放射状整齐散开，
				//   那看着像爆炸而不像被挤
				const away = Math.atan2(this.y - this.crowdedAt.y, this.x - this.crowdedAt.x)
				this.wanderTimer = rand(1.5, 3)
				this.wanderTarget = away + rand(-0.7, 0.7)
			} else {
				this.wanderTimer = rand(1.2, 3.5)
				this.wanderTarget = this.angle + rand(-1.3, 1.3)
			}
		}

		if (this.scentSpot) {
			// 朝**记住的那个位置**爬。注意不是食物现在的位置 ——
			// 这正是「食物拖走了、它还在往老地方爬」的来源
			const target = Math.atan2(this.scentSpot.y - this.y, this.scentSpot.x - this.x)
			this.angle = angleLerp(this.angle, target, clamp(F.scentPull * dt, 0, 1))
			this.wanderTarget = this.angle
			this.wanderTimer = rand(0.5, 1.5) // 有目标时别急着改主意
		} else if (this.crowdedAt) {
			// 被挤出了果子 → **脱离队伍**自己走开。
			//
			// 优先于集群和组队：刚被挤开的幼虫要是还跟着同伴走，
			// 而同伴正好站在果子上，它就会被原地拽回去，驱赶等于白做。
			//
			// ⚠ 这是允许跳过 buddy 分支的**唯一**位置。放宽成「没食物就跳过」的话，
			//   tools/simulate.js 那条「清空食物、48 只幼虫、180 秒」的组队断言会挂
			this.angle = angleLerp(this.angle, this.wanderTarget, clamp(L.turnRate * dt, 0, 1))
		} else if (this.swarming && world.swarm.active) {
			// 集群时被中心吸引，但保留随机扰动，不然会叠成一只
			const target = Math.atan2(world.swarm.y - this.y, world.swarm.x - this.x)
			const jitter = rand(-1, 1) * CONFIG.swarm.jitter * 0.4
			this.angle = angleLerp(this.angle, target + jitter, clamp(CONFIG.swarm.pull * dt, 0, 1))
			this.wanderTarget = this.angle
			this.wanderTimer = rand(0.4, 1.2) // 集群时别急着改主意
		} else {
			// 什么都没闻到、也没在集群 —— 那就看看附近有没有同窝的伴
			this._updateBuddy(dtMs, world)

			if (this.buddy) {
				// 跟着同伴走。目标点取在它**前方一点**，不是它身上 ——
				// 直接盯着同伴本人的话，两条虫会越贴越近、最后叠成一坨
				const b = this.buddy
				const tx = b.x + Math.cos(b.angle) * L.buddyLead
				const ty = b.y + Math.sin(b.angle) * L.buddyLead
				const target = Math.atan2(ty - this.y, tx - this.x)
				// 转向强度比普通随机游走**低**，所以是「跟着晃」而不是「贴上去」
				this.angle = angleLerp(this.angle, target, clamp(L.buddyFollowPull * dt, 0, 1))
				this.wanderTarget = this.angle
				this.wanderTimer = rand(0.6, 1.6) // 有伴时别急着改主意
			} else {
				this.angle = angleLerp(this.angle, this.wanderTarget, clamp(L.turnRate * dt, 0, 1))
			}
		}

		this._advance(dt)

		this._keepInBounds(world)
		// 位置定下来了，再让脊柱跟上来。顺序不能反：
		// 先更新脊柱的话，身体会对齐到上一帧的位置上，头和身体差一帧
		this._updateSpine()
	}

	/**
	 * 沿当前朝向走一步。
	 *
	 * 匀速。之前这里还乘过一个由蠕动相位驱动的步进系数，把速度做成脉动的；
	 * 蠕动去掉之后速度也一并改成恒定 —— 身体不再有可见的收缩，
	 * 速度却还在一下一下地顿，看着反而更假。
	 *
	 * 注意速度恒定**不影响**软身体：身体的弯折不是靠变速做出来的，
	 * 而是靠「尾巴跟不上头」——见 _updateSpine()
	 *
	 * @param {number} scale 速度倍率（啃食时慢下来）
	 */
	_advance(dt, scale = 1) {
		const speed = CONFIG.larva.crawlSpeed * this.speedScale * scale
		// 扫帚的推力**另算**，不乘 speedScale —— 那是「这只虫自己爬多快」的个体差异，
		// 而扫帚是同一把，推谁都是同样的力
		this.x += (Math.cos(this.angle) * speed + this.pushVx) * dt
		this.y += (Math.sin(this.angle) * speed + this.pushVy) * dt
	}

	/**
	 * 在果子上啃：**在外围慢慢挪**，而不是钉死在一个点上。
	 *
	 * 这一条是「看起来像一排钟点数字」的解药之一（另一个是落点半径，见 config）。
	 * 早先是走到自己那个落点就永远停住：几只幼虫坐在同一个半径上、
	 * 各自一个固定方位角、一动不动 —— 那不就是钟面么。
	 * 真幼虫在果子上是边走边啃的。
	 */
	_graze(dtMs, food) {
		const F = CONFIG.food
		const dt = dtMs / 1000

		this.grazeTimer -= dtMs
		if (this.grazeTimer <= 0) {
			this.grazeTimer = rand(F.grazeMin, F.grazeMax)
			// 方位角和半径**都**重新抽：只换方位角的话，它们仍然待在同一个圆上
			this.grazeAngle = rand(0, TAU)
			this.grazeRing = food.size * rand(F.restRingMin, F.restRingMax)
		}

		const tx = food.x + Math.cos(this.grazeAngle) * this.grazeRing
		const ty = food.y + Math.sin(this.grazeAngle) * this.grazeRing
		this.angle = angleLerp(this.angle, Math.atan2(ty - this.y, tx - this.x), clamp(F.grazeTurnRate * dt, 0, 1))
	}

	/**
	 * 啃食时把位置按在果子范围内。
	 *
	 * ⚠ 少了这一条，「在果子上慢慢挪」会直接毁掉进食机制：
	 * 换位置时它要先转身（grazeTurnRate 才 1.6 rad/s），转身那几帧还在往原方向走，
	 * 很容易拱到 munchRadius 外面去 —— `eating` 一掉成 false，
	 * 这张嘴就从 _updateFeeding 的计数里消失了，果子这一段就少一个人啃，
	 * 而且它要愣到下一次转向才爬回来。实测 12 只围着一份苹果，20 分钟都啃不完。
	 *
	 * 用**夹**而不是「转向回来」：转向要好几帧，那几帧里它已经在外面了。
	 * 而且 grazeRing 的上限（0.5）离 munchRadius（0.6）本来就留了余量，
	 * 这一夹通常只修几像素，看不出来
	 */
	_clampToFood(food) {
		// ⚠ 被扫帚推着的时候**不夹**。
		//
		// 这一夹是给「自己边吃边挪」兜底的辅助，不是一堵物理的墙 ——
		// 让外力优先，是它该有的语义。
		//
		// ⚠ 但**别以为少了这一条扫帚就完全推不动**：实测（一只幼虫趴在
		//   40px 果子上、半径 120 的扫帚按住扫）少这一条也照样能推出去，
		//   只是中间会被夹住**两帧**（d 卡在 munchRadius 上不动），第三帧就脱身了。
		//   原因是这一夹只夹**位置**、不夹速度，而它夹完之后幼虫正好落在
		//   `munchRadius` 这个边界上，`onFruit` 那边是 `dist2 <= munch*munch` ——
		//   浮点误差让下一帧落在哪一侧基本是掷硬币，掷到外侧就出去了。
		//
		//   换句话说：少了这一条，能不能推走取决于浮点运气。
		//   留着它是把这件事**确定下来**，那两帧的「顶着果子边缘原地不动」
		//   也正好是玩家最容易看成「扫帚坏了」的样子
		if (this.pushVx !== 0 || this.pushVy !== 0) return

		const R = food.size * CONFIG.food.munchRadius
		const dx = this.x - food.x
		const dy = this.y - food.y
		const d = Math.hypot(dx, dy)
		if (d <= R || d < 1e-9) return
		this.x = food.x + (dx / d) * R
		this.y = food.y + (dy / d) * R
	}

	/**
	 * 组队：找一个附近的小伙伴一起徘徊。
	 *
	 * 和 swarm（世界级的集群事件，几十秒一次、把大半屏幼虫拽到一个点上）
	 * 是两回事 —— 这里只是一两只同窝的朝同一个方向慢慢爬，日常、安静。
	 *
	 * 规则就是用户要的那条：**同窝的几率更大，但也不排除其他幼虫**。
	 * 旁边有同窝的就按 kinChance 跟它走；没跟上（或旁边压根没有同窝的）
	 * 再按 otherChance 考虑别的幼虫，两个都没抽中就自己爬。
	 *
	 * 一条链只跟一层：已经有伴的幼虫不会被别人跟 —— 否则会串成一串
	 * 首尾相接的「火车」，那比不组队还怪。
	 */
	_updateBuddy(dtMs, world) {
		const L = CONFIG.larva
		this.buddyTimer -= dtMs

		// —— 先看现在这个伴还算不算数 ——
		if (this.buddy) {
			const b = this.buddy
			// 化蛹也算散伙：蛹不会动了，跟着它只会原地打转
			if (b.dead || b.pupa || dist2(this.x, this.y, b.x, b.y) > L.buddyLose * L.buddyLose) {
				this.buddy = null
				this.buddyTimer = rand(L.buddyRetryMin, L.buddyRetryMax)
			}
		}
		if (this.buddy || this.buddyTimer > 0) return
		this.buddyTimer = rand(L.buddyRetryMin, L.buddyRetryMax)

		// —— 重新挑一个 ——
		let kin = null
		let other = null
		let kinD = Infinity
		let otherD = Infinity
		const r2 = L.buddyRadius * L.buddyRadius
		for (const l of world.larvae) {
			// l.buddy 这一条同时挡掉了「跟已经有伴的」和「互相跟随」两种情况
			if (l === this || l.dead || l.pupa || l.buddy) continue
			const d = dist2(this.x, this.y, l.x, l.y)
			if (d > r2) continue
			if (l.clutch === this.clutch && this.clutch !== 0) {
				if (d < kinD) {
					kinD = d
					kin = l
				}
			} else if (d < otherD) {
				otherD = d
				other = l
			}
		}

		// 两次独立掷骰：先看同窝的跟不跟，没跟成再看别的幼虫。
		// 两个概率都不是 1 —— 「同窝的也可能各走各的、不同窝的也可能凑一块」
		const pick = kin && Math.random() < L.kinChance ? kin : other && Math.random() < L.otherChance ? other : null
		if (pick) this.buddy = pick
	}

	/**
	 * 推进身体的脊柱。**软身体的全部实现就在这里。**
	 *
	 * 规则只有一条：每个点被约束在「离前一个点恰好一个体节」的位置上，
	 * 自己**不主动移动**。所以头往前走，尾巴是被拽过去的 ——
	 * 走的是头刚才走过的那条路径。
	 *
	 * 「不主动移动」是关键。早先是按 sin(相位 - t*波数) 给每个点加横向偏移，
	 * 身体确实会扭，但整条是**刚性绑在头的朝向上**的：头一转，身体立刻跟着转，
	 * 看着就是一根硬棍子在平移。真正的软身子来自「身体跟不上头」，
	 * 而不是来自身体自己摆。
	 *
	 * 每帧从头到尾扫一遍就能收敛：头一帧只走 0.2px 左右，
	 * 链条每次都被拉直，不会攒下大的形变。
	 */
	_updateSpine() {
		const sp = this.spine
		// 体节长度跟着体型走 —— 幼虫在长大，身体要同步变长
		const seg = (this.size * this.lengthScale) / (sp.length - 1)

		sp[0].x = this.x
		sp[0].y = this.y

		for (let i = 1; i < sp.length; i++) {
			const prev = sp[i - 1]
			const cur = sp[i]
			const dx = cur.x - prev.x
			const dy = cur.y - prev.y
			const d = Math.hypot(dx, dy)

			if (d < 1e-4) {
				// 两点重合了（刚出生、或者被边界钳制夹到一起）：
				// 朝身体反方向摊开。少了这一步下面就要除以 0，
				// 得到的 NaN 会顺着脊柱一路传给后面每一个点
				cur.x = prev.x - Math.cos(this.angle) * seg
				cur.y = prev.y - Math.sin(this.angle) * seg
				continue
			}

			// 只改距离、不改方向 —— 方向是头走出来的路径给的。
			// 这一行是「拽」而不是「推」：点被拉向/推离前一个点，
			// 但永远不会主动朝别处跑
			const k = (d - seg) / d
			cur.x -= dx * k
			cur.y -= dy * k
		}
	}

	/**
	 * 身体的中轴线，用来画轮廓。**局部坐标**：头在原点、头朝 +x。
	 *
	 * 脊柱本身是世界坐标（跟随要在世界空间里量距离），这里做一次平移 + 反向旋转
	 * 换成渲染需要的局部坐标。正是这一步让身体「不跟着头转」：
	 * 转弯时头转了、世界坐标的脊柱没转，换算到局部坐标里就表现为身体还弯在旧路径上。
	 *
	 * 做成 Larva 上的方法而不是写在 render 里，是为了让自检也能拿到这条曲线：
	 * 头有没有钉在原点、体节长度有没有被拉伸、转弯时身体会不会弯，
	 * 都能在无头环境里断言，不用靠肉眼看画布。
	 *
	 * @param {number} samples 采样点数，默认就是脊柱的点数
	 * @returns {{x:number,y:number,t:number,r:number}[]} 第 0 个是头
	 */
	bodyAxis(samples = CONFIG.larva.bodySamples) {
		const len = this.size * this.lengthScale
		const maxR = len * larvaWidthRatio(this.slim)

		const c = Math.cos(-this.angle)
		const s = Math.sin(-this.angle)

		const out = []
		for (let i = 0; i < samples; i++) {
			// 采样点数可能和脊柱点数不同（自检会传小样本），按比例映射
			const src = this.spine[Math.min(this.spine.length - 1, Math.round((i / (samples - 1)) * (this.spine.length - 1)))]
			const dx = src.x - this.x
			const dy = src.y - this.y
			const t = i / (samples - 1)
			out.push({
				x: dx * c - dy * s,
				y: dx * s + dy * c,
				t,
				r: maxR * larvaProfileAt(t),
			})
		}
		return out
	}

	/**
	 * 身体的闭合轮廓（局部坐标，头在原点、头朝 +x）。渲染直接拿它填充。
	 *
	 * 做法：沿中轴线算出左右两条轮廓线，**两端各补一个半圆头**，再首尾相接。
	 *
	 * ⚠ 两端必须补圆头。少了这一步，轮廓就是在头尾各拉一条垂直于身体的直线
	 * 把两侧连起来 —— 尾巴看上去像被削掉了一块。这个 bug 只靠调半径剖面是修不掉的：
	 * 剖面决定「切面有多宽」，不决定「切成什么形状」。
	 *
	 * @param {number} samples 采样点数，默认就是脊柱的点数
	 * @returns {{x:number,y:number}[]} 闭合折线，首尾相接
	 */
	bodyOutline(samples = CONFIG.larva.bodySamples) {
		const axis = this.bodyAxis(samples)
		const n = axis.length
		const CAP = 7 // 每个圆头补几个点，7 个在这个尺寸下已经看不出棱角

		// 每个点的法线：切线逆时针转 90°。
		// 不能直接沿 y 轴偏移 —— 身体弯得厉害时那一段中轴接近竖直，
		// 横着撑会把轮廓挤成奇怪的形状
		const rim = []
		for (let i = 0; i < n; i++) {
			const prev = axis[Math.max(0, i - 1)]
			const next = axis[Math.min(n - 1, i + 1)]
			const tx = next.x - prev.x
			const ty = next.y - prev.y
			const tl = Math.hypot(tx, ty) || 1
			rim.push({ nx: -ty / tl, ny: tx / tl })
		}

		const loop = []
		/** 半圆头：从 +法线侧绕到 -法线侧，中途经过身体外侧（tx,ty 那个方向） */
		const cap = (p, nx, ny, tx, ty, side) => {
			for (let k = 1; k < CAP; k++) {
				const a = (Math.PI * k) / CAP
				const c = Math.cos(a) * p.r * side
				const s = Math.sin(a) * p.r
				loop.push({ x: p.x + nx * c + tx * s, y: p.y + ny * c + ty * s })
			}
		}

		// 一侧轮廓，从尾到头
		for (let i = 0; i < n; i++) {
			loop.push({ x: axis[i].x + rim[i].nx * axis[i].r, y: axis[i].y + rim[i].ny * axis[i].r })
		}

		// 尾巴的圆头。外侧方向 = 从倒数第二点指向尾点
		const tail = axis[n - 1]
		const ttdx = tail.x - axis[n - 2].x
		const ttdy = tail.y - axis[n - 2].y
		const ttl = Math.hypot(ttdx, ttdy) || 1
		cap(tail, rim[n - 1].nx, rim[n - 1].ny, ttdx / ttl, ttdy / ttl, 1)

		// 另一侧轮廓，从尾到头
		for (let i = n - 1; i >= 0; i--) {
			loop.push({ x: axis[i].x - rim[i].nx * axis[i].r, y: axis[i].y - rim[i].ny * axis[i].r })
		}

		// 头的圆头。外侧方向 = 从头指向第二点
		const head = axis[0]
		const hdx = head.x - axis[1].x
		const hdy = head.y - axis[1].y
		const hl = Math.hypot(hdx, hdy) || 1
		cap(head, rim[0].nx, rim[0].ny, hdx / hl, hdy / hl, -1)

		return loop
	}

	/**
	 * 把幼虫夹回屏幕内，撞到边就反射掉头。
	 *
	 * 注意这个方法必须在 **每一条** return 路径上都调用 ——
	 * 早先只有「爬行」那条路径会钳制，「进食」和「蛹期」直接提前 return 了，
	 * 结果是一只出生在边界外的幼虫会永远卡在屏幕外。
	 */
	_keepInBounds(world) {
		const m = CONFIG.larva.margin
		if (this.x < m) {
			this.x = m
			this._bounce(Math.PI - this.angle)
		} else if (this.x > world.w - m) {
			this.x = world.w - m
			this._bounce(Math.PI - this.angle)
		}
		if (this.y < m) {
			this.y = m
			this._bounce(-this.angle)
		} else if (this.y > world.h - m) {
			this.y = world.h - m
			this._bounce(-this.angle)
		}
	}

	_bounce(newAngle) {
		this.angle = newAngle
		this.wanderTarget = newAngle
		this.wanderTimer = rand(0.6, 1.8)
	}

	/**
	 * 这只幼虫准备趴在食物的哪一点上。
	 *
	 * 不能直接拿食物圆心当目标 —— 那样所有幼虫会全挤到正中央叠成一坨，
	 * 看起来像「一堆」而不是「一群」。所以每只幼虫各自记一个方位角，
	 * 各自落在果实表面的不同位置。
	 */
	_foodSpot(food) {
		const ring = food.size * CONFIG.food.restRing
		return {
			x: food.x + Math.cos(this.foodAngle) * ring,
			y: food.y + Math.sin(this.foodAngle) * ring,
			// 到了「离落点这么近」就算走到了。趴在果子上之后就走 _graze 那条路了，
			// 这个 r 只管「从外面爬过来的最后一段」
			r: Math.max(4, food.size * 0.14),
		}
	}
}

// ====================================================================
//  食物 — 苹果 / 香蕉 / 葡萄
//
//  它是整个生态的聚集点：
//    幼虫靠嗅觉找到它并趴上去啃 → 营养被一点点吃光 → 剩下的烂摊子要擦
//    成虫被发酵的味道勾过来（果蝇的本能）
//  顺带把原本「随机挑一个中心点」的集群机制变得有意义了。
// ====================================================================

/**
 * 抽一份食物的尺寸。**两段**，不是一段连续分布：
 *
 *   · 正常： sizeMin ~ sizeNormalMax（24~30px），占 sizeNormalChance（95%），段内均匀
 *   · 巨型： sizeNormalMax+1 ~ sizeMax（31~200px），剩下那 5%，段内**越大越少**
 *
 * ⚠ 两段之间**没有空洞也不重叠**：正常段抽到的是 [24, 30]，
 *   巨型段从 31 起 —— 断言里专门有一条查「不存在 30~31 之间的尺寸」
 *
 * ⚠ 单独抽成函数（而不是写在 Food 构造函数里）是为了让模拟器能**直接**
 *   按这个分布抽样验证 —— 它要抽六千次来查段占比，造六千个 Food 对象
 *   白白搭上 durability / nutrition 那些字段，而且掩盖了「被测的是分布本身」
 *
 * @returns {number} 尺寸（像素，绘制直径）
 */
export function rollFoodSize() {
	const F = CONFIG.food
	if (Math.random() < F.sizeNormalChance) return rand(F.sizeMin, F.sizeNormalMax)
	// 巨型段：把 random^sizeBias 压向小端。sizeBias = 1 时退化成均匀
	const lo = F.sizeNormalMax + 1
	return lo + (F.sizeMax - lo) * Math.pow(Math.random(), F.sizeBias)
}

export class Food {
	/**
	 * @param {number|null} [size] 指定尺寸。**传 null 才是游戏里的正常路径**（随机抽）。
	 *   显式给一个值只有一个用途：让断言拿到一份**确定的**食物 ——
	 *   size 一旦确定就牵动 durability / maxEaters / 各种判定半径，
	 *   用随机尺寸做测试的话，同一套代码会因为这次抽到 24、下次抽到 190
	 *   而表现完全不同，断言只能时红时绿
	 */
	constructor(x, y, type, size = null) {
		const F = CONFIG.food

		this.kind = 'food'
		this.x = x
		this.y = y
		this.type = type

		this.size = size ?? rollFoodSize()
		this.angle = rand(0, TAU)

		this.age = 0

		/**
		 * 耐用性 = 这一份总共含多少营养。在 1 ~ durabilityMax 之间按 size 线性插值。
		 *
		 * ⚠ 这就是「大果子更经啃」的全部实现。早先 nutrition 恒为 1，
		 *   于是「果子多大」和「能啃多久」**完全无关** —— size 只通过
		 *   maxEaters 影响能同时站几只。现在两者都随 size 走。
		 *
		 * 啃完时间 = larvaMealTime × durability ÷ 同时进食的幼虫数，
		 * 所以对固定的一批幼虫，时间倍率正好落在 1 ~ durabilityMax 倍。
		 */
		this.durability = lerp(
			1,
			F.durabilityMax,
			(this.size - F.sizeMin) / (F.sizeMax - F.sizeMin),
		)

		// 剩余营养。**单位是「份」不是「比例」** —— 满值是 durability，不是 1。
		// ⚠ 想拿「被啃掉了几成」请用 eaten getter，别自己写 `1 - nutrition`
		this.nutrition = this.durability

		this.eaters = 0 // 这一帧有几只幼虫趴在上面（由 world 统计，纯用于渲染）
		this.seed = rand(0, 1000)
		this.dead = false
		this.causeOfDeath = null
	}

	/** 腐烂程度 0（新鲜）→ 1（烂透）。做成 getter，理由同 Remains.rot */
	get rot() {
		return clamp(this.age / CONFIG.food.rotTime, 0, 1)
	}

	/**
	 * 被啃掉了几成：0（完好）→ 1（啃光）。
	 *
	 * ⚠ **渲染必须读这个，不能写 `1 - f.nutrition`。**
	 *   nutrition 是**总量**（最大 durabilityMax = 20），满的时候
	 *   `1 - 20 = -19`，画出来会是 5 倍大的一坨。
	 *   两者在 durability = 1 的小果子上恰好相等，所以这个错在
	 *   开局的普通果子上**看不出来**，只会在大果子上突然爆掉
	 */
	get eaten() {
		return 1 - this.nutrition / this.durability
	}

	/** 被啃光了 */
	get depleted() {
		return this.nutrition <= 0
	}

	/** 烂到开始散味道、能招蝇了吗 */
	get smelly() {
		return this.rot >= CONFIG.food.flyAttractMinRot
	}

	/**
	 * 这份食物能同时供几只幼虫进食。
	 *
	 * **按体积算**，不是固定值：上限 = size × eatersPerSize。
	 * 大果子能多站几只，小果子少几只 —— 早先这是个全局的 6，
	 * 无论苹果多大都只能挤 6 只。
	 *
	 * ⚠ 它决定的不只是「谁在消耗营养」，还是**谁会被饿死**
	 * （见 world._updateFeeding 里那个 ateLastTick）
	 */
	get maxEaters() {
		return Math.max(1, Math.round(this.size * CONFIG.food.eatersPerSize))
	}

	update(dtMs) {
		this.age += dtMs // rot 是 getter，自己会跟着 age 走
	}
}

// ====================================================================
//  烤炉 —— lv3 的容器，手套抓最多 5 只成虫塞进去，进度条满了自动卖钱
//
//  结构和 Jar 是同一套路（内部坐标同样是**相对炉心的偏移**，
//  这样拖动炉子时里面的果蝇自动跟着走），但有个关键区别：
//  炉里的果蝇**照常老化、照常算售价** —— 炉子只是个暂存区，
//  不像罐子那样把年龄推进减速。出炉时按当时的 fly.value × 档位倍率折算。
//
//  ⚠ 「出炉」= **直接变成钱**，不在世界上留任何东西（结算在
//  world._updateOvens 里）。这个类自己只管倒计时和进度，不认识钱。
//
//  ⚠ 炉里的果蝇不在 world.flies 里（和罐子同理），所以交配、拍打、
//  网捕都自动不参与，不需要到处加 if。
// ====================================================================

export class Oven {
	constructor(x, y) {
		const O = CONFIG.roast.oven

		this.kind = 'oven'
		this.x = x
		this.y = y
		this.w = O.width
		this.h = O.height
		this.seed = rand(0, 1000)

		/** 炉里的成虫。x / y 是相对炉心的偏移，和 Jar.flies 一个规矩 */
		this.items = []

		/**
		 * 开烤之后的倒计时（ms）。null = 还没开烤。
		 * ⚠ 只有这两个字段配合起来才画得出「烤到几成了」——
		 * 光有剩余时间不知道总量，算不出比例
		 */
		this.roastTimer = null
		this.roastTotal = 0

		this.dead = false
	}

	get capacity() {
		return CONFIG.roast.oven.capacity
	}

	get full() {
		return this.items.length >= this.capacity
	}

	/** 正在烤 */
	get roasting() {
		return this.roastTimer !== null
	}

	get halfW() {
		return this.w / 2
	}

	get halfH() {
		return this.h / 2
	}

	/**
	 * 收一只果蝇进炉。
	 *
	 * 和 Jar.admit 一样，这里也是**屏幕坐标 → 炉内相对坐标**的唯一转换点。
	 * 传进来的果蝇还带着世界坐标，出去时 x / y 已经变成相对偏移了。
	 */
	admit(fly) {
		if (this.full) return false
		const s = CONFIG.roast.oven.innerScale
		fly.x = rand(-1, 1) * this.halfW * s
		fly.y = rand(-1, 1) * this.halfH * s
		fly.angle = rand(0, TAU)
		fly.aim = fly.angle
		fly.vx = 0
		fly.vy = 0
		// 同 Jar.admit：进炉之后不受外面那只手影响
		fly.startleMul = 1
		// ⚠ 金光光环也要清。理由同上：这个 pass 够不着容器里的果蝇，
		//   留着的话它会带着一个外面已经不存在的 +10% 一直待在炉子里 ——
		//   而且 goldAura 是自有字段，**会跟着存档走**，等于永久通胀
		fly.goldAura = 1
		this.items.push(fly)
		return true
	}

	/**
	 * 开烤。空炉子点了不该有反应，更不能白烧一个倒计时。
	 *
	 * ⚠ 时长是**调用方传进来的**，炉子自己不去 CONFIG 里找。
	 * 8 秒这个数住在 `market.roastChain` 的 lv3 那一条上 ——
	 * 它和「×1.8」「$16」是同一档的三个属性，拆开放两处迟早会对不上。
	 * （早先这里写的是 `CONFIG.roast.oven.roastMs`，而那个键**根本不存在**，
	 * 于是倒计时变成 NaN、炉子一次都不 tick —— 见下面 update 的第一行注释）
	 */
	startRoast(ms) {
		if (this.roasting || this.items.length === 0) return false
		if (!Number.isFinite(ms) || ms <= 0) return false
		this.roastTimer = ms
		this.roastTotal = ms
		return true
	}

	/** 烤到几成了，0 → 1。没在烤就是 0 */
	get roastProgress() {
		if (!this.roasting || !(this.roastTotal > 0)) return 0
		return clamp(1 - this.roastTimer / this.roastTotal, 0, 1)
	}
}

// ====================================================================
//  飘字 —— 纯表现层的一行提示文字
// ====================================================================

/**
 * 往上飘的一行字（目前只有「烤炉卖出一只 +$x」在用）。
 *
 * 和 Particle 是两回事：粒子是**画出来的形状**，这个是**文字** ——
 * 文字没法用画圆的方式表达，所以单独一个小东西，而不是往粒子系统里塞一个
 * 「如果 kind 是 text 就 fillText」的分支。
 *
 * ⚠ 纯表现层，**不进存档**（和 particles / wipeTrail 同一个规矩）：
 *   它寿命只有一秒多，存下来读回去只会看到一堆陈年的价格飘在半空
 */
export class FloatText {
	constructor(x, y, text, opts = {}) {
		const F = CONFIG.roast.oven.float

		this.x = x
		this.y = y
		this.text = text
		this.color = opts.color ?? F.color

		// 寿命和速度都带个体抖动 —— 一炉 5 个数字**完全同步**地往上飘会像一列火车
		this.life = F.life * rand(0.85, 1.15)
		this.maxLife = this.life
		this.vy = -F.rise * rand(0.85, 1.2)

		/**
		 * 还要等多久才出现（ms）。同一炉的第 n 只延后 n × delayStep。
		 *
		 * ⚠ 延后期间**不飘也不淡出**：先原地等着，到点了才从头开始。
		 *   要是延后期间照样扣 life，排在最后那个数字出现时已经快没了
		 */
		this.delay = opts.delay ?? 0

		this.dead = false
	}

	/** 0~1。两头都淡：出现时淡入、消失时淡出，中间全不透明 */
	get alpha() {
		if (this.delay > 0) return 0
		const t = clamp(this.life / this.maxLife, 0, 1)
		return clamp((1 - t) / 0.2, 0, 1) * clamp(t / 0.4, 0, 1)
	}

	update(dtMs) {
		if (this.delay > 0) {
			this.delay -= dtMs
			return
		}
		this.y += this.vy * (dtMs / 1000)
		this.life -= dtMs
		if (this.life <= 0) this.dead = true
	}
}

// ====================================================================
//  玻璃罐 —— 把成虫抓起来单独观察
//
//  罐中果蝇**不在 world.flies 里**，而是挂在这个罐子的 flies 数组上。
//  于是「隔离」是白送的：交配、苍蝇拍、生命周期结算全都只遍历 world.flies，
//  果蝇不在里面就自动不参与 —— 不需要在那些地方各塞一个 if 判断，
//  也就不会漏掉某一处（漏掉的那种 bug 表现为「罐子里的果蝇莫名其妙死了」）。
// ============================================================

export class Jar {
	constructor(x, y) {
		const J = CONFIG.jar

		this.kind = 'jar'
		this.x = x
		this.y = y
		// 平面矩形，不是圆罐。宽高存在实例上（而不是每次去读 CONFIG），
		// 这样存档能原样带着尺寸走，将来想支持「大小不同的罐子」也不用改结构
		this.w = J.width
		this.h = J.height
		this.seed = rand(0, 1000) // 预留：高光/纹理的固定随机，目前画法还没用到

		/**
		 * 罐中的成虫。
		 *
		 * ⚠ 这些果蝇的 x / y 是**相对罐子中心的偏移**，不是屏幕坐标。
		 * 渲染时要写成 (jar.x + f.x, jar.y + f.y)。
		 *
		 * 这么存是为了拖动：只要改 jar.x / jar.y 一个地方，罐里所有果蝇自动跟着走，
		 * 不会出现「拖动时果蝇掉队」，也不需要每帧同步一遍坐标。
		 * 代价就是这一行 —— 直接读 f.x 拿到的是偏移。
		 */
		this.flies = []

		/**
		 * 罐中配上的、还没产完的那一窝。null = 没有。
		 *
		 * ⚠ 产卵的是**罐子**，不是母体 —— 母体在罐里根本不该进入 laying 状态
		 *   （`laying` 同时是渲染的「收翅」标记，也是 canMate 的前置条件，
		 *   占上了她就再也不能配对，而且罐中虫会一直收着翅膀）。
		 *   所以这一窝的「内容」挂在罐子上，按 `laying.eggInterval` 一颗颗产到罐外。
		 *
		 * ⚠ 存的是**纯数据**（全是数字 / 字符串 / 数组 / 纯对象），
		 *   不是某只虫的引用 —— 存引用的话 snapshot 会把一只活虫走私进存档
		 *   （REF_FIELDS 就是为这件事存在的）；而纯数据是自动就能存档的
		 */
		this.pending = null

		this.dead = false
	}

	get capacity() {
		return CONFIG.jar.capacity
	}

	get full() {
		return this.flies.length >= this.capacity
	}

	/** 半宽 / 半高。拖动的边界、渲染的矩形都按这两个来 */
	get halfW() {
		return this.w / 2
	}

	get halfH() {
		return this.h / 2
	}

	/**
	 * 含盖子的上半高。
	 *
	 * 盖子坐在罐身上沿**之上**，所以这个罐子在竖直方向占的其实不止 h ——
	 * 夹边界（拖拽、窗口 resize）要用这个值，否则拖到屏幕最上面时
	 * 盖子会被顶出屏幕外，罐子看着像被削掉了脑袋。
	 * 水平方向没这个问题（盖子比罐身窄），所以只有上半高这一项。
	 */
	get topHalfH() {
		return this.halfH + CONFIG.jar.capHeight
	}

	/** 果蝇能飞到的地方（离内壁留一点，不然会一直贴着边线飞） */
	get innerHalfW() {
		return Math.max(6, this.halfW - CONFIG.jar.innerPad)
	}

	get innerHalfH() {
		return Math.max(6, this.halfH - CONFIG.jar.innerPad)
	}

	/**
	 * 收一只果蝇进罐。
	 *
	 * 这里是**屏幕坐标 → 罐内相对坐标**的唯一转换点：传入的果蝇还带着
	 * 世界坐标，出来时它的 x / y 已经变成相对偏移了。
	 *
	 * @param {Fly} fly
	 * @returns {boolean} 罐子满了就返回 false，由调用方决定怎么办
	 */
	admit(fly) {
		if (this.full) return false

		// 位置在罐内矩形里均匀撒开。全都塞中心的话，几只果蝇会叠成一个黑点
		fly.x = rand(-1, 1) * this.innerHalfW * 0.85
		fly.y = rand(-1, 1) * this.innerHalfH * 0.85
		fly.angle = rand(0, TAU)
		fly.aim = fly.angle
		// 关进来了就不再受外面那只手影响。⚠ 必须显式清 ——
		// 它可能正是被手吓着的时候被抓进来的，不清的话会带着那个倍率
		// 在罐子里乱撞，而 _applyStartle 再也管不到它了
		fly.startleMul = 1
		// ⚠ 金光光环同理，而且这条**更要紧**：world.sellFly 是直接按 fly.value
		//   给罐中果蝇结算的（罐中列表里那个「售价」就是它）。
		//   带着外面蹭来的 +10% 进罐子，等于白送钱，而且再也洗不掉
		fly.goldAura = 1

		// 罐里是**飞着的**：翅膀张开、会扑腾。
		// 初始速度给 0，让它自己加速到罐内巡航速度 —— 直接给满速会看起来像被弹进去
		fly.mode = 'fly'
		fly.vx = 0
		fly.vy = 0
		fly.targetSpeed = rand(CONFIG.jar.flySpeedMin, CONFIG.jar.flySpeedMax)
		fly.dartTimer = rand(CONFIG.jar.dartMin, CONFIG.jar.dartMax)
		fly.hoverTimer = 0

		// 这几个状态必须清掉：
		//   pausing / feeding —— 罐里没有「走走停停」和「在果子上进食」这回事
		//   laying —— 它是被网住的瞬间正在产卵的那只。不清的话，
		//     render 里的 grounded 判定会让它永远收着翅膀（laying 没人推进了），
		//     而且它会带着一个永远不会结束的产卵状态一直飞
		fly.pausing = false
		fly.feeding = false
		fly.feedTarget = null
		fly.laying = false

		this.flies.push(fly)
		return true
	}
}

// ====================================================================
//  蛹壳 — 羽化之后留在原地的那枚空壳
//
//  它是一个独立实体，不走 Remains 那套 rot —— 壳不会腐烂，放多久都是同一枚壳，
//  所以擦掉它需要的路程是固定的。
//
//  清理方式有两条，都留着：
//    · 抹布来回擦（和残留物同一套累计路程的算法，只是更费劲）
//    · 手套拖进垃圾桶（干脆，但要先切工具）
//  早先只有后者（「残留物归抹布、蛹壳归手套」是一条刻意的分工），
//  后来发现这条分工只是让玩家多切一次工具，没有带来任何取舍。
//
//  形状沿用原来那只蛹的体型参数（size / lengthScale / slim），
//  这样「壳」和「刚才那只蛹」看起来是同一个东西，只是空了。
// ====================================================================

export class Shell {
	constructor(x, y, angle, size, lengthScale, slim) {
		this.kind = 'shell'
		this.x = x
		this.y = y
		this.angle = angle
		this.size = size
		this.lengthScale = lengthScale
		this.slim = slim
		this.seed = rand(0, 1000) // 壳面颗粒的固定随机

		// 塌陷：几处向内凹的坑，位置 / 深浅 / 宽窄逐枚随机。
		// 这是「一眼看出是空壳」的主要线索 —— 活着的那枚蛹是饱满的椭圆。
		// 存成数据而不是每帧现算：渲染每帧都会读它，而且存档要能原样带过去
		const S = CONFIG.pupa.shellCollapse
		this.dents = []
		const lobes = randInt(S.lobesMin, S.lobesMax)
		for (let i = 0; i < lobes; i++) {
			this.dents.push({
				// 方向要躲开已经放好的坑（见 config 的 minSep）。
				// 拒绝采样而不是「先随便撒再推开」：处数最多才 2，
				// 撒不出合法位置的概率极低，几次就能撞上
				a: this._freeAngle(S.minSep),
				d: rand(S.depthMin, S.depthMax), // 凹进去多深（相对半径）
				w: rand(S.widthMin, S.widthMax), // 这处凹陷有多宽（弧度）
			})
		}

		this.age = 0
		// 擦拭进度 0 → 1，和 Remains 是同一套「累计路程」的算法。
		// 早先蛹壳是抹布**擦不掉**的（只能戴手套拖进垃圾桶）——
		// 那条分工已经取消：两条路都留着，谁方便用谁
		this.clean = 0
		this.dead = false
	}

	update(dtMs) {
		this.age += dtMs
	}

	/**
	 * 被抹布擦一下。参数和 Remains.wipe 完全同义。
	 *
	 * 需要的路程是固定的（不像残留物会随腐烂变难）—— 壳不会腐烂，
	 * 放多久都是同一枚壳。
	 *
	 * @param {number} scrub 这一次滑过了多少像素
	 * @returns {boolean} 是否已被擦掉
	 */
	wipe(scrub) {
		if (!(scrub > 0)) return this.dead
		this.clean += scrub / CONFIG.pupa.shellScrub
		if (this.clean >= 1) {
			this.clean = 1
			this.dead = true
		}
		return this.dead
	}

	/**
	 * 找一个离已有凹陷都足够远的方向（弧度）。
	 *
	 * 前 24 个候选里只要有一个合法的就直接用（保持「先到先得」的随机感）；
	 * 一个都没有就退而求其次，用**最疏**的那个。
	 *
	 * ⚠ 这里原来是「试 12 次，都不行就重新随便来一个」。那个兜底是有问题的：
	 * 随便来的那个完全可能正好落在已有凹陷上，两处叠起来就是个深坑 ——
	 * 而 minSep 存在的全部意义就是不许这种事发生。
	 * 实测大约每 200 枚壳里就会撞上几次（模拟器有一条断言专门守它，
	 * 改之前它是**间歇性**报错的）。
	 *
	 * 换成「best of 24」之后，同一份断言稳定通过，而随机感一点没少 ——
	 * 合法位置是第一个撞上的那个，不是最优的那个
	 */
	_freeAngle(minSep) {
		let best = 0
		let bestGap = -1
		for (let i = 0; i < 24; i++) {
			const a = rand(0, TAU)
			let gap = Infinity
			for (const d of this.dents) {
				const diff = Math.abs(Math.atan2(Math.sin(a - d.a), Math.cos(a - d.a)))
				if (diff < gap) gap = diff
			}
			if (gap >= minSep) return a
			if (gap > bestGap) {
				bestGap = gap
				best = a
			}
		}
		return best
	}

	/** 局部坐标下的长短半轴。和活蛹用同一套公式，壳才和刚才那只蛹对得上号 */
	get radii() {
		const P = CONFIG.pupa
		return {
			pl: this.size * this.lengthScale * P.lengthScale,
			pw: this.size * lerp(P.widthFat, P.widthSlim, this.slim),
		}
	}

	/**
	 * 某个方向上的半径系数：1 = 完好的椭圆，小于 1 = 这里塌进去了一块。
	 *
	 * 每一处凹陷是一条高斯坑，叠加起来就是平滑的瘪壳。
	 *
	 * 最后钳到 0.55：正常情况下靠 config 的 minSep 就叠不起来，
	 * 这一钳是**保险丝**，不是主要手段 —— 万一 minSep 被改小、
	 * 或者以后处数调多了，壳也不会被掐成一条缝。
	 */
	radiusAt(t) {
		let r = 1
		for (const dent of this.dents) {
			// 角差要折到 [-π, π]。不折的话，凹陷跨过 ±π 接缝时会从
			// 另一头「翻」出来，在壳的正对面多出一个莫名其妙的坑
			const da = Math.atan2(Math.sin(t - dent.a), Math.cos(t - dent.a))
			r -= dent.d * Math.exp(-((da / dent.w) ** 2))
		}
		return Math.max(r, 0.55)
	}

	/**
	 * 壳体轮廓点（局部坐标，未旋转，单位是像素）。首尾不重复的闭合环。
	 *
	 * 放在实体上而不是 render.js 里，一是模拟器要拿它断言「壳真的瘪了」，
	 * 二是它纯粹是几何，和画布没有半点关系。
	 *
	 * 每个点带上角度 t —— render 那边画「羽化缺口」时要挑出属于某一段弧的点。
	 */
	outline(samples = CONFIG.pupa.shellSamples) {
		const { pl, pw } = this.radii
		const out = []
		for (let i = 0; i < samples; i++) {
			const t = (i / samples) * TAU
			const r = this.radiusAt(t)
			out.push({ x: Math.cos(t) * r * pl, y: Math.sin(t) * r * pw, t })
		}
		return out
	}
}

// ====================================================================
//  残留物 — 自然死亡的尸体 / 拍死留下的汁渍
//  两者共用同一套「越久越难擦」的机制，只是外观和腐烂速度不同
// ====================================================================

export class Remains {
	constructor(x, y, kind, size, angle, fly = null) {
		this.kind = kind // 'corpse' 尸体 | 'stain' 汁渍
		this.x = x
		this.y = y
		this.size = size
		this.angle = angle

		this.age = 0
		this.rotTime = kind === 'stain' ? CONFIG.remains.rotTimeStain : CONFIG.remains.rotTime

		this.clean = 0 // 擦拭进度 0 → 1（累计的路程 ÷ scrubNeeded），到 1 就消失
		this.seed = rand(0, 1000) // 让形状稳定但不重复
		this.dead = false

		// —— 尸体才能烤、才值钱 ——
		//
		// ⚠ 汁渍（stain）永远是 0：它是拍击溅出来的，不是一具身体。
		// 而且它**没有 rarity**，烤制相关的整套字段对它都没意义，
		// 所以这里全部走「没有 fly 就留空」这一条路
		this.value = fly ? fly.value : 0 // 死那一刻的售价快照
		this.rarity = fly ? fly.rarity : null
		this.sex = fly ? fly.sex : null
		this.roasted = false // 烤过了没有。**单向**，再烤不会更贵
		this.roastMul = 1

		// 挂了多久才开始掉价（ms）。0 = 立刻开始（汁渍用不上，它没价）
		this.decayStart = CONFIG.roast.decayStartMs
		this.decaySpan = CONFIG.roast.decaySpanMs
		this.decayTo = CONFIG.roast.decayTo
	}

	/** 这一具能不能拿去烤 / 拿去卖 */
	get roastable() {
		return this.kind === 'corpse' && this.value > 0
	}

	/**
	 * 随时间掉价的系数：1 → 0.1。
	 *
	 * 前 decayStart（5 分钟）恒定 1 倍 —— 拍死之后有充足的时间去拿打火机；
	 * 之后在 decaySpan（15 分钟）里线性掉到 decayTo（0.1），到底就停在那儿。
	 * 不会掉成 0：留一点残值，玩家清理屏幕时顺手卖掉也不算白干。
	 *
	 * ⚠ 做成 getter，由 age 推导，不存字段 —— 理由和 rot 一模一样：
	 * 存字段的话，任何没走到 update() 的路径都会让它停在旧值上
	 */
	get decayFactor() {
		if (!(this.value > 0)) return 0
		const t = clamp((this.age - this.decayStart) / this.decaySpan, 0, 1)
		return lerp(1, this.decayTo, t)
	}

	/** 现在卖掉能换多少钱。烤过的再乘倍率 */
	get price() {
		return this.value * this.decayFactor * this.roastMul
	}

	/**
	 * 腐烂程度 0（新鲜）→ 1（烂透）。
	 *
	 * 刻意做成 getter 而不是存储字段：早先是每帧在 update() 里算好写进 this.rot，
	 * 结果任何没走到 update 的代码路径（以及所有外部想「催熟」它的地方）
	 * 都会发现赋值被无声覆盖掉。上一版就在这儿栽过一次。
	 * 由 age 推导就没有这个坑了。
	 */
	get rot() {
		return clamp(this.age / this.rotTime, 0, 1)
	}

	/**
	 * 擦掉它总共需要累计多少像素的来回滑动。
	 * 新鲜时来回两三下，完全腐烂后要十几下 —— 这就是「更难擦除」的实现。
	 */
	get scrubNeeded() {
		return lerp(CONFIG.remains.wipeScrubFresh, CONFIG.remains.wipeScrubRotten, this.rot)
	}

	/**
	 * 被抹布擦一下。
	 *
	 * @param {number} scrub 这一次**滑过了多少像素**（不是「几下」，也不是毫秒）。
	 *   传 0 什么也不会发生 —— 停在原地按住不放就是 0
	 * @returns {boolean} 是否已被擦干净
	 */
	wipe(scrub) {
		if (!(scrub > 0)) return this.dead
		this.clean += scrub / this.scrubNeeded
		if (this.clean >= 1) {
			this.clean = 1
			this.dead = true
		}
		return this.dead
	}

	update(dtMs) {
		this.age += dtMs // rot 是 getter，自己会跟着 age 走
	}
}

// ====================================================================
//  粒子 —— 汁液 / 灰尘 / 火苗 / 水雾，全是同一种东西
// ====================================================================

/**
 * @param {object} [opts] 这几个都是**可选的**，不传就是原来那套「汁液」的物理。
 *   加它们是为了让同一个类也能画火苗（往上飘、边飘边缩）和灰尘（慢慢扩散）——
 *   再写三个类的话，「寿命 / 阻力 / 上限」这些规则就要维护四份
 * @param {number} [opts.life]      存活秒数
 * @param {number} [opts.gravity]   重力（负值 = 往上飘，火苗用它）
 * @param {number} [opts.drag]      空气阻力系数，越大停得越快
 * @param {number} [opts.grow]      尺寸随 alpha 变化的额外系数。
 *   0 = 不变（汁液）；正 = 越淡越大（灰尘扩散）；负 = 越淡越小（火苗收尖）
 */
export class Particle {
	constructor(x, y, vx, vy, color, size, opts = {}) {
		this.x = x
		this.y = y
		this.vx = vx
		this.vy = vy
		this.color = color
		this.size = size
		this.life = (opts.life ?? CONFIG.tools.particleLife) * rand(0.7, 1.3)
		this.maxLife = this.life
		this.gravity = opts.gravity ?? CONFIG.tools.particleGravity
		this.drag = opts.drag ?? 2.8
		this.grow = opts.grow ?? 0
		this.dead = false
	}

	get alpha() {
		return clamp(this.life / this.maxLife, 0, 1)
	}

	update(dtMs) {
		const dt = dtMs / 1000

		this.vy += this.gravity * dt

		// 空气阻力：汁液甩出去之后很快减速
		const drag = Math.exp(-this.drag * dt)
		this.vx *= drag
		this.vy *= drag

		this.x += this.vx * dt
		this.y += this.vy * dt

		this.life -= dtMs
		if (this.life <= 0) this.dead = true
	}
}

// ====================================================================
//  存档 —— 实体状态的取出与放回
//
//  这一节只回答「一只果蝇自身有哪些数据」，不知道世界怎么组织，
//  也不知道存到哪儿去。编排（哪个数组叫什么、要不要存）全部在 world.js。
// ====================================================================

/**
 * 这些字段指向**别的实体对象**，不是数据本身，存档时必须跳过。
 *
 * 好在它们都是每帧在 update() 里重新算出来的（Fly.bait 是嗅觉结果、
 * Larva.eating 是「正趴在哪个食物上」），恢复后自然会重新填上，
 * 跳过不会丢任何信息。
 */
const REF_FIELDS = new Set([
	// 指向别的实体对象，全是每帧重算的
	'bait',
	'eating',
	// Larva.buddy 是「一起徘徊的那个同伴」，指向另一个 Larva。
	// 它每隔几秒重挑一次，丢了也只是「这一轮没伴」，不需要存
	'buddy',
	// Jar.flies 是**嵌套的实体数组**，必须由 world.serialize() 单独展开成
	// snapshot(fly) 的数组。放着不管的话，通用 snapshot() 会把 Array.isArray
	// 那条分支走到，slice() 出一份「装着活 Fly 对象的浅拷贝」——
	// JSON.stringify 时它会顺带把 Fly 的自有属性都序列化出来，
	// 表面上像是能跑，实际上绕过了 REF_FIELDS 的过滤（bait 引用会被一起写进存档）
	'flies',
	// Oven.items 和 Jar.flies 是**一模一样**的情况，理由见上。
	// ⚠ 读档时它拿到的是**纯对象**而不是 Fly 实例，直接 assign 上去的话，
	// 炉子里的果蝇会变成「有 x/y 但没有任何方法」的空壳 —— 画得出来、
	// 但一旦进 update 就是 undefined is not a function。所以 world.restore()
	// 必须和 jars 一样成对重建，不能走通用路径
	'items',
])

/**
 * 把一只实体拍成纯数据。
 *
 * 做法是「拷贝所有自有可枚举属性，跳过引用字段」，而不是手写字段白名单。
 * 白名单的问题是：以后给实体加一个新字段、忘了往白名单里补，那个字段就会在
 * 存档/读档之间**悄悄**丢掉，不报错、不崩溃，只是过一会儿发现「这虫子怎么不动了」。
 * 反过来做（默认全存）则是新增字段自动跟上，只有引用字段需要显式排除。
 *
 * 原型上的 getter（Remains.rot / Remains.scrubNeeded / Food.depleted / Larva.pupaProgress
 * 等等）都不是自有属性，Object.entries 取不到，也不需要存 —— 它们全部由 age
 * 这类存储字段推导出来，把 age 存对了它们自然就对。
 */
export function snapshot(e) {
	const out = {}
	for (const [k, v] of Object.entries(e)) {
		if (REF_FIELDS.has(k)) continue
		if (v === null || typeof v !== 'object') {
			out[k] = v
			continue
		}
		// 只接受纯对象 / 数组（shape、layShape、feedTarget 这类），其余一律跳过。
		// 不深拷贝是因为这份快照马上就会被 JSON.stringify，没有回写的窗口。
		// 数组要**逐个元素**浅拷贝，不能只 v.slice()：slice 出来的是「装着同一批
		// 对象引用的新数组」，Larva.spine 那种 [{x,y},...] 就会和活实体共用点对象 ——
		// 存档对象还没被 stringify，世界又跑了一帧，存下来的坐标就变了
		if (Array.isArray(v)) out[k] = v.map((it) => (it && typeof it === 'object' ? { ...it } : it))
		else if (v.constructor === Object) out[k] = { ...v }
	}
	return out
}

/**
 * 每种实体的「空壳」怎么造。
 *
 * 注意 Remains 不能用 kind 当判别键 —— 它的 kind 是 'corpse' / 'stain'（外观种类），
 * 而不是实体种类，六种实体里只有它这么特殊。所以判别键由调用方（world.js）
 * 按数组来给，不从实体里读。
 */
const BUILDERS = {
	adult: () => new Fly(0, 0, 'M'),
	egg: () => new Egg(0, 0),
	larva: () => new Larva(0, 0),
	food: () => new Food(0, 0, 'apple'),
	remains: () => new Remains(0, 0, 'corpse', 14, 0),
	jar: () => new Jar(0, 0),
	shell: () => new Shell(0, 0, 0, 14, 1, 0.5),
	oven: () => new Oven(0, 0),
	// ⚠ 没有 skewer 了。牙签那套在 1.7.0 被换成「直接烤尸体」，
	// Skewer 类已经删掉。旧存档里的 skewers 数组读不进来（revive 找不到构造器
	// 就返回 null，由 _loadList 丢掉），表现是地上的烤串消失 —— 不会崩，
	// 但也不该有人再往这儿加回来
}

/**
 * 用存档数据造回一只实体。
 *
 * 关键在于**先 new 一个默认实例、再往上覆盖**，而不是 Object.create(proto) 直接填字段：
 * 老存档里缺的新字段会保留构造函数的默认值，而不是变成 undefined。
 * undefined 混进物理计算就是 NaN，而 NaN 会无声地扩散到坐标上，
 * 等到发现「果蝇不见了」的时候已经很难查是哪一步引入的。
 *
 * @param {string} type 'adult' | 'egg' | 'larva' | 'food' | 'remains'
 * @param {object} data snapshot() 的产物
 * @returns {object|null} 造不出来就返回 null，由调用方丢弃
 */
export function revive(type, data) {
	const build = BUILDERS[type]
	if (!build || !data || typeof data !== 'object') return null

	const e = build()
	for (const [k, v] of Object.entries(data)) {
		if (REF_FIELDS.has(k)) continue
		if (!canAssign(e, k)) continue
		e[k] = v
	}
	return e
}

/**
 * 这个字段能不能往恢复出来的实体上写。
 *
 * 规则是「实例自己有的照写；实例没有的，只有原型上**压根没有**这个键时才允许新增」。
 *
 * 分两种情况，缺一不可：
 *
 *   不能无条件写 —— 原型上的访问器（Remains.rot、Food.depleted、Larva.pupaProgress）
 *     在严格模式下赋值会直接抛 TypeError；原型上的方法被同名字段遮蔽掉则更隐蔽。
 *
 *   不能只写实例已有的 —— Fly.layShape 是 startLaying() 运行时才挂上去的，
 *     构造函数里根本没有这个字段。一刀切按 hasOwnProperty 挡掉的话，
 *     正在产卵的母体一旦存档，这一窝幼虫的体型性状就无声无息地丢了，
 *     而且不报错、不崩溃，只是孵出来的幼虫「长得不像它妈」。
 */
function canAssign(e, k) {
	if (Object.prototype.hasOwnProperty.call(e, k)) return true
	return !(k in e) // in 会顺着原型链找
}
