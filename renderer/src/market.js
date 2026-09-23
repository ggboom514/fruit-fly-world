/**
 * market.js — 体重、稀有度、售价、货币格式
 *
 * 这一层是**纯计算**：给一个稀有度和成长进度，算出体重；给一个体重，算出值多少钱。
 * 它不认识 Fly，也不碰 DOM。
 *
 * 单独成模块而不是塞进 entities.js 的两个理由：
 *   1. tools/simulate.js 要直接断言这些公式。摊在实体里的话，
 *      「稀有度分布对不对」就只能靠养一大群果蝇间接地看，而那要跑几分钟
 *   2. entities.js 已经很长了，而这里是完全独立的一套规则
 */

import { CONFIG } from './config.js'
import { lerp } from './utils.js'

/** 三档稀有度的配置表（从便宜到贵） */
const RARITIES = CONFIG.market.rarity

/** id → 档位描述，省得每次遍历 */
const RARITY_BY_ID = {}
for (const r of RARITIES) RARITY_BY_ID[r.id] = r

/** 按 id 取稀有度描述。认不出来就退回第一档（普通）—— 老存档里的果蝇没有这个字段 */
export function rarityOf(id) {
	return RARITY_BY_ID[id] ?? RARITIES[0]
}

/**
 * 抽一次稀有度，返回档位 id。
 *
 * 按**累积概率**抽，所以配置里的 chance 之和必须是 1；
 * 浮点误差可能让最后一段差一点点，末尾兜底返回最后一档，
 * 不然会有极小概率抽出 undefined。
 */
export function rollRarity() {
	let r = Math.random()
	for (const t of RARITIES) {
		if (r < t.chance) return t.id
		r -= t.chance
	}
	return RARITIES[RARITIES.length - 1].id
}

/**
 * 这一只满成长时的体重（mg）。每只在出生时抽一次，之后**固定不变** ——
 * 它代表的是「这只果蝇的体格」，而不是「现在多重」。
 *
 * 固定下来的好处：成长过程中体重是单调的，而且存档只需要存这一个数，
 * 不用存「当时抽到了区间里的哪一段」。
 */
export function rollWeightMax(rarityId) {
	const r = rarityOf(rarityId)
	return lerp(r.weightMin, r.weightMax, Math.random())
}

/**
 * 当前体重（mg）。
 *
 * ⚠ 三档的**出生体重是一样的**（market.birthWeight），只是长成后的上限差很多。
 * 所以刚羽化的果蝇看不出是不是变异 —— 得养到接近满成长才显形。
 * 这是有意的：让「它到底值多少」变成一个要等的信息，而不是一出生就开奖。
 *
 * @param {number} growth 成长进度 0~1（就是 age / lifespan）
 */
export function weightAt(rarityId, weightMax, growth) {
	return lerp(CONFIG.market.birthWeight, weightMax, Math.max(0, Math.min(1, growth)))
}

/** 售价。体重(mg) × pricePerMg —— 默认就是「每 0.1mg 得 $0.001」 */
export function priceOf(weightMg) {
	return weightMg * CONFIG.market.pricePerMg
}

/**
 * 卖一只**被封禁的幼虫**值多少钱。
 *
 * 幼虫没有体重、稀有度、成长（`Larva` 类里压根没这几个字段），
 * 所以它不是算出来的，是在 `CONFIG.tools.ban` 那个区间里随机抽的 ——
 * 「一条蛆不值钱」。用户指定 $0.001 ~ $0.01。
 *
 * ⚠ round 到三位，和 `formatMoney` / `bulkPrice` 同一个理由：
 *   浮点尾巴会渗进 `world.money`，攒多了就会看到 `$0.3009999999999999`
 */
export function bannedLarvaPrice() {
	const B = CONFIG.tools.ban
	return Math.round((B.larvaValueMin + Math.random() * (B.larvaValueMax - B.larvaValueMin)) * 1000) / 1000
}

/**
 * 价值落在哪一档。返回 valueTiers 里的那一条配置。
 *
 * 用「第一个上界 ≥ 价值」来判，所以档位配置**必须按上界升序排**。
 * 超出最后一档就归最后一档 —— 以后真出现更贵的东西，也是显示成最花哨的那档，
 * 而不是崩掉或者变成 undefined
 */
export function valueTierOf(value) {
	for (const t of CONFIG.market.valueTiers) {
		if (value <= t.upper) return t
	}
	return CONFIG.market.valueTiers[CONFIG.market.valueTiers.length - 1]
}

/**
 * 货币文本，格式 `$xxx,xxx.xxx` —— 千分位 + **至少**三位小数。
 *
 * 价格的最小单位是 $0.001（体重的最小刻度 0.1mg），所以三位小数足够表示所有金额；
 * 先 round 到三位再格式化，是为了挡住浮点误差 ——
 * 直接 toFixed(3) 一长串相加的结果，会时不时冒出 `$0.3009999999999999` 这种尾巴。
 *
 * 整数部分没有上限，「最高无上限」就是靠不写上限做到的。
 */
export function formatMoney(v) {
	const n = Number.isFinite(v) ? v : 0
	const fixed = (Math.round(n * 1000) / 1000).toFixed(3)
	const [int, dec] = fixed.split('.')
	return '$' + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec
}

