/**
 * tools/probe-forage.js — 「果蝇在哪儿落地」的调参探针
 *
 *   bun run probe:forage
 *
 * 只回答一个问题：**果蝇是在离果子多远的地方落地的？**
 *
 * 为什么值得单独量：这个距离直接决定玩家看到的是「飞过去吃」还是
 * 「一路走过去」。它由 `behavior.foodLandRadius` 决定，而那个值
 * 一旦逼近嗅觉半径（`food.flyScentRadius`，600px），
 * 落地的掷骰就发生在**刚闻到味道那一瞬间** —— 也就是离果子最远的地方。
 * 实测落点中位 593px，落地后还要爬 10 秒，看起来很蠢。
 *
 * 场景很窄，是刻意的：一颗催熟的果子和一只从 900px 外飞过来的成虫，
 * 跑 15 秒，记录它**第一次**从飞切到走的那一刻的直线距离。
 * 40 个方向各来一次，看中位数。
 *
 * 和 `tools/probe-fly.js` 的分工：那个调单只果蝇的物理（速度 / 转向），
 * 这个调「它决定在哪儿停下」。
 */

import { World } from '../renderer/src/world.js'
import { CONFIG } from '../renderer/src/config.js'

const W = 1920
const H = 1080
/** 果子摆在正中间，探针从各个方向等距飞过来 */
const FOOD_X = 960
const FOOD_Y = 540
/** 出发距离。要明显大于嗅觉半径，才量得到「飞进去」的过程 */
const START_R = 900
const TRIES = 40
/** 每次最多跑 15 秒（60fps）—— 1700px/s 飞 900px 只要半秒出头，绰绰有余 */
const MAX_FRAMES = 900

const world = new World(W, H)

// 整个世界只留「一颗果子 + 一只探针」，别的全清掉：
// 否则幼虫抢食、同伴交配都会混进来，量到的就不是「落地」了
const clear = () => {
	world.flies.length = 0
	world.larvae.length = 0
	world.eggs.length = 0
	world.foods.length = 0
	world.remains.length = 0
	world.shells.length = 0
	world.particles.length = 0
}

const landings = []
let neverLanded = 0
let cantFly = 0

for (let i = 0; i < TRIES; i++) {
	clear()
	const food = world.addFood(FOOD_X, FOOD_Y, 'apple', 40)
	// rot 是**由 age 推导的 getter**，直接赋值会被立刻覆盖 —— 要催熟只能改 age
	food.age = CONFIG.food.rotTime
	if (!food.smelly) throw new Error('果子没烂，它散不出味道，量出来的东西没有意义')

	const a = (i / TRIES) * Math.PI * 2
	const f = world.addFly(FOOD_X + Math.cos(a) * START_R, FOOD_Y + Math.sin(a) * START_R, 'M', 'normal')
	if (!f) continue
	// 石化蝇飞不起来，「飞过去」这件事对它不成立，剔掉
	if (!f.canFly) {
		cantFly++
		continue
	}

	// 把飞行状态钉死。不钉的话它可能一开局就掷中「落地」，
	// 量到的就成了「随机落地」而不是「飞到跟前才落」
	f.mode = 'fly'
	f.modeTimer = 1e9
	f.dartTimer = 1e9
	f.hoverTimer = 0
	f.aim = Math.atan2(FOOD_Y - f.y, FOOD_X - f.x)

	let at = null
	for (let t = 0; t < MAX_FRAMES; t++) {
		const before = f.mode
		f.update(1000 / 60, world)
		// 只看**第一次**飞→走的那一帧；之后它在果子上起起落落都不算
		if (before === 'fly' && f.mode === 'walk') {
			at = Math.hypot(f.x - FOOD_X, f.y - FOOD_Y)
			break
		}
	}
	if (at == null) neverLanded++
	else landings.push(at)
}

const L = CONFIG.behavior.foodLandRadius
const S = CONFIG.food.flyScentRadius
const V = CONFIG.walk.speed

console.log(`落地半径 foodLandRadius = ${L} px ｜ 嗅觉半径 flyScentRadius = ${S} px ｜ 爬行速度 ${V} px/s`)
console.log(`出发距离 ${START_R}px，${TRIES} 次尝试：落地 ${landings.length} / 没落地 ${neverLanded} / 石化剔掉 ${cantFly}`)

if (!landings.length) {
	console.log('一只都没落地 —— 检查 behavior.landChanceNearFood 和 _updateMode 里的落地判定')
} else {
	landings.sort((x, y) => x - y)
	const med = landings[(landings.length / 2) | 0]
	const avg = landings.reduce((x, y) => x + y, 0) / landings.length
	console.log(
		`落点距离：最小 ${landings[0].toFixed(0)} / 中位 ${med.toFixed(0)} / 最大 ` +
			`${landings[landings.length - 1].toFixed(0)} / 平均 ${avg.toFixed(0)} px`,
	)
	console.log(`落地后还要爬 ${(med / V).toFixed(1)} 秒（中位）才到果子跟前`)
	const far = landings.filter((d) => d > L * 1.5).length
	console.log(`落点超过落地半径 1.5 倍的：${far} / ${landings.length}`)
	// 对照：这条如果接近 1，说明果蝇是在嗅觉半径的**边缘**落地的，
	// 也就是「一路走过去」那个毛病又回来了
	console.log(`落点 ÷ 嗅觉半径 = ${(med / S).toFixed(2)}（越接近 1 越糟）`)
}
