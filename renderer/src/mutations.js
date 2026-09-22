/**
 * mutations.js — 基因突变的**纯计算**：抽取、遗传、以及「这组基因值多少 / 多重」
 *
 * 和 market.js 一个分层：它不认识 Fly，也不碰 DOM，
 * 只做「给一组突变 id，算出结果」。
 *
 * 单独成模块的理由和 market.js 一样：
 *   1. tools/simulate.js 要直接断言遗传率。摊在实体里的话，
 *      「子代是不是真的各有 inheritChance 概率继承」就只能靠养一大群果蝇间接地看，
 *      而那要跑几十分钟、还得跟繁殖速度纠缠在一起
 *   2. 遗传规则本身是独立的一套学问，塞进 entities.js 会被别的东西淹掉
 *
 * ## 遗传模型（按用户要求「用现实基因突变的方式」）
 *
 * 现实里突变有**两个**来源，这里都有：
 *   · **新发（de novo）** —— 配子形成时新产生的，父母都没有。
 *     每个卵独立骰，概率就是 CONFIG.mutation.types[].chance
 *   · **遗传（inherited）** —— 父母带了，子代就可能带。
 *     每个突变按 inheritChance 传下去
 *
 * ⚠ **结构是孟德尔的，比例不是。** 每个基因座互相独立、父母各算一次、
 *   子代可能同时带多个 —— 这套「基因而不是重新抽奖」的骨架是照现实来的。
 *   但那个比例 `inheritChance` 现在是 **0.2**，不是杂合子的 50%：
 *   它是**节奏旋钮**，用户要求调低，好让突变在谱系里慢慢稀释而不是几代铺满。
 *   别照着教科书去「修正」它 —— 想改就改 config，那里有说明。
 *
 * 所以一只果蝇的基因 = 从母亲那继承的 ∪ 从父亲那继承的 ∪ 自己新发的。
 * 这也意味着突变会在谱系里**扩散**，而不是每代重新开奖。
 *
 * ⚠ 游戏性上必须注意：「疯狂」是**有害**突变。如果它只咬正常个体，
 *   带它的谱系就有绝对生存优势，几代之内会把种群里其他果蝇杀光。
 *   所以攻击目标里**包含其他疯狂个体** —— 自相残杀，自己压住自己。
 *   这不是为了平衡硬加的，现实里有害等位基因被自然选择压住也是同一回事。
 */

import { CONFIG } from './config.js'

/** 突变配置表。顺序就是 UI 里徽章的显示顺序 */
export const MUTATION_TYPES = CONFIG.mutation.types

/** id → 配置，省得每次遍历 */
const BY_ID = {}
for (const t of MUTATION_TYPES) BY_ID[t.id] = t

const IDS = MUTATION_TYPES.map((t) => t.id)

/**
 * 按 id 取突变配置。认不出来返回 null（**不抛异常**）——
 * 这条路会被读档走到，而存档可能是旧版本写的、或者被人手改过。
 * 一个认不出的 id 不该让整局游戏起不来
 */
export function mutationOf(id) {
	return BY_ID[id] ?? null
}

/**
 * 清一遍并去重。
 *
 * 两个地方需要它：
 *   · 父母双方带同一种突变时，子代不该拿到两份
 *   · 存档里可能有已经不存在的 id（改过配置），留着会让
 *     valueMulOf 之类的乘法吃进 undefined → NaN → 整只果蝇价值变成 NaN
 */
export function cleanGenes(list) {
	if (!Array.isArray(list)) return []
	const out = []
	for (const id of list) {
		if (typeof id !== 'string') continue
		if (!BY_ID[id]) continue
		if (out.includes(id)) continue
		out.push(id)
	}
	return out
}

/** 这一组基因里有没有某个突变 */
export function hasMutation(list, id) {
	return Array.isArray(list) && list.includes(id)
}

/**
 * 新发突变：每个类型独立骰一次。
 *
 * ⚠ **独立**骰，不是「先抽中不中、再抽是哪种」。两者的差别是
 * 「一窝里出现两种新突变」的概率：独立骰允许同一只带多个突变，
 * 这才是对的（现实里不同基因座各自突变，互不影响）
 */
export function rollDeNovo() {
	const out = []
	for (const t of MUTATION_TYPES) {
		if (Math.random() < t.chance) out.push(t.id)
	}
	return out
}

/**
 * 从**一个**亲本继承：他身上每一种**突变 id 各骰一次**，概率 inheritChance。
 *
 * 形状借的是孟德尔的分离比（每个基因座独立、双亲各算一次），
 * 但**概率本身是游戏旋钮**，不是 0.5 —— 见 CONFIG.mutation 那段注释。
 * （现实里纯合子该 100%、杂合子 50%，游戏不追踪合子型，一律用同一个数）
 */
export function inheritFrom(parent) {
	const out = []
	if (!Array.isArray(parent)) return out
	for (const id of parent) {
		if (!BY_ID[id]) continue
		if (Math.random() < CONFIG.mutation.inheritChance) out.push(id)
	}
	return out
}

/**
 * 一个受精卵的完整基因：母亲传的 ∪ 父亲传的 ∪ 自己新发的。
 *
 * ⚠ 返回的是**新数组**，调用方可以放心改。这一点很重要：
 *   卵的数组会一路递到幼虫、再递到成虫，
 *   共用同一个数组的话，给一只加突变会同时改到所有拿到它的个体
 */