/** 商店道具描述。认不出来返回 null，由调用方决定怎么报错 */
export function shopItem(id) {
	return CONFIG.market.shop.find((it) => it.id === id) ?? null
}

/**
 * 取某条**可升级链**的配置表。认不出来返回 null。
 *
 * world.chainTier 走这里。抽成函数是因为它以前是写死单条链的
 * （`id === 'roast' ? ... : null`）—— 加第二条链时如果不改，
 * `upgradeShopItem('keeper')` 会永远返回 false，
 * 而**症状只是「点了升级没反应」**，不报错、也不会有别的异常。
 *
 * ⚠ 加新链要改**两个**地方：config.market 里加那张表，这里加一行分支。
 */
export function chainOf(id) {
	if (id === 'roast') return CONFIG.market.roastChain
	if (id === 'keeper') return CONFIG.market.keeperChain
	return null
}

/**
 * 养蝇人的可选项。`tiers` 配成 null 时回退到 valueTiers ——
 * 「卖哪档」只有一份定义（market.valueTiers），别在 UI 或断言里另抄一遍。
 *
 * ⚠ 是 **valueTiers**（售价分档），不是 market.rarity（体重档）。
 *   这两个现在是完全不同的东西，见 config.js 里 valueTiers 那段注释
 */
export function keeperOptions() {
	const K = CONFIG.market.keeperOptions
	return {
		foods: K.foods,
		counts: K.counts,
		tiers: K.tiers ?? CONFIG.market.valueTiers.map((t) => t.id),
		checkMs: K.checkMs,
	}
}

// ⚠ 这里原来还有一对 priceFromSlider / sliderFromPrice（养蝇人那根
//   对数价格滑条的换算）和它们用的 clampT / clamp01 / logSpan。
//   滑条整条删掉之后它们就没有调用方了，一并删掉 ——
//   留着的话，下一个人会以为「价格门槛」这个功能还在，只是没接线

/** 放大镜那条商店配置。找不到就返回 null（`?? Infinity` 那套已经删了） */
export function magnifierItem() {
	return CONFIG.market.shop.find((it) => it.id === 'magnifier') ?? null
}

/**
 * 放大镜**默认**高亮哪几档。配成 null / 缺省就回退到全部档位。
 *
 * ⚠ 和 keeperOptions 同一条规矩：只有一份 valueTiers，别在 UI 或断言里另抄。
 *   返回的是**副本** —— 调用方（world）会把它当自己的状态存着，共享一个数组的话
 *   玩家一勾就把配置本身改掉了
 */
export function magnifierDefaultTiers() {
	const it = magnifierItem()
	const list = it?.tiers ?? CONFIG.market.valueTiers.map((t) => t.id)
	return sanitizeTiers(list)
}

/**
 * 把一组候选**洗成**合法的价值档 id：去重、丢掉认不出的、按 valueTiers 的顺序排。
 *
 * ⚠ 这是唯一的验收入口 —— 存档、玩家的勾选、devtools 的乱写都从这里过。
 *   为什么要洗而不是直接信：`valueTiers` 是**有序**的，而 UI 是按顺序画的；
 *   一个手改过的存档塞进来 `['mythic','common']` 的话，
 *   不高亮错什么，但 `JSON.stringify` 往返之后和别人的不一样，很难查
 */
export function sanitizeTiers(list) {
	const known = new Set(CONFIG.market.valueTiers.map((t) => t.id))
	const picked = new Set()
	if (Array.isArray(list)) {
		for (const id of list) if (known.has(id)) picked.add(id)
	}
	// 按 valueTiers 的顺序输出，顺手把去重也做了
	return CONFIG.market.valueTiers.filter((t) => picked.has(t.id)).map((t) => t.id)
}

/**
 * 一次买 n 份的总价。
 *
 * ⚠ 必须 round 到三位。`0.001 * 10` 在浮点里是 0.010000000000000002，
 * 不挡的话它会一路渗进 world.money，最后在 UI 上变成 `$0.010` 旁边多出来的一串尾巴
 * （formatMoney 虽然也会 round，但**余额**本身是脏的：攒够十次就会漂）。
 * 这和 formatMoney 里那次 round 是同一个理由，只是位置更靠前。
 */
export function bulkPrice(unit, n) {
	return Math.round(unit * n * 1000) / 1000
}

/** 一份食物的单价。认不出来的类型按最贵的算，免得被拿来做无本买卖 */
export function foodPrice(type) {
	const t = CONFIG.market.prices.food
	if (type in t) return t[type]
	return Math.max(...Object.values(t))
}

/** 投一只果蝇的单价 */
export function flyPrice() {
	return CONFIG.market.prices.spawnFly
}

// ⚠ 这里删掉过 `ovenPrice()`。烤炉从 1.27.0 起是商店里的**一次性道具**
//   （见 CONFIG.market.shop 里 oven 那条），不再是按次收费的消耗品，
//   所以「摆一个多少钱」这个问题不存在了 —— 价格走 shopItem('oven').price，
//   而投放面板里那一行是免费的「摆一个」，和玻璃罐同一个形态。
