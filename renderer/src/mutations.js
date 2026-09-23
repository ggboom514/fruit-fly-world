/**
 * mutations.js — 基因突变的**纯计算**：抽取、以及「这组基因值多少 / 多重」
 *
 * 和 market.js 一个分层：它不认识 Fly，也不碰 DOM，
 * 只做「给一组突变 id，算出结果」。
 *
 * 单独成模块的理由和 market.js 一样：tools/simulate.js 要直接断言抽中率。
 * 摊在实体里的话，「子代是不是真的按 chance 骰出新发突变」就只能靠养一大群
 * 果蝇间接地看，而那要跑几十分钟、还得跟繁殖速度纠缠在一起。
 *
 * ## 突变模型：**每颗卵各自独立骰一次，不看父母**
 *
 * ⚠ 这里**曾经**有一套遗传机制（父母带了的按 inheritChance 传给子代），
 *   用户明确要求删掉。现在全项目只有**一条**产生突变的规则：
 *
 *     每个卵形成时，对每一种突变各骰一次，概率就是
 *     CONFIG.mutation.types[].chance。父母带什么**完全不影响**。
 *
 * 这条规则的两个后果，都是刻意的：
 *   · 突变不会在谱系里累积。带结晶的父母，孩子照样只有 1.1% 是结晶 ——
 *     稀有突变永远稀有，「养一批带某基因的种蝇」这件事不存在了
 *   · **星云**（chance 为 0，只能靠幼虫吃星空苹果得来）传不下去。
 *     一只星云蝇的后代全是普通蝇，想要就一直得重新喂
 *
 * ⚠ 游戏性上必须注意：「疯狂」是**有害**突变。如果它只咬正常个体，
 *   带它的个体就有绝对生存优势，几代之内会把种群里其他果蝇杀光。
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

// ⚠ 这里**删掉过**两个函数：`inheritFrom()` 和 `combineGenes()`。
//   用户要求去掉遗传机制，全项目现在只有 rollDeNovo() 一条产生突变的路。
//   别再按「教科书上的孟德尔」把它们加回来 —— 那不是漏了，是刻意不要。

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
// · **不追踪合子型**（纯合 / 杂合），也**不追踪谱系**。突变就是个体身上一个
//   平铺的 id 数组，从哪来的不记录、往下传不参与 ——
//   遗传整个去掉了（见文件头），所以「基因座 / 等位基因」这套概念在这里
//   一概不存在。想加回来的话先想清楚：那是用户明确要求删掉的
//
// · **不追踪携带者与表达者的区别**。点石成金和石化是 adultOnly（只在成虫
//   身上显形），但基因从卵就有了 —— 也就是说一枚卵/一只幼虫身上可能挂着
//   一个「现在还看不出来」的突变，等它羽化才显形。
//   ⚠ 别把它和「携带者遗传」搞混：现在**没有**遗传这回事，
//   这个字段只影响「什么时候画得出来」
//
// · **突变没有位置效应**。现实里基因在染色体上、会连锁，这里每种突变
//   独立分离。屏幕上一共五种突变，连锁只会让玩家更难看出规律。