export function combineGenes(motherGenes, fatherGenes) {
	return cleanGenes([...inheritFrom(motherGenes), ...inheritFrom(fatherGenes), ...rollDeNovo()])
}

/** 拷贝一份。跨个体传递基因时一律先过它 */
export function copyGenes(list) {
	return Array.isArray(list) ? list.slice() : []
}

/**
 * 自身价值倍率 = 各突变 valueMul 的**乘积**。
 *
 * 用乘法而不是加法：同时带点石成金和结晶应该是 1.3 × 2 = 2.6，
 * 而不是 1 + 0.3 + 1 = 2.3。前者才是「两件事各自独立生效」的语义
 */
export function valueMulOf(list) {
	if (!Array.isArray(list)) return 1
	let m = 1
	for (const id of list) {
		const t = BY_ID[id]
		if (t && typeof t.valueMul === 'number') m *= t.valueMul
	}
	return m
}

/**
 * 疯狂蝇的寿命倍率（默认 0.5，没带这个突变就是 1）。
 *
 * 成虫乘在 `lifespan` 上；幼虫没有「寿命」这条线，乘在 `starveAfter`
 * 上 —— 那是它唯一的死亡时钟（见 Larva 构造函数）。
 * 两处用的是同一个倍率，改配置只改 `mutation.types` 里 berserk 的 `lifespanMul`。
 */
export function berserkLifespanMul(list) {
	const t = BY_ID.berserk
	if (!t || typeof t.lifespanMul !== 'number') return 1
	return hasMutation(list, 'berserk') ? t.lifespanMul : 1
}

/** 体重倍率，同样连乘 */
export function weightMulOf(list) {
	if (!Array.isArray(list)) return 1
	let m = 1
	for (const id of list) {
		const t = BY_ID[id]
		if (t && typeof t.weightMul === 'number') m *= t.weightMul
	}
	return m
}

/**
 * 移动速度倍率（星云 ×2），同样连乘。
 *
 * ⚠ 和 valueMulOf / weightMulOf 一样，**在消费点乘**，绝不写进
 *   `Fly.targetSpeed` / `Larva.speedScale` 那些字段 ——
 *   那些赋值点有三四处（构造函数、飞 / 走切换、窜的间歇、罐子里、孵化），
 *   漏一处就会变成「星云蝇在**某些时候**飞得和普通一样快」：
 *   不报错、不崩，只是某条路径上效果消失了。
 *   entities.js 里 speedScale / panicMul 那两段注释说的是同一件事
 */
export function speedMulOf(list) {
	if (!Array.isArray(list)) return 1
	let m = 1
	for (const id of list) {
		const t = BY_ID[id]
		if (t && typeof t.speedMul === 'number') m *= t.speedMul
	}
	return m
}

/**
 * 这组基因是不是「要发光吸引同伴」的那种（点石成金）。
 * 抽出来是因为 world 的光环 pass 每帧都要问一遍
 */
export function isGoldAuraSource(list) {
	return hasMutation(list, 'golden')
}

/**
 * 随机挑一种突变，给工具用（sim / devtools 造测试个体）。
 * 传 id 时就返回那一串，方便「我要一只石化蝇」这种写法
 */
export function randomGeneSet(ids = null) {
	if (ids) return cleanGenes(ids)
	const out = []
	for (const t of MUTATION_TYPES) {
		if (Math.random() < 0.5) out.push(t.id)
	}
	return out
}

/**
 * UI 徽章描述。幼虫面板只用这个 —— 它不显示成长 / 体重 / 售价，
 * 因为那些对一个还在啃果子的蛆没有意义
 */
export function badgesOf(list) {
	if (!Array.isArray(list)) return []
	const out = []
	for (const t of MUTATION_TYPES) {
		if (!list.includes(t.id)) continue
		out.push({ id: t.id, name: t.name, icon: t.icon, color: t.color, adultOnly: !!t.adultOnly })
	}
	return out
}

/**
 * 全部合法的突变 id。给断言和 devtools 用
 */
export function allMutationIds() {
	return IDS.slice()
}

// ────────────────────────────────────────────────────────────────
// 取舍说明（写在这里，免得被当成疏漏）
//
// · **不追踪合子型**（纯合 / 杂合）。现实里纯合子会把突变 100% 传给子代，
//   杂合子才是别的比例。要支持这个，每个个体得存「每个基因座两份等位基因」，
//   而且交配时要按位点配对 —— 复杂度翻三倍，玩家却完全看不出来
//   （面板上只会显示「有 / 没有」）。所以**一律用同一个 inheritChance**，
//   不分纯合杂合 —— 那个数现在是 0.2，是个游戏旋钮（见 config）。
//
// · **不追踪携带者与表达者的区别**。点石成金和石化是 adultOnly（只在成虫
//   身上显形），但基因从卵就有了，幼虫面板上也能看到那个徽章。
//   这正是「携带者」该有的样子：自己没显出来，但会传给孩子。
//
// · **突变没有位置效应**。现实里基因在染色体上、会连锁，这里每种突变
//   独立分离。屏幕上一共五种突变，连锁只会让玩家更难看出规律。
