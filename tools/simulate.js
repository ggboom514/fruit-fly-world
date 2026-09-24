/**
 * tools/simulate.js — 无头模拟器
 *
 * 不启动 Electron，直接把 World 跑起来，用比真实快几百倍的速度推演完整生命周期。
 * 用来验证数值、排查逻辑问题，或者改完 config.js 之后快速看效果。
 *
 *   bun tools/simulate.js          # 默认模拟 120 分钟
 *   bun tools/simulate.js 600      # 模拟 600 分钟
 *
 * 模拟核心不碰任何 DOM，所以能在 bun/node 里直接跑 —— 这也是当初把
 * 实体逻辑和渲染彻底分开的收益之一。
 */

import { World } from '../renderer/src/world.js'
import {
	CONFIG,
	MIN,
	SEC,
	clamp,
	inheritTrait,
	rand,
	larvaSizeAt,
	larvaWidthRatio,
	larvaProfileAt,
	foodGrowthBonus,
	foodZoneRect,
	FOOD_DRAW_RADIUS,
	alarmLevel,
} from '../renderer/src/config.js'
import { dist2, TAU, lerp } from '../renderer/src/utils.js'
import { snapshot, Shell, Larva, Food, Fly, rollFoodSize } from '../renderer/src/entities.js'
import {
	rollRarity,
	rollWeightMax,
	priceOf,
	valueTierOf,
	formatMoney,
	foodPrice,
	flyPrice,
	bulkPrice,
} from '../renderer/src/market.js'
import {
	rollDeNovo,
	valueMulOf,
	weightMulOf,
	speedMulOf,
	MUTATION_TYPES,
} from '../renderer/src/mutations.js'
// ⚠ render.js 能在无头环境里 import：它只在**函数体**里碰 canvas / performance，
//   模块顶层只有常量和函数定义。这一条要是哪天坏了，import 会直接抛
import { magnifierTargets } from '../renderer/src/render.js'
import { magnifierDefaultTiers, sanitizeTiers, magnifierItem } from '../renderer/src/market.js'

const W = 1920
const H = 1080
const STEP = 1 / 60
const TOTAL_MINUTES = Number(process.argv[2] ?? 120)

const world = new World(W, H)

let simSec = 0
const target = TOTAL_MINUTES * 60

const marks = { egg: null, larva: null, adult: null, death: null, swarm: null, corpse: null }
let nanAt = null

const samples = []
let nextSample = 0

function fmt(sec) {
	if (sec == null) return '—'
	const m = Math.floor(sec / 60)
	return `${m}分${String(Math.floor(sec % 60)).padStart(2, '0')}秒`
}

/**
 * 每一步都检查两条不变量：
 *   1. 坐标必须是有限数（防 NaN 悄悄扩散）
 *   2. 幼虫不能跑出屏幕（它们不会飞，撞边就该掉头）
 * 成虫不查边界 —— 它们本来就允许短暂飞到屏幕外，再从对称位置回来。
 */
function checkSanity() {
	for (const [list, name] of [
		[world.flies, '成虫'],
		[world.larvae, '幼虫'],
		[world.eggs, '卵'],
		[world.remains, '残留'],
		[world.particles, '粒子'],
	]) {
		for (const e of list) {
			if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) return `${name}坐标变成 NaN`

			if (name === '幼虫') {
				const m = CONFIG.larva.margin
				if (e.x < m - 1 || e.x > W - m + 1 || e.y < m - 1 || e.y > H - m + 1) {
					return `幼虫跑出屏幕 (${e.x.toFixed(1)}, ${e.y.toFixed(1)})`
				}
			}
		}
	}
	return null
}

console.log(`模拟 ${TOTAL_MINUTES} 分钟，画布 ${W}×${H}\n`)

while (simSec < target) {
	world.update(STEP)
	simSec += STEP

	if (world.stats.eggsLaid > 0 && marks.egg == null) marks.egg = simSec
	if (world.larvae.length > 0 && marks.larva == null) marks.larva = simSec
	if (world.stats.emerged > 0 && marks.adult == null) marks.adult = simSec
	if (world.stats.deaths > 0 && marks.death == null) marks.death = simSec
	if (world.swarm.active && marks.swarm == null) marks.swarm = simSec
	if (world.remains.length > 0 && marks.corpse == null) marks.corpse = simSec

	if (nanAt == null) {
		const bad = checkSanity()
		if (bad) nanAt = { sec: simSec, kind: bad }
	}

	if (simSec >= nextSample) {
		nextSample += 10 * 60
		const c = world.counts
		samples.push(
			`  ${String(Math.round(simSec / 60)).padStart(4)}分 │ ` +
				`成虫 ${String(c.adults).padStart(3)} │ 幼虫 ${String(c.larvae).padStart(3)} │ ` +
				`卵 ${String(c.eggs).padStart(3)} │ 食物 ${c.foods}(${String(c.eating).padStart(2)}啃) │ ` +
				`残留 ${String(c.remains).padStart(4)} │ 累计死亡 ${String(c.deaths).padStart(4)}`,
		)
	}
}

// ⚠ 主干跑完了，从这儿往下全是**针对性验证**。
//
// 先把集群关掉：它是每 30~90 秒随机触发一次的世界级事件，
// 一触发就把大半屏幼虫往一个点上拽。哪个验证恰好撞上它，
// 被测的那条幼虫就被拽着走 —— 身体是弯的、头也不转向、位置也不对，
// 报出来的却是「尾巴是平的」「转弯测试没生效」这种完全误导人的理由。
// 实测每跑几次就会撞上一次（集群计时器是随机的，什么时候触发纯看运气）。
//
// 「首次集群」已经在里程碑里量过了，后面这些验证不需要它。
CONFIG.swarm.enabled = false
world.swarm.active = false

console.log('—— 里程碑 ——')
console.log(`  首次产卵      ${fmt(marks.egg)}`)
console.log(`  首条幼虫孵化  ${fmt(marks.larva)}`)
console.log(`  首只成虫羽化  ${fmt(marks.adult)}`)
console.log(`  首次死亡      ${fmt(marks.death)}`)
console.log(`  首次集群      ${fmt(marks.swarm)}`)
console.log('')

console.log('—— 种群曲线 ——')
console.log(samples.join('\n'))
console.log('')

// ---------------------------------------------------------------- 食物验证
console.log('—— 食物验证 ——')

let foodProblems = []
{
	// 清场，只留一圈幼虫，验证「闻着味自己爬过去啃」这条链路
	world.flies.length = 0
	world.eggs.length = 0
	world.larvae.length = 0
	world.remains.length = 0
	world.foods.length = 0

	// ⚠ 尺寸同样**钉死**。下面「20 分钟内被啃光」那条窗口、
	//   `minMinutes` 那个理论下限、还有「趴在离圆心多远」的判据，
	//   全都是按一个固定量级的果子调出来的；尺寸随机的话它们会一起失效
	const BAIT_SIZE = 30
	const bait = world.addFood(W / 2, H / 2, 'apple', BAIT_SIZE)
	// ⚠ 起跑半径必须落在**每只**幼虫都闻得到的范围内。
	//
	// 每只的嗅觉半径是 scentRadius × 自己的 scentGain（0.65~1.35），
	// 所以最迟钝的那只能闻到 170×0.65 ≈ 110px。原来写死 150px —— 那已经在那只的
	// 范围之外了，它只能靠随机游走瞎撞。撞不撞得上纯看运气：
	// 实测同一份代码连跑五次，峰值趴在上面的只数是 1 / 1 / 11 / 12 / 4，
	// 有两次根本「没有任何幼虫找到食物」，而机制本身完全正常。
	// 取最小嗅觉半径的 0.85 倍，留一点余量
	const RING = Math.round(CONFIG.food.scentRadius * CONFIG.food.scentGainMin * 0.85)
	for (let i = 0; i < 12; i++) {
		const a = (i / 12) * TAU
		world.addLarva(W / 2 + Math.cos(a) * RING, H / 2 + Math.sin(a) * RING)
	}

	const remainsAtStart = world.remains.length
	let peakEaters = 0
	let spreadAtPeak = 0
	let t = 0
	// 统计「啃食时离食物中心多远」——这一条守的是「幼虫趴在外围，不在圆心」。
	// 只在峰值那一刻量是不够的：那时候它们可能还在往里挤
	let eatRadiusSum = 0
	let eatRadiusN = 0

	// —— 先空跑 3 秒，确认「闻」这个动作真的会发生 ——
	//
	// ⚠ 这一条守的是**单位错误**，而且它值得单独守：
	// 起跑时所有幼虫都在自己的嗅觉半径之内，所以 1.6 秒之内它们都该闻到过。
	// 曾经 sniffTimer 是毫秒、却被按秒去减 —— 「1.6 秒闻一次」变成了「1600 秒闻一次」，
	// 幼虫一生只闻到一次味道。症状极具迷惑性：看起来只是「有的找得到食物、
	// 有的找不到」，像随机性，其实是**只有初值恰好接近 0 的那几只**闻到了。
	// 不崩、不报错，只让整个觅食机制静悄悄地废掉一大半
	for (let i = 0; i < 3 * 60; i++) {
		world.update(STEP)
		t += STEP
	}
	const smelling = world.larvae.filter((l) => l.scentSpot || l.eating).length
	console.log(`  起跑 3 秒后：${smelling}/${world.larvae.length} 只已经闻到食物`)

	// 上限 20 模拟分钟：幼虫 20 分钟就进蛹期了，跑太久就测不到「吃」了
	while (!bait.depleted && t < 20 * 60) {
		world.update(1 / 60)
		t += 1 / 60

		const n = world.counts.eating
		for (const l of world.larvae) {
			if (!l.eating) continue
			eatRadiusSum += Math.hypot(l.x - bait.x, l.y - bait.y)
			eatRadiusN++
		}
		if (n > peakEaters) {
			peakEaters = n
			// 顺便记下这一刻它们离食物中心平均多远。
			// 如果都拿圆心当目标，这个数会接近 0 —— 一堆幼虫叠在正中央，很丑。
			const eaters = world.larvae.filter((l) => l.eating)
			spreadAtPeak = eaters.reduce((sum, l) => sum + Math.hypot(l.x - bait.x, l.y - bait.y), 0) / eaters.length
		}
	}

	// 理论最短耗时：一次最多 maxEaters 只同时消耗，每只独吞要 larvaMealTime。
	//
	// ⚠ maxEaters 现在是**每份食物各自的**（= size × eatersPerSize），
	// 不再是 CONFIG.food 上的常数。读错了会得到 undefined，
	// 于是 minMinutes 是 NaN、下面 `t/60 < NaN*0.85` 是 false ——
	// **上限完全失效也不会报错**。所以先确认它是个有效的正数
	const maxEaters = bait.maxEaters
	if (!(maxEaters > 0)) {
		foodProblems.push(`Food.maxEaters 不是有效正数（${maxEaters}）—— 上限断言会静悄悄地恒通过`)
	}
	const minMinutes = CONFIG.food.larvaMealTime / MIN / Math.max(1, maxEaters)

	const eatRadius = eatRadiusSum / Math.max(1, eatRadiusN)
	const eatRing = eatRadius / bait.size // 折算成「体长的几倍」，和 config 的 restRing 同一把尺子

	console.log(`  12 只幼虫围在 ${RING}px 外，一份苹果`)
	if (smelling < 10) {
		foodProblems.push(`起跑 3 秒后只有 ${smelling}/12 只闻到食物 —— 嗅觉的间歇采样没在跑，先查 sniffTimer 的单位（毫秒 vs 秒）`)
	}
	console.log(
		`  ${(t / 60).toFixed(1)} 分钟后被啃光；峰值 ${peakEaters} 只趴在上面，` +
			`但这颗果子（size ${bait.size.toFixed(0)}）能同时供 ${maxEaters} 只真的进食`,
	)
	console.log(`  理论最短耗时 ${minMinutes.toFixed(1)} 分钟 —— 实际耗时明显长于它就说明上限生效了`)
	console.log(
		`  幼虫在果实上的落点：平均离中心 ${spreadAtPeak.toFixed(1)}px（果子半径约 ${(bait.size / 2).toFixed(0)}px）；` +
			`全程平均 ${eatRadius.toFixed(1)}px = size×${eatRing.toFixed(2)}（配置 restRing ${CONFIG.food.restRing}）`,
	)

	// 「趴在外围、不在圆心」——这是「远看像一排钟点数字」那个反馈的解药。
	// 上限定在 size×0.2 是为了挡住「又退回圆心」，实际值约 0.39
	if (eatRadiusN > 600 && eatRing < 0.2) {
		foodProblems.push(`幼虫啃食时平均只离食物中心 size×${eatRing.toFixed(2)}，又挤回圆心了 —— 检查 food.restRing / munchRadius`)
	}
	console.log(`  残留物 ${remainsAtStart} → ${world.remains.length}（啃光后留下 ${world.remains.length - remainsAtStart} 块）`)

	if (peakEaters === 0) foodProblems.push('没有任何幼虫找到食物 —— 检查 food.scentRadius / eatRadius')
	// 全都挤在圆心说明落点逻辑退化了（比如误把食物中心当目标）
	if (peakEaters > 2 && spreadAtPeak < bait.size * 0.12) {
		foodProblems.push(`幼虫全挤在食物圆心（平均只离中心 ${spreadAtPeak.toFixed(1)}px），落点没有分散`)
	}
	if (!bait.depleted) foodProblems.push('20 分钟内没被啃光 —— 检查 food.larvaMealTime')
	// 这条才是真正验证 maxEaters 的：12 只一起上的话耗时应该接近 minMinutes/2
	if (bait.depleted && t / 60 < minMinutes * 0.85) {
		foodProblems.push(`被啃得太快（${(t / 60).toFixed(1)} 分 < ${minMinutes.toFixed(1)} 分），maxEaters 上限没生效`)
	}
	if (bait.depleted && world.remains.length <= remainsAtStart) foodProblems.push('啃光后没有留下污渍')

	// —— 挤不进去的幼虫要让位 ——
	//
	// 需求是「一份食物每 1px 只能有 1 只幼虫进食，没有进食空间的则到处移动」。
	// 前半句好写，**后半句才是容易漏的那一半**：光在 world._updateFeeding 里
	// 判定「超额的吃不到营养」，不给它们解挂的话，多出来的幼虫照样物理趴在
	// 果子上（eating 为 null，但身体还叠在那儿）—— 看起来依旧是一坨糊着，
	// 玩家完全看不出上限存在。这个断言就是钉死后半句。
	//
	// ⚠ 正常模式下这份上限（size×2 = 38~60）永远大过全场幼虫上限（40 上下），
	//   在游戏里根本触发不到。所以这里**临时把系数压小**逼出拥挤场景，
	//   测完立刻还原 —— 不改的话后面所有小节都会跟着变。
	const savedPerSize = CONFIG.food.eatersPerSize
	CONFIG.food.eatersPerSize = 0.25
	// ⚠ 必须**清干净**：不清成虫的话它们会来啃同一份食物、把营养吃光；
	//   不清卵的话 90 秒里会陆续孵出新的幼虫混进来，而下面数的是
	//   `world.larvae` 全体，新孵的那批会把「爬走了几只」这个数字搅乱。
	//   这条断言要的是**受控**的 30 只，不是「当时屏幕上碰巧有几只」
	world.larvae.length = 0
	world.foods.length = 0
	world.flies.length = 0
	world.eggs.length = 0
	// ⚠ 尺寸**必须钉死**。食物的 size 现在是 24~200 之间随机抽的（越大概率越小），
	//   而这条断言量的是「还贴在果子上的有几只」，那个数**天然随果子面积涨** ——
	//   果子越大，munchRadius 圈住的面积越大，随机游走经过的幼虫就越多。
	//   用随机尺寸的话，同一套代码会这次抽到 24（过）、下次抽到 90（红），
	//   而红的时候看起来像「解挂坏了」，实际上只是这次抽到了一个大果子。
	//   30 是老尺寸区间的上沿，这条断言的所有阈值都是照那个量级调出来的
	const CROWD_SIZE = 30
	const crowded = world.addFood(500, 400, 'apple', CROWD_SIZE)
	const CROWD_N = 30
	for (let i = 0; i < CROWD_N; i++) {
		const a = (i / CROWD_N) * TAU
		world.addLarva(crowded.x + Math.cos(a) * crowded.size * 0.8, crowded.y + Math.sin(a) * crowded.size * 0.8, null, 0)
	}
	const crowdCap = crowded.maxEaters
	if (!(crowdCap > 0 && crowdCap < CROWD_N)) {
		foodProblems.push(`挤食测试的前提没成立：上限 ${crowdCap} 不小于放进去的 ${CROWD_N} 只，这个断言会恒通过`)
	}
	// 跑 90 秒：给被挤出来的足够时间爬开，别拿开局那一瞬间说事
	for (let i = 0; i < 60 * 90; i++) world.update(1 / 60)
	const attached = world.larvae.filter((l) => l.eating).length
	const fedNow = world.larvae.filter((l) => l.ateLastTick).length
	// 判据取 size×1.5 而不是 munchRadius（0.82）—— 幼虫是**撒在** size×0.8 那一圈上的，
	// 拿 0.82 当线等于在量出生点，压根没量到「有没有爬走」
	const strayed = world.larvae.filter((l) => Math.hypot(l.x - crowded.x, l.y - crowded.y) > crowded.size * 1.5).length
	console.log(
		`  ${CROWD_N} 只幼虫围一份 size ${crowded.size.toFixed(0)} 的苹果（上限压到 ${crowdCap}）：` +
			`${attached} 只趴着进食、${strayed} 只爬到果子外面去了`,
	)
	// ⚠ attached 允许**暂时**超员 2 只。座位是在 Larva.update 里认的，
	//   而 food.eaters 要等这一帧末尾的 _updateFeeding 才重算 ——
	//   于是同一帧里好几只幼虫会读到同一个偏旧的计数、一起坐下，
	//   下一帧才发现超了、再被赶走。实测 90 秒里 attached 在 cap~cap+1 之间抖，
	//   卡死成 `attached > cap` 会随机红
	if (attached > crowdCap + 2) {
		foodProblems.push(`${attached} 只同时趴在食物上，远超上限 ${crowdCap} —— seated 判定没拦住`)
	}
	// 这条才是硬不变量：真正吃到营养的绝不可能超过配额
	if (fedNow > crowdCap) {
		foodProblems.push(`${fedNow} 只同时吃到营养，超过上限 ${crowdCap} —— _updateFeeding 的配额没生效`)
	}
	if (attached < 1) {
		foodProblems.push('一只都没趴上去 —— 上限压过头了，不是挤食而是禁止进食')
	}
	// 这一条才是「到处移动」：超额的那些必须真的**离开果子**，不能只是不吃还赖着。
	//
	// ⚠ **不要**拿「爬出 size×1.5 以外的只数」当判据。那量的是随机游走的
	//   **净位移**，本质上是个噪声量 —— 实测同一套代码、同样 90 秒，
	//   12 组里能从 4 只波动到 25 只（超额的期望是 23~25）。
	//   150 秒反而更差（5~22），因为跑得越久，组队把散开的又聚回去了。
	//   卡死那个数字的话，这条断言会稳定地每几次红一次，
	//   而红的时候看起来像「解挂没做」，实际上只是那次随机游走没走远。
	//
	// 改成量**「还贴在果子上的有几只」**：这个数直接对应玩家看到的画面
	// （糊成一坨），而且有个很宽的安全区 —— 修好之后实测 5~12 只，
	// 没修的时候是满员 30 只。
	const munchR = crowded.size * CONFIG.food.munchRadius
	const inMunch = world.larvae.filter((l) => Math.hypot(l.x - crowded.x, l.y - crowded.y) <= munchR).length
	if (inMunch > CROWD_N * 0.6) {
		foodProblems.push(
			`还有 ${inMunch}/${CROWD_N} 只幼虫物理上贴在果子上（上限只有 ${crowdCap} 个座位）—— ` +
				'挤不进去的没有散开（查 Larva.update 的 seated / crowdedAt）',
		)
	}
	console.log(`  其中 ${inMunch} 只仍然贴在果子范围内（${strayed} 只已爬到 size×1.5 之外）`)
	CONFIG.food.eatersPerSize = savedPerSize
	world.larvae.length = 0
	world.foods.length = 0

	// —— 尺寸分布：两段 ——
	//
	// ⚠ 抽的是 rollFoodSize() **本身**，不是 new Food().size。
	//   造六千个 Food 只会白白搭上 durability / nutrition 那些字段，
	//   还会让人以为「被测的是食物对象」—— 被测的是分布
	//
	// ⚠ 判据全是**统计量**，不是「看着像不像」。四个数各自守一件事：
	//     ① 段占比   —— 「正常占 95%」这一条本身
	//     ② 两段的区间 —— 不许越界，也不许 30~31 之间有空隙
	//     ③ 巨型段内的偏斜 —— 用 u³ 的均值（均匀时是 0.5，三次方后是 0.25）
	//     ④ 巨型确实罕见 —— 上一条只在「巨型够多」时才有意义
	{
		const N = 6000
		const F = CONFIG.food
		const sizes = []
		for (let i = 0; i < N; i++) sizes.push(rollFoodSize())

		const lo = F.sizeMin
		const hi = F.sizeMax
		const split = F.sizeNormalMax
		const giantLo = split + 1

		const outOfRange = sizes.filter((s) => !(s >= lo && s <= hi)).length
		if (outOfRange) foodProblems.push(`有 ${outOfRange}/${N} 份食物的尺寸落在 ${lo}~${hi} 之外`)

		// ① 段占比
		const normal = sizes.filter((s) => s <= split)
		const share = normal.length / N
		// 理论 95%，N=6000 时标准差约 0.28%，所以 ±1.5% 相当于 5 个标准差
		if (Math.abs(share - F.sizeNormalChance) > 0.015) {
			foodProblems.push(
				`正常尺寸（${lo}~${split}px）占了 ${(share * 100).toFixed(1)}%，` +
					`配置写的是 ${(F.sizeNormalChance * 100).toFixed(0)}%`,
			)
		}

		// ② 两段之间既不能有空洞，也不能重叠
		const hole = sizes.filter((s) => s > split && s < giantLo).length
		if (hole) foodProblems.push(`有 ${hole} 份食物的尺寸落在 ${split}~${giantLo} 之间 —— 两段分布之间有空隙`)
		const overlap = normal.filter((s) => s < lo).length
		if (overlap) foodProblems.push(`有 ${overlap} 份正常果子小于下限 ${lo}`)

		// ③ 巨型段内**越大越少**。
		//
		// ⚠ 这里比的是 `u³` 的均值而不是尺寸本身：抽法是 31 + 169·u^sizeBias，
		//   均匀（sizeBias = 1）时 u 的均值是 0.5，三次方之后是 **0.25**。
		//   直接比尺寸的均值也能测，但那个数同时受区间和偏斜影响，
		//   红的时候分不清是哪一边错了
		const giants = sizes.filter((s) => s >= giantLo)
		if (giants.length < 100) {
			foodProblems.push(`6000 次里只抽到 ${giants.length} 个巨型 —— 占比太低，下一条偏斜断言测不准`)
		} else {
			const meanU3 = giants.reduce((a, s) => a + (s - giantLo) / (hi - giantLo), 0) / giants.length
			// 三次方时理论 0.25，标准差约 0.016；±0.08 相当于 5 个标准差，
			// 而均匀分布（0.5）离得远得多，一定会被这条抓住
			if (!(meanU3 < 0.33)) {
				foodProblems.push(
					`巨型段里 u³ 的均值是 ${meanU3.toFixed(3)}（越小越偏小端）—— ` +
						`按 sizeBias=${F.sizeBias} 应当是 0.25 上下，接近 0.5 说明巨型段退化成均匀分布了`,
				)
			}
		}

		const biggest = Math.max.apply(null, sizes)
		const smallest = Math.min.apply(null, sizes)
		console.log(
			`  尺寸分布：正常 ${lo}~${split}px 占 ${(share * 100).toFixed(1)}%` +
				`（配置 ${(F.sizeNormalChance * 100).toFixed(0)}%），巨型 ${giantLo}~${hi}px 越大越少` +
				`（bias ${F.sizeBias}）；6000 次实测 ${smallest.toFixed(0)}~${biggest.toFixed(0)}px` +
				`，巨型 ${giants.length} 个`,
		)
	}

	// —— 耐用性：1 ~ durabilityMax 倍 ——
	//
	// ⚠ 这是「最高 20 倍」**唯一**的机器检查。别的地方都只是读这同一个字段，
	//   所以插值写错了不会有第二条断言兜住
	{
		const MAX = CONFIG.food.durabilityMax
		const small = new Food(0, 0, 'apple', CONFIG.food.sizeMin)
		const large = new Food(0, 0, 'apple', CONFIG.food.sizeMax)

		if (Math.abs(small.durability - 1) > 1e-9) foodProblems.push(`最小的果子耐用度是 ${small.durability}，应当是 1`)
		if (Math.abs(large.durability - MAX) > 1e-9) foodProblems.push(`最大的果子耐用度是 ${large.durability}，应当是 ${MAX}`)

		// 中间线性：正中尺寸应当正好是 (1+MAX)/2
		const midFood = new Food(0, 0, 'apple', (CONFIG.food.sizeMin + CONFIG.food.sizeMax) / 2)
		if (Math.abs(midFood.durability - (1 + MAX) / 2) > 1e-9) {
			foodProblems.push(`中型果子的耐用度是 ${midFood.durability}，按线性插值应当是 ${(1 + MAX) / 2}`)
		}
		// 单调
		if (!(large.durability > small.durability)) foodProblems.push('果子越大耐用度反而没有更高')

		// 单调性抽样：尺寸递增时 durability 不能有回落
		let lastDur = -Infinity
		for (let s = CONFIG.food.sizeMin; s <= CONFIG.food.sizeMax; s += 4) {
			const d = new Food(0, 0, 'apple', s).durability
			if (!(d >= lastDur)) {
				foodProblems.push(`尺寸 ${s} 处的耐用度比更小的果子还低（${lastDur} → ${d}）`)
				break
			}
			lastDur = d
		}

		// nutrition 的**初值**就是 durability（不是 1）
		if (Math.abs(large.nutrition - MAX) > 1e-9) {
			foodProblems.push(`大果子刚放下时 nutrition 是 ${large.nutrition}，应当等于耐用度 ${MAX}`)
		}
		console.log(
			`  耐用性：${CONFIG.food.sizeMin}px → 1× · ${CONFIG.food.sizeMax}px → ${MAX}×` +
				`（一只幼虫独吞要 ${((CONFIG.food.larvaMealTime / MIN) * MAX).toFixed(0)} 分钟）`,
		)

		// —— eaten 必须落在 0~1，而且**永远不为负** ——
		//
		// ⚠ 这条守的是渲染那个坑：`drawFood` 读的是 `f.eaten`，
		//   要是有人改回 `1 - f.nutrition`，大果子会得到 -19，
		//   被画成 5 倍大。**小果子上两者恰好相等，所以这个错只在
		//   200px 的果子上爆**，拿小果子测是测不出来的
		if (Math.abs(large.eaten) > 1e-9) foodProblems.push(`刚放下的大果子 eaten 是 ${large.eaten}，应当是 0`)
		large.nutrition = large.durability / 2
		if (Math.abs(large.eaten - 0.5) > 1e-9) foodProblems.push(`啃掉一半时 eaten 是 ${large.eaten}，应当是 0.5`)
		large.nutrition = 0
		if (Math.abs(large.eaten - 1) > 1e-9) foodProblems.push(`啃光时 eaten 是 ${large.eaten}，应当是 1`)
		// 重新造一份完好的来查「不会为负」——上面那份已经被掏空了
		const freshBig = new Food(0, 0, 'apple', CONFIG.food.sizeMax)
		if (freshBig.eaten < 0) {
			foodProblems.push(`完好的大果子 eaten 是 ${freshBig.eaten}（负数）—— 多半是把 1 - nutrition 当成了进度`)
		}
	}

	// —— 啃光之后的污渍要有尺寸上限 ——
	//
	// 200px 的果子按线性算会留下 124px 的污渍，比工具栏面板还大
	{
		const wS = new World(W, H)
		wS.reset()
		wS.foods.length = 0
		wS.remains.length = 0
		const big = wS.addFood(600, 400, 'apple', CONFIG.food.sizeMax)
		big.nutrition = 0
		wS._updateFood(16)

		const fresh = wS.remains.filter((r) => r.kind === 'stain')
		const biggest = fresh.reduce((m, r) => Math.max(m, r.size), 0)
		if (fresh.length !== CONFIG.food.huskStains) {
			foodProblems.push(`一份果子啃光后留下了 ${fresh.length} 块污渍，应当是 ${CONFIG.food.huskStains} 块`)
		}
		if (biggest > CONFIG.food.stainMaxSize + 1e-6) {
			foodProblems.push(
				`最大的果子留下了 ${biggest.toFixed(0)}px 的污渍，超过上限 ${CONFIG.food.stainMaxSize} —— 会糊掉半个屏`,
			)
		}
		console.log(`  ${CONFIG.food.sizeMax}px 的果子啃光：留下 ${fresh.length} 块污渍，最大 ${biggest.toFixed(0)}px`)
	}

	// —— 喷水枪 ——
	//
	// ⚠ 这条守两件事：① 线段命中的是**线段**（不是端点、不是圆）
	//   ② 它**只**冲可清洁物，别的一律不碰
	{
		const wQ = new World(W, H)
		wQ.reset()
		wQ.remains.length = 0
		wQ.shells.length = 0
		wQ.foods.length = 0
		wQ.larvae.length = 0
		wQ.flies.length = 0
		wQ.eggs.length = 0

		// 线段：水平，从 (300, 500) 到 (700, 500)，中点 (500, 500)
		const X1 = 300
		const Y1 = 500
		const X2 = 700
		const Y2 = 500

		// —— 线上的：三类残留物各一 + 蛹壳 ——
		const onLine = [
			wQ.addRemains(500, 500, 'stain', 14, 0), // 正中
			wQ.addRemains(340, 500, 'corpse', 14, 0), // 靠左端
			wQ.addRemains(660, 500, 'grub', 14, 0), // 靠右端
		]
		const shell = wQ.addShell(420, 500, 0, 12, 1, 0.5)

		// —— 线外的：同一批东西挪出去一点，必须原封不动 ——
		const offLine = [
			wQ.addRemains(500, 560, 'stain', 14, 0), // 垂直方向 60px
			wQ.addRemains(180, 500, 'corpse', 14, 0), // 线段的延长线上、但在端点之外
			wQ.addRemains(820, 500, 'grub', 14, 0), // 同上，另一头
		]
		const shellOff = wQ.addShell(500, 560, 0, 12, 1, 0.5)

		// —— 绝对不该被冲掉的 ——
		const food = wQ.addFood(500, 500, 'apple', 30)
		const larva = wQ.addLarva(500, 520, null, 0)
		const fly = wQ.addFly(500, 480, 'F')

		const cleaned = wQ.squirt(X1, Y1, X2, Y2)

		if (cleaned !== onLine.length + 1) {
			foodProblems.push(`喷水枪冲掉了 ${cleaned} 件，线上应当有 ${onLine.length + 1} 件（3 残留 + 1 蛹壳）`)
		}
		for (const r of onLine) {
			if (r && !r.dead) foodProblems.push(`线段穿过了一具 ${r.kind} 却没冲掉`)
		}
		if (shell && !shell.dead) foodProblems.push('线段穿过蛹壳却没冲掉')
		for (const r of offLine) {
			if (r && r.dead) foodProblems.push(`线段外的 ${r.kind} 被冲掉了 —— 判定没有贴着线段走`)
		}
		if (shellOff && shellOff.dead) foodProblems.push('线段外的蛹壳被冲掉了')
		if (food && food.dead) foodProblems.push('喷水枪把食物冲掉了 —— 它只该冲可清洁物')
		if (larva && larva.dead) foodProblems.push('喷水枪把幼虫冲掉了')
		if (fly && fly.dead) foodProblems.push('喷水枪把成虫冲掉了')

		// 线段**两头**都要算命中（用户定的是「以指针为中心向两头」）——
		// 只判一端的话，中线那一侧的断言会漏掉一半
		wQ.remains.length = 0
		const leftHalf = wQ.addRemains(320, 500, 'stain', 14, 0)
		const rightHalf = wQ.addRemains(680, 500, 'stain', 14, 0)
		wQ.squirt(X1, Y1, X2, Y2)
		if (leftHalf && !leftHalf.dead) foodProblems.push('线段左半边的东西没被冲掉 —— 只判了右半段')
		if (rightHalf && !rightHalf.dead) foodProblems.push('线段右半边的东西没被冲掉')

		// wipeTrail 是抹布的拖尾，不是可清洁物，不该被碰
		wQ.wipeTrail.length = 0
		wQ.wipeTrail.push({ x: 500, y: 500, life: 0.4 })
		wQ.squirt(X1, Y1, X2, Y2)
		if (wQ.wipeTrail.length !== 1) foodProblems.push('喷水枪把抹布的拖尾也清了 —— 那是纯表现，不是可清洁物')

		console.log(
			`  喷水枪：一条 ${X1},${Y1} → ${X2},${Y2} 的水线冲掉 ${cleaned} 件；` +
				`线外的 3 件残留 + 1 个壳、以及食物 / 幼虫 / 成虫全部无恙`,
		)
	}

	// —— 成虫被烂果子吸引 ——
	// 注意必须放在 flyScentRadius 之内，否则测的是「闻不到的果蝇」，毫无意义
	world.larvae.length = 0
	world.foods.length = 0
	const rotten = world.addFood(400, 300, 'banana')
	if (rotten) {
		// 催熟：rot 每帧从 age 推导，直接给 rot 赋值会被立刻覆盖，要改 age
		rotten.age = CONFIG.food.rotTime * 0.9
		world.flies.length = 0

		const R = CONFIG.food.flyScentRadius * 0.9
		for (let i = 0; i < 6; i++) {
			const a = (i / 6) * TAU
			world.addFly(rotten.x + Math.cos(a) * R, rotten.y + Math.sin(a) * R, i % 2 ? 'F' : 'M')
		}

		const avgDist = () =>
			world.flies.reduce((sum, f) => sum + Math.hypot(f.x - rotten.x, f.y - rotten.y), 0) / world.flies.length

		const d0 = avgDist()
		// 量的是**全程最近**的那一次平均距离，不是 90 秒后的终值。
		//
		// ⚠ 终值是一个很差的判据：果蝇在果子上吃够就会起飞，而
		// `justArrived` 只在**刚飞进落点半径**那一帧为真 —— 起飞之后要是没离开
		// 那个半径，就不会再落回去了。于是它飞走、终值回升，
		// 哪怕招蝇机制完全正常也会「失败」。
		// 实测终值在 89~541px 之间乱跳，两条断言里就有一条是误报。
		// 「全程最近」问的才是这条机制真正该回答的问题：它们有没有被吸过来过
		let dMin = d0
		for (let i = 0; i < 90 * 60; i++) {
			world.update(1 / 60)
			if (i % 30 === 0) dMin = Math.min(dMin, avgDist())
		}
		const d1 = avgDist()

		console.log(
			`  烂苹果屑招蝇：起始平均 ${d0.toFixed(0)}px（嗅觉半径 ${CONFIG.food.flyScentRadius}px）` +
				`→ 全程最近 ${dMin.toFixed(0)}px，90 秒后 ${d1.toFixed(0)}px`,
		)
		// 门槛定在「至少靠近一半」。飞行速度提到 1700px/s 之后，
		// 光靠飞行时的方向偏转已经抓不住它们了 —— 真正起作用的是
		// 「飞到果子跟前就落下来」，所以这条同时也在守着那个机制。
		if (dMin >= d0 * 0.5) {
			foodProblems.push(`成虫没有明显靠近过食物（${d0.toFixed(0)} → 最近才 ${dMin.toFixed(0)}px）—— 检查 behavior.landChanceNearFood 和 _updateMode 里的「刚飞到」判定`)
		}
	}

	// —— 落点：必须在**果子跟前**落地，不能在半路上就落下来走过去 ——
	//
	// 用户报过「果蝇去觅食怎么全程都是走过去的」。根因是落地那次掷骰挂在
	// 「刚闻到味道」那一帧上，而那一刻正是离果子**最远**的地方
	// （嗅觉半径 600px）—— 实测 100% 的个体都在 520~600px 处落地，
	// 然后按 58px/s 爬 10 秒才到。
	//
	// ⚠ 这条和上面那条是**互补的，不能互相替代**：上面问「有没有被吸引过去」，
	//   这条问「是被吸引飞的、还是自己走过去的」。
	//   只有上面那条的话，把落地半径改回 600px 照样全绿。
	world.larvae.length = 0
	world.foods.length = 0
	world.flies.length = 0
	world.eggs.length = 0
	const landingDist = []
	let neverLanded = 0
	const probeFood = world.addFood(960, 540, 'apple', 40)
	if (probeFood) {
		probeFood.age = CONFIG.food.rotTime // rot 是 getter，要催熟只能改 age
		const TRIES = 40
		for (let i = 0; i < TRIES; i++) {
			world.flies.length = 0
			const a = (i / TRIES) * TAU
			const f = world.addFly(960 + Math.cos(a) * 900, 540 + Math.sin(a) * 900, 'M', 'normal')
			// 石化蝇飞不起来，量不了「飞过去」这件事，跳过
			if (!f || !f.canFly) continue
			// 钉住飞行状态：不钉的话它可能一开局就掷中「落地」，
			// 量到的就不是「飞到跟前才落」，而是「随机落地」
			f.mode = 'fly'
			f.modeTimer = 1e9
			f.dartTimer = 1e9
			f.hoverTimer = 0
			f.aim = Math.atan2(540 - f.y, 960 - f.x)

			let at = null
			for (let t = 0; t < 900; t++) {
				const before = f.mode
				f.update(1000 / 60, world)
				// 只看**第一次**从飞切到走的那一刻 —— 之后在果子上起起落落都不算
				if (before === 'fly' && f.mode === 'walk') {
					at = Math.hypot(f.x - 960, f.y - 540)
					break
				}
			}
			if (at == null) neverLanded++
			else landingDist.push(at)
		}
	}
	landingDist.sort((x, y) => x - y)
	const medLand = landingDist.length ? landingDist[(landingDist.length / 2) | 0] : NaN
	// ⚠ 判据是**落地之后还要走几秒**，不是「离食物多少 px」——
	//   玩家抱怨的本来就是「全程走过去」，直接量那件事花多久最贴题。
	//
	// ⚠⚠ 门槛**绝对不能**写成 `foodLandRadius × 常数`。第一版就是那么写的，
	//   结果把落点半径调回 600px（= 复现旧行为）之后断言跟着放宽，照样全绿 ——
	//   自己证明自己，等于没测。这里锚在**爬行速度**上，
	//   和落点半径、嗅觉半径都无关
	const walkSec = medLand / CONFIG.walk.speed
	console.log(
		`  落地点：中位 ${Number.isFinite(medLand) ? medLand.toFixed(0) : '—'}px` +
			`（落地半径 ${CONFIG.behavior.foodLandRadius}px、嗅觉半径 ${CONFIG.food.flyScentRadius}px），` +
			`落地后还要爬 ${Number.isFinite(walkSec) ? walkSec.toFixed(1) : '—'} 秒`,
	)
	if (!Number.isFinite(medLand)) {
		foodProblems.push(`40 次尝试里没有一只在飞行途中落地（${neverLanded} 次没落）—— 落点断言量不到东西`)
	} else if (walkSec > 3) {
		foodProblems.push(
			`果蝇平均在离食物 ${medLand.toFixed(0)}px 的地方就落地了，落地后还要爬 ${walkSec.toFixed(1)} 秒 —— ` +
				`看着就是「一路走过去」。检查 _updateMode 里判的是不是 foodLandRadius`,
		)
	}

	// —— 拖走食物：幼虫的反应必须是**散开**的，不能同一帧集体掉头 ——
	//
	// 这是玩家能直接看见的一条：以前每帧都把食物的当前位置喂给每只幼虫，
	// 于是拖动食物的那一瞬间，半径内所有幼虫在同一帧一起转向，
	// 像一群被同一根线牵着的木偶。
	// 现在嗅觉是间歇采样的（food.sniffMin/Max），每只幼虫按自己的节奏
	// 重新闻到、各自掉头，反应时间自然就散开了。
	world.larvae.length = 0
	world.foods.length = 0
	world.flies.length = 0
	world.eggs.length = 0
	// 集群会把幼虫往一个点上拽，和这里要测的「朝哪儿爬」混在一起，先关掉
	CONFIG.swarm.enabled = false
	world.swarm.active = false

	const HOME = { x: 600, y: 600 }
	const bait2 = world.addFood(HOME.x + 100, HOME.y, 'apple')
	const N = 12
	for (let i = 0; i < N; i++) world.addLarva(HOME.x + rand(-6, 6), HOME.y + rand(-6, 6))

	// 先让它们闻到、并朝东边爬一会儿，这样每只都已经锁定了一个目标方向
	for (let i = 0; i < 3 * 60; i++) world.update(STEP)

	// 食物从「正东 100px」跳到「正北 100px」—— 需要的朝向整整转了 90°。
	// 位移刻意压在嗅觉半径之内（170 × 最小灵敏度 0.65 ≈ 110px），
	// 这样「没反应」只可能来自间歇采样，不会是因为闻不到
	bait2.x = HOME.x + 20
	bait2.y = HOME.y - 100

	const before = world.larvae.map((l) => l.angle)
	const turnedAt = new Array(world.larvae.length).fill(-1)

	for (let f = 0; f < 10 * 60 && turnedAt.some((v) => v < 0); f++) {
		world.update(STEP)
		for (let i = 0; i < world.larvae.length; i++) {
			if (turnedAt[i] >= 0) continue
			// 朝向偏了 0.2 弧度以上 = 它真的开始掉头了
			const d = Math.abs(
				Math.atan2(Math.sin(world.larvae[i].angle - before[i]), Math.cos(world.larvae[i].angle - before[i])),
			)
			if (d > 0.2) turnedAt[i] = f
		}
	}

	const times = turnedAt.filter((v) => v >= 0).map((v) => v / 60)
	const never = turnedAt.filter((v) => v < 0).length
	const tMin = Math.min(...times)
	const tMax = Math.max(...times)
	const sameFrame = times.filter((t) => t <= 2 / 60).length

	console.log(
		`  拖走食物（正东 100px → 正北 100px）：${N - never}/${N} 只掉头，` +
			`最快 ${tMin.toFixed(2)}s / 最慢 ${tMax.toFixed(2)}s，${sameFrame} 只在头两帧就转了`,
	)

	if (never > N * 0.25) {
		foodProblems.push(`拖走食物后有 ${never}/${N} 只幼虫一直没掉头 —— 检查食物是不是跳出了它们的嗅觉半径`)
	}
	if (tMax - tMin < 0.4) {
		foodProblems.push(`幼虫几乎同时掉头（反应时间只差 ${(tMax - tMin).toFixed(2)}s）—— 间歇采样没生效，检查 food.sniffMin/Max`)
	}
	// 头两帧就转 = 它压根没等下一次「闻」，还在被实时喂食
	if (sameFrame > N * 0.4) {
		foodProblems.push(`有 ${sameFrame}/${N} 只幼虫在拖动的瞬间就掉头了 —— 嗅觉又变回每帧实时跟随了`)
	}
	CONFIG.swarm.enabled = true
}
console.log('')

// ---------------------------------------------------------------- 产卵验证
console.log('—— 产卵验证 ——')

const layProblems = []
{
	world.flies.length = 0
	world.larvae.length = 0
	world.eggs.length = 0
	world.foods.length = 0
	world.remains.length = 0

	const female = world.addFly(500, 500, 'F')
	const male = world.addFly(540, 500, 'M') // 放在 seekRadius 内，应当立刻配对

	// 必须直接催熟：新孵出的果蝇要 20 秒才性成熟，
	// 而按现在的飞行速度，它们 20 秒里早就飞出几百像素散开了。
	female.age = CONFIG.adult.matureAge + 1000
	male.age = CONFIG.adult.matureAge + 1000

	let sawLaying = false
	let maxJump = 0 // 单帧最多同时出现几颗卵
	let lastEggs = 0
	let t = 0
	// 进入产卵那一刻她的速度。判定「溜出去多远算正常」必须用这个，
	// 不能用固定阈值 —— 理由见下面 driftLimit 那段注释
	let entrySpeed = 0

	// 关键：距离必须在「卵落下的那一刻」量。
	// 产完卵母体就飞走了，拿卵和 30 秒后她的位置比，量到的是她飞了多远，不是卵散得多开。
	const eggDists = []
	let firstLayPos = null
	let lastLayPos = null
	// 每颗卵的「逐颗抖动」还原值，见下面统计那一节
	const jitters = []
	const noteEgg = () => {
		const fresh = world.eggs[world.eggs.length - 1]
		if (!fresh) return
		eggDists.push(Math.hypot(fresh.x - female.x, fresh.y - female.y))
		// scale = layScale × jitter → 一除就把「这一窝偏大还是偏小」的母体个性消掉了
		jitters.push(fresh.scale / female.layScale)
	}

	while (t < 30) {
		const before = world.eggs.length
		world.update(1 / 60)
		t += 1 / 60

		if (female.laying) {
			if (!sawLaying) entrySpeed = Math.hypot(female.vx, female.vy)
			sawLaying = true
			if (!firstLayPos) firstLayPos = { x: female.x, y: female.y }
			lastLayPos = { x: female.x, y: female.y }
		}

		const after = world.eggs.length
		if (after > before) {
			maxJump = Math.max(maxJump, after - before)
			noteEgg()
		}
		lastEggs = after
	}

	const eggs = world.eggs
	const sizes = eggs.map((e) => e.scale)
	const spread = eggDists.length ? eggDists.reduce((a, b) => a + b, 0) / eggDists.length : 0
	// 产卵期间母体的位移（从第一次产卵到最后一次产卵）
	const drift =
		firstLayPos && lastLayPos ? Math.hypot(lastLayPos.x - firstLayPos.x, lastLayPos.y - firstLayPos.y) : 0

	console.log(`  一雌一雄放在 40px 内 → 30 秒共产下 ${eggs.length} 颗卵`)
	console.log(`  进入过产卵状态：${sawLaying ? '是' : '否'}；单帧最多新增 ${maxJump} 颗（应为 1 = 一颗颗落）`)
	console.log(
		`  卵散落范围：平均离母体 ${spread.toFixed(1)}px（配置上限 ${CONFIG.laying.scatter}px）；` +
			`母体位移 ${drift.toFixed(0)}px（进场速度 ${entrySpeed.toFixed(0)}px/s）`,
	)
	console.log(
		eggs.length
			? `  逐颗尺寸倍率：${Math.min(...sizes).toFixed(2)} ~ ${Math.max(...sizes).toFixed(2)}（不同则说明每颗大小确实不一样）`
			: '  逐颗尺寸倍率：（无卵）',
	)

	if (!sawLaying) layProblems.push('母体没有进入产卵状态 —— 检查 _tryMate / startLaying')
	if (eggs.length < 2) layProblems.push(`30 秒只产了 ${eggs.length} 颗卵（配置是 2~6 颗）`)
	if (maxJump > 1) layProblems.push('卵是一次性全冒出来的，没有「一颗颗落」的过程')
	if (eggs.length && spread > CONFIG.laying.scatter + 6) layProblems.push('卵散得太开，不像原地产卵')
	// 「母体基本停在原地」不能用一个写死的像素阈值来判断。
	//
	// 配对扫描是在**飞行途中**发生的：她可能正以 speedMax（1700px/s）掠过，
	// 而 _lay 是靠阻力自然滑停的（settleDrag=4.5，刻意不硬把速度清零 ——
	// 那样看起来像被按了暂停键）。速度为 v 的果蝇在阻尼 k 下自然滑停的距离
	// 就是 v/k，1700/4.5 ≈ 378px。
	//
	// 所以原来那个 `drift > 120` 的固定阈值必然误报：它把「设计如此的自然滑停」
	// 判成了「母体在产卵时到处乱跑」。实测也确实如此 —— 同一份代码连跑几次，
	// 位移在 0~170px 之间跳，这个自检就变得时灵时不灵，
	// 而时灵时不灵的自检比没有自检更糟：真出问题时会被当成「又抽风了」。
	//
	// 换成按她进产卵那一刻的**实际速度**算上限，就同时抓住了两件事：
	// 滑得比阻尼允许的更远 = 有问题；进场速度很低却滑出去很远 = 也有问题。
	const driftLimit = entrySpeed / CONFIG.laying.settleDrag + 40
	if (drift > driftLimit) {
		layProblems.push(
			`母体产卵时滑了 ${drift.toFixed(0)}px，超过阻尼允许的 ${driftLimit.toFixed(0)}px（进场速度 ${entrySpeed.toFixed(0)}px/s）`,
		)
	}
	// —— 逐颗抖动 ——
	//
	// 这里**不能**只看这一窝的尺寸极差。一窝只有 2~6 颗，样本太少：
	// 「两颗碰巧差不多大」本身是完全正常的随机结果（概率有几个百分点），
	// 拿它当失败信号，每跑十几次就会误报一次。
	//
	// 所以多产几窝，并且把每颗卵的抖动**还原出来**再看整体分布 ——
	// scale = layScale × jitter，而 layScale 是那一刻母体的值，
	// 两者一除就把「这一窝偏大 / 偏小」的母体个性消掉了，剩下的纯粹是逐颗抖动。
	for (let round = 0; round < 6; round++) {
		female.cooldown = 0
		female.beginClutch(world)

		let guard = 0
		// laySite 也要等 —— beginClutch 只是挑好了地方，她还得飞过去才开始产
		while ((female.laying || female.laySite) && guard++ < 60 * 40) {
			const before = world.eggs.length
			world.update(1 / 60)
			if (world.eggs.length > before) noteEgg()
		}
		t += guard / 60
	}

	const jMin = jitters.length ? Math.min(...jitters) : 1
	const jMax = jitters.length ? Math.max(...jitters) : 1
	const jRange = jMax - jMin
	// 抖动的理论区间是 1 ± scaleJitter，也就是全宽 2×scaleJitter
	const fullRange = 2 * CONFIG.egg.scaleJitter
	console.log(
		`  逐颗抖动（${jitters.length} 颗样本）：${jMin.toFixed(3)} ~ ${jMax.toFixed(3)}，极差 ${jRange.toFixed(3)}` +
			`（理论全宽 ${fullRange.toFixed(2)}）`,
	)

	// 样本够多了，这时候极差还不到理论值的三分之一，就确实说明抖动没生效
	if (jitters.length >= 8 && jRange < fullRange / 3) {
		layProblems.push(`逐颗尺寸抖动过小（${jitters.length} 颗样本极差只有 ${jRange.toFixed(3)}）—— 检查 _lay 里的 jitter`)
	}
}
console.log('')

// ---------------------------------------------------------------- 窝（clutch）验证
console.log('—— 窝（clutch）验证 ——')

const clutchProblems = []
{
	const mother = world.flies.find((f) => f.sex === 'F' && !f.dead)
	if (!mother) {
		clutchProblems.push('场上没有可用的母体')
	} else {
		// —— 1. 同一窝的卵，孵化时间相近 ——
		world.flies.length = 0
		world.flies.push(mother)
		world.larvae.length = 0
		world.eggs.length = 0
		world.foods.length = 0
		world.remains.length = 0
		mother.cooldown = 0
		mother.age = CONFIG.adult.matureAge + 1000

		// ⚠ 要多产几窝再下结论。一窝只有 2~6 颗，只取一窝的话
		// 「两颗碰巧抖到差不多」会直接误报 —— 和上面逐颗抖动那一节是同一个道理
		const broods = []
		// 她挑好的产卵点，和实际落卵的位置之间差多远。
		// ⚠ 这一条守的是「进场减速」：没有减速的话，她会以巡航速度（最高 1700px/s）
		// 冲过目标、再靠阻力滑出去几百像素才停下，卵落在离挑好的地方老远的位置
		const siteMisses = []
		for (let round = 0; round < 6; round++) {
			// ⚠ 用**对象集合**记「这一轮之前有哪些卵」，不要用 `world.eggs.length` 当下标切片。
			//
			// 切片版本的假设是「world.eggs 只增不减」，但它是会减的 ——
			// 卵会孵化，孵化时 _resolveLifecycles 会把它从数组里摘掉。
			// 一轮最长跑 60 秒（guard），六轮加起来够早先那几颗卵孵出来，
			// 于是下标整体错位：`slice(from)` 可能返回空数组，
			// 再往下就是 `lastBrood[0].clutch` 崩在 undefined 上。
			// 那个崩溃看起来像「窝号传递坏了」，实际上只是数组被删短了。
			//
			// 用集合做差集就没有这个问题 —— 不管中间删掉什么，
			// 「这一轮新出现的卵」这个定义都成立
			const before = new Set(world.eggs)
			mother.cooldown = 0
			mother.beginClutch(world)
			let guard = 0
			let site = null
			// laySite 也要等 —— beginClutch 只是挑好了地方，她还得飞过去才开始产
			while ((mother.laying || mother.laySite) && guard++ < 60 * 60) {
				// 趁它还没被 startLaying 清掉，一直记着最后一刻的目标
				if (mother.laySite) site = { x: mother.laySite.x, y: mother.laySite.y }
				world.update(STEP)
			}
			const laid = world.eggs.filter((e) => !before.has(e))
			if (site && laid.length) {
				const cx = laid.reduce((s, e) => s + e.x, 0) / laid.length
				const cy = laid.reduce((s, e) => s + e.y, 0) / laid.length
				siteMisses.push(Math.hypot(cx - site.x, cy - site.y))
			}
			// 空窝不进 broods：她可能这一轮一颗都没产下（中途被打断等），
			// 而下面几处都假设 broods 里每一窝至少有东西
			if (laid.length) broods.push(laid)
		}

		if (siteMisses.length) {
			const worst = Math.max(...siteMisses)
			const avgMiss = siteMisses.reduce((a, b) => a + b, 0) / siteMisses.length
			console.log(
				`  挑好的产卵点 vs 实际落卵中心：平均偏 ${avgMiss.toFixed(0)}px，最远 ${worst.toFixed(0)}px` +
					`（${siteMisses.length} 窝真的飞到点上了；其余是 scatterChance 就地开产的）`,
			)
			// 容差给的是「卵的散布半径 + 一点滑行」。超过这个数就说明她冲过头了
			if (worst > CONFIG.laying.scatter + 45) {
				clutchProblems.push(
					`有一窝落在离挑好的产卵点 ${worst.toFixed(0)}px 的地方 —— 她冲过头了，检查 food/laying 的 siteBrakeSafety`,
				)
			}
		} else {
			clutchProblems.push('6 窝全都没走「选址 → 飞过去」这条路 —— 检查 beginClutch 里的 scatterChance')
		}

		// 端到端量一次「卵到底落在哪儿」——这才是玩家看得见的东西。
		// 上面那条量的是 _pickLaySite 的挑选结果，这里量的是**实际产下的每一颗卵**，
		// 所以把 scatterChance（那时她偷懒，就地开产）也算进去了
		{
			const all = broods.flat()
			const out = all.filter((e) => mother._siteOutwardness(world, e.x, e.y) > 1).length
			console.log(
				`  实际产下的卵：${all.length} 颗里有 ${out} 颗（${((out / Math.max(1, all.length)) * 100).toFixed(0)}%）` +
					`在中间留白之外（含 ${CONFIG.laying.scatterChance * 100}% 就地开产的）`,
			)
			if (all.length && out / all.length < 0.6) {
				clutchProblems.push(`实际产下的卵只有 ${((out / all.length) * 100).toFixed(0)}% 在中间留白之外 —— 卵会堆在屏幕正中间`)
			}
		}

		const brood = world.eggs.slice()
		const hatches = brood.map((e) => e.hatchAt)
		const spans = broods
			.filter((b) => b.length >= 2)
			.map((b) => (Math.max(...b.map((e) => e.hatchAt)) - Math.min(...b.map((e) => e.hatchAt))) / SEC)
		const maxSpan = spans.length ? Math.max(...spans) : 0
		const minSpan = spans.length ? Math.min(...spans) : 0
		// 跨窝的差异：各窝基准时间之间的极差，这才是「这套区间有多宽」的实测值
		const bases = broods.filter((b) => b.length).map((b) => b[0].hatchAt)
		const betweenSpan = ((Math.max(...bases) - Math.min(...bases)) / MIN).toFixed(1)
		const fullSpan = (CONFIG.egg.hatchMax - CONFIG.egg.hatchMin) / MIN

		console.log(
			`  ${broods.length} 窝共 ${brood.length} 颗卵；**窝内**孵化时间跨 ${minSpan.toFixed(1)} ~ ${maxSpan.toFixed(1)} 秒` +
				`（配置的抖动是 ±${CONFIG.egg.clutchJitter / SEC} 秒）`,
		)
		console.log(
			`  **窝与窝之间**的基准时间相差 ${betweenSpan} 分钟，而整套孵化区间有 ${fullSpan.toFixed(0)} 分钟宽 ——` +
				` 一窝只占其中很小一段`,
		)

		// ⚠ 这条不能写成「**任何**一窝少于 2 颗就报错」。
		//
		// 一窝没产完就被打断是**正常**的，有两种正当原因：
		//   · 母体中途死了（现在多了一种：被疯狂蝇咬死）—— 她停在 layRemaining > 0
		//   · 撞上 maxEggs 上限，新的卵根本放不下
		// 实测这一条会稳定地每七八次红一次，而红的时候看起来像
		// 「eggsMin 配错了」，其实只是那一窝的母体恰好遇害。
		//
		// 要防的回归是「eggsMin 被改成了 1」—— 那种情况**所有**窝都会只有 1 颗，
		// 所以判据改成「短窝必须是少数」
		const shortBroods = broods.filter((b) => b.length < 2).length
		const shortRatio = broods.length ? shortBroods / broods.length : 0
		console.log(`  ${broods.length} 窝里有 ${shortBroods} 窝不足 2 颗（母体中途死了 / 撞上卵上限）`)
		if (shortRatio > 0.25) {
			clutchProblems.push(
				`${broods.length} 窝里有 ${shortBroods} 窝只产了不到 2 颗（${(shortRatio * 100).toFixed(0)}%）—— ` +
					`检查 mating.eggsMin（现值 ${CONFIG.mating.eggsMin}）`,
			)
		}
		if (maxSpan > (2 * CONFIG.egg.clutchJitter) / SEC + 0.5) {
			clutchProblems.push(`同一窝的孵化时间最多跨了 ${maxSpan.toFixed(1)} 秒，超过 ±clutchJitter 允许的范围`)
		}
		// 抖动不能是 0：那样一窝会同一帧全孵出来，像爆开一样
		if (maxSpan < 0.5) clutchProblems.push('每一窝的孵化时间都几乎完全一致 —— 会一帧全孵出来，clutchJitter 太小了')
		if (hatches.some((h) => h < CONFIG.egg.hatchMin || h > CONFIG.egg.hatchMax)) {
			clutchProblems.push('有卵的孵化时间被抖出了 hatchMin~hatchMax 的区间')
		}
		for (const b of broods) {
			if (b.length && !b.every((e) => e.clutch === b[0].clutch)) clutchProblems.push('同一窝的卵却有不同的窝号')
		}
		// 窝与窝之间要真的拉开 —— 全都一样的话，「一窝」这个概念就没意义了。
		//
		// ⚠ 判据只能卡「有没有变化」，不能卡「极差够不够大」。
		//   每个窝的基准时间是从 hatchMin~hatchMax（4 分钟）里**独立抽**的，
		//   而这里最多只有 6 个样本 —— 6 个均匀样本全部落进同一分钟的概率
		//   并不低，实测每十五次红一次。那纯粹是抽样波动，不是配置坏了。
		//   「区间够不够宽」由上面 fullSpan 那行直接读配置来保证（那是确定性的），
		//   这里只负责抓「基准时间根本没在变」这种真回归
		if (broods.length >= 2 && Number(betweenSpan) <= 0) {
			clutchProblems.push(`不同窝的孵化时间完全一样（${betweenSpan} 分钟）—— 窝与窝之间没拉开`)
		}
		// 区间本身必须够宽，否则「一窝只占其中一小段」这个前提就不成立了
		if (fullSpan < 3) {
			clutchProblems.push(`整套孵化区间只有 ${fullSpan.toFixed(1)} 分钟宽 —— 太窄，各窝会挤在一起`)
		}

		// —— 2. 窝号会传到幼虫身上 ——
		const lastBrood = broods[broods.length - 1]
		for (const e of lastBrood) {
			e.age = e.hatchAt
			e.x = clamp(e.x, 40, W - 40)
			e.y = clamp(e.y, 40, H - 40)
		}
		world.update(STEP) // 推进一帧让它们孵出来
		const hatched = world.larvae.filter((l) => l.clutch === lastBrood[0].clutch)
		console.log(`  最后一窝 ${lastBrood.length} 颗卵孵出 ${hatched.length} 只幼虫，窝号 ${lastBrood[0].clutch} 原样传了下去`)
		if (hatched.length !== lastBrood.length) {
			clutchProblems.push(`孵化的幼虫里只有 ${hatched.length}/${lastBrood.length} 只带着正确的窝号`)
		}

		// —— 3. 产卵点是「挑过」的，不是随便下的 ——
		//
		// 判据：挑出来的点，_siteScore 要明显高于同一片区域里随机撒的点。
		// 只在「挑出来的点」和「随机点」之间比，而不是去定义一个绝对的「安全」——
		// 安全本来就是相对的，绝对值没有意义。
		world.larvae.length = 0
		world.eggs.length = 0
		// 在母体旁边堆一片尸体，制造出「一半地方明显更差」的局面。
		// 随便撒满全屏的话，每个候选点离最近尸体的距离都差不多，
		// 打分拉不开差距 —— 那样测的是噪声，不是选址
		const DEN = { x: W / 2, y: H / 2 }
		for (let i = 0; i < 40; i++) {
			const a = rand(0, TAU)
			const d = Math.sqrt(Math.random()) * 200
			world.addRemains(DEN.x + Math.cos(a) * d, DEN.y + Math.sin(a) * d, 'corpse', 16, rand(0, TAU))
		}
		mother.x = DEN.x + 120 // 就在这片「危险区」边上
		mother.y = DEN.y

		// 判据用**离最近尸体的距离**，不用抽象的打分值 ——
		// 「她挑的地方离尸体更远」是能直接讲清楚的一句话，分数不是
		const nearestCorpse = (x, y) => {
			let m = Infinity
			for (const r of world.remains) m = Math.min(m, Math.hypot(r.x - x, r.y - y))
			return m
		}

		let pickedSum = 0
		let randSum = 0
		let pickedD = 0
		let randD = 0
		const TRIES = 200
		const outward = []
		for (let i = 0; i < TRIES; i++) {
			const site = mother._pickLaySite(world)
			pickedSum += mother._siteScore(world, site.x, site.y)
			pickedD += nearestCorpse(site.x, site.y)
			// 对照组：同样**在整块屏幕上**均匀撒一个点（和 _pickLaySite 的撒法一致）
			const rx = rand(60, W - 60)
			const ry = rand(60, H - 60)
			randSum += mother._siteScore(world, rx, ry)
			randD += nearestCorpse(rx, ry)
			outward.push(mother._siteOutwardness(world, site.x, site.y))
		}
		const pickedAvg = pickedSum / TRIES
		const randAvg = randSum / TRIES
		const siteD = pickedD / TRIES
		const rndD = randD / TRIES
		console.log(
			`  产卵点：挑出来的平均离最近尸体 ${siteD.toFixed(0)}px（打分 ${pickedAvg.toFixed(2)}），` +
				`随机点 ${rndD.toFixed(0)}px（打分 ${randAvg.toFixed(2)}）`,
		)

		if (pickedAvg <= randAvg + 0.2) {
			clutchProblems.push(`挑出来的产卵点（${pickedAvg.toFixed(2)}）没有明显优于随机点（${randAvg.toFixed(2)}）—— 选址没生效`)
		}
		if (siteD < rndD * 1.15) {
			clutchProblems.push(`挑出来的产卵点离尸体 ${siteD.toFixed(0)}px，和随机点 ${rndD.toFixed(0)}px 差不多 —— 没有在躲开危险区`)
		}

		// —— 3b. **卵要产在屏幕边缘，别堆在正中间** ——
		//
		// 这是一条**产品要求**，不是生态上的取舍：桌宠不能挡着玩家干活。
		// 判据用 _siteOutwardness()：0 = 屏幕正中心，1 = 中间那块留白的边界。
		//
		// ⚠ 必须专门守这一条。它和「离尸体远」「别挤堆」是**互相拉扯**的，
		// 而那两项不封顶时总和能到十几分、盖过靠边那一项 ——
		// 结果就是「边上一堆尸体的时候，卵又被推回屏幕正中间」。
		const outside = outward.filter((e) => e > 1).length / outward.length
		const avgOut = outward.reduce((a, b) => a + b, 0) / outward.length
		const midOut = outward.slice().sort((a, b) => a - b)[Math.floor(outward.length / 2)]
		console.log(
			`  产卵点靠不靠边：${(outside * 100).toFixed(0)}% 落在中间留白之外，` +
				`归一化半径 中位 ${midOut.toFixed(2)} / 平均 ${avgOut.toFixed(2)}（1.0 = 留白边界）`,
		)
		// 「大部分在边缘就行，并非完全强制」—— 门槛定在六成，不是十成
		if (outside < 0.6) {
			clutchProblems.push(`只有 ${(outside * 100).toFixed(0)}% 的产卵点在中间留白之外 —— 卵会堆在屏幕正中间挡着玩家，检查 laying.centerClearRx/Ry 和 edgeWeight`)
		}
		if (midOut < 1.1) {
			clutchProblems.push(`产卵点的归一化半径中位数只有 ${midOut.toFixed(2)}，贴着留白边界 —— 边缘偏好不够强`)
		}

		// —— 4. 同窝的幼虫更容易组队，但不排除其他幼虫 ——
		//
		// 两窝各 24 只，全部塞在一小片里（都在彼此的 buddyRadius 内），
		// 跑一段时间，统计「结成过对」的组合里有多少是同窝的。
		world.flies.length = 0
		world.larvae.length = 0
		world.eggs.length = 0
		world.remains.length = 0
		world.foods.length = 0
		world.swarm.active = false
		CONFIG.swarm.enabled = false

		const CA = world.newClutch()
		const CB = world.newClutch()
		for (let i = 0; i < 24; i++) world.addLarva(W / 2 + rand(-60, 60), H / 2 + rand(-60, 60), null, CA)
		for (let i = 0; i < 24; i++) world.addLarva(W / 2 + rand(-60, 60), H / 2 + rand(-60, 60), null, CB)

		// ⚠ 观察窗口从 90 秒加长到 180 秒。跨窝组队是个**小概率事件**
		// （同窝的就在旁边时，先掷 kinChance 0.75；失败才轮到 otherChance 0.35，
		// 合起来每次尝试不到 9%），而且一旦结上伴就会维持一阵子、不会反复重掷 ——
		// 90 秒的窗口偶尔会一次都采不到，那条断言就会间歇性报错。
		// 窗口翻倍之后「一次都没有」基本不可能出现，代价只是多跑 5400 帧
		const pairs = new Set()
		for (let f = 0; f < 180 * 60; f++) {
			world.update(STEP)
			for (const l of world.larvae) {
				if (!l.buddy) continue
				pairs.add(l.clutch === l.buddy.clutch ? 'kin' : 'other')
			}
		}
		const kinPair = world.larvae.filter((l) => l.buddy && l.buddy.clutch === l.clutch).length
		const otherPair = world.larvae.filter((l) => l.buddy && l.buddy.clutch !== l.clutch).length
		const total = kinPair + otherPair
		const kinShare = total ? kinPair / total : 0

		console.log(
			`  48 只（两窝各 24）跑 180 秒：此刻 ${total} 只结着伴，其中同窝 ${kinPair} 只（${(kinShare * 100).toFixed(0)}%）`,
		)
		console.log(`  期间出现过的组合：同窝 ${pairs.has('kin') ? '有' : '无'} / 跨窝 ${pairs.has('other') ? '有' : '无'}`)

		if (total === 0) clutchProblems.push('48 只挤在一小片里，却一只组队的都没有 —— 检查 _updateBuddy')
		if (total > 0 && kinShare < 0.6) {
			clutchProblems.push(`组队里只有 ${(kinShare * 100).toFixed(0)}% 是同窝的 —— 同窝优先没生效`)
		}
		if (total > 0 && !pairs.has('other')) {
			clutchProblems.push('跨窝的组合一次都没出现 —— 「也不排除和其他幼虫」这条没了，检查 otherChance')
		}
		// 不恢复 CONFIG.swarm.enabled —— 主干跑完之后它一直保持关闭，见里程碑前面那段
	}
}
console.log('')

// ---------------------------------------------------------------- 幼虫体型验证
console.log('—— 幼虫体型验证 ——')

const shapeProblems = []
{
	const L = CONFIG.larva

	// —— 1. 批次之间应该明显不同，批次内部则比较接近 ——
	world.larvae.length = 0
	const groups = []
	for (let b = 0; b < 5; b++) {
		// 五个批次均匀铺满整个区间，模拟「不同母体的后代」
		const shape = {
			length: lerp(L.lengthMin, L.lengthMax, b / 4),
			slim: lerp(L.slimMin, L.slimMax, b / 4),
		}
		const start = world.larvae.length
		for (let i = 0; i < 8; i++) world.addLarva(300, 300, shape)
		groups.push(world.larvae.slice(start))
	}

	const avg = (arr, k) => arr.reduce((s, x) => s + x[k], 0) / arr.length
	const groupMid = groups.map((g) => avg(g, 'slim'))
	const acrossRange = Math.max(...groupMid) - Math.min(...groupMid)
	const withinSpread =
		groups.reduce((s, g) => s + (Math.max(...g.map((l) => l.slim)) - Math.min(...g.map((l) => l.slim))), 0) /
		groups.length

	// 渲染出来的宽长比 = 最大体宽 / 体长（含 -0.85 的扁平系数）。
	// 系数走 config 的 larvaWidthRatio()，和 render.js 用的是同一个来源 ——
	// 早先这里写死过 lerp(1.45, 0.64) / (segments-1)，render 那边另有一份，
	// 改了任何一边另一边就悄悄失去意义（而且不会报错，只是数字不再对应）
	const aspectOf = (l) => 2 * larvaWidthRatio(l.slim) * 0.85
	const all = groups.flat()
	const aspects = all.map(aspectOf)
	const lengths = all.map((l) => l.lengthScale)

	console.log(`  5 个批次 × 8 只`)
	console.log(`  批次之间瘦度差 ${acrossRange.toFixed(3)}，批次内部平均只差 ${withinSpread.toFixed(3)}（前者越大越像「一批一批」的）`)
	console.log(`  体长倍率 ${Math.min(...lengths).toFixed(2)} ~ ${Math.max(...lengths).toFixed(2)}（均值 ${avg(all, 'lengthScale').toFixed(2)}，设定均值 1.00）`)
	console.log(
		`  渲染宽长比 ${Math.min(...aspects).toFixed(2)}（细长米粒）← → ${Math.max(...aspects).toFixed(2)}（短胖椭圆），相差 ${(Math.max(...aspects) / Math.min(...aspects)).toFixed(1)} 倍`,
	)

	if (acrossRange < withinSpread * 1.5) {
		shapeProblems.push('批次之间的体型差异不明显，和批次内部差不多 —— 看不出「一批一批」')
	}
	if (Math.max(...aspects) / Math.min(...aspects) < 1.9) {
		shapeProblems.push('椭圆和米粒的宽长比差距太小，视觉上区分不出来')
	}

	// —— 2. 体长曲线：逐点对死 CONFIG.larva.sizeKeys ——
	//
	// ⚠ 这里把**每一个关键帧**都写进断言，而不是只抽查首尾。
	//   只对比首尾的话，中间某一档被删掉、或者插值写成了阶梯，两端照样是对的。
	//   代价是改 sizeKeys 必须回来同步这一行 —— 这是有意的，
	//   曲线是玩法参数，改动本来就该是一次显式的动作
	const at = (min) => larvaSizeAt(min * MIN)
	const keys = CONFIG.larva.sizeKeys
	console.log(
		`  体长曲线：` +
			[0, 6, 10, 15, 25].map((m) => `${m}分 ${at(m)}px`).join(' → '),
	)
	for (const k of keys) {
		if (at(k.t) !== k.size) {
			shapeProblems.push(`体长关键帧 ${k.t} 分钟应当是 ${k.size}px，实测 ${at(k.t)}`)
		}
	}
	// 最后一帧之后必须**封顶**，不能继续涨
	const last = keys[keys.length - 1]
	if (at(last.t + 30) !== last.size) {
		shapeProblems.push(`超出最后一帧之后体型还在变（实测 ${at(last.t + 30)}，应当是封顶的 ${last.size}）`)
	}
	// 必须单调递增，中途不能回落
	for (let i = 1; i < keys.length; i++) {
		if (keys[i].size <= keys[i - 1].size) {
			shapeProblems.push(`体长曲线在 ${keys[i].t} 分钟处没有继续变大 —— 幼虫不该越长越小`)
		}
	}

	// —— 2.5 软身体：头拖着尾巴走 ——
	//
	// 这是**纯外形**，不参与物理（幼虫的位移始终是匀速直线）。
	// 所以只能在数据层面断言。曲线来自 l.bodyAxis()，和 render.js 画的是同一条。
	//
	// 要证明的核心只有一件事：**身体不是刚性绑在头的朝向上的**。
	// 做法是让它直着走一段、把身体拉直，然后猛转 90°，
	// 立刻看尾巴落在哪 —— 真是拖尾的话，它此刻还留在转弯前的方向上。
	//
	// ⚠ 场子必须先清空。上面那几组「批次差异」的幼虫还留在 world 里，
	// 而组队是会**抢走控制权**的：soft 一旦跟上了同伴，走的就是「同伴前方一点」，
	// 而不是下面 walk() 每帧硬塞给它的 wanderTarget ——
	// 表现是身体一直弯着、头几乎不转，报出来的却是「尾巴是平的」这种驴唇不对马嘴的理由。
	world.larvae.length = 0
	world.eggs.length = 0
	world.foods.length = 0
	world.remains.length = 0
	world.flies.length = 0

	const soft = world.addLarva(500, 500)
	// ⚠ 要设 age 而不是 size：update() 每帧都会用 larvaSizeAt(age) 重算 size，
	// 手动赋的 size 第一帧就被覆盖掉了。
	//
	// ⚠ age 必须**卡在 pupateAt 之前**。幼虫一到化蛹点就停下不动了 ——
	// 那时下面「直行看身体弯不弯」「猛转 90° 看拖尾」全部测不到东西，
	// 报出来的却是「尾巴是平的」「头只转了 0.0°」这种驴唇不对马嘴的理由。
	// 早先这里写死 19 分钟，而 pupateAt 从 20 调到了 17 ——
	// 于是「设一个还没化蛹的年龄」这条注释变成了假的，四条断言一起红。
	// 现在从配置里推，改 pupateAt 不会再悄悄把这里变成假测试
	soft.age = CONFIG.larva.pupateAt - 1.5 * MIN
	soft.lengthScale = 1
	soft.slim = 0.5

	// 手动推进：每帧都把 wanderTimer 顶回去，免得它中途随机改主意
	const walk = (frames, target) => {
		for (let i = 0; i < frames; i++) {
			soft.wanderTarget = target
			soft.wanderTimer = 1
			world.update(1 / 60)
		}
	}

	// 先朝 +x 直走一段，把身体拉成一条直线。
	//
	// ⚠ 时间是**算出来的**，不是随手写的 3 秒。身体要走完两步才算直：
	//   ① 头像转到 0：最坏 π 弧度 ÷ turnRate(2.4) ≈ 1.3 秒
	//   ② 脊柱跟着走完一个体长：19.4px ÷ 最慢爬速（11 × speedScale 0.75）≈ 2.4 秒
	// 加起来 3.7 秒 —— 取 3 秒是**不够**的。
	//
	// 这条曾经只是偶尔失败（尾巴鼓出 1.77px 而不是 2.4px），因为初始角度是随机的：
	// 抽到接近 0 的时候 3 秒刚好够，抽到接近 π 就不够，身体还弯着，
	// 尾巴的圆头方向跟着偏，量出来的「鼓出」就短了一截。
	// 任何扰动随机数序列的改动（比如给构造函数多加两个 rand()）都会让它换个结果
	walk(60 * 6, 0)

	const seg = (soft.size * soft.lengthScale) / (soft.spine.length - 1)
	let headMax = 0 // 头在 bodyAxis 里偏离原点的距离
	let segErr = 0 // 体节长度和理论值的最大偏差
	let radiusJump = 0 // 相邻采样点的半径最大跳变

	const checkBody = () => {
		const axis = soft.bodyAxis()
		headMax = Math.max(headMax, Math.hypot(axis[0].x, axis[0].y))
		for (let k = 1; k < axis.length; k++) {
			radiusJump = Math.max(radiusJump, Math.abs(axis[k].r - axis[k - 1].r))
		}
		return axis
	}
	checkBody()

	// 脊柱上相邻两点的距离必须**始终**等于一个体节 —— 这是「不可伸缩的软绳」
	// 这条约束的全部内容。被拉长或压短就说明约束没生效
	for (let i = 1; i < soft.spine.length; i++) {
		const a = soft.spine[i - 1]
		const b = soft.spine[i]
		segErr = Math.max(segErr, Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - seg))
	}

	// 角度归一化到 [-π, π]。⚠ 必须做这一步：
	// Larva.angle 是 angleLerp 一路累加出来的，会漂到 ±π 之外（实测能到 6.6 弧度），
	// 直接相减得到的差值毫无意义 —— 第一次跑这条断言时它报出来的是「头转了 380°」
	const norm = (a) => {
		let d = a % TAU
		if (d > Math.PI) d -= TAU
		if (d < -Math.PI) d += TAU
		return d
	}
	/**
	 * 身体相对**头自身朝向**的弯曲量。
	 *
	 * bodyAxis() 给的是局部坐标（头在原点、头朝 +x），所以「身体笔直向后」
	 * 在局部坐标里恒为 π。弯曲量就是实际方位和 π 的差。
	 *
	 * ⚠ 不能拿这个方位去和世界坐标的 angle + π 比 —— 局部坐标里的 π 和
	 * 世界角度不是一回事，第一次写这条断言时就是这么错的，报出来「头转了 380°」。
	 */
	const bendOf = (axis) => {
		const t = axis[axis.length - 1]
		return Math.abs(norm(Math.atan2(t.y, t.x) - Math.PI))
	}

	const straight = checkBody()
	const straightBend = bendOf(straight)
	console.log(`  直行 6 秒后：身体弯曲 ${((straightBend * 180) / Math.PI).toFixed(1)}°（直线应为 0°）`)

	// —— 尾巴必须是圆头，不能是「被切平」的 ——
	//
	// 轮廓如果只是把左右两条侧线首尾直连，端点就成了一条垂直于身体的直线切口，
	// 尾巴看着像被削掉一块。判据很干脆：圆头会在身体方向上比脊柱末端再鼓出去
	// 一个尾巴半径，切平的则一点都不鼓。
	const bodyLen = soft.size * soft.lengthScale
	const tailR = bodyLen * larvaWidthRatio(soft.slim) * larvaProfileAt(1)
	const outline = soft.bodyOutline()
	// 局部坐标里头在原点、身体朝 -x，所以「最远」是 x 最小
	const minX = Math.min(...outline.map((p) => p.x))
	const bulge = -minX - bodyLen
	console.log(
		`  尾巴：轮廓最远到 x=${minX.toFixed(1)}px（脊柱末端 -${bodyLen.toFixed(1)}px），` +
			`鼓出 ${bulge.toFixed(2)}px；尾巴半径 ${tailR.toFixed(2)}px`,
	)
	if (bulge < tailR * 0.8) {
		shapeProblems.push(
			`尾巴是平的（只鼓出 ${bulge.toFixed(2)}px，圆头应当鼓出 ${tailR.toFixed(2)}px）—— 轮廓两端少了半圆头`,
		)
	}
	// 头也一样，只是半径小些
	const maxX = Math.max(...outline.map((p) => p.x))
	const headR = bodyLen * larvaWidthRatio(soft.slim) * larvaProfileAt(0)
	if (maxX < headR * 0.8) {
		shapeProblems.push(`头是平的（只鼓出 ${maxX.toFixed(2)}px，圆头应当 ${headR.toFixed(2)}px）`)
	}

	// —— 猛转 90°，立刻检查身体 ——
	const angleBefore = soft.angle
	walk(6, Math.PI / 2) // 0.1 秒
	const turned = checkBody()

	const headTurn = Math.abs(norm(soft.angle - angleBefore))
	const lag = bendOf(turned)
	// 滞后比例：0 = 身体瞬间跟着头转（硬棍子），1 = 身体在世界上完全没动（纯拖尾）。
	// 尾巴若冻结在世界坐标里，换算到头的局部坐标就正好是「头转了多少」，
	// 所以 lag / headTurn 天然落在 0~1
	const lagRatio = headTurn > 1e-6 ? lag / headTurn : 0

	console.log(
		`  转弯 0.1 秒后：头转了 ${((headTurn * 180) / Math.PI).toFixed(1)}°，` +
			`身体弯了 ${((lag * 180) / Math.PI).toFixed(1)}° —— 滞后比例 ${(lagRatio * 100).toFixed(0)}%` +
			`（硬棍子恒为 0%）`,
	)
	console.log(
		`  体节长度偏差最大 ${segErr.toFixed(4)}px（体节 ${seg.toFixed(2)}px）；` +
			`头部偏离原点 ${headMax.toFixed(4)}px；半径跳变 ${radiusJump.toFixed(2)}px`,
	)

	// 头就是幼虫的 (x, y)，局部坐标里必须正好在原点
	if (headMax > 0.001) shapeProblems.push(`头部在身体曲线上偏离了原点 ${headMax.toFixed(3)}px —— 头应当是锚点`)
	// 身体不可伸缩
	if (segErr > seg * 0.05) shapeProblems.push(`体节长度偏差 ${segErr.toFixed(3)}px（体节 ${seg.toFixed(2)}px）—— 脊柱的距离约束没生效`)
	// 直行时应当是直的
	if (straightBend > 0.25) shapeProblems.push(`直行时身体还是弯的（${((straightBend * 180) / Math.PI).toFixed(0)}°）—— 直线爬行时身体不该弯`)
	// **核心断言**：转弯之后身体必须明显滞后。
	// 这一条就是「软身体」和「硬棍子」的分界 —— 身体若刚性绑在头的朝向上，
	// 滞后比例会恒等于 0，头怎么转身体就怎么转
	if (headTurn < 0.15) shapeProblems.push(`转弯测试没生效：0.1 秒里头只转了 ${((headTurn * 180) / Math.PI).toFixed(1)}°`)
	if (lagRatio < 0.5) {
		shapeProblems.push(
			`转弯后身体只滞后了 ${(lagRatio * 100).toFixed(0)}% —— 身体太接近「刚性绑在头的朝向上」，拖尾不明显`,
		)
	}
	// 半径不能有突变，否则轮廓上会出现台阶（那又变回「分节」了）
	if (radiusJump > soft.size * soft.lengthScale * larvaWidthRatio(soft.slim) * 0.25) {
		shapeProblems.push(`身体半径有 ${radiusJump.toFixed(2)}px 的跳变 —— 轮廓会出现台阶，像分节`)
	}

	// —— 3. 遗传漂移：跑 200 代，均值不应当跑到区间边缘 ——
	// 全部从区间上界起步是最能暴露漂移的设定
	const popMeanSlim = (L.slimMin + L.slimMax) / 2
	let lineage = new Array(60).fill(L.slimMax)
	for (let gen = 0; gen < 200; gen++) {
		lineage = lineage.map((v) => inheritTrait(v, L.slimMin, L.slimMax))
	}
	const drifted = lineage.reduce((a, b) => a + b, 0) / lineage.length

	console.log(
		`  遗传 200 代（60 条血脉，全部从区间上界 ${L.slimMax} 起步）→ 均值回落到 ${drifted.toFixed(3)}，群体均值是 ${popMeanSlim.toFixed(3)}`,
	)
	if (Math.abs(drifted - popMeanSlim) > 0.06) {
		shapeProblems.push(
			`体型性状发生世代漂移：200 代后均值 ${drifted.toFixed(3)}，偏离群体均值 ${popMeanSlim.toFixed(3)} —— 检查 traitHeritability`,
		)
	}
}
console.log('')

// ---------------------------------------------------------------- 飞行 / 步行验证
console.log('—— 飞行 / 步行验证 ——')

const walkProblems = []
{
	world.flies.length = 0
	world.larvae.length = 0
	world.eggs.length = 0
	world.foods.length = 0
	world.remains.length = 0

	for (let i = 0; i < 8; i++) world.addFly(rand(200, 1700), rand(200, 900), i % 2 ? 'F' : 'M')

	let walkFrames = 0
	let flyFrames = 0
	let walkDist = 0
	let flyDist = 0
	// 爬行时「这一帧位置完全没动」的帧数 —— 那是走走停停里的「停」
	let walkIdle = 0
	// 爬行时单帧最大位移 —— 用来抓「位移被离散化」这种回退
	let walkMaxStep = 0
	const prev = new Map()

	for (let i = 0; i < 60 * 120; i++) {
		for (const f of world.flies) prev.set(f, { x: f.x, y: f.y, mode: f.mode })
		world.update(1 / 60)

		for (const f of world.flies) {
			const p = prev.get(f)
			if (!p || p.mode !== f.mode) continue // 模式刚切换，这一步不算
			const d = Math.hypot(f.x - p.x, f.y - p.y)
			if (p.mode === 'walk') {
				walkFrames++
				walkDist += d
				if (d < 0.001) walkIdle++
				else if (d > walkMaxStep) walkMaxStep = d
			} else {
				flyFrames++
				flyDist += d
			}
		}
	}

	const total = walkFrames + flyFrames
	const walkShare = walkFrames / total
	// 每帧位移 × 60 = 等效速度 px/s
	const walkSpeed = (walkDist / Math.max(1, walkFrames)) * 60
	const flySpeed = (flyDist / Math.max(1, flyFrames)) * 60
	const idleShare = walkIdle / Math.max(1, walkFrames)

	console.log(`  8 只果蝇观察 120 秒，共 ${total} 个「果蝇·帧」`)
	console.log(`  爬行占 ${(walkShare * 100).toFixed(0)}%，飞行占 ${((1 - walkShare) * 100).toFixed(0)}%`)
	console.log(`  等效速度：爬行 ${walkSpeed.toFixed(0)} px/s  vs  飞行 ${flySpeed.toFixed(0)} px/s（相差 ${(flySpeed / Math.max(1, walkSpeed)).toFixed(1)} 倍）`)
	console.log(`  爬行时 ${(idleShare * 100).toFixed(0)}% 的帧完全静止（走走停停里的「停」），单帧最大位移 ${walkMaxStep.toFixed(2)}px`)

	// 下限定在 20%：「飞一会走一会」里的「走」得有存在感，
	// 掉到 15% 以下时屏幕上几乎永远在飞，走路模式等于白做
	if (walkShare < 0.2) walkProblems.push(`爬行只占 ${(walkShare * 100).toFixed(0)}%，太低 —— 检查 behavior.landChance`)
	if (walkShare > 0.8) walkProblems.push(`爬行占了 ${(walkShare * 100).toFixed(0)}%，太高，果蝇几乎不飞了`)
	if (flySpeed < walkSpeed * 4) walkProblems.push('爬行和飞行的速度差不够大，看不出「走」的感觉')

	// —— 下面两条是这次刻意反过来加的，防止再退回「离散步进」那版 ——
	// 那一版把位移按固定间隔量化成跳步，观感就是掉帧。
	// 爬行速度 58px/s、60fps 下每帧应当只挪 0.97px。阈值卡在 1.5px ——
	// 一旦出现更大的单帧位移，说明有东西在「瞬移」。
	//
	// 这个检查抓到过两种完全不同的 bug，所以别把阈值放宽：
	//   1. 位移被按固定间隔量化成跳步（早就废弃的做法，观感是掉帧）
	//   2. 开始产卵那一下的边界钳制和 walk.edgeMargin 不一致，
	//      把在屏幕边缘走着的果蝇瞬间弹进来 6px（见 entities.js 的 _lay）
	if (walkMaxStep > 1.5) walkProblems.push(`爬行单帧最大位移 ${walkMaxStep.toFixed(2)}px（正常应约 0.97px）—— 有东西在瞬移`)
	// 停顿是行为节奏，占比应当在一到两成；太高就说明大部分时间在僵住
	if (idleShare > 0.4) walkProblems.push(`爬行有 ${(idleShare * 100).toFixed(0)}% 的帧完全静止，停得太多了`)
	if (idleShare < 0.02) walkProblems.push('爬行完全没有停顿，走走停停的节奏丢失')

	if (flySpeed < 250) walkProblems.push(`飞行等效速度只有 ${flySpeed.toFixed(0)} px/s，偏低`)
}
console.log('')

// ---------------------------------------------------------------- 成虫进食验证
console.log('—— 成虫进食验证 ——')

const feedProblems = []
{
	world.flies.length = 0
	world.larvae.length = 0
	world.eggs.length = 0
	world.foods.length = 0
	world.remains.length = 0

	const bait = world.addFood(800, 500, 'apple')
	// 必须催熟：果子要烂到 flyAttractMinRot 才散味道，新鲜的果子对成虫是完全隐形的
	bait.age = CONFIG.food.rotTime * 0.9

	const N = 6
	// 摆在嗅觉半径内、但还没到果子上的位置：它们应当自己走过去
	for (let i = 0; i < N; i++) {
		const a = (i / N) * TAU
		world.addFly(bait.x + Math.cos(a) * 60, bait.y + Math.sin(a) * 60, i % 2 ? 'F' : 'M')
	}
	// 先强制落地 —— 飞行状态的果蝇会一路窜出去，测不到「走过去 → 在果子上踱步」
	for (const f of world.flies) f.mode = 'walk'

	const R = bait.size * CONFIG.food.feedRadius
	let feedFrames = 0
	let sumDist = 0
	let maxDist = 0
	let turnSum = 0 // 进食时每帧的朝向变化量
	let movedFrames = 0 // 进食时真的挪动了的帧
	const last = new Map()
	const cells = new Set() // 去过哪些 6px 网格 —— 用来确认是铺开而不是绕圈

	for (let i = 0; i < 60 * 60; i++) {
		world.update(STEP)
		for (const f of world.flies) {
			if (!f.feeding) {
				last.delete(f)
				continue
			}
			feedFrames++
			const d = Math.hypot(f.x - bait.x, f.y - bait.y)
			sumDist += d
			if (d > maxDist) maxDist = d
			cells.add(`${Math.round(f.x / 6)},${Math.round(f.y / 6)}`)

			const p = last.get(f)
			if (p) {
				let da = Math.abs(f.angle - p.a) % TAU
				if (da > Math.PI) da = TAU - da
				turnSum += da
				if (Math.hypot(f.x - p.x, f.y - p.y) > 0.01) movedFrames++
			}
			last.set(f, { x: f.x, y: f.y, a: f.angle })
		}
	}

	const avgDist = sumDist / Math.max(1, feedFrames)
	const avgTurn = turnSum / Math.max(1, feedFrames)
	console.log(`  ${N} 只果蝇 + 一份苹果屑（活动半径 ${R.toFixed(0)}px）：60 秒里有 ${feedFrames} 个「进食·帧」`)
	console.log(`  进食时平均离中心 ${avgDist.toFixed(1)}px（=活动半径的 ${(avgDist / R).toFixed(2)} 倍），最远 ${maxDist.toFixed(1)}px`)
	console.log(`  进食时平均每帧转向 ${avgTurn.toFixed(3)} 弧度，${((movedFrames / Math.max(1, feedFrames)) * 100).toFixed(0)}% 的帧真的在移动`)
	console.log(`  走过的 6px 网格数 ${cells.size}（绕圈只会踩到一圈格子，随机踱步会铺满整块果子）`)

	if (feedFrames < 60) feedProblems.push('果蝇根本没能落到果子上进食 —— 检查 _updateMode / _forage')
	// 平均位置贴着圆心 = 又退回「全挤在正中」，那样几只叠在一起像在开会
	if (feedFrames > 60 && avgDist < R * 0.35) {
		feedProblems.push(`进食时平均只离中心 ${avgDist.toFixed(1)}px（活动半径 ${R.toFixed(0)}px），果蝇又挤到圆心上了 —— 检查 _forage 的随机落点`)
	}
	// 跑到果子外面老远 = 没有「在食物范围内」移动
	if (maxDist > R * 2.2) feedProblems.push(`进食时最远跑到离中心 ${maxDist.toFixed(0)}px（活动半径 ${R.toFixed(0)}px），没有留在食物范围内`)
	// 一直不转向 = 沿着直线穿过果子，不是踱步
	if (feedFrames > 60 && avgTurn < 0.004) feedProblems.push(`进食时几乎不转向（每帧 ${avgTurn.toFixed(4)} 弧度），不像在果子上踱步`)
	// 网格数太少 = 只在一条线/一个点上重复，随机性没生效
	if (feedFrames > 600 && cells.size < 6) feedProblems.push(`只在 ${cells.size} 个位置打转，随机踱步没生效`)
}
console.log('')

// ---------------------------------------------------------------- 工具验证
console.log('—— 工具验证 ——')

const toolProblems = []

// 拍死一只刚放出来的果蝇，看有没有留下需要擦的污渍
world.addFly(W / 2, H / 2, 'F')
const killed = world.swat(W / 2, H / 2)

// 不能用「残留物总数变化」来数新增了几块：
// 总数到上限之后，新污渍会把最旧的挤出去，净变化可能是 0。
// 所以直接看落点附近有没有新的。
const fresh = world.remains.filter((r) => r.kind === 'stain' && dist2(r.x, r.y, W / 2, H / 2) < 60 * 60)
console.log(`  挥拍一次：拍死 ${killed} 只，落点新增汁渍 ${fresh.length} 块，汁液粒子 ${world.particles.length} 颗`)

// 被拍死的果蝇必须留下尸体，不能凭空消失。
// 尸体是在 _resolveLifecycles 里结算的，所以要推进一帧才看得到。
world.update(1 / 60)
const corpse = world.remains.find((r) => r.kind === 'corpse' && dist2(r.x, r.y, W / 2, H / 2) < 60 * 60)
console.log(`  被拍死的果蝇留下尸体：${corpse ? '是' : '否'}`)
if (!corpse) toolProblems.push('被拍死的果蝇没有留下尸体 —— 检查 _resolveLifecycles 里 swatted 分支')

// —— 抹布：必须「来回滑动」才擦得掉 ——
//
// 擦的进度计的是**滑过的路程**（像素），不是按住的时间，也不是次数。
// 所以这里用一个「来回滑」的模拟：每帧在残留物上来回移动 STEP 像素，
// 一直擦到它消失，看累计要走多少路。
const scrubUntilGone = (target, perFrame = 8) => {
	let travelled = 0
	let guard = 0
	while (!target.dead && guard++ < 100000) {
		world.wipe(target.x, target.y, perFrame)
		travelled += perFrame
	}
	return travelled
}

// ① 按住不动（路程 0）必须一点都擦不掉 —— 这是整个机制的核心
const stuck = fresh[0] ?? world.addRemains(300, 300, 'stain', 16, 0)
const cleanBefore = stuck.clean
for (let i = 0; i < 120; i++) world.wipe(stuck.x, stuck.y, 0) // 两秒「按住不放」
console.log(`  按住不动两秒：clean ${cleanBefore.toFixed(3)} → ${stuck.clean.toFixed(3)}（应当纹丝不动）`)
if (stuck.clean > cleanBefore) toolProblems.push('按住不动也能擦掉东西 —— world.wipe 把 0 路程当成了有效擦拭')

// ② 新鲜污渍要走多少路程
const target1 = stuck
const travel1 = scrubUntilGone(target1)
console.log(`  新鲜污渍：累计滑动 ${travel1}px 清除（配置 ${CONFIG.remains.wipeScrubFresh}px，约 ${(travel1 / 32).toFixed(1)} 个来回）`)

// 手动推进到完全腐烂，再看要滑多远。
// 注意 rot 是每帧从 age 推导的，直接给 rot 赋值会被覆盖 —— 要改 age
const rotten = world.addRemains(W / 2, H / 2, 'corpse', 20, 0)
rotten.age = rotten.rotTime
const travel2 = scrubUntilGone(rotten)
console.log(`  烂透的尸体：累计滑动 ${travel2}px 清除（配置 ${CONFIG.remains.wipeScrubRotten}px，约 ${(travel2 / 32).toFixed(1)} 个来回）`)

// 越烂越难擦这条关系必须还在
if (travel2 <= travel1) toolProblems.push(`烂透的尸体（${travel2}px）不比新鲜污渍（${travel1}px）难擦 —— 「越烂越难擦」没了`)
// 新鲜的要真的需要来回：一趟直着划过去在半径内只有 2×wipeRadius 的路程
if (travel1 <= 2 * CONFIG.tools.wipeRadius) {
	toolProblems.push(`新鲜污渍只要 ${travel1}px 就擦掉了，一趟直线就够 —— 没有「来回」的要求`)
}
console.log('')

// ---------------------------------------------------------------- 蛹与蛹壳验证
console.log('—— 蛹与蛹壳验证 ——')

const pupaProblems = []
{
	world.flies.length = 0
	world.larvae.length = 0
	world.eggs.length = 0
	world.foods.length = 0
	world.jars.length = 0
	world.shells.length = 0
	world.remains.length = 0

	// —— 1. 变色只占蛹期开头的 30 秒，不是摊满 5 分钟 ——
	//
	// 「看着一条蛆在几十秒里慢慢变成一粒褐色的蛹」是这个机制的全部意义。
	// 摊到整个蛹期的话，头一分钟几乎看不出变化，等于没有。
	const P = CONFIG.pupa
	const p = world.addLarva(500, 500)
	p.age = CONFIG.larva.pupateAt + 1000
	world.update(1 / 60) // 推进一帧让它进入蛹期

	const tanAt = (sec) => {
		p.age = CONFIG.larva.pupateAt + sec * 1000
		return p.tanProgress
	}
	const t0 = tanAt(0)
	const t15 = tanAt(15)
	const t30 = tanAt(30)
	const t60 = tanAt(60)
	console.log(
		`  ${p.pupa ? '已进入蛹期' : '没进入蛹期！'}；变色进度：0s ${t0.toFixed(2)} → 15s ${t15.toFixed(2)} → 30s ${t30.toFixed(2)} → 60s ${t60.toFixed(2)}` +
			`（30 秒走完，之后停在 1）`,
	)
	if (!p.pupa) pupaProblems.push('到了 pupateAt 却没有进入蛹期')
	if (Math.abs(t0) > 0.02) pupaProblems.push(`刚化蛹时变色进度应当是 0，实际 ${t0.toFixed(2)}`)
	if (Math.abs(t15 - 0.5) > 0.05) pupaProblems.push(`化蛹 15 秒时变色进度应当是 0.5，实际 ${t15.toFixed(2)}`)
	if (Math.abs(t30 - 1) > 0.02) pupaProblems.push(`化蛹 30 秒时变色应当已经完成，实际 ${t30.toFixed(2)}`)
	if (Math.abs(t60 - 1) > 0.02) pupaProblems.push(`变色应当在 30 秒后停住，60 秒时却是 ${t60.toFixed(2)}`)

	// —— 2. 羽化之后原地留下蛹壳 ——
	world.larvae.length = 0
	world.shells.length = 0
	const soon = world.addLarva(700, 400)
	// 差一帧就羽化。⚠ 只能差 1ms —— 一帧是 16.7ms，
	// 留 100ms 的话它这一帧根本跨不过 emergeAt，测出来是「没羽化」
	soon.age = CONFIG.larva.emergeAt - 1
	const shellsBefore = world.shells.length
	const fliesBefore = world.flies.length
	world.update(1 / 60)

	console.log(
		`  羽化：成虫 ${fliesBefore}→${world.flies.length}，蛹壳 ${shellsBefore}→${world.shells.length}` +
			`（壳落在 ${world.shells.length ? world.shells[0].x.toFixed(0) + ',' + world.shells[0].y.toFixed(0) : '—'}）`,
	)
	if (world.flies.length !== fliesBefore + 1) pupaProblems.push('幼虫没有羽化成成虫')
	if (world.shells.length !== shellsBefore + 1) pupaProblems.push('羽化之后没有留下蛹壳')

	// 壳要继承原来那只蛹的体型，否则「壳」和「刚才的蛹」对不上号
	const sh = world.shells[0]
	if (sh && (sh.size !== soon.size || sh.slim !== soon.slim)) {
		pupaProblems.push('蛹壳没有沿用原来那只蛹的体型')
	}

	// —— 2b. 空壳是**瘪**的 ——
	//
	// 光靠「颜色比活蛹浅」区分空壳不够快：颜色得比一比才看出来。
	// 形状才是第一眼线索 —— 所以每一枚壳都有随机几处向内塌陷。
	// 这里量的是「塌得到底有多深」，1.0 = 完好的椭圆、越小越瘪。
	const bestOf = (shell) => {
		// 沿一圈密集采样，取凹得最狠的那一处
		let m = 1
		for (let i = 0; i < 720; i++) m = Math.min(m, shell.radiusAt((i / 720) * TAU))
		return m
	}

	const probes = []
	for (let i = 0; i < 200; i++) probes.push(new Shell(0, 0, 0, 20, 1, rand(0, 1)))
	const depths = probes.map(bestOf)
	const dMin = Math.min(...depths)
	const dMax = Math.max(...depths)
	const dAvg = depths.reduce((a, b) => a + b, 0) / depths.length
	console.log(
		`  空壳塌陷（200 枚，半径系数，1.0 = 完好的椭圆）：最深 ${dMin.toFixed(2)} / 平均 ${dAvg.toFixed(2)} / 最浅 ${dMax.toFixed(2)}`,
	)

	// 「看得出是瘪的」——最浅的那枚也得凹进去一点，否则形状这条线索等于没有
	if (dMax > 0.9) pupaProblems.push(`最浅的一枚空壳只凹了 ${(1 - dMax).toFixed(2)}（半径系数 ${dMax.toFixed(2)}），形状上看不出是空壳`)
	// 「不要过强」——凹得再狠也不该把壳咬掉一块。
	// 这条同时守着两件事：minSep 挡住了叠加，radiusAt 的 0.55 是最后一道保险丝
	if (dMin < 0.5) pupaProblems.push(`有壳凹得太狠（半径系数 ${dMin.toFixed(2)}，下限 0.55）—— 两处凹陷叠在一起了？检查 config 的 minSep`)
	// 典型的那一枚必须落在「明显凹了、但没凹烂」这一段里。
	// 用平均值而不是最值：最值归上面两条守边界，这里看的是手感
	if (dAvg < 0.6 || dAvg > 0.88) pupaProblems.push(`空壳的塌陷平均 ${dAvg.toFixed(2)}，不在「看得瘪但不过强」的区间（0.60~0.88）`)
	// 随机性：200 枚壳的凹陷深度不该挤在同一个值上
	if (dMax - dMin < 0.05) pupaProblems.push('每一枚空壳的塌陷深度几乎一样 —— 随机没生效')

	// 两处凹陷之间必须真的隔开（minSep 生效）—— 所有凹陷方向两两比一遍
	let tooClose = 0
	for (const s of probes) {
		for (let i = 0; i < s.dents.length; i++) {
			for (let j = i + 1; j < s.dents.length; j++) {
				const diff = Math.abs(
					Math.atan2(Math.sin(s.dents[i].a - s.dents[j].a), Math.cos(s.dents[i].a - s.dents[j].a)),
				)
				if (diff < CONFIG.pupa.shellCollapse.minSep - 1e-6) tooClose++
			}
		}
	}
	// 拒绝采样允许失败（试满 12 次就认了），所以给一点余量，不能要求 0
	if (tooClose > probes.length * 0.02) {
		pupaProblems.push(`有 ${tooClose} 对凹陷挨得比 minSep 还近 —— 拒绝采样没生效，凹陷会叠出深坑`)
	}

	// 凹陷的角度位置也必须逐枚不同，否则所有壳都是同一个模子
	const angles = new Set(probes.map((s) => s.dents.map((d) => d.a.toFixed(3)).join(',')))
	if (angles.size < probes.length * 0.95) {
		pupaProblems.push(`200 枚空壳里只有 ${angles.size} 种凹陷位置 —— 凹陷方向没有随机`)
	}

	// 轮廓点必须真的把凹陷反映出来（render 画的就是它，光有 dents 不算数）
	const probe = probes[0]
	const pts = probe.outline()
	if (pts.length !== CONFIG.pupa.shellSamples) {
		pupaProblems.push(`空壳轮廓点数 ${pts.length} 与配置的 ${CONFIG.pupa.shellSamples} 不符`)
	}
	// 每个点的半径系数要和 radiusAt 对得上（outline 是把极坐标摊成直角坐标的那一步）
	const rr = probe.radii
	const off = pts.filter((q) => {
		const r = Math.hypot(q.x / rr.pl, q.y / rr.pw)
		return Math.abs(r - probe.radiusAt(q.t)) > 1e-6
	})
	if (off.length) pupaProblems.push(`空壳轮廓上有 ${off.length} 个点和 radiusAt 对不上 —— outline 算错了`)

	// —— 3. 蛹壳两条路都能清：抹布来回擦，或者手套拖进垃圾桶 ——
	//
	// 早先只有后者（「残留物归抹布、蛹壳归手套」是一条刻意的分工），
	// 后来发现那条分工只是让玩家多切一次工具，没有带来任何取舍，已经取消
	if (sh) {
		// 同样得来回滑，而且比烂尸体更费劲 —— 它是一枚硬壳
		const stuckShell = world.wipe(sh.x, sh.y, 0)
		const cleanBeforeShell = sh.clean
		for (let i = 0; i < 60; i++) world.wipe(sh.x, sh.y, 0)
		void stuckShell

		let travelled = 0
		let guard = 0
		while (!sh.dead && guard++ < 100000) {
			world.wipe(sh.x, sh.y, 8)
			travelled += 8
		}
		console.log(
			`  空壳：按住不动 ${cleanBeforeShell.toFixed(3)} → 纹丝不动；` +
				`来回滑动 ${travelled}px 擦掉（配置 ${CONFIG.pupa.shellScrub}px）`,
		)
		if (sh.clean < 1 && !sh.dead) pupaProblems.push('抹布擦不掉蛹壳了')
		if (travelled < CONFIG.pupa.shellScrub) pupaProblems.push('蛹壳需要的路程比配置的还少 —— shellScrub 没生效')
		// 壳是硬的，应当比烂尸体更费劲
		if (travelled <= CONFIG.remains.wipeScrubRotten) {
			pupaProblems.push(`蛹壳（${travelled}px）不比烂尸体（${CONFIG.remains.wipeScrubRotten}px）难擦 —— 壳是硬的，该更费劲`)
		}
	}

	// 另一条路（手套 + 垃圾桶）必须还在
	world.shells.length = 0
	const sh2 = world.addShell(700, 400, 0, 20, 1, 0.5)
	world.discardShell(sh2)
	world.update(1 / 60)
	console.log(`  另一条路：手套拖进垃圾桶后剩 ${world.shells.length} 枚`)
	if (world.shells.length !== 0) pupaProblems.push('discardShell 之后蛹壳还在')

	// —— 4. 卵的深浅逐颗不同，但幅度很小 ——
	world.eggs.length = 0
	for (let i = 0; i < 30; i++) world.spawnEgg(rand(100, 900), rand(100, 600))
	const shades = world.eggs.map((e) => e.shade)
	const shMin = Math.min(...shades)
	const shMax = Math.max(...shades)
	console.log(`  卵的深浅 shade：${shMin.toFixed(2)} ~ ${shMax.toFixed(2)}（配置区间 ${CONFIG.egg.shadeMin}~${CONFIG.egg.shadeMax}）`)
	if (shMax - shMin < 0.1) pupaProblems.push('30 颗卵的深浅几乎没有变化 —— shade 没生效')
	if (shMin < CONFIG.egg.shadeMin - 1e-9 || shMax > CONFIG.egg.shadeMax + 1e-9) {
		pupaProblems.push('卵的深浅超出了配置区间')
	}
	// 「不要太过于明显」：两个色之间的差距必须很小
	if (CONFIG.egg.shadeMax - CONFIG.egg.shadeMin > 0.6) {
		pupaProblems.push(`卵的深浅区间 ${CONFIG.egg.shadeMin}~${CONFIG.egg.shadeMax} 太宽，会看着像两种东西`)
	}

	// —— 5. 蛹比幼虫细长，像一粒米 ——
	//
	// ⚠ 幼虫那一侧必须带上 render 里的 **0.85 压扁系数**（ctx.scale(1, 0.85)），
	// 否则比的是「没压扁的幼虫」，而玩家看到的是压扁过的 ——
	// 第一次写这条断言就漏了它，结果判出来「蛹比幼虫细长」，
	// 而屏幕上的实际情况恰好相反：蛹比幼虫还胖。
	const pupaAspect = (slim) => lerp(P.widthFat, P.widthSlim, slim) / P.lengthScale
	const larvaOnScreen = (slim) => 2 * larvaWidthRatio(slim) * 0.85
	const rows = [0, 0.5, 1].map((slim) => `瘦度${slim}: 蛹 ${pupaAspect(slim).toFixed(2)} vs 幼虫 ${larvaOnScreen(slim).toFixed(2)}`)
	console.log(`  屏幕上的宽长比 —— ${rows.join('；')}`)
	for (const slim of [0, 0.5, 1]) {
		const pa = pupaAspect(slim)
		if (pa < 0.15 || pa > 0.32) pupaProblems.push(`瘦度 ${slim} 时蛹的宽长比 ${pa.toFixed(2)} 不在「米粒」的范围内（0.15~0.32）`)
		if (pa >= larvaOnScreen(slim)) pupaProblems.push(`瘦度 ${slim} 时蛹（${pa.toFixed(2)}）不比幼虫（${larvaOnScreen(slim).toFixed(2)}）细长`)
	}
}
console.log('')

// ---------------------------------------------------------------- 玻璃罐验证
console.log('—— 玻璃罐验证 ——')

const jarProblems = []
{
	// —— 1. 网得住、装得下、不会超容量 ——
	world.flies.length = 0
	world.jars.length = 0
	world.eggs.length = 0
	world.remains.length = 0

	const jar1 = world.addJar(W / 2, H / 2)
	const N = CONFIG.jar.capacity + 4
	for (let i = 0; i < N; i++) {
		world.addFly(W / 2 + rand(-20, 20), H / 2 + rand(-20, 20), i % 2 ? 'F' : 'M')
	}
	const caught = world.catchFlies(W / 2, H / 2)
	console.log(`  撒 ${N} 只围住罐子 → 网到 ${caught} 只，罐中 ${jar1.flies.length}/${jar1.capacity}，屏上还剩 ${world.flies.length}`)
	if (caught !== jar1.capacity) jarProblems.push(`一网应当只装到容量上限 ${jar1.capacity}，实际 ${caught}`)
	if (jar1.flies.length !== jar1.capacity) jarProblems.push(`罐中数量 ${jar1.flies.length} 与容量 ${jar1.capacity} 不符`)
	if (world.flies.length !== N - caught) jarProblems.push(`网走的果蝇没有从 world.flies 里移除（剩 ${world.flies.length}，应为 ${N - caught}）`)

	// 罐内位置必须是相对罐心的偏移，而且是散开的、不叠在中心
	const offs = jar1.flies.map((f) => Math.hypot(f.x, f.y))
	const maxOff = Math.max(...offs)
	const avgOff = offs.reduce((a, b) => a + b, 0) / offs.length
	console.log(
		`  罐内落点：平均离罐心 ${avgOff.toFixed(1)}px，最远 ${maxOff.toFixed(1)}px` +
			`（罐内半宽 ${jar1.innerHalfW.toFixed(0)}px / 半高 ${jar1.innerHalfH.toFixed(0)}px）`,
	)
	// 矩形罐子：要横竖分别判，不能像圆罐那样比半径
	if (jar1.flies.some((f) => Math.abs(f.x) > jar1.innerHalfW + 0.5 || Math.abs(f.y) > jar1.innerHalfH + 0.5)) {
		jarProblems.push('有果蝇被放到了罐子外面')
	}
	if (maxOff < Math.min(jar1.innerHalfW, jar1.innerHalfH) * 0.3) {
		jarProblems.push('罐中果蝇全挤在中心附近 —— admit() 的随机落点没生效')
	}

	// —— 2. 罐中配对：一对异性会生，但**卵产在罐外**；拍子依然打不进去 ——
	//
	// ⚠ 这一节原来是「完全隔离：不产卵」的守卫。罐子变成种蝇房之后那条
	//   契约**主动作废**了，所以断言反过来写。
	//   但「拍不到」这半边**没有变**，仍然要守着。
	//
	// ⚠⚠ 改写的时候发现旧断言其实是**假绿**的：它跑 20 秒，
	//   而成熟期 matureAge 正好是 20 秒 —— 那两只催熟过的不假，
	//   但就算不催熟也测不出东西。现在的断言必须真的跑到产出卵为止
	world.flies.length = 0
	world.jars.length = 0
	world.eggs.length = 0
	world.remains.length = 0
	world.larvae.length = 0

	const jar2 = world.addJar(600, 400)
	const male = world.addFly(600, 400, 'M')
	const female = world.addFly(620, 400, 'F')
	// 催熟，不然成熟度不够根本不会交配，测出来是假阳性
	for (const f of [male, female]) {
		f.age = CONFIG.adult.matureAge + 1000
		f.cooldown = 0
	}
	world.catchFlies(600, 400)

	const eggsBefore = world.stats.eggsLaid
	const swatted = world.swat(600, 400) // 直接拍罐子所在的坐标
	for (let i = 0; i < 60 * 20; i++) world.update(1 / 60)
	const eggsAfter = world.stats.eggsLaid

	console.log(
		`  一雌一雄关进罐子跑 20 秒：罐中还剩 ${jar2.flies.length} 只，期间产卵 ${eggsAfter - eggsBefore} 颗，` +
			`对着罐子挥拍打死 ${swatted} 只`,
	)
	if (jar2.flies.length !== 2) jarProblems.push('罐中的果蝇消失或死亡了 —— 检查 _updateJars 的收尸逻辑')
	if (swatted !== 0) jarProblems.push(`苍蝇拍拍到了罐中的果蝇（打死 ${swatted} 只）—— 罐子应当能挡住拍子`)

	// —— 2.1 罐中配对的正例：真的会生，而且卵在罐外 ——
	if (CONFIG.jar.mateInside) {
		if (eggsAfter === eggsBefore) {
			jarProblems.push(
				'罐中的一对成熟异性跑了 20 秒一颗卵都没生 —— ' +
					'检查 _tryJarMate 是不是被挂到了 _updateJars 里（那里跑在 60ms 闸门之前，' +
					'mateScanTimer 恒为 60，条件永远不成立）',
			)
		}
		// 双亲都还在罐里。⚠ 这一条守的是「产卵的是罐子、不是母体」：
		//   母体一旦进入 laying，她会收翅、而且被 canMate 永久挡住
		if (male.laying || male.laySite || female.laying || female.laySite) {
			jarProblems.push('罐中的果蝇进入了 laying 状态 —— 产卵的应当是罐子，母体不该收翅')
		}
		// 冷却两方都要上，而且按**墙钟**走（不是被 lifespanBonus 膨胀过的）
		if (!(male.cooldown > 0) || !(female.cooldown > 0)) {
			jarProblems.push('罐中配对之后双亲的冷却没有设上 —— 下一帧就会再配一次')
		}
		// 卵全部落在**罐子外面的底部**
		const outside = world.eggs.filter((e) => e.y > jar2.y + jar2.halfH * 0.6)
		if (world.eggs.length && outside.length !== world.eggs.length) {
			jarProblems.push(
				`罐中配对产下的卵有 ${world.eggs.length - outside.length} 颗落在罐子里面或上面 —— ` +
					'卵应当产在罐外的底部',
			)
		}
		// 而且要落在屏幕内（罐子可能贴着边）
		const margin = CONFIG.larva.margin
		const offscreen = world.eggs.filter(
			(e) => e.x < margin - 1 || e.x > W - margin + 1 || e.y < margin - 1 || e.y > H - margin + 1,
		)
		if (offscreen.length) {
			jarProblems.push(`罐中配对产下的卵有 ${offscreen.length} 颗落在屏幕边缘之外 —— 要夹进 larva.margin`)
		}
		// 母体身上**不该**留下这一窝的痕迹：_endClutch 永远不会为她跑，
		// 所以罐里这条路必须压根不写她那几个字段。
		//
		// ⚠ 这里原来查的是 `layMutations` / `fatherMutations` 两个字段 ——
		//   遗传去掉之后它们不存在了。但**这条断言的意图没变**：
		//   罐里这条路必须**压根不碰**母体身上那套产卵字段。
		//
		//   ⚠ 判据只认 `laying` 和 `layClutch`：这两个只有 beginClutch /
		//   startLaying 会写，罐里那条路用的 clutchPlan() 是**纯函数**，
		//   碰都不该碰。`layScale` 不能拿来判 —— 它产完一窝**本来就不复位**
		//   （_endClutch 只管前三个），拿它当判据会天天误报
		if (female.laying || female.layClutch !== 0) {
			jarProblems.push('罐中配对把母体的产卵状态写脏了（laying / layClutch）—— 会漏到下一窝')
		}
		console.log(
			`  罐中配对：产下 ${world.eggs.length} 颗卵，全部在罐外底部（罐底 y=${Math.round(jar2.y + jar2.halfH)}），` +
				`双亲都没进入产卵状态、冷却已设上`,
		)
	} else if (eggsAfter !== eggsBefore) {
		jarProblems.push('jar.mateInside 是关的，罐中果蝇却产卵了')
	}

	// —— 2.2 关掉 mateInside 就该退回「完全隔离」 ——
	{
		const savedMate = CONFIG.jar.mateInside
		CONFIG.jar.mateInside = false
		world.flies.length = 0
		world.jars.length = 0
		world.eggs.length = 0
		const jarOff = world.addJar(600, 400)
		for (const [x, sex] of [
			[600, 'M'],
			[620, 'F'],
		]) {
			const f = world.addFly(x, 400, sex)
			f.age = CONFIG.adult.matureAge + 1000
			f.cooldown = 0
			world.putInJar(jarOff, f)
		}
		const before = world.stats.eggsLaid
		for (let i = 0; i < 60 * 20; i++) world.update(1 / 60)
		if (world.stats.eggsLaid !== before) {
			jarProblems.push('mateInside 关掉之后罐中果蝇还在产卵 —— 那个开关没接上')
		}
		console.log('  罐中配对关掉（mateInside=false）：罐子退回纯收藏柜，20 秒一颗卵都没有')
		CONFIG.jar.mateInside = savedMate
		world.flies.length = 0
		world.jars.length = 0
		world.eggs.length = 0
	}

	// —— 2.3 冷却按墙钟走，不被罐中的时间膨胀拉长 ——
	//
	// 罐里的年龄推进是 1/lifespanBonus 倍，但**冷却不是**：它是 90 秒的
	// 实时闸门，跟寿命膨胀是两回事。写错的话罐里那对 180 秒才能再配一次
	{
		const jarCd = world.addJar(600, 400)
		const cdFly = world.addFly(600, 400, 'F')
		cdFly.age = CONFIG.adult.matureAge + 1000
		cdFly.cooldown = 4000
		world.putInJar(jarCd, cdFly)
		for (let i = 0; i < 60; i++) world.update(1 / 60) // 1 秒
		const spent = 4000 - cdFly.cooldown
		if (Math.abs(spent - 1000) > 60) {
			jarProblems.push(
				`罐中 1 秒只走掉了 ${spent.toFixed(0)}ms 冷却（应当是 1000）—— ` +
					'冷却被 lifespanBonus 一起膨胀了，那会让罐里那对多等一倍时间',
			)
		} else {
			console.log(`  罐中冷却按墙钟走：1 秒扣掉 ${spent.toFixed(0)}ms（期望 1000）`)
		}
		world.flies.length = 0
		world.jars.length = 0
		world.eggs.length = 0
	}

	// —— 2.4 端到端：罐里生出来的卵要能孵出幼虫 ——
	{
		const jarE2E = world.addJar(900, 500)
		for (const [x, sex] of [
			[900, 'M'],
			[915, 'F'],
		]) {
			const f = world.addFly(x, 500, sex)
			f.age = CONFIG.adult.matureAge + 1000
			f.cooldown = 0
			world.putInJar(jarE2E, f)
		}
		let hatched = false
		for (let i = 0; i < 60 * 60 * 20 && !hatched; i++) {
			world.update(1 / 60)
			hatched = world.larvae.length > 0
		}
		if (!hatched) jarProblems.push('罐中配对产下的卵跑了 20 分钟也没孵出幼虫 —— 整条链没接上')
		else console.log(`  罐中配对端到端：卵孵出了 ${world.larvae.length} 只幼虫`)
		world.flies.length = 0
		world.jars.length = 0
		world.eggs.length = 0
		world.larvae.length = 0
	}

	// —— 2.5 罐中飞行：会飞、飞得起来、但别飞出罐子也别飞太快 ——
	//
	// 「能飞但不会飞太快」是个手感要求，只能实测：
	// 看速度分布落在哪，以及有没有撞穿玻璃跑出去。
	world.flies.length = 0
	world.jars.length = 0
	world.eggs.length = 0
	world.remains.length = 0

	const jarFly = world.addJar(W / 2, H / 2)
	for (let i = 0; i < 4; i++) {
		const f = world.addFly(W / 2, H / 2, i % 2 ? 'F' : 'M')
		if (f) world.putInJar(jarFly, f)
	}

	let speedSum = 0
	let speedMax = 0
	let samples = 0
	let moving = 0
	let escaped = 0
	for (let i = 0; i < 60 * 30; i++) {
		world.update(1 / 60)
		for (const f of jarFly.flies) {
			const sp = Math.hypot(f.vx, f.vy)
			speedSum += sp
			samples++
			if (sp > speedMax) speedMax = sp
			if (sp > 10) moving++
			// 留 1px 容差：反射是「贴到边界再翻速度」，边界上那一帧正好等于半宽
			if (Math.abs(f.x) > jarFly.innerHalfW + 1 || Math.abs(f.y) > jarFly.innerHalfH + 1) escaped++
		}
	}
	const avgSpeed = speedSum / Math.max(1, samples)
	const moveShare = (moving / Math.max(1, samples)) * 100
	console.log(
		`  罐中飞行 30 秒：平均 ${avgSpeed.toFixed(0)}px/s，峰值 ${speedMax.toFixed(0)}px/s` +
			`（配置 ${CONFIG.jar.flySpeedMin}~${CONFIG.jar.flySpeedMax}），${moveShare.toFixed(0)}% 的时间在动`,
	)
	if (!jarFly.flies.every((f) => f.mode === 'fly')) jarProblems.push('罐中果蝇不是飞行状态 —— 翅膀会是收拢的')
	if (avgSpeed < 20) jarProblems.push(`罐中果蝇几乎不动（平均 ${avgSpeed.toFixed(0)}px/s）`)
	// 超过配置上限说明指数趋近失控了；跟外面 300~1700px/s 的巡航比，
	// 这里必须低一个数量级，否则在罐子里就是一道影子
	if (speedMax > CONFIG.jar.flySpeedMax * 1.15) {
		jarProblems.push(`罐中飞行峰值 ${speedMax.toFixed(0)}px/s，超过了配置上限 ${CONFIG.jar.flySpeedMax}`)
	}
	if (escaped > 0) jarProblems.push(`罐中果蝇飞出罐子 ${escaped} 帧 —— 矩形边界反射有问题`)

	// —— 3. 寿命 1.5 倍：实测，不是看配置 ——
	//
	// 给两只果蝇强制同一个 lifespan，一只放进罐子、一只留在外面，
	// 然后一起跑到各自老死，比较**实际经过的真实时间**。
	//
	// 只断言「lifespan 有没有被乘 1.5」是不够的：那个数字对了，
	// 但年龄推进速度没跟着改的话，果蝇该死的时候照样死。
	world.flies.length = 0
	world.jars.length = 0
	world.eggs.length = 0
	world.remains.length = 0

	const LIFESPAN = 60 * SEC
	const freeFly = world.addFly(200, 200, 'M')
	const cagedFly = world.addFly(400, 200, 'F')
	for (const f of [freeFly, cagedFly]) {
		f.lifespan = LIFESPAN
		f.age = 0
	}
	const jar3 = world.addJar(400, 500)
	world.putInJar(jar3, cagedFly)

	let freeDies = null
	let cagedDies = null
	let t = 0
	while ((freeDies === null || cagedDies === null) && t < 400) {
		world.update(1 / 60)
		t += 1 / 60
		if (freeDies === null && freeFly.dead) freeDies = t
		if (cagedDies === null && cagedFly.dead) cagedDies = t
	}

	const ratio = cagedDies / freeDies
	console.log(`  同寿命 ${LIFESPAN / 1000} 秒的两只：外面活 ${freeDies.toFixed(1)}s，罐里活 ${cagedDies.toFixed(1)}s，比值 ${ratio.toFixed(2)}（配置 ${CONFIG.jar.lifespanBonus}）`)
	if (Math.abs(ratio - CONFIG.jar.lifespanBonus) > 0.08) {
		jarProblems.push(`罐中寿命倍率实测 ${ratio.toFixed(2)}，配置是 ${CONFIG.jar.lifespanBonus} —— 检查 updateJarred 里的年龄推进`)
	}

	// —— 4. 放逐：回到屏幕，并且恢复正常的年龄推进速度 ——
	world.flies.length = 0
	world.jars.length = 0
	const jar4 = world.addJar(500, 500)
	const guest = world.addFly(500, 500, 'F')
	guest.lifespan = LIFESPAN
	guest.age = 0
	world.putInJar(jar4, guest)

	// 在罐里先待 10 秒
	for (let i = 0; i < 60 * 10; i++) world.update(1 / 60)
	const agedInJar = guest.age

	world.releaseFly(jar4, guest)
	const backOnScreen = world.flies.includes(guest)
	const stillCaged = world.jarOf(guest) !== null

	for (let i = 0; i < 60 * 10; i++) world.update(1 / 60)
	const agedOutside = guest.age - agedInJar

	console.log(`  放逐：罐里待 10 秒长了 ${(agedInJar / 1000).toFixed(1)}s 年龄，放出来再 10 秒长了 ${(agedOutside / 1000).toFixed(1)}s`)
	if (!backOnScreen) jarProblems.push('放逐后没有回到 world.flies')
	if (stillCaged) jarProblems.push('放逐后仍然被认为在罐子里')
	if (Math.abs(agedInJar / 1000 - 10 / CONFIG.jar.lifespanBonus) > 0.5) {
		jarProblems.push(`罐中 10 秒实际只长了 ${(agedInJar / 1000).toFixed(1)}s 年龄，时间膨胀不对`)
	}
	if (Math.abs(agedOutside / 1000 - 10) > 0.5) {
		jarProblems.push(`放逐后 10 秒长了 ${(agedOutside / 1000).toFixed(1)}s 年龄 —— 年龄推进速度没有恢复正常`)
	}

	// —— 4.5 罐中列表里的「出售」和「扔罐子」——
	//
	// 这两条都是 UI 会直接踩到的路径，而且都很容易只写一半：
	//   出售：罐中果蝇不在 world.flies 里，sellFly 只查那个数组的话会静默返回 0
	//   扔罐：早先 discardJar 是 jar.flies.length = 0，整罐的蝇跟着没了
	//
	// ⚠ 下面几段要把世界的罐子清空重来，而**第 5 节「存档往返」还要用 jar4**
	// （它拿 world.jars[0] 和存档里的比对）。所以这里先存后还 ——
	// 不还的话，第 5 节会拿到一个空数组，报的是「存档往返后罐子数量对不上」，
	// 一个和存档毫无关系的假故障
	const keepJars = world.jars.slice()
	world.jars.length = 0
	world.flies.length = 0
	world.money = 0

	const jar5 = world.addJar(600, 500)
	const keepA = world.addFly(600, 500, 'F')
	const keepB = world.addFly(600, 500, 'M')
	const sellMe = world.addFly(600, 500, 'F')
	world.putInJar(jar5, keepA)
	world.putInJar(jar5, keepB)
	world.putInJar(jar5, sellMe)
	for (const f of jar5.flies) f.age = f.lifespan // 满成长，价钱是个确定的数
	const wantGain = sellMe.value

	const gotGain = world.sellFly(sellMe)
	console.log(
		`  卖罐里的（${sellMe.weight.toFixed(2)}mg）：+${formatMoney(gotGain)}，罐里剩 ${jar5.flies.length} 只，钱 ${formatMoney(world.money)}`,
	)
	if (Math.abs(gotGain - wantGain) > 1e-9) jarProblems.push('卖罐中果蝇给的钱和它的 value 对不上')
	if (jar5.flies.includes(sellMe)) jarProblems.push('卖掉之后它还留在罐子里')
	if (!sellMe.dead) jarProblems.push('卖掉之后罐中果蝇没有被标记 dead')
	if (Math.abs(world.money - wantGain) > 1e-9) jarProblems.push('卖罐中果蝇的钱没有进 world.money')
	// 再卖一次不能再给钱
	if (world.sellFly(sellMe) !== 0) jarProblems.push('重复出售同一只罐中果蝇又给了一次钱')

	// 扔罐子：里面的必须**全被放出来**，一个都不能少
	const beforeCount = world.flies.length
	const insideCount = jar5.flies.length
	world.discardJar(jar5)
	console.log(
		`  扔罐子：罐里 ${insideCount} 只全部放回屏幕，屏上 ${beforeCount} → ${world.flies.length}，罐子剩 ${world.jars.length} 个`,
	)
	if (world.flies.length !== beforeCount + insideCount) {
		jarProblems.push(
			`扔罐子后屏上只多了 ${world.flies.length - beforeCount} 只，罐里原本有 ${insideCount} 只 —— 有果蝇被连罐删掉了`,
		)
	}
	if (world.jars.includes(jar5)) jarProblems.push('扔掉的罐子还留在 world.jars 里')
	if (world.jarOf(keepA) || world.jarOf(keepB)) jarProblems.push('扔罐子后还有果蝇被认为在罐里')
	// 放出来的必须真的能飞，而不是留个死引用在旁边
	for (const f of [keepA, keepB]) {
		if (f.dead) jarProblems.push('扔罐子把里面的果蝇标记成死了 —— 应当只是放出来')
		if (!world.flies.includes(f)) jarProblems.push('扔罐子后放出来的果蝇不在 world.flies 里')
	}

	// 把第 5 节要用的罐子还回去（见上面 keepJars 那段说明）
	world.jars.length = 0
	for (const j of keepJars) world.jars.push(j)
	world.flies.length = 0

	// —— 5. 存档往返：罐子连里面的果蝇一起，坐标要原样 ——
	//
	// 先把罐子重新装满。上一步的放逐把 jar4 掏空了，
	// 空罐子做往返测试是测不到嵌套果蝇的 —— 数量 0→0 当然对得上，
	// 而真正会出错的地方（罐内坐标有没有被 admit() 重新随机）根本没被执行
	for (let i = 0; i < 3; i++) {
		const f = world.addFly(500 + rand(-10, 10), 500 + rand(-10, 10), i % 2 ? 'F' : 'M')
		if (f) world.putInJar(jar4, f)
	}
	// 再让它们在罐里走一会儿，坐标就不会是恰好落在圆心附近的对称值，
	// 万一两边都用同一套公式「重算」位置，也能被看出来
	for (let i = 0; i < 60 * 3; i++) world.update(1 / 60)

	const snap = JSON.parse(JSON.stringify(world.serialize()))
	const back = new World(W, H)
	back.restore(snap)

	const srcJar = world.jars[0]
	const dstJar = back.jars[0]
	const sameCount = srcJar && dstJar && srcJar.flies.length === dstJar.flies.length
	// 位置必须**逐字段完全一致**：restore 里如果误用了 jar.admit()，
	// 果蝇会被重新随机到新的位置，数量照样对得上，但状态已经不是原来那个了
	const samePos =
		sameCount && srcJar.flies.every((f, i) => Math.abs(f.x - dstJar.flies[i].x) < 1e-9 && Math.abs(f.y - dstJar.flies[i].y) < 1e-9)
	console.log(`  存档往返：罐子 ${world.jars.length}→${back.jars.length}，罐中果蝇 ${srcJar?.flies.length ?? 0}→${dstJar?.flies.length ?? 0}，位置${samePos ? '原样' : '对不上'}`)
	if (world.jars.length !== back.jars.length) jarProblems.push('存档往返后罐子数量对不上')
	if (!sameCount) jarProblems.push('存档往返后罐中果蝇数量对不上')
	if (!samePos) jarProblems.push('存档往返后罐中果蝇的坐标变了 —— restore 里可能误用了 admit()')
}
console.log('')

// ---------------------------------------------------------------- 经济验证
console.log('—— 经济验证 ——')

const moneyProblems = []
{
	const M = CONFIG.market

	// —— 1. 稀有度分布 ——
	//
	// 抽 20000 次。二项分布下 4.5% 那档的标准差约 0.15%，0.5% 那档约 0.05%，
	// 所以容差给 ±0.6% / ±0.3% 足够宽 —— 能挡住「比例写错了」这种量级的错误，
	// 又不会因为随机波动误报
	const N = 20000
	const counts = {}
	for (const t of M.rarity) counts[t.id] = 0
	for (let i = 0; i < N; i++) counts[rollRarity()]++

	const dist = M.rarity.map((t) => `${t.name} ${((counts[t.id] / N) * 100).toFixed(2)}%`).join(' / ')
	console.log(`  抽 ${N} 次：${dist}（配置 ${M.rarity.map((t) => (t.chance * 100).toFixed(1) + '%').join(' / ')}）`)
	for (const t of M.rarity) {
		const got = counts[t.id] / N
		if (Math.abs(got - t.chance) > 0.006) {
			moneyProblems.push(`「${t.name}」实际出现率 ${(got * 100).toFixed(2)}%，配置是 ${(t.chance * 100).toFixed(1)}%`)
		}
	}
	// 三档之和必须是 1 —— 不是的话 rollRarity 末尾的兜底会把差额全给最后一档
	const sum = M.rarity.reduce((a, t) => a + t.chance, 0)
	if (Math.abs(sum - 1) > 1e-9) moneyProblems.push(`market.rarity 的 chance 之和是 ${sum}，必须是 1`)

	// —— 2. 体重曲线 ——
	world.flies.length = 0
	world.larvae.length = 0
	world.eggs.length = 0
	world.foods.length = 0
	world.remains.length = 0
	world.jars.length = 0

	const wFly = world.addFly(400, 300, 'F', 'normal')
	const growths = [0, 0.25, 0.5, 0.75, 1].map((g) => {
		wFly.age = wFly.lifespan * g
		return wFly.weight
	})
	console.log(
		`  体重随成长（普通，满成长上限 ${wFly.weightMax.toFixed(3)}mg）：` +
			growths.map((w, i) => `${[0, 25, 50, 75, 100][i]}%→${w.toFixed(3)}`).join(' ') + ' mg',
	)
	if (Math.abs(growths[0] - M.birthWeight) > 1e-9) {
		moneyProblems.push(`刚羽化的体重应当是 ${M.birthWeight}mg，实际 ${growths[0].toFixed(3)}`)
	}
	if (Math.abs(growths[4] - wFly.weightMax) > 1e-9) {
		moneyProblems.push(`满成长时体重应当等于 weightMax（${wFly.weightMax.toFixed(3)}），实际 ${growths[4].toFixed(3)}`)
	}
	for (let i = 1; i < growths.length; i++) {
		if (growths[i] < growths[i - 1] - 1e-9) moneyProblems.push('体重没有随成长单调增加')
	}
	// 满成长的体重必须落在它那一档的区间里
	for (const t of M.rarity) {
		for (let i = 0; i < 200; i++) {
			const w = rollWeightMax(t.id)
			if (w < t.weightMin - 1e-9 || w > t.weightMax + 1e-9) {
				moneyProblems.push(`「${t.name}」抽出了区间外的 weightMax ${w}`)
				break
			}
		}
	}

	// —— 3. 体重**不影响体型** ——
	world.flies.length = 0
	const sNorm = world.addFly(300, 300, 'M', 'normal')
	const sBig = world.addFly(340, 300, 'M', 'extreme')
	for (const f of [sNorm, sBig]) f.age = f.lifespan * 0.5
	console.log(`  体型不受体重影响：普通 ${sNorm.size.toFixed(2)}px vs 极端变异 ${sBig.size.toFixed(2)}px`)
	if (Math.abs(sNorm.size - sBig.size) > 1e-9) moneyProblems.push('体重影响到了体型 —— 按需求它只该影响速度')

	// —— 4. 体重影响速度（飞行 / 爬行 / 罐中，三条路都要） ——
	//
	// 直接量**收敛后的速度**，而不是只看 speedScale 这个 getter ——
	// getter 对了但某条移动路径没乘上，是这套改动最容易出的漏。
	//
	// ⚠ 单位：`world.update(rawDt)` 收的是**秒**，而 `fly.update(dtMs, world)`
	// 收的是**毫秒**（整个项目都这样，见 entities.js 顶部那段约定）。
	// 第一次写这里时两处都传了 STEP，结果爬行量出来是 0 px/s ——
	// 而 0/0 得到 NaN，`Math.abs(NaN - 0.6) > 0.05` 又是 false，
	// 断言**静悄悄地通过了**。所以下面每个比值都先查一遍分母是不是有效数
	const STEP_MS = STEP * 1000
	const settle = (fly, mode, frames = 90) => {
		fly.mode = mode
		fly.targetSpeed = 1000
		fly.dartTimer = 1e9 // 别中途重抽
		fly.modeTimer = 1e9 // 别飞/走切换
		fly.hoverTimer = 0
		fly.boutTimer = 1e9
		fly.pausing = false
		fly.aim = 0
		fly.angle = 0
		fly.vx = 0
		fly.vy = 0
		// ⚠ 这两个也必须钉住，否则量出来的不是「速度倍率」而是别的什么：
		//
		//   bait  —— 闻到食物会转去 _forage，那条路上速度乘 feedSpeedScale，
		//            而三只探针分别站在 (300,300)/(300,600)/(300,900)，
		//            有没有蹭到前面几节留下的烂果子纯看运气
		//   startleMul —— 被鼠标挥手吓到时的临时倍率。世界里的值由
		//            _applyStartle() 每帧重写，但这里直接调 fly.update()，
		//            绕过了它，于是上一节留下的值会一直挂在身上
		//
		// 症状都是**偶发**的：跑十次红一次，报的是「变异的速度倍率是 0.47」，
		// 看着像 speedScale 的取值错了，其实是这一只恰好走了另一条路
		fly.bait = null
		fly.startleMul = 1

		let path = 0
		let px = fly.x
		let py = fly.y
		for (let i = 0; i < frames; i++) {
			// ⚠ 每一帧都要重新钉，**上面那几行一次性赋值是不够的**。
			//   `Fly.update` 开头会自己重算 `this.bait = world.nearestFood(...)`，
			//   于是只要探测点附近有果子，它照样会拐进 `_forage` ——
			//   那条路上爬行速度要再乘一个 feedSpeedScale(0.6)。
			//
			//   症状是比值落在 0.6 和 1.0 之间的某个怪数上（实测 0.53），
			//   因为「90 帧里有二十几帧在觅食」—— 看起来完全不像速度公式的问题。
			//   下面 jarSpeed 那个探针一直是每帧钉的，这里以前只钉了一次
			fly.bait = null
			fly.feeding = false
			fly.startleMul = 1
			fly.update(STEP_MS, world)
			path += Math.hypot(fly.x - px, fly.y - py)
			px = fly.x
			py = fly.y
		}
		// 飞行量瞬时速度（指数趋近的目标），爬行量**累计路程 ÷ 时间** ——
		// 用首尾直线距离的话，随机游走拐几个弯就会量少一截
		return mode === 'fly' ? Math.hypot(fly.vx, fly.vy) : path / (frames * STEP)
	}
	/** 比值，分母无效时返回 NaN —— 由调用方当成失败处理，而不是静默放过去 */
	const ratio = (a, b) => (a > 1e-6 && b > 1e-6 ? a / b : NaN)

	world.flies.length = 0
	// ⚠ 把食物清空。这是让上面那组探针**确定**不觅食的唯一可靠办法。
	//
	// 光在 settle 里钉 `fly.bait = null` 是不够的：`_forage` 是在
	// `Fly.update` 里被调用的，它会在**同一帧内**把 `feeding` 置真，
	// 而 `_walk` 接着就读它算速度 —— 也就是说，无论在外面怎么提前钉，
	// 都拦不住这一帧的觅食。
	//
	// 症状：三个探针站在不同的位置，附近有果子的那两个爬得慢，
	// 比值同时缩水到 0.49 / 0.24（都乘了同一个 0.816），
	// 看起来像 speedScale 算错了。实测每十五次红一次。
	// 三个探针都在 x=300 这一列，清掉食物之后谁都不会拐去吃
	world.foods.length = 0
	const fNorm = world.addFly(300, 300, 'M', 'normal')
	const fMut = world.addFly(300, 600, 'M', 'mutant')
	const fExt = world.addFly(300, 900, 'M', 'extreme')
	const vFly = [settle(fNorm, 'fly'), settle(fMut, 'fly'), settle(fExt, 'fly')]
	const vWalk = [settle(fNorm, 'walk'), settle(fMut, 'walk'), settle(fExt, 'walk')]
	const rFlyMut = ratio(vFly[1], vFly[0])
	const rFlyExt = ratio(vFly[2], vFly[0])
	const rWalkMut = ratio(vWalk[1], vWalk[0])
	const rWalkExt = ratio(vWalk[2], vWalk[0])
	console.log(
		`  飞行速度：普通 ${vFly[0].toFixed(0)} / 变异 ${vFly[1].toFixed(0)} / 极端 ${vFly[2].toFixed(0)} px/s ` +
			`（倍率 ${rFlyMut.toFixed(2)} / ${rFlyExt.toFixed(2)}）`,
	)
	console.log(
		`  爬行速度：普通 ${vWalk[0].toFixed(0)} / 变异 ${vWalk[1].toFixed(0)} / 极端 ${vWalk[2].toFixed(0)} px/s ` +
			`（倍率 ${rWalkMut.toFixed(2)} / ${rWalkExt.toFixed(2)}）`,
	)
	for (const [label, m, e] of [
		['飞行', rFlyMut, rFlyExt],
		['爬行', rWalkMut, rWalkExt],
	]) {
		if (!(Math.abs(m - 0.6) <= 0.05)) moneyProblems.push(`${label}时变异的速度倍率是 ${m}，应当是 0.6`)
		if (!(Math.abs(e - 0.3) <= 0.05)) moneyProblems.push(`${label}时极端变异的速度倍率是 ${e}，应当是 0.3`)
	}

	// 罐中那条路是另一套代码（updateJarred），单独量一次
	world.flies.length = 0
	world.jars.length = 0
	const jar = world.addJar(600, 400)
	const jNorm = world.addFly(600, 400, 'M', 'normal')
	const jExt = world.addFly(600, 400, 'M', 'extreme')
	world.catchFlies(600, 400)
	// ⚠ 罐子只有 280×410，以 1000px/s 飞的话几帧就撞墙；而**撞墙会把
	// dartTimer 重置成 0.25~0.9 秒**，到期后又重抽 targetSpeed（罐内是 60~150）。
	// 于是量出来的根本不是「速度倍率有没有生效」，而是「最后一帧恰好抽到了多少」——
	// 第一次跑就量到 0.03 这种莫名其妙的比值。
	//
	// 所以每帧都把它按回统一状态，只让 speedScale 这一个变量起作用。
	// 撞墙仍然会翻速度的符号，但**不改大小**，而这里量的是大小
	const jarSpeed = (fly) => {
		fly.vx = 0
		fly.vy = 0
		// 同样注意单位：updateJarred 收的也是毫秒
		for (let i = 0; i < 90; i++) {
			fly.targetSpeed = 1000
			fly.dartTimer = 1e9
			fly.hoverTimer = 0
			fly.updateJarred(STEP_MS, jar)
		}
		return Math.hypot(fly.vx, fly.vy)
	}
	const jvN = jarSpeed(jNorm)
	const jvE = jarSpeed(jExt)
	const rJar = ratio(jvE, jvN)
	console.log(`  罐中速度：普通 ${jvN.toFixed(0)} / 极端 ${jvE.toFixed(0)} px/s（倍率 ${rJar.toFixed(2)}）`)
	if (!(Math.abs(rJar - 0.3) <= 0.05)) moneyProblems.push(`罐中极端变异的速度倍率是 ${rJar}，应当是 0.3`)

	// —— 5. 售价公式与分档边界 ——
	if (Math.abs(priceOf(1.4) - 0.014) > 1e-9) moneyProblems.push('售价公式不对：1.4mg 应当值 $0.014')
	if (Math.abs(priceOf(10000) - 100) > 1e-6) moneyProblems.push('售价公式不对：10000mg 应当值 $100')

	const tiers = M.valueTiers
	let tierOk = true
	for (let i = 0; i < tiers.length; i++) {
		const t = tiers[i]
		if (valueTierOf(t.upper) !== t) tierOk = false
		if (i + 1 < tiers.length && valueTierOf(t.upper + 0.0001) !== tiers[i + 1]) tierOk = false
	}
	// 超出最后一档也应当归最后一档，而不是 undefined
	if (valueTierOf(1e9) !== tiers[tiers.length - 1]) tierOk = false
	if (!tierOk) moneyProblems.push('价值分档的边界对不上 config.market.valueTiers')

	// 从最便宜到最贵，档位必须单调 —— 排错了的话会静默地和别的档重叠
	for (let i = 1; i < tiers.length; i++) {
		if (tiers[i].upper <= tiers[i - 1].upper) moneyProblems.push('valueTiers 没有按上界升序排列')
	}

	// —— 六档的**名字和顺序**要和约定的完全一致 ——
	//
	// ⚠ 这条是防「改了一处忘了另一处」的：名字同时被数据面板、
	//   养蝇人配置卡（「卖哪档」那一行）、README 的表格引用。
	//   把「极稀有」和「超级稀有」写反、或者中间漏掉一档，
	//   代码全都照跑不误，只有玩家会看到一句对不上价钱的评语。
	//   所以这里把**期望的完整序列**抄一遍当基准 —— 这一份是刻意的重复，
	//   不是可以「去重」的地方
	const WANT_TIER_NAMES = ['普通', '罕见', '稀有', '极稀有', '超级稀有', '传说生物']
	const gotNames = tiers.map((t) => t.name)
	if (gotNames.join('|') !== WANT_TIER_NAMES.join('|')) {
		moneyProblems.push(
			`价值分档的名字是 [${gotNames.join(' / ')}]，应当是 [${WANT_TIER_NAMES.join(' / ')}]`,
		)
	}
	// id 和颜色也不能重复：重复的 id 会让养蝇人的筛选同时选中两档，
	// 重复的颜色会让玩家在两个档位之间看不出区别
	for (const key of ['id', 'name', 'color']) {
		const seen = new Set()
		for (const t of tiers) {
			if (seen.has(t[key])) moneyProblems.push(`valueTiers 里有重复的 ${key}：${t[key]}`)
			seen.add(t[key])
		}
	}

	// —— 六档「取不到」的两种情况要分开对待 ——
	//
	// ⚠ 这条是两个完全不同的故障，**不能混成一条**：
	//
	//   A. **分界划歪了** —— 某一档的上下界之间压根没有能养出来的东西。
	//      那是 bug，必须红。（最早的六档版就是这样：红 / 淡彩的上界是
	//      $1000 / $10000，而当时最贵的极端变异正好 $100，那两档从来没亮过。）
	//
	//   B. **整档在天花板之上** —— 那一档的下界本身就超过了全局最高售价。
	//      这不是划歪了，是**数值还没调到那儿**（比如「传说生物 > $1000」
	//      配「天花板 $429」）。它不该让 sim 变红 —— 那会逼着人要么删档、
	//      要么把断言删掉 —— 但**也绝不能静默通过**，
	//      所以打印出来，并附带一句「调哪个数才能让它亮」
	//
	// 做法是**真的抽**：按每个体重档的区间抽满成长体重，换算成售价看落哪一档；
	// 再叠上突变倍率（石化 ×1.5 体重、炫彩 ×2、金 ×1.3）重抽一遍。
	// 倍率从 CONFIG.mutation.types 现算，不在测试里另抄一份 ——
	// 抄一份的话，改了 config 而测试还按老倍率算，这条就会假绿
	const hitTiers = new Set()
	const tiersFromW = (mul) => {
		for (const r of M.rarity) {
			for (let i = 0; i < 300; i++) {
				hitTiers.add(valueTierOf(priceOf(rollWeightMax(r.id)) * mul).id)
			}
		}
	}
	tiersFromW(1)
	// 突变叠满的自身倍率：valueMul 和 weightMul 都直接体现在体重 → 售价上
	const maxMutMul = MUTATION_TYPES.reduce(
		(m, t) => m * (t.valueMul ?? 1) * (t.weightMul ?? 1),
		1,
	)
	tiersFromW(maxMutMul)

	// —— 全局天花板：最重的体格 × 突变叠满 × 金光光环 ——
	//
	// 全部从 config 现算：哪个数被调了，天花板和下面的判断都会跟着动。
	// ⚠ 光环那一项取的是**所有突变里最大的 auraMul**（目前只有点石成金有），
	//   不是硬写 1.1 —— 加一种带光环的突变时这里会自动跟上
	const ceiling =
		Math.max(...M.rarity.map((r) => priceOf(r.weightMax))) *
		maxMutMul *
		Math.max(1, ...MUTATION_TYPES.map((t) => t.auraMul ?? 1))

	// 分两类。判据是**这一档的下界**（= 上一档的上界）有没有超过天花板：
	//   · 下界 > 天花板 → 整档都在够不着的地方，属于 B 类，只提示
	//   · 下界 ≤ 天花板 → 本该有东西落进来却没有，属于 A 类，报错
	const outOfReach = []
	const misdrawn = []
	for (let i = 0; i < tiers.length; i++) {
		const t = tiers[i]
		if (hitTiers.has(t.id)) continue
		const floor = i === 0 ? -Infinity : tiers[i - 1].upper
		if (floor > ceiling) outOfReach.push(t)
		else misdrawn.push(t)
	}

	if (misdrawn.length) {
		moneyProblems.push(
			`这几档价值取不到，但天花板（${formatMoney(ceiling)}）明明够得着 —— ` +
				`分界要按「实际能养出什么」重新划：${misdrawn.map((t) => t.name).join('、')}`,
		)
	}

	// 实测几个代表值落在哪一档，打印出来好对
	const samples = [0.002, 0.014, 0.06, 0.5, 1.5, 50, 300, 1500]
	console.log(
		`  价值分档（${tiers.length} 档，实际能取到 ${hitTiers.size} 档）：` +
			samples.map((v) => `${formatMoney(v)}→${valueTierOf(v).name}`).join('  '),
	)
	console.log(`  售价天花板：${formatMoney(ceiling)}（最重的体格 × 突变叠满 × 金光光环）`)
	if (outOfReach.length) {
		console.log(
			`  ⚠ 够不着的档：${outOfReach.map((t) => t.name).join('、')} —— ` +
				`下界在天花板之上，现在一只都养不出来。` +
				`想让它亮，把 market.pricePerMg 调大，或抬高 rarity.extreme.weightMax`,
		)
	}

	// —— 5b. 罐子的一键出售 / 一键放逐 ——
	//
	// ⚠ 这一节钉的是「**逐罐 slice 副本**」那个写法。两个方法都会在遍历中
	//   splice 掉正在看的那只，直接遍历原数组会跳着走、漏掉一半 ——
	//   而症状是「点了全部出售，罐子里还剩几只」，看起来像没卖干净
	{
		const wB = new World(W, H)
		wB.reset()
		wB.flies.length = 0
		wB.larvae.length = 0
		wB.foods.length = 0
		wB.jars.length = 0

		// 摆三个罐子，每个塞不同数量的果蝇（1 / 2 / 3）——
		// 单一数量的话，「跳着走」正好会漏掉偶数只，可能碰巧看不出来
		const counts = [1, 2, 3]
		const all = []
		for (let i = 0; i < counts.length; i++) {
			const jar = wB.addJar(300 + i * 400, 400)
			if (!jar) {
				moneyProblems.push('批量操作测试：造不出罐子')
				break
			}
			for (let k = 0; k < counts[i]; k++) {
				const f = wB.addFly(300 + i * 400, 400, k % 2 ? 'M' : 'F', 'normal', [])
				if (!f) {
					moneyProblems.push('批量操作测试：造不出果蝇')
					break
				}
				jar.admit(f)
				const fi = wB.flies.indexOf(f)
				if (fi >= 0) wB.flies.splice(fi, 1)
				all.push(f)
			}
		}
		const total = counts.reduce((a, b) => a + b, 0)
		const inJars = () => wB.jars.reduce((n, j) => n + j.flies.length, 0)
		if (inJars() !== total) {
			moneyProblems.push(`批量操作测试：罐子里只有 ${inJars()} 只，应当是 ${total} 只`)
		}

		// —— 全部放逐 ——
		const freed = wB.releaseAllInJars()
		if (freed !== total) moneyProblems.push(`releaseAllInJars 放走了 ${freed} 只，应当是 ${total} 只`)
		if (inJars() !== 0) moneyProblems.push(`全部放逐之后罐子里还剩 ${inJars()} 只 —— 遍历时跳着走了`)
		const backOnScreen = all.filter((f) => wB.flies.includes(f)).length
		if (backOnScreen !== total) {
			moneyProblems.push(`全部放逐之后只有 ${backOnScreen}/${total} 只回到了 world.flies`)
		}

		// —— 全部出售 ——
		// 再塞回去，这次整批卖掉，钱要对得上
		for (const f of all) {
			const jar = wB.jarOf(f) || wB.jars[0]
			jar.admit(f)
			const fi = wB.flies.indexOf(f)
			if (fi >= 0) wB.flies.splice(fi, 1)
		}
		const wantGain = Math.round(all.reduce((s, f) => s + f.value, 0) * 1000) / 1000
		const moneyBefore = wB.money
		const sold = wB.sellAllInJars()
		if (sold.count !== total) {
			moneyProblems.push(`sellAllInJars 卖了 ${sold.count} 只，应当是 ${total} 只 —— 遍历时跳着走了`)
		}
		if (Math.abs(sold.gain - wantGain) > 1e-6) {
			moneyProblems.push(`sellAllInJars 报的金额 ${sold.gain}，按每只售价加起来应当是 ${wantGain}`)
		}
		// money 是逐只累加的，gain 是累加后统一 round 的，允许差半个最小单位
		if (Math.abs(wB.money - moneyBefore - wantGain) > 0.002) {
			moneyProblems.push('sellAllInJars 之后余额不对 —— 钱没有真的进账')
		}
		if (inJars() !== 0) moneyProblems.push(`全部出售之后罐子里还剩 ${inJars()} 只`)
		console.log(
			`  罐子批量：${counts.join('+')} 只分散在 3 个罐子里 → 放逐 ${freed} 只、出售 ${sold.count} 只换 ${formatMoney(sold.gain)}`,
		)
	}

	// —— 6. 货币格式 ——
	const fmCases = [
		[0, '$0.000'],
		[0.001, '$0.001'],
		[0.014, '$0.014'],
		[1234.5, '$1,234.500'],
		[1234567.891, '$1,234,567.891'],
		[0.1 + 0.2, '$0.300'], // 浮点误差不能漏到显示上
		[999999999.999, '$999,999,999.999'],
	]
	console.log(`  货币格式：${fmCases.map(([v]) => v + '→' + formatMoney(v)).join('  ')}`)
	for (const [v, want] of fmCases) {
		const got = formatMoney(v)
		if (got !== want) moneyProblems.push(`formatMoney(${v}) 得到 ${got}，应当是 ${want}`)
	}

	// —— 7. 出售 ——
	world.flies.length = 0
	world.money = 0
	const seller = world.addFly(500, 500, 'F', 'mutant')
	seller.age = seller.lifespan // 满成长，卖个整价
	const worth = seller.value
	const before = world.flies.length
	const gain = world.sellFly(seller)
	console.log(`  卖一只满成长的变异（${seller.weight.toFixed(1)}mg）：+${formatMoney(gain)}，钱 ${formatMoney(world.money)}`)
	if (Math.abs(gain - worth) > 1e-9) moneyProblems.push('sellFly 给的钱和 value 对不上')
	if (world.flies.length !== before - 1) moneyProblems.push('卖掉之后果蝇还留在 world.flies 里')
	if (!seller.dead) moneyProblems.push('卖掉之后果蝇没有被标记 dead')
	if (Math.abs(world.money - gain) > 1e-9) moneyProblems.push('卖到的钱没有进 world.money')
	// 卖一只不存在的（已经卖过的）不该再加钱
	if (world.sellFly(seller) !== 0) moneyProblems.push('重复出售同一只果蝇又给了一次钱')

	// —— 8. 商店 ——
	world.money = 0
	world.shop = {}
	if (world.buyShopItem('magnifier')) moneyProblems.push('钱是 0 却买成了放大镜')
	if (world.money !== 0) moneyProblems.push('买失败却扣了钱')
	if (world.hasShopItem('magnifier')) moneyProblems.push('买失败却记了已购')

	world.money = 5
	const bought = world.buyShopItem('magnifier')
	const price = CONFIG.market.shop.find((it) => it.id === 'magnifier').price
	console.log(`  商店：$${price} 的放大镜，钱 $5 → ${bought ? '买下' : '没买到'}，余 ${formatMoney(world.money)}`)
	if (!bought) moneyProblems.push('钱够却买不到放大镜')
	if (Math.abs(world.money - (5 - price)) > 1e-9) moneyProblems.push('买下之后扣的钱不对')
	if (!world.hasShopItem('magnifier')) moneyProblems.push('买下之后没有记进 world.shop')

	// 重复购买：不能再扣一次钱
	const moneyBefore = world.money
	if (world.buyShopItem('magnifier')) moneyProblems.push('同一件道具能重复购买')
	if (world.money !== moneyBefore) moneyProblems.push('重复购买把第二次的钱也扣了')

	// 不认识的道具 id 不该扣钱也不该崩
	if (world.buyShopItem('不存在的道具')) moneyProblems.push('买了一个不存在的道具却成功了')

	world.money = 0
	world.shop = {}
}
console.log('')

// ---------------------------------------------------------------- 投放经济
console.log('—— 投放经济 ——')

// ⚠ 名字不能叫 feedProblems —— 上面「成虫进食」那一节已经占了
const buyProblems = []
{
	const F = CONFIG.food
	const P = CONFIG.market.prices

	// —— 1. 价格 ——
	//
	// ⚠ bulkPrice 存在的唯一理由是挡住浮点尾巴。`0.001 * 10` 在 IEEE754 里是
	// 0.010000000000000002 —— 直接乘出来的话它会一路渗进 world.money，
	// 攒够十次就漂成一个显示得出来的误差。所以这里专门盯死那几组乘法
	if (Math.abs(bulkPrice(0.001, 10) - 0.01) > 1e-12) {
		buyProblems.push(`bulkPrice(0.001, 10) = ${bulkPrice(0.001, 10)}，应当是 0.01`)
	}
	if (bulkPrice(0.001, 10) !== 0.01) buyProblems.push('bulkPrice(0.001, 10) 不是精确的 0.01，浮点尾巴漏出来了')
	if (bulkPrice(0.005, 10) !== 0.05) buyProblems.push('bulkPrice(0.005, 10) 不是精确的 0.05')
	if (bulkPrice(0.01, 10) !== 0.1) buyProblems.push('bulkPrice(0.01, 10) 不是精确的 0.1')
	if (foodPrice('apple') !== P.food.apple) buyProblems.push('foodPrice(apple) 和配置对不上')
	if (foodPrice('gold') !== P.food.gold) buyProblems.push('foodPrice(gold) 和配置对不上')
	if (flyPrice() !== P.spawnFly) buyProblems.push('flyPrice() 和配置对不上')
	console.log(
		`  单价：苹果 ${formatMoney(foodPrice('apple'))} / 金苹果 ${formatMoney(foodPrice('gold'))} / 果蝇 ${formatMoney(flyPrice())}`,
	)
	console.log(
		`  投 10 个总价：${formatMoney(bulkPrice(foodPrice('apple'), 10))} / ` +
			`${formatMoney(bulkPrice(foodPrice('gold'), 10))} / ${formatMoney(bulkPrice(flyPrice(), 10))}`,
	)

	// —— 2. 投放区：两千次都要落在框里，而且**整个果子**不出屏 ——
	//
	// 只看两三个点是不够的 —— 边界写错（比如把 w 当成了右边界而不是宽度）时，
	// 绝大多数点仍然是对的，随机撞几次根本撞不出来
	world.flies.length = 0
	world.larvae.length = 0
	world.foods.length = 0
	const z = foodZoneRect(world.w, world.h)
	let outside = 0
	let offscreen = 0
	// ⚠ 圆心**一次都不许出框**（早先这里有 `sizeMax*0.5` 的容差，
	//   那是给「果子有一半挂在区外」留的后门，现在内缩量按绘制半径算，不需要了）
	for (let i = 0; i < 2000; i++) {
		world.foods.length = 0
		world.dropFoods('apple', 1)
		const f = world.foods[0]
		if (f.x < z.x || f.x > z.x + z.w || f.y < z.y || f.y > z.y + z.h) outside++
		// 绘制半径是 size × FOOD_DRAW_RADIUS（不是 size/2）——
		// 按 size/2 判的话，200px 的果子会探出 22px 而这条断言看不见
		const r = f.size * FOOD_DRAW_RADIUS
		if (f.x - r < 0 || f.x + r > world.w || f.y - r < 0 || f.y + r > world.h) offscreen++
	}
	console.log(
		`  投放区 ${Math.round(z.x)},${Math.round(z.y)} ${Math.round(z.w)}×${Math.round(z.h)}：` +
			`撒 2000 次，圆心出框 ${outside} 次、整个果子出屏 ${offscreen} 次`,
	)
	if (outside > 0) buyProblems.push(`撒了 2000 次有 ${outside} 次圆心落在投放区外`)
	if (offscreen > 0) {
		buyProblems.push(
			`撒了 2000 次有 ${offscreen} 次整个果子切到屏幕外 —— ` +
				'投放区的内缩量要按绘制半径（FOOD_DRAW_RADIUS）算，不是 size/2',
		)
	}

	// —— 3. 买食物：扣款、钱不够、超上限退差价 ——
	world.foods.length = 0
	world.money = 1
	const n1 = world.buyFood('apple', 10) // $0.001 × 10 = $0.01
	console.log(`  买 10 个苹果：放下 ${n1} 个，钱 $1 → ${formatMoney(world.money)}`)
	if (n1 !== 10) buyProblems.push(`一次买 10 个苹果只放下 ${n1} 个 —— maxCount 是不是没调够`)
	if (Math.abs(world.money - (1 - 0.01)) > 1e-12) buyProblems.push('买 10 个苹果扣的钱不对')

	// 钱不够：既不投放也不扣款
	const foodsBefore = world.foods.length
	const moneyBefore = world.money
	world.money = 0.0005 // 连一个 $0.001 的苹果都买不起
	if (world.buyFood('apple', 1) !== 0) buyProblems.push('钱不够却买成了苹果')
	if (world.foods.length !== foodsBefore) buyProblems.push('钱不够却投放了食物')
	if (world.money !== 0.0005) buyProblems.push('买失败却扣了钱')

	// 超上限：按实际放下的份数收费，剩下的退回来
	world.foods.length = 0
	world.money = 1
	const room = F.maxCount - 3
	for (let i = 0; i < room; i++) world.dropFoods('apple', 1) // 先占掉大半
	const n2 = world.buyFood('apple', 10) // 只剩 3 个空位
	const paid = bulkPrice(foodPrice('apple'), n2)
	console.log(
		`  只剩 3 个空位时买 10 个：放下 ${n2} 个，扣 ${formatMoney(paid)}，余 ${formatMoney(world.money)}`,
	)
	if (n2 !== 3) buyProblems.push(`只剩 3 个空位却放下了 ${n2} 个`)
	if (Math.abs(world.money - (1 - paid)) > 1e-12) {
		buyProblems.push(`没放下的那几份没有退钱：余 ${world.money}，应当是 ${1 - paid}`)
	}

	// —— 4. 金苹果的 1.5× ——
	//
	// 直接量 age 推进，不看体型 —— 体型还要经过 larvaSizeAt 的关键帧插值，
	// 多一层换算就多一处可能把 bug 藏起来的余地。
	//
	// ⚠ 每一帧都要**重新钉住** eating：两个 update 都会把它清成 null 再按
	// world.nearestFood() 重算，而这里喂进去的 Food 并不在 world.foods 里。
	// 只在循环外设一次的话，只有第一帧算「在吃」，量出来是 1.005 而不是 1.5 ——
	// 差别小到不容易一眼看出来，正是那种会静默混过去的假通过
	const step = (type, times) => {
		const l = new Larva(500, 500)
		const bait = type ? new Food(500, 500, type) : null
		for (let i = 0; i < times; i++) {
			l.eating = bait
			l.update(100, world)
		}
		return l.age
	}
	const ageNone = step(null, 100)
	const ageApple = step('apple', 100)
	const ageGold = step('gold', 100)
	console.log(
		`  幼虫 10 秒的年龄推进：没吃 ${ageNone.toFixed(0)}ms / 苹果 ${ageApple.toFixed(0)}ms / 金苹果 ${ageGold.toFixed(0)}ms`,
	)
	if (Math.abs(ageApple - ageNone) > 1e-9) buyProblems.push('普通苹果也加速了成长 —— 加成只该给金苹果')
	if (Math.abs(ageGold / ageApple - F.growthBonus.gold) > 1e-9) {
		buyProblems.push(`金苹果的成长倍率是 ${(ageGold / ageApple).toFixed(3)}，应当是 ${F.growthBonus.gold}`)
	}

	// 成虫那条路走的是 feeding + bait，两个字段都得对上才算数
	const adultAge = (feeding, type) => {
		const f = world.addFly(600, 400, 'F')
		f.feeding = feeding
		f.bait = type ? new Food(600, 400, type) : null
		for (let i = 0; i < 100; i++) {
			f.feeding = feeding // update 每帧会把它清掉，这里钉住
			f.bait = type ? new Food(600, 400, type) : null
			f.update(100, world)
		}
		const a = f.age
		world.flies.length = 0
		return a
	}
	const aNone = adultAge(false, null)
	const aApple = adultAge(true, 'apple')
	const aGold = adultAge(true, 'gold')
	console.log(
		`  成虫 10 秒的年龄推进：没吃 ${aNone.toFixed(0)}ms / 苹果 ${aApple.toFixed(0)}ms / 金苹果 ${aGold.toFixed(0)}ms`,
	)
	if (Math.abs(aApple - aNone) > 1e-9) buyProblems.push('成虫吃普通苹果也加速了成长')
	if (Math.abs(aGold / aApple - F.growthBonus.gold) > 1e-9) {
		buyProblems.push(`成虫吃金苹果的成长倍率是 ${(aGold / aApple).toFixed(3)}，应当是 ${F.growthBonus.gold}`)
	}

	// 上面量的是「倍率算得对」，这一条量的是「买来的金苹果真的是金苹果」——
	// 加成认的是 Food.type，中间任何一环把类型丢了（买成普通苹果、存档读回来变了），
	// 上面的断言都照样通过
	world.foods.length = 0
	world.money = 1
	world.buyFood('gold', 1)
	if (world.foods.length !== 1) {
		buyProblems.push('买了金苹果却没落进 world.foods')
	} else {
		const g = world.foods[0]
		if (g.type !== 'gold') buyProblems.push(`买来的金苹果 type 是 ${g.type}，应当是 gold`)
		if (foodGrowthBonus(g.type) !== F.growthBonus.gold) {
			buyProblems.push('从 world 里拿到的那份金苹果没有 1.5 倍加成')
		}
	}

	// 认不出的类型（含 null）一律 1 —— 调用方可以放心把「当前在吃什么」原样丢进来
	for (const bad of [null, undefined, 'grape', '']) {
		if (foodGrowthBonus(bad) !== 1) buyProblems.push(`foodGrowthBonus(${bad}) 应当是 1`)
	}

	// —— 6. 警报器的档位 ——
	//
	// 抽成纯函数就是为了能这样**精确**测：阈值卡在 20% / 10%，
	// 肉眼看光环永远分不清 20.1% 和 19.9% 该亮哪一档
	const alarm = CONFIG.market.shop.find((it) => it.id === 'alarm')
	if (!alarm) {
		buyProblems.push('商店里没有警报器')
	} else {
		const at = (left) => alarmLevel({ age: 1000 * (1 - left), lifespan: 1000, dead: false })
		const cases = [
			[1.0, 0, '刚进罐子'],
			[0.5, 0, '过半'],
			[alarm.warnOrange + 0.001, 0, '刚好还没到橙线'],
			[alarm.warnOrange, 1, '刚好压在橙线上（含）'],
			[0.15, 1, '橙'],
			[alarm.warnRed + 0.001, 1, '刚过橙、还没到红'],
			[alarm.warnRed, 2, '刚好压在红线上（含）'],
			[0.05, 2, '红'],
		]
		console.log(
			`  警报器档位（橙 ≤${alarm.warnOrange * 100}% / 红 ≤${alarm.warnRed * 100}%）：` +
				cases.map(([l]) => `${(l * 100).toFixed(1)}%→${['不亮', '橙', '红'][at(l)]}`).join('  '),
		)
		for (const [left, want, why] of cases) {
			const got = at(left)
			if (got !== want) {
				buyProblems.push(`剩余 ${(left * 100).toFixed(2)}%（${why}）应当是 ${['不亮', '橙', '红'][want]}，实际是 ${['不亮', '橙', '红'][got]}`)
			}
		}
		// 边界必须是**含**的 —— 写成 < 的话正好卡在 20% 的那一帧不会亮，
		// 而剩余寿命是连续变化的，这种「差一点点」在实机上就是「有时候不灵」
		if (alarmLevel({ age: 1000 * (1 - alarm.warnOrange), lifespan: 1000 }) !== 1) {
			buyProblems.push('剩余寿命正好 20% 时没有点亮橙光（阈值要用 ≤，不是 <）')
		}
		// 没寿命 / 已经死了的不能亮
		if (alarmLevel(null) !== 0 || alarmLevel({ age: 0, lifespan: 0 }) !== 0) {
			buyProblems.push('警报器对空对象 / 零寿命的果蝇也返回了等级')
		}
		if (alarmLevel({ age: 999, lifespan: 1000, dead: true }) !== 0) {
			buyProblems.push('警报器对已经死掉的果蝇还亮着')
		}
	}

	// 金苹果不进自动投放的种类表 —— 它只能花钱买
	if (F.types.includes('gold')) buyProblems.push('金苹果混进了 food.types，自动投放会白送')
	// 星空苹果同理，而且它还得先解锁才买得到 —— 掉进自动投放等于白送彩蛋
	if (F.types.includes('star')) buyProblems.push('星空苹果混进了 food.types，自动投放会白送彩蛋')

	// —— 5. 投蝇 ——
	//
	// ⚠ 这里曾经有一条「场上 0 只成虫时免费」的破产保底，后来按要求去掉了。
	// 所以下面专门钉一条**反向**断言：断代 + 没钱时就是投不成。
	// 少了它的话，哪天有人「好心」把保底加回来，没有任何测试会拦
	world.flies.length = 0
	world.money = 0
	const brokeFlies = world.buyFlies(1)
	console.log(`  场上 0 只成虫、钱也是 0：投到 ${brokeFlies} 只，钱 ${formatMoney(world.money)}（应当投不成）`)
	if (brokeFlies !== 0) buyProblems.push('钱是 0 却投成了果蝇 —— 破产保底应当已经取消了')
	if (world.flies.length !== 0) buyProblems.push('钱是 0 却真的放出了果蝇')
	if (world.money !== 0) buyProblems.push('投蝇失败却动了钱')

	world.money = 1
	const paidFlies = world.buyFlies(10)
	const flyCost = bulkPrice(flyPrice(), 10)
	console.log(`  场上已有 ${world.flies.length - paidFlies} 只时投 10 只：${paidFlies} 只，钱 $1 → ${formatMoney(world.money)}`)
	if (paidFlies !== 10) buyProblems.push(`投 10 只只来了 ${paidFlies} 只`)
	if (Math.abs(world.money - (1 - flyCost)) > 1e-12) buyProblems.push('投蝇扣的钱不对')

	// 钱不够
	world.money = 0.001 // 一只 $0.005 都买不起
	const before2 = world.flies.length
	if (world.buyFlies(1) !== 0) buyProblems.push('钱不够却投成了果蝇')
	if (world.flies.length !== before2) buyProblems.push('钱不够却投放了果蝇')
	if (world.money !== 0.001) buyProblems.push('投蝇失败却扣了钱')

	// 性别：n=1 时不该永远出同一性 —— 原来写死 i%2 就是这么偏的
	let females = 0
	for (let i = 0; i < 300; i++) {
		world.flies.length = 0
		world.spawnBatch(1)
		if (world.flies[0].sex === 'F') females++
	}
	console.log(`  「投 1 只」300 次里出了 ${females} 只雌性（应当在一半上下，不能是 0 或 300）`)
	if (females < 100 || females > 200) {
		buyProblems.push(`「投 1 只」出了 ${females}/300 只雌性 —— 性别有偏向`)
	}
	// n=2 仍然要保证一雌一雄（开局「有雌有雄」那条需求靠它）
	for (let i = 0; i < 50; i++) {
		world.flies.length = 0
		world.spawnBatch(2)
		const sexes = world.flies.map((f) => f.sex).sort().join('')
		if (sexes !== 'FM') {
			buyProblems.push(`投 2 只没有凑成一雌一雄：${sexes}`)
			break
		}
	}

	world.flies.length = 0
	world.foods.length = 0
	world.money = 0
}
console.log('')
console.log('')

// ---------------------------------------------------------------- 存档往返验证
console.log('—— 存档往返验证 ——')

const saveProblems = []
{
	// 直接拿前面几节折腾过的 world 当样本：它这会儿六种实体齐全、还有各种
	// 中间状态（产卵中的母体、趴在果子上的幼虫、正在腐烂的残留物），
	// 比专门造一个干净的样本更能暴露问题。
	//
	// 但前面几节跑完时，幼虫和残留物往往恰好是空的，而这两种恰恰最该测：
	//   Remains 的 rot / integrity、Larva 的 pupaProgress 都是**原型上的访问器**，
	//     是恢复时最容易踩「给 getter 赋值」这个坑的地方；
	//   Fly.layShape 更特殊 —— 它不在构造函数里，是 startLaying() 运行时才挂上去的，
	//     不主动造出「正在产卵」这个状态，测试就永远覆盖不到它。
	for (let i = 0; i < 5; i++) world.addLarva(rand(200, W - 200), rand(200, H - 200))
	const halfRotten = world.addRemains(300, 300, 'corpse', 18, 1.2)
	halfRotten.age = halfRotten.rotTime * 0.6 // 烂到一半，rot 是个有意义的中间值
	world.addRemains(500, 400, 'stain', 12, 0.4)

	const mom = world.flies.find((f) => f.sex === 'F')
	if (mom) mom.startLaying()

	// 再推进一步，把刚被拍死、还在数组里等着结算的果蝇收走 ——
	// 存档里不该出现 dead 的实体。
	world.update(1 / 60)

	const before = world
	const json = JSON.stringify(before.serialize())
	const bytes = Buffer.byteLength(json, 'utf8')

	// 造一个全新的世界再灌进去：这一步同时验证了「restore 会先清空现有内容」，
	// 否则新开局那几只果蝇会和存档里的叠在一起
	const after = new World(W, H)
	after.restore(JSON.parse(json))

	console.log(`  存档体积 ${(bytes / 1024).toFixed(1)} KB（${before.livingCount} 个生命体 + ${before.remains.length} 块残留）`)
	console.log(
		`  各类数量 成虫 ${before.flies.length}→${after.flies.length}，幼虫 ${before.larvae.length}→${after.larvae.length}，` +
			`卵 ${before.eggs.length}→${after.eggs.length}，食物 ${before.foods.length}→${after.foods.length}，残留 ${before.remains.length}→${after.remains.length}`,
	)

	// —— 1. 数量一致 ——
	// jars 也放进来：罐子自身的字段（位置、容量）同样要能原样往返。
	// 罐中果蝇是嵌套的，snapshot(jar) 取不到，由上面「玻璃罐验证」那一节单独比对
	const keys = ['flies', 'larvae', 'eggs', 'foods', 'remains', 'jars']
	for (const key of keys) {
		if (before[key].length !== after[key].length) {
			saveProblems.push(`存档往返后 ${key} 数量对不上：${before[key].length} → ${after[key].length}`)
		}
	}

	// —— 2. 逐字段比对 ——
	// 这一步才是真正抓得住「某个字段忘了存」的地方。只比数量的话，
	// 位置、年龄、速度全丢了也照样「通过」。
	let compared = 0
	const mismatch = []
	for (const key of keys) {
		for (let i = 0; i < Math.min(before[key].length, after[key].length); i++) {
			const a = snapshot(before[key][i])
			const b = snapshot(after[key][i])
			for (const k of Object.keys(a)) {
				compared++
				if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
					if (mismatch.length < 5) mismatch.push(`${key}[${i}].${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`)
				}
			}
		}
	}
	console.log(`  逐字段比对 ${compared} 个字段，不一致 ${mismatch.length}${mismatch.length >= 5 ? '+' : ''} 个`)
	for (const m of mismatch) saveProblems.push(`存档往返后字段对不上 —— ${m}`)

	// —— 3. 二次往返稳定 ——
	// 存→读→再存 必须和第一次完全一样，否则说明恢复出来的世界在慢慢漂移
	const json2 = JSON.stringify(after.serialize())
	console.log(`  二次往返${json2 === json ? '完全一致' : '不一致'}`)
	if (json2 !== json && JSON.parse(json2).flies.length !== before.flies.length) {
		saveProblems.push('二次存档往返后数量发生变化')
	}

	// —— 4. 恢复出来的世界真的能继续跑 ——
	// 字段对得上但一跑就 NaN，是「存了个引用 / 存了个 undefined」这类问题的典型症状
	let step = 0
	let broke = null
	while (step < 60 * 30 && !broke) {
		after.update(1 / 60)
		step++
		for (const l of after.larvae) {
			if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) broke = `第 ${(step / 60).toFixed(1)} 秒幼虫坐标变成 NaN`
			else if (l.x < CONFIG.larva.margin - 1 || l.x > W - CONFIG.larva.margin + 1) broke = `第 ${(step / 60).toFixed(1)} 秒幼虫跑出屏幕`
		}
		for (const f of after.flies) {
			if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) broke = `第 ${(step / 60).toFixed(1)} 秒成虫坐标变成 NaN`
		}
	}
	console.log(`  恢复后的世界继续跑 30 秒：${broke ? '出错' : '正常'}（存活 ${after.livingCount}）`)
	if (broke) saveProblems.push(`存档恢复后无法正常运行 —— ${broke}`)
}
console.log('')

// ---------------------------------------------------------------- 结论
console.log('—— 结果 ——')
const c = world.counts
console.log(`  最终：成虫 ${c.adults} / 幼虫 ${c.larvae} / 卵 ${c.eggs} / 残留 ${c.remains}`)
console.log(`  累计：产卵 ${c.eggsLaid}，羽化 ${c.emerged}，死亡 ${c.deaths}（自然 ${c.natural} / 拍死 ${c.swatted}）`)

// ---------------------------------------------------------------- 工具粒子特效
//
// 工具图案和范围圈全删之后，「手里拿着什么、作用范围多大」只剩粒子在表达。
// 这一节**不需要 UI**：发射器读的是 world.toolFx，直接写那个对象就能驱动
const fxProblems = []
{
	const wFx = new World(W, H)
	wFx.reset()
	wFx.flies.length = 0
	wFx.larvae.length = 0
	wFx.eggs.length = 0
	wFx.foods.length = 0
	wFx.remains.length = 0

	const run = (fx, frames, dt = 1 / 60) => {
		Object.assign(wFx.toolFx, { on: false, rate: 0, acc: 0 }, fx)
		wFx.toolFx.on = true
		for (let i = 0; i < frames; i++) wFx.update(dt)
	}

	// —— 火苗：会冒、往上飘 ——
	wFx.particles.length = 0
	run({ tool: 'lighter', x: 500, y: 500, rate: CONFIG.tools.fx.flameRate }, 60)
	const flame = wFx.particles.slice()
	if (flame.length === 0) {
		fxProblems.push('举着打火机 1 秒一颗粒子都没冒 —— 火苗特效没接上')
	} else {
		const meanVy = flame.reduce((a, p) => a + p.vy, 0) / flame.length
		if (!(meanVy < 0)) {
			fxProblems.push(`打火机的粒子平均 vy=${meanVy.toFixed(1)}，应当是负的（火苗往上飘）`)
		}
		// 数量应当约等于 rate × life。粒子寿命 0.34s × rand(0.7~1.3)，
		// 所以稳态的存活数在 rate×0.24 ~ rate×0.44 之间，宽松取 ±70%
		const want = CONFIG.tools.fx.flameRate * 0.34
		if (flame.length < want * 0.3 || flame.length > want * 2.4) {
			fxProblems.push(`打火机 1 秒后场上有 ${flame.length} 颗粒子，按 rate×life 应当在 ${(want * 0.3).toFixed(0)}~${(want * 2.4).toFixed(0)} 之间`)
		}
	}
	// 喷火枪要比打火机**多**（更大更长更密是用户的原话）
	const bigCount = (() => {
		wFx.particles.length = 0
		run({ tool: 'flamer', x: 500, y: 500, big: true, rate: CONFIG.tools.fx.flameRateBig }, 60)
		return wFx.particles.length
	})()
	if (!(bigCount > flame.length)) {
		fxProblems.push(`喷火枪 1 秒只有 ${bigCount} 颗，不比打火机的 ${flame.length} 颗多 —— 两档没拉开`)
	}

	// —— 关掉之后只减不增 ——
	wFx.particles.length = 0
	run({ tool: 'lighter', x: 500, y: 500, rate: CONFIG.tools.fx.flameRate }, 30)
	const before = wFx.particles.length
	wFx.toolFx.on = false
	for (let i = 0; i < 120; i++) wFx.update(1 / 60)
	if (!(wFx.particles.length < before)) {
		fxProblems.push(`放下工具之后粒子没有减少（${before} → ${wFx.particles.length}）—— 发射器没停`)
	}

	// —— 按秒算，不是按帧算 ——
	//
	// ⚠ 这条是这个项目被咬过的老毛病（把毫秒当成秒），所以专门钉一遍：
	//   rate 60/s 跑 1 秒要出约 60 颗，而不是「每帧 60 颗」（那是 3600 颗）
	{
		const wRate = new World(W, H)
		wRate.reset()
		let spawned = 0
		const origSpawn = wRate.spawnParticle.bind(wRate)
		wRate.spawnParticle = (...args) => {
			spawned++
			return origSpawn(...args)
		}
		Object.assign(wRate.toolFx, { on: true, tool: 'lighter', x: 100, y: 100, rate: 60, acc: 0 })
		for (let i = 0; i < 60; i++) wRate._emitToolFx(1000 / 60)
		if (spawned < 50 || spawned > 70) {
			fxProblems.push(`rate=60/s 跑 1 秒发出了 ${spawned} 颗，应当约 60 —— 发射器多半是按帧算的`)
		}
	}

	// —— 大 dt 不能一次灌满 ——
	{
		const wBig = new World(W, H)
		wBig.reset()
		let spawned = 0
		const origSpawn = wBig.spawnParticle.bind(wBig)
		wBig.spawnParticle = (...args) => {
			spawned++
			return origSpawn(...args)
		}
		Object.assign(wBig.toolFx, { on: true, tool: 'lighter', x: 0, y: 0, rate: 200, acc: 0 })
		wBig._emitToolFx(500) // 卡了半秒
		if (spawned > CONFIG.tools.fx.maxPerTick) {
			fxProblems.push(`单帧 dt=500ms 发出了 ${spawned} 颗，上限是 ${CONFIG.tools.fx.maxPerTick} —— 卡一帧就会炸出一团`)
		}
	}

	// —— 满员时静默，不抛 ——
	{
		const wFull = new World(W, H)
		wFull.reset()
		for (let i = 0; i < CONFIG.world.maxParticles + 50; i++) {
			wFull.spawnParticle(0, 0, 0, 0, '#fff', 1)
		}
		const capped = wFull.particles.length
		if (capped !== CONFIG.world.maxParticles) {
			fxProblems.push(`粒子数没有被 maxParticles 卡住（${capped}）`)
		}
		Object.assign(wFull.toolFx, { on: true, tool: 'lighter', x: 0, y: 0, rate: 100, acc: 0 })
		try {
			for (let i = 0; i < 60; i++) wFull._emitToolFx(1000 / 60)
		} catch (e) {
			fxProblems.push(`满员时发射器抛了异常：${e.message}`)
		}
		if (wFull.particles.length !== capped) fxProblems.push('满员时粒子数还在涨')
	}

	// —— 烧着的蝇身上的火苗：发射点必须在**它身上**，不是指针 ——
	//
	// ⚠ 这一条是这次改动里最容易写歪、又最难发现的地方：`_emitToolFx` 是
	//   **指针单例**（全世界只有一个 fx.x / fx.y），拿它去发烧蝇的火，
	//   火焰会从鼠标那里冒出来。而屏幕上看起来只是「火焰飘错了地方」——
	//   像特效没调好，谁都不会往「接错发射器」上想。
	//   所以这里把 toolFx 关掉，只留烧蝇这一路，然后量**粒子到蝇的距离**
	{
		const wBurn = new World(W, H)
		wBurn.reset()
		wBurn.flies.length = 0
		wBurn.particles.length = 0
		wBurn.shop.roast = 1

		const bf = wBurn.addFly(400, 300, 'F')
		if (!bf) fxProblems.push('烧蝇那段：addFly 失败')
		else if (!wBurn.ignite(bf, 'lighter')) fxProblems.push('烧蝇那段：ignite 没点着')
		else {
			// 把指针那一套彻底关掉 —— 只剩「从蝇身上发」这一条来路
			wBurn.toolFx.on = false
			wBurn.particles.length = 0

			// ⚠ 要跑**好几帧**才能凑出一颗：发射率是 34 颗/秒，而一帧只有 1/60 秒，
			//   累加器每帧涨 0.567 —— 头一帧注定是 0 颗。只跑一帧就断言「冒了没有」
			//   会得到一条恒红的假警报（第一版就是这么写的）
			for (let i = 0; i < 5; i++) wBurn.update(1 / 60)
			const beforeFrame = wBurn.particles.length
			wBurn.update(1 / 60)
			// 只认**最后一帧**发出来的那些：新粒子本帧不走 update()，
			// 所以它们还停在发射点上，正好用来量距离
			const fromFly = wBurn.particles.slice(beforeFrame)
			if (fromFly.length === 0) {
				fxProblems.push('烧着的蝇跑了 6 帧，一颗粒子都没冒')
			}
			for (const p of fromFly) {
				const d = Math.hypot(p.x - bf.x, p.y - bf.y)
				if (d > bf.size * 1.6) {
					fxProblems.push(
						`烧蝇的火苗落在离它 ${d.toFixed(0)}px 的地方 —— 多半是接到了指针那个单例上（见 _emitBurnFx）`,
					)
					break
				}
				if (!(p.vy < 0)) {
					fxProblems.push('烧蝇的火苗不往上飘')
					break
				}
			}

			// 单帧封顶：一帧卡了 500ms 也不能一次炸出一团。
			//
			// ⚠ **直接调 `_emitBurnFx(500)`**，不要写 `update(0.5)` ——
			//   `World.update` 会把半秒切成 15 个 33ms 的子步，每个子步各发一次，
			//   于是上限是**按子步**生效的，总量可以到 15 倍。
			//   第一版就是拿 `update(0.5)` 去量，报出来「单帧发了 11 颗」——
			//   数字没错，是断言把「一帧」理解成了「一次 update 调用」
			wBurn.particles.length = 0
			wBurn._emitBurnFx(500)
			if (wBurn.particles.length > CONFIG.tools.fx.maxPerTick) {
				fxProblems.push(
					`烧蝇的火苗单帧发了 ${wBurn.particles.length} 颗，上限是 ${CONFIG.tools.fx.maxPerTick}`,
				)
			}

			// 灭火之后必须**停**
			wBurn.extinguish(bf)
			if (bf.burning) fxProblems.push('extinguish 之后 burning 还是 true')
			wBurn.particles.length = 0
			for (let i = 0; i < 60; i++) wBurn.update(1 / 60)
			if (wBurn.particles.length > 0) {
				fxProblems.push(`火灭了还在冒粒子（${wBurn.particles.length} 颗）—— 发射器没跟着状态停`)
			}
		}
	}

	// —— 挥拍 / 撒网：命中与否都要放一圈 ——
	//
	// ⚠ 这一圈是删掉虚线圈之后**唯一**能说明「打得到哪儿」的东西。
	//   只测「命中时有粒子」是不够的 —— 挥空时才是最需要知道范围的时刻
	{
		const wRing = new World(W, H)
		wRing.reset()
		wRing.flies.length = 0
		wRing.larvae.length = 0
		wRing.eggs.length = 0
		wRing.particles.length = 0
		wRing.swat(400, 400) // 空地上挥一拍
		if (wRing.particles.length === 0) {
			fxProblems.push('挥空时一颗粒子都没有 —— 那玩家没法知道杀伤范围在哪儿')
		}
		// 粒子应当落在**杀伤半径**周围，而不是堆在中心
		if (wRing.particles.length) {
			const T = CONFIG.tools
			const rs = wRing.particles.map((p) => Math.hypot(p.x - 400, p.y - 400))
			const meanR = rs.reduce((a, b) => a + b, 0) / rs.length
			if (Math.abs(meanR - T.swatRadius) > T.swatRadius * 0.35) {
				fxProblems.push(
					`挥拍粒子平均落在离拍心 ${meanR.toFixed(0)}px 处，杀伤半径是 ${T.swatRadius}px —— 粒子没勾出真实范围`,
				)
			}

			// ⚠ 光看「挥下去那一瞬间有几颗」是**不够**的 —— 这一节最阴的坑是
			//   把 life 写成秒（0.34）而不是毫秒（340）：粒子在第一次 update 时
			//   就 0.34 - 16.67 < 0 当场死掉，而上面那个计数发生在 update **之前**，
			//   照样是绿的。表现是「这一圈根本看不见」，但不报任何错。
			//   所以必须真的推几帧，看它还在不在
			for (let i = 0; i < 5; i++) for (const p of wRing.particles) p.update(1000 / 60)
			const alive = wRing.particles.filter((p) => !p.dead).length
			if (alive < wRing.particles.length * 0.5) {
				fxProblems.push(
					`挥拍那一圈推进 5 帧后只剩 ${alive}/${wRing.particles.length} 颗 —— ` +
						`多半是把 life 写成了秒而不是毫秒（见 CONFIG.tools.fx.ringLife）`,
				)
			}
		}

		// 撒网：没有空罐子时会提前 return，那条路上也要放一圈
		wRing.jars.length = 0
		wRing.particles.length = 0
		wRing.catchFlies(500, 500)
		if (wRing.particles.length === 0) {
			fxProblems.push('撒网没有空罐子时一颗粒子都没有 —— 那只剩「点了没反应」')
		}
	}

	// —— 生命周期的单位：必须是毫秒 ——
	//
	// 上面那条是行为验证，这条是直接把单位钉死。Particle.update 里写的是
	// `this.life -= dtMs`，所以任何小于一帧（16.7ms）的 life 都是「出生即死」。
	// 这个项目在「毫秒 vs 秒」上已经被咬过不止一次（见 Larva 的 sniffTimer）
	{
		const F = CONFIG.tools.fx
		const lifeKeys = ['flameLife', 'flameLifeBig', 'broomLife', 'squirtLife', 'clothLife', 'ringLife']
		for (const k of lifeKeys) {
			if (!(F[k] > 100)) {
				fxProblems.push(`CONFIG.tools.fx.${k} = ${F[k]}，看着像「秒」—— Particle 的生命周期是**毫秒**，写小了这个特效会整个看不见`)
			}
		}
	}

	console.log(
		`  工具粒子：火苗 ${flame.length} 颗（喷火枪 ${bigCount} 颗）· 挥拍/撒网命中与否都放圈 · ` +
			`按秒发射、单帧封顶 ${CONFIG.tools.fx.maxPerTick}、满员静默`,
	)
	console.log('  烧蝇的火苗：从**蝇身上**发（不是指针）· 往上飘 · 灭火即停')
}

// ---------------------------------------------------------------- 扫帚
//
// 只有一条规则：**把圆里的幼虫朝外推**。但每一面都得钉住 ——
// 推错对象（蛹 / 卵 / 成虫）和推反方向都不会报错，只会让扫帚看起来「不听话」
const broomProblems = []
{
	const B = CONFIG.tools.broom
	const bw = new World(W, H)
	bw.reset()
	// 清场：只要我们自己摆的那几只，否则开局的虫子会混进计数
	bw.flies.length = 0
	bw.larvae.length = 0
	bw.eggs.length = 0
	bw.foods.length = 0
	bw.shells.length = 0
	bw.remains.length = 0
	bw.particles.length = 0

	// ⚠ 圆心要离边距够远。摆太靠边的话 _keepInBounds 会把被推出去的幼虫
	//   弹回来，而症状是「推力没生效」—— 测的就成了墙而不是扫帚
	const CX = W / 2
	const CY = H / 2
	const R = 120

	// 12 只按 0.3~1.4 倍半径摆一圈。用固定角度而不是随机 ——
	// 随机的话「圈外那几只」的位置每次跑都不一样，红了也不知道是不是运气
	const N = 12
	const placed = []
	for (let i = 0; i < N; i++) {
		const a = (i / N) * TAU
		const frac = 0.3 + (i / (N - 1)) * 1.1 // 0.3 → 1.4
		const L = new Larva(CX + Math.cos(a) * R * frac, CY + Math.sin(a) * R * frac, null, 0)
		L.angle = a // 先让它朝着外侧，把「推力」和「它自己爬」分开看
		bw.larvae.push(L)
		placed.push({ L, a, frac })
	}

	const pushed = bw.broom(CX, CY, R)
	// 同样按实测距离数 —— `world.broom` 用的就是 `d2 > r2` 这一条，
	// 断言必须和它数同一批虫，否则边界那一只会让两个口径差一
	const insideCount = placed.filter((p) => Math.hypot(p.L.x - CX, p.L.y - CY) <= R).length
	if (pushed !== insideCount) {
		broomProblems.push(`扫帚说推了 ${pushed} 只，圈里其实有 ${insideCount} 只（共摆 ${N} 只）`)
	}

	let backwards = 0
	let leaked = 0
	for (const { L, a } of placed) {
		const ax = Math.cos(a)
		const ay = Math.sin(a)
		const along = L.pushVx * ax + L.pushVy * ay // 推力的「朝外」分量
		// ⚠ 圈内圈外用**实测距离**判，不用摆的时候那个 frac ——
		//   frac 是浮点算出来的，边界那一只可能落在半径外侧 1e-16，
		//   于是「圈内必须有推力」这条会去要求一只其实在圈外的幼虫
		const d = Math.hypot(L.x - CX, L.y - CY)
		if (d > R) {
			// 圈外：不许有一丝推力
			if (L.pushVx !== 0 || L.pushVy !== 0) leaked++
		} else if (d >= R * (1 - 1e-6)) {
			// 正好压在半径上：falloff 就是 0，推力**应当**是 0。
			// 这一档单列出来，不然「必须朝外」会把它判成方向反了
			if (along !== 0) leaked++
		} else if (along <= 0) {
			// 圈内：必须朝外。⚠ 只查「非零」是不够的 —— 推反了也非零，
			//   而且推反的表现（幼虫往扫帚里钻）比不动更像 bug
			backwards++
		}
	}
	if (backwards > 0) broomProblems.push(`圈里有 ${backwards} 只被推向了**圆心**（方向反了）`)
	if (leaked > 0) broomProblems.push(`圈外有 ${leaked} 只也被推了 —— 判定半径比说的更大`)

	// 越靠边越弱
	const near = placed.find((p) => Math.abs(p.frac - 0.3) < 1e-9)
	const far = placed.find((p) => Math.abs(p.frac - 1) < 1e-9)
	const spd = (p) => Math.hypot(p.L.pushVx, p.L.pushVy)
	if (near && far && !(spd(near) > spd(far))) {
		broomProblems.push(`靠近圆心的那只被推得比边缘的还慢（${spd(near).toFixed(0)} vs ${spd(far).toFixed(0)}）—— 衰减方向反了`)
	}
	// 硬上限。把 pushSpeed 临时调大，看它是不是真的夹住了
	{
		const saved = B.pushSpeed
		B.pushSpeed = B.pushMaxSpeed * 100
		bw.broom(CX, CY, R)
		B.pushSpeed = saved
		const over = placed.filter((p) => p.frac <= 1 && spd(p) > B.pushMaxSpeed + 1e-6).length
		if (over > 0) broomProblems.push(`有 ${over} 只的速度超过了 pushMaxSpeed（${B.pushMaxSpeed}）—— 上限没夹住`)
		bw.broom(CX, CY, R) // 用回正常值，免得影响下面
	}

	// —— 不该被推的东西 ——
	{
		const before = bw.larvae.map((l) => ({ l, x: l.x, y: l.y }))
		const pupa = new Larva(CX + 10, CY, null, 0)
		pupa.pupa = true
		const fly = bw.flies.length
		bw.larvae.push(pupa)
		const n = bw.broom(CX, CY, R)
		if (pupa.pushVx !== 0 || pupa.pushVy !== 0) {
			broomProblems.push('蛹被扫帚推动了 —— 蛹期的设定是完全静止')
		}
		if (n !== insideCount) {
			broomProblems.push(`多了只蛹之后扫帚说推了 ${n} 只（应当是 ${insideCount}）—— 蛹也被算进去了`)
		}
		if (bw.flies.length !== fly) broomProblems.push('扫帚动到了成虫数组')
		bw.larvae.pop()

		// 已经死掉的幼虫不该再被推（它正等着 _resolveLifecycles 收尸）
		const corpse = new Larva(CX + 5, CY + 5, null, 0)
		corpse.dead = true
		bw.larvae.push(corpse)
		bw.broom(CX, CY, R)
		if (corpse.pushVx !== 0) broomProblems.push('死掉的幼虫还被扫帚推了')
		bw.larvae.pop()
		void before
	}

	// —— 半径 0 是空操作 ——
	//
	// ⚠ 这条不是凑数：滚轮还没调过半径、或者配置被改成 0 时，
	//   `1 - d/r` 会变成 NaN / 负数，把推力算成 NaN 灌进 pushVx ——
	//   那只幼虫之后再也画不出来（canvas 遇到 NaN 直接跳过这一笔），而且不报错
	{
		for (const p of placed) {
			p.L.pushVx = 0
			p.L.pushVy = 0
		}
		const n = bw.broom(CX, CY, 0)
		if (n !== 0) broomProblems.push(`半径 0 的扫帚推了 ${n} 只`)
		const nan = placed.filter((p) => !Number.isFinite(p.L.pushVx) || !Number.isFinite(p.L.pushVy)).length
		if (nan > 0) broomProblems.push(`半径 0 的扫帚把 ${nan} 只的速度算成了 NaN`)
	}

	// —— 真的会动：推一秒，净位移朝外，然后停下来 ——
	{
		for (const p of placed) {
			p.L.pushVx = 0
			p.L.pushVy = 0
			p.L.wanderTimer = 999 // 别让它自己改主意，否则测的是游走
		}
		const start = placed.map((p) => ({ x: p.L.x, y: p.L.y, r: Math.hypot(p.L.x - CX, p.L.y - CY) }))

		// 按住一秒：每帧都扫（_useTool 就是这么调的）
		for (let i = 0; i < 60; i++) {
			bw.broom(CX, CY, R)
			for (const p of placed) p.L.update(1000 / 60, bw)
		}
		let inward = 0
		placed.forEach((p, i) => {
			const r = Math.hypot(p.L.x - CX, p.L.y - CY)
			// 圈内那几只（除了本来就在边上的）必须被推远
			if (p.frac <= 0.9 && !(r > start[i].r)) inward++
		})
		if (inward > 0) broomProblems.push(`按住扫了一秒，圈里有 ${inward} 只没有离圆心更远`)

		// 松开：推力必须衰减干净，不能留着让它一直飘
		for (let i = 0; i < 120; i++) for (const p of placed) p.L.update(1000 / 60, bw)
		const stillMoving = placed.filter((p) => p.L.pushVx !== 0 || p.L.pushVy !== 0).length
		if (stillMoving > 0) {
			broomProblems.push(`松手两秒后还有 ${stillMoving} 只带着推力 —— 衰减没有归零，它们会一直飘`)
		}

		// 没被推出屏幕
		const m = CONFIG.larva.margin
		const out = placed.filter((p) => p.L.x < m - 1 || p.L.x > W - m + 1 || p.L.y < m - 1 || p.L.y > H - m + 1)
		if (out.length > 0) broomProblems.push(`扫完有 ${out.length} 只越出了 larva.margin`)
	}

	// —— 趴在果子上的那只，必须真的被扫离 munchRadius ——
	//
	// ⚠ 这一条**不能靠推理**。幼虫趴在果子上时，`_clampToFood` 会把它按在
	//   `size × munchRadius` 上 —— 那个夹子本来只服务于「边吃边挪」，
	//   但它是**每帧都跑**的，拿它去挡外力的话扫帚会推不动一只正在吃饭的幼虫。
	//   实测过：不放开这个夹子，扫十秒都推不走，而症状只是「扫帚在果子上不好使」
	{
		const fw = new World(W, H)
		fw.reset()
		fw.larvae.length = 0
		fw.flies.length = 0
		fw.eggs.length = 0
		fw.remains.length = 0
		// ⚠ 签名是 addFood(x, y, **type**, size)。写反了的话 size 会变成字符串
		//   'apple'，`size * munchRadius` 是 NaN，`onFruit` 恒为 false ——
		//   症状就是这条断言报的「那只幼虫根本没趴到果子上」
		const food = fw.addFood(CX, CY, 'apple', 40)
		const munch = food.size * CONFIG.food.munchRadius

		const eater = new Larva(CX + 2, CY + 2, null, 0)
		fw.larvae.push(eater)
		// 先让它真的坐上桌：跑几帧让 eating / ateLastTick 落定
		for (let i = 0; i < 10; i++) {
			eater.update(1000 / 60, fw)
			fw._updateFeeding(1000 / 60)
		}
		if (!eater.eating) {
			broomProblems.push('测试前提没成立：那只幼虫根本没趴到果子上（eating 是空的）')
		} else {
			// 按住扫。⚠ 扫帚落在**果子上**，圆心就是食物中心
			let pinnedFrames = 0
			for (let i = 0; i < 90; i++) {
				fw.broom(food.x, food.y, R)
				eater.update(1000 / 60, fw)
				fw._updateFeeding(1000 / 60)

				// ⚠ 这一条才是 `_clampToFood` 里那个「被推着就不夹」真正实现的契约。
				//
				//   **只看最后有没有推出去是不够的** —— 把那个守卫删掉重跑，
				//   结论照样是「推出去了」（实测：被夹住两帧之后就自己脱身了，
				//   因为夹完正好落在 munchRadius 这个边界上，而 onFruit 的
				//   `dist2 <= munch*munch` 吃浮点误差，下一帧落哪边是掷硬币）。
				//   也就是说「推得动」这件事不该靠浮点运气 —— 这一条把它钉死：
				//   只要身上带着推力，就不许正好停在那个夹子的半径上
				const dNow = Math.hypot(eater.x - food.x, eater.y - food.y)
				if ((eater.pushVx !== 0 || eater.pushVy !== 0) && Math.abs(dNow - munch) < 1e-6) {
					pinnedFrames++
				}
			}
			const d = Math.hypot(eater.x - food.x, eater.y - food.y)
			if (!(d > munch)) {
				broomProblems.push(
					`扫了 1.5 秒，趴在果子上的那只离圆心还有 ${d.toFixed(1)}px（munchRadius 是 ${munch.toFixed(1)}）—— ` +
						`多半是 _clampToFood 把它按住了（见那条注释）`,
				)
			}
			if (pinnedFrames > 0) {
				broomProblems.push(
					`被扫帚推着的时候有 ${pinnedFrames} 帧正好停在 munchRadius 上 —— ` +
						`_clampToFood 那个「被推着就不夹」的守卫没生效（结果也许照样推得动，但那是靠浮点运气）`,
				)
			}
			if (eater.dead) broomProblems.push('被扫的那只幼虫死了 —— 扫帚不该有杀伤力')
		}
	}

	// —— 记忆不许被抹掉 ——
	//
	// 抹掉 scentSpot 的扫帚等于洗脑：被扫开之后不会再爬回果子。
	// 而「赶开一坨蛆、它们过会儿又聚回来」正是这个工具的用法
	{
		const sw = new World(W, H)
		sw.reset()
		sw.larvae.length = 0
		const L = new Larva(CX, CY, null, 0)
		L.scentSpot = { x: CX + 300, y: CY, r: 20 }
		L.buddy = null
		sw.larvae.push(L)
		sw.broom(CX, CY, R)
		if (!L.scentSpot) broomProblems.push('扫帚把 scentSpot 清掉了 —— 被扫开的幼虫会忘记食物在哪儿')
	}

	console.log(
		`  扫帚：半径 ${R}px 推走 ${pushed}/${N} 只（圈外不动）· 圆心快边缘慢、夹在 ${B.pushMaxSpeed}px/s · ` +
			`蛹 / 卵 / 成虫 / 尸体都不受影响 · 半径 0 空转 · 趴在果子上的也推得动`,
	)
}

// ---------------------------------------------------------------- 放大镜
const magnifierProblems = []
//
// ⚠ 这一节测的是**坐标换算**，不是画得好不好看。
//   三种来源的 x / y 不是同一个坐标系：world.flies 是屏幕坐标，
//   而 jar.flies / oven.items 是**相对容器中心**的偏移。
//   忘了加偏移的话，光环会全叠在屏幕左上角，而虫子好好地画在罐子里 ——
//   看起来像「光环全跑到一起了」，光看代码几乎发现不了
{
	const mw = new World(W, H)
	mw.reset()
	mw.flies.length = 0
	mw.larvae.length = 0
	mw.jars.length = 0
	mw.ovens.length = 0
	const tiers = magnifierDefaultTiers()

	// —— 默认勾的档位要「够得着变异蝇」——
	//
	// 门槛最初是价格 10.1（只有极端变异会亮，0.5%），买完基本没见过它亮一次。
	// 现在门槛是**档位集合**，这里钉的是同一条线：
	// 默认要含「稀有」（变异蝇的中段落在那里），不含「普通」（否则满屏都亮）
	if (!tiers.includes('rare')) {
		magnifierProblems.push(`放大镜默认没勾「稀有」档 —— 变异蝇（$0.1~$10）基本亮不起来（现在是 ${tiers.join('/')}）`)
	}
	if (tiers.includes('common')) {
		magnifierProblems.push('放大镜默认勾了「普通」档 —— 连普通蝇（$0.002~$0.014）都会亮，等于满屏都是光环')
	}
	if (tiers.length === 0) {
		magnifierProblems.push('放大镜默认档位是空集 —— 买完一档都不亮')
	}
	// 反向断言：旧的那个单一门槛必须**删干净**了。
	// 留着的话它就是个谎 —— 全局只有一个门槛这件事已经不存在了
	// （同一个套路用在删养蝇人价格滑条那次）
	if (magnifierItem() && 'minValue' in magnifierItem()) {
		magnifierProblems.push('放大镜配置里还留着 minValue —— 门槛已经改成档位集合了，这个字段是个谎')
	}

	// —— 三只果蝇：一只在屏幕上、一只在罐子里、一只在烤炉里 ——
	const screenFly = mw.addFly(800, 600, 'F', 'extreme', [])
	const jarFly = mw.addFly(0, 0, 'F', 'extreme', [])
	const ovenFly = mw.addFly(0, 0, 'M', 'extreme', [])
	if (!screenFly || !jarFly || !ovenFly) {
		magnifierProblems.push('造不出放大镜测试用的果蝇')
	} else {
		// 催肥，保证三只都过门槛（改的是 getter 依赖的字段，不是 value 本身）
		for (const f of [screenFly, jarFly, ovenFly]) {
			f.weightMax = 5000
			f.age = f.lifespan * 0.9
		}

		const jar = mw.addJar(300, 200)
		const oven = mw.addOven(1400, 300)
		if (!jar || !oven) {
			magnifierProblems.push('造不出放大镜测试用的罐子 / 烤炉')
		} else {
			jar.admit(jarFly)
			mw.flies.splice(mw.flies.indexOf(jarFly), 1)
			oven.items.push(ovenFly)
			mw.flies.splice(mw.flies.indexOf(ovenFly), 1)
			// 容器里的坐标是**相对容器中心**的偏移 —— 故意给一个非零值，
			// 全给 0 的话「忘了加偏移」和「加对了」结果一模一样，测不出来
			jarFly.x = 40
			jarFly.y = -25
			ovenFly.x = -30
			ovenFly.y = 18

			const targets = magnifierTargets(mw, tiers)
			const at = (fly) => targets.find((c) => c.fly === fly)

			if (targets.length !== 3) {
				magnifierProblems.push(`放大镜应当罩住 3 只（屏幕 / 罐中 / 炉中各一只），实际 ${targets.length} 只`)
			}
			const tScreen = at(screenFly)
			const tJar = at(jarFly)
			const tOven = at(ovenFly)
			if (!tScreen || !tJar || !tOven) {
				magnifierProblems.push('三种来源里有没被罩住的 —— 放大镜应当连罐子和烤炉里的也一起高亮')
			} else {
				if (tScreen.x !== screenFly.x || tScreen.y !== screenFly.y) {
					magnifierProblems.push('屏幕上那只的坐标被改动了 —— 它本来就是屏幕坐标，不该再加偏移')
				}
				if (Math.abs(tJar.x - (jar.x + 40)) > 1e-9 || Math.abs(tJar.y - (jar.y - 25)) > 1e-9) {
					magnifierProblems.push(
						`罐中那只的光环画在 (${tJar.x}, ${tJar.y})，应当是 (${jar.x + 40}, ${jar.y - 25}) —— 漏了罐心的偏移`,
					)
				}
				if (Math.abs(tOven.x - (oven.x - 30)) > 1e-9 || Math.abs(tOven.y - (oven.y + 18)) > 1e-9) {
					magnifierProblems.push(
						`炉中那只的光环画在 (${tOven.x}, ${tOven.y})，应当是 (${oven.x - 30}, ${oven.y + 18}) —— 漏了炉心的偏移`,
					)
				}
			}

			// —— 没勾的档不亮 ——
			const cheap = mw.addFly(100, 100, 'F', 'normal', [])
			if (cheap) {
				cheap.age = 0 // 刚出生：体重就是出生体重，价值最低 → 落在「普通」档
				const cheapHit = magnifierTargets(mw, tiers).some((c) => c.fly === cheap)
				if (cheapHit) {
					magnifierProblems.push('刚出生的小蝇也被放大镜罩住了 —— 默认不该勾到它那一档')
				}
				// 单独勾上「普通」档，它就该亮了 —— 这条证明筛的**真的是档位**，
				// 而不是「贵的才亮」那种碰巧对上的行为
				const onlyCommon = magnifierTargets(mw, ['common']).some((c) => c.fly === cheap)
				if (!onlyCommon) {
					magnifierProblems.push('只勾「普通」档时，刚出生的小蝇却没亮 —— 筛的不是价值档')
				}
			}

			// —— 空集是合法的，而且不能抛 ——
			//
			// 「一档都不勾」= 把放大镜关掉，是个正当选择。它必须表现为
			// 「什么都不亮」，而不是崩溃或者退回默认
			if (magnifierTargets(mw, []).length !== 0) {
				magnifierProblems.push('放大镜档位是空集时还有东西在亮 —— 空集应当表示「都不亮」')
			}
			// 不存在的档位 id 也不该炸（存档可能是手改的）
			if (magnifierTargets(mw, ['mythic', '不存在的档']).length !== 0) {
				magnifierProblems.push('勾了不存在的档位时有东西亮了 —— sanitize 没生效')
			}

			// —— 勾选集合的写入路径：去重、丢非法、按 valueTiers 顺序排 ——
			const probeTiers = new World(W, H)
			probeTiers.setMagnifierTiers(['epic', 'rare', 'rare', 'bogus'])
			if (JSON.stringify(probeTiers.magnifierTiers) !== JSON.stringify(['rare', 'epic'])) {
				magnifierProblems.push(
					`setMagnifierTiers 洗完是 ${JSON.stringify(probeTiers.magnifierTiers)}，应当是 ["rare","epic"]（去重 + 丢非法 + 按档位顺序）`,
				)
			}
			// 非数组 → 退回默认，而不是空集。
			// 「传了个乱七八糟的东西」和「玩家主动一档都不勾」必须分开 ——
			// 后者是合法的，前者是调用方的 bug
			probeTiers.setMagnifierTiers('nope')
			if (JSON.stringify(probeTiers.magnifierTiers) !== JSON.stringify(magnifierDefaultTiers())) {
				magnifierProblems.push('setMagnifierTiers 收到非数组时没有退回默认值')
			}
			// 勾 / 取消一个档位，而且允许勾成空集
			probeTiers.setMagnifierTiers([])
			if (!probeTiers.toggleMagnifierTier('rare')) magnifierProblems.push('toggleMagnifierTier 勾不上')
			if (probeTiers.toggleMagnifierTier('rare')) magnifierProblems.push('toggleMagnifierTier 取消不掉')
			if (probeTiers.magnifierTiers.length !== 0) magnifierProblems.push('取消之后应当是空集')
			if (probeTiers.toggleMagnifierTier('不存在')) magnifierProblems.push('toggleMagnifierTier 接受了不存在的档位')

			// —— 存档往返 ——
			//
			// ⚠ 这条**必须单独写**：存档那节里的「逐字段比对」只覆盖实体数组
			//   （flies / larvae / …），而「二次往返稳定」也只在计数同样变化时才报 ——
			//   所以一个**顶层世界字段**丢了，现在的存档测试是看不见的
			probeTiers.setMagnifierTiers(['common', 'mythic'])
			const roundTrip = new World(W, H)
			roundTrip.restore(probeTiers.serialize())
			if (JSON.stringify(roundTrip.magnifierTiers) !== JSON.stringify(['common', 'mythic'])) {
				magnifierProblems.push(
					`存档往返之后放大镜档位变成了 ${JSON.stringify(roundTrip.magnifierTiers)}，应当是 ["common","mythic"]`,
				)
			}
			// 老存档（没这个字段）要拿到默认值，而不是 undefined / 空集
			const legacyTiers = new World(W, H)
			legacyTiers.restore({ ...probeTiers.serialize(), magnifierTiers: undefined })
			if (JSON.stringify(legacyTiers.magnifierTiers) !== JSON.stringify(magnifierDefaultTiers())) {
				magnifierProblems.push('老存档（没有 magnifierTiers 字段）没有拿到默认档位')
			}
			// 手改过的存档（塞了不存在的档位）要被洗干净，而不是静默留着一个死 id
			const dirtyTiers = new World(W, H)
			dirtyTiers.restore({ ...probeTiers.serialize(), magnifierTiers: ['rare', '不存在', 'rare'] })
			if (JSON.stringify(dirtyTiers.magnifierTiers) !== JSON.stringify(['rare'])) {
				magnifierProblems.push(
					`脏存档里的档位没洗干净：${JSON.stringify(dirtyTiers.magnifierTiers)}`,
				)
			}
			// sanitizeTiers 本身也不能崩
			if (sanitizeTiers(null).length !== 0 || sanitizeTiers('x').length !== 0) {
				magnifierProblems.push('sanitizeTiers 收到非数组时应当返回空集')
			}

			console.log(
				`  放大镜：默认勾 ${tiers.join('/')}；屏幕 ${tScreen ? '亮' : '不亮'} · ` +
					`罐中（偏移 ${jar.x + 40},${jar.y - 25}）${tJar ? '亮' : '不亮'} · ` +
					`炉中（偏移 ${oven.x - 30},${oven.y + 18}）${tOven ? '亮' : '不亮'}；` +
					'档位集合可勾可洗可存档',
			)
		}
	}
}

// ---------------------------------------------------------------- 商店 / 投放的分类
//
// ⚠ 分类表（`market.shopCats` / `feedCats`）是**渲染顺序和归组的唯一来源** ——
//   UI 完全按它遍历，不在代码里另写判断。好处是加商品只改一处，
//   代价是**漏改一处就会静默出错**：
//     · 商品漏归类 → 它从商店里**凭空消失**，界面上没有任何异常
//     · 商品归了两类 → 渲染两遍，看起来像「重复的商品」
//   两种都不会报错，所以必须有一条断言盯着
{
	const catProblems = []

	/** 把一张分类表摊平成 id → 出现次数 */
	const tally = (cats) => {
		const seen = new Map()
		for (const c of cats) {
			for (const id of c.items) seen.set(id, (seen.get(id) ?? 0) + 1)
		}
		return seen
	}

	// —— 商店：一次性道具 + 两条升级链 ——
	const shopTally = tally(CONFIG.market.shopCats)
	const shopWanted = [
		...CONFIG.market.shop.map((it) => it.id),
		'roast', // 烤制链（在 market.roastChain 里，不在 market.shop 里）
		'keeper', // 养蝇人链
	]
	for (const id of shopWanted) {
		const n = shopTally.get(id) ?? 0
		if (n === 0) catProblems.push(`商店商品「${id}」没有归到任何分类里 —— 它不会出现在商店界面上`)
		if (n > 1) catProblems.push(`商店商品「${id}」被归了 ${n} 个分类 —— 会被渲染 ${n} 遍`)
	}
	// 反过来：分类表里写了不存在的 id（多半是改名或删商品时漏了）
	for (const id of shopTally.keys()) {
		if (!shopWanted.includes(id)) catProblems.push(`商店分类里写了一个不存在的商品 id：${id}`)
	}

	// —— 投放：食物 + 果蝇 + 玻璃罐 ——
	// ⚠ `jar` 是特例：它不花钱、不在任何价格表里（走 world.dropJar），
	//   但仍然要归类，否则那颗按钮就没了
	const feedTally = tally(CONFIG.market.feedCats)
	// ⚠ 这张表是**手写的**，不从 feedCats 现算 —— 现算的话它就永远绿，等于不测。
	//   `oven` 必须手写进来：它是 `prices` 的**顶层键**，
	//   不会被 `Object.keys(prices.food)` 带出来（那个只看 food 那一层）
	const feedWanted = [...Object.keys(CONFIG.market.prices.food), 'fly', 'jar', 'oven']
	for (const id of feedWanted) {
		const n = feedTally.get(id) ?? 0
		if (n === 0) catProblems.push(`投放项「${id}」没有归到任何分类里 —— 它不会出现在投放界面上`)
		if (n > 1) catProblems.push(`投放项「${id}」被归了 ${n} 个分类 —— 会被渲染 ${n} 遍`)
	}
	for (const id of feedTally.keys()) {
		if (!feedWanted.includes(id)) catProblems.push(`投放分类里写了一个不存在的 id：${id}`)
	}

	if (catProblems.length) buyProblems.push(...catProblems)
	console.log(
		`  分类：商店 ${CONFIG.market.shopCats.length} 组（${shopWanted.length} 件）、` +
			`投放 ${CONFIG.market.feedCats.length} 组（${feedWanted.length} 项），全部各归其位`,
	)
}

// ---------------------------------------------------------------- 烤制经济
console.log('\n—— 烤制经济 ——')
const roastProblems = []
{
	const R = CONFIG.roast
	const chain = CONFIG.market.roastChain
	const w = new World(W, H)
	w.reset()

	// —— 1. 拍死留下的尸体带着售价 ——
	//
	// ⚠ 从 1.18.0 起，**地上的尸体不能再烤了** —— 打火机 / 喷火枪改成点着活蝇。
	//   所以这一节测的不再是「尸体能不能烤」，而是「尸体还值不值钱」：
	//   它必须记住「这曾经是一只值多少钱的果蝇」，否则拍死的果蝇就只是
	//   一堆擦掉完事的垃圾，玩家连按原价卖掉这条路都没有
	w.flies.length = 0
	w.remains.length = 0
	const victim = w.addFly(W / 2, H / 2, 'F')
	if (!victim) roastProblems.push('addFly 失败，后面都没法测')
	// 让它长一会儿再拍，这样 value 是个像样的数
	for (let i = 0; i < 600; i++) victim.update(16, w)
	const valueBefore = victim.value

	const c1 = w.addRemains(victim.x, victim.y, 'corpse', victim.size, victim.angle, victim)
	if (!c1) roastProblems.push('addRemains 没造出尸体')
	else {
		if (c1.value !== valueBefore) {
			roastProblems.push(`尸体上的售价快照不对：${c1.value} vs ${valueBefore}`)
		}
		if (c1.rarity !== victim.rarity) roastProblems.push('尸体的稀有度没抄过来')
		if (c1.sex !== victim.sex) roastProblems.push('尸体的性别没抄过来')
		if (!c1.sellable) roastProblems.push('刚拍死的尸体应当是能卖的')
		if (Math.abs(c1.decayFactor - 1) > 1e-9) roastProblems.push('刚拍死的尸体不该掉价')
		// ⚠ 这条钉的是「倍率那一档真的没了」：`roastMul` 要是被谁加回来，
		//   地上的尸体就会比活蝇还值钱，而点火器那一整套就没意义了
		if (c1.roastMul !== undefined) {
			roastProblems.push('尸体上又出现了 roastMul —— 尸体从 1.18.0 起不该有倍率这一档')
		}
		if (Math.abs(c1.price - c1.value * c1.decayFactor) > 1e-9) {
			roastProblems.push(`尸体的价钱 ${c1.price} 不等于「原价 × 掉价」—— 多半是倍率被加回来了`)
		}
	}
	console.log(
		`  尸体：拍死一只满成长雌蝇，售价快照 ${formatMoney(valueBefore)}（稀有度 ${victim.rarity}）· **只能按原价卖**`,
	)

	// ⚠ 汁渍不能卖 —— 它是拍击溅出来的，不是一具身体，连 value 都没有
	const stain = w.addRemains(50, 50, 'stain', 20, 0)
	if (stain) {
		if (stain.sellable) roastProblems.push('汁渍被当成能卖的了 —— 它没有身体')
		if (stain.price > 0) roastProblems.push('汁渍居然有价钱')
		if (w.sellFly(stain) > 0) roastProblems.push('汁渍被卖出去了')
	}

	// —— 2. 掉价曲线：前 5 分钟 1 倍，5~20 分钟掉到 0.1，之后保持 ——
	if (c1) {
		const dec = CONFIG.roast
		const check = (min, want, label) => {
			const probe = w.addRemains(0, 0, 'corpse', 14, 0, victim)
			probe.age = min * 60000
			if (Math.abs(probe.decayFactor - want) > 1e-6) {
				roastProblems.push(`${label}（${min} 分钟）系数是 ${probe.decayFactor}，应当是 ${want}`)
			}
			return probe
		}
		check(0, 1, '刚拍死')
		check(4.99, 1, '掉价前一刻')
		check(5, 1, '刚好到 5 分钟')
		// 5~20 分钟线性：中点是 1 和 0.1 的中值
		check(12.5, (1 + dec.decayTo) / 2, '掉价中点')
		check(20, dec.decayTo, '掉价结束')
		check(999, dec.decayTo, '很久以后')

		// 掉价必须是**连续**的：不能用「超过某个点直接归零」那种阶梯
		const a = w.addRemains(0, 0, 'corpse', 14, 0, victim)
		a.age = 10 * 60000 - 1
		const b = w.addRemains(0, 0, 'corpse', 14, 0, victim)
		b.age = 10 * 60000 + 1
		if (Math.abs(a.decayFactor - b.decayFactor) > 1e-3) {
			roastProblems.push('掉价在中途出现了跳变，不是连续的')
		}
		console.log(
			`  掉价：0~${dec.decayStartMs / 60000} 分钟恒为 1 倍，` +
				`之后 ${dec.decaySpanMs / 60000} 分钟内线性掉到 ${dec.decayTo} 倍并保持`,
		)
	}

	// —— 3. 点火：点着 → 烧够时间 → **直接变钱**，不留尸体 ——
	//
	// 这是 1.18.0 这次改动的地基。和上一版的区别只有一处，但那是全部意义：
	//   上一版火只改**地上那具尸体**的价钱，还要玩家自己拖去出售区；
	//   这一版火直接烧**活着的成虫**，烧完自动结账。
	//
	// ⚠ 下面这几条必须逐条钉死：钱涨了多少、**尸体数没涨**、**natural 没涨**、
	//   sold 涨了。少了任何一条，「走 _resolveLifecycles 结算」那个 bug
	//   就会表现为「钱拿到了，地上还多一具尸体，统计里还多一个自然老死」——
	//   三件事各自都不报错
	for (const tier of chain) {
		const wb = new World(W, H)
		wb.reset()
		wb.flies.length = 0
		wb.remains.length = 0
		wb.shop.roast = tier.level

		const f = wb.addFly(W / 2, H / 2, 'F')
		if (!f) {
			roastProblems.push(`${tier.name} 那段：addFly 失败`)
			continue
		}
		for (let i = 0; i < 600; i++) f.update(16, wb)

		if (!wb.ignite(f, tier.id)) {
			roastProblems.push(`${tier.name} 没点着`)
			continue
		}
		if (f.burnLeft !== tier.burnMs) {
			roastProblems.push(`${tier.name} 的燃烧时长是 ${f.burnLeft}，应当是 ${tier.burnMs}`)
		}
		if (f.burnMul !== tier.mul) roastProblems.push(`${tier.name} 的倍率没冻结在蝇身上`)
		if (!f.burning) roastProblems.push(`${tier.name} 点着之后 burning 是 false`)

		// ⚠ 再点一次必须被拒，而且**不能重置倒计时** ——
		//   UI 按住工具时会每帧调一次 ignite，能重置的话就永远烧不完
		const leftBefore = f.burnLeft
		if (wb.ignite(f, tier.id)) roastProblems.push(`${tier.name} 把同一只点了第二次`)
		if (f.burnLeft !== leftBefore) {
			roastProblems.push('重点一次把倒计时重置了 —— 按住不放就永远烧不完')
		}

		// 烧到一半：还在烧，而且**还没给钱**
		const money0 = wb.money
		for (let t = 0; t < Math.floor(tier.burnMs / 2 / 16); t++) wb._updateBurning(16)
		if (!f.burning) roastProblems.push(`${tier.name} 才烧了一半就结束了`)
		if (wb.money !== money0) roastProblems.push('还没烧完就给钱了')

		// —— 烧完：结账 ——
		// ⚠ 结账金额要在**最后一次 tick 之前**读 f.value（它是 age 派生的 getter，
		//   中间跑的这半程已经推进了年龄）。做法和炉子那段一样：
		//   把倒计时压到最后一帧，读完再走
		f.burnLeft = 1
		const want = f.value * tier.mul
		const remains0 = wb.remains.length
		const natural0 = wb.stats.natural
		const sold0 = wb.stats.sold ?? 0
		wb._updateBurning(16)

		// ⚠ **必须补这一行**。上面是直接调 `_updateBurning` 的（不经 `step()`），
		//   而「留尸体 / 记成自然老死」是 `_resolveLifecycles` 干的活 ——
		//   不调它的话，下面那两条断言**永远为真**：死掉的蝇在数组里没人收，
		//   自然也就没有尸体、没有计数。
		//   这正是「恒真的断言」那类陷阱：写完就绿，但它什么都没测。
		//   补上之后，「拿 die('roasted') 顶替 sellFly」那种写法会当场红两条
		wb._resolveLifecycles()

		const got = wb.money - money0
		if (Math.abs(got - want) > 1e-9) {
			roastProblems.push(
				`${tier.name} 烧完到账 ${formatMoney(got)}，应当是「售价 ${formatMoney(f.value)} × ${tier.mul}」= ${formatMoney(want)}`,
			)
		}
		if (wb.remains.length !== remains0) {
			roastProblems.push(`${tier.name} 烧完留下尸体了 —— 它必须直接变成钱`)
		}
		if (wb.stats.natural !== natural0) {
			roastProblems.push(`${tier.name} 烧完被记成了自然老死 —— 结算走到 _resolveLifecycles 里去了`)
		}
		if ((wb.stats.sold ?? 0) !== sold0 + 1) roastProblems.push(`${tier.name} 烧完的出售计数没涨`)
		if (wb.flies.indexOf(f) >= 0) roastProblems.push(`${tier.name} 烧完的蝇还留在 world.flies 里`)
		if (f.burnLeft > 0) roastProblems.push(`${tier.name} 结账之后倒计时没清`)
		// 冒了一个「+$x」（炉子那条路也是这么显示的，玩家才有得对照）
		if (wb.floatTexts.length === 0) roastProblems.push(`${tier.name} 烧完没有冒出金额飘字`)
	}
	console.log(
		`  点火：` +
			chain.map((t) => `${t.name} 烧 ${t.burnMs / 1000} 秒 ×${t.mul}`).join(' / ') +
			` —— 烧完直接到账、不留尸体、不计自然老死`,
	)

	// —— 3b. 灭火：四条抢先路径 ——
	//
	// ⚠ 不灭的话，那只虫会带着倒计时进容器，而容器里的虫不在 this.flies 里，
	//   `_updateBurning` 永远走不到它 —— 倒计时就永久悬在存档里了
	{
		const wE = new World(W, H)
		wE.reset()
		wE.shop.roast = 1

		const fresh = (x) => {
			wE.flies.length = 0
			const f = wE.addFly(x, H / 2, 'F')
			wE.ignite(f, 'lighter')
			return f
		}

		// ① 被拍死
		const fSwat = fresh(W * 0.3)
		if (!fSwat.burning) roastProblems.push('灭火那组：前提没成立（没点着）')
		wE.swat(fSwat.x, fSwat.y)
		if (fSwat.burning) roastProblems.push('被拍死的蝇还带着火')

		// ② 进玻璃罐
		const fJar = fresh(W * 0.4)
		wE.jars.length = 0
		const jar = wE.addJar(W / 2, H / 2)
		if (jar && jar.admit(fJar) && fJar.burning) roastProblems.push('进罐的蝇还带着火')

		// ③ 进烤炉
		const fOven = fresh(W * 0.5)
		wE.ovens.length = 0
		const ov = wE.addOven(W / 2, H / 2)
		if (ov && ov.admit(fOven) && fOven.burning) roastProblems.push('进炉的蝇还带着火')

		// ④ 被玩家手工卖掉（拖进出售区，不带第二个参数）
		const fSold = fresh(W * 0.6)
		const wantPlain = fSold.value
		const gotPlain = wE.sellFly(fSold)
		if (Math.abs(gotPlain - wantPlain) > 1e-9) {
			roastProblems.push(
				`手工卖掉一只烧着的蝇拿到 ${formatMoney(gotPlain)}，应当是**原价** ${formatMoney(wantPlain)} —— 倍率只有「让它自己烧完」才给`,
			)
		}
		if (fSold.burning) roastProblems.push('被卖掉的蝇还带着火')
	}

	// —— 3b-2. 手里拿的是**哪一把**就按哪一把算 ——
	//
	// ⚠ 这条是自检抓出来的一个真 bug：`ignite` 一开始取的是「当前**最高**档」，
	//   而不是「手里这一把」。玩家买到喷火枪之后工具栏上是两颗按钮，
	//   他完全可能回头去拿打火机 —— 那时点出来的是 3 秒 ×1.5，
	//   两颗按钮变成同一把，而界面上看不出任何异常。
	//
	//   模拟器原来一直绿，是因为它每次都把等级设成刚好等于要测的那一档，
	//   「最高档」和「手里那把」恰好一致。这条断言把两者拆开
	{
		const wT = new World(W, H)
		wT.reset()
		wT.shop.roast = 2 // **两把都买了**
		const chainT = CONFIG.market.roastChain
		const lo = chainT[0]
		const hi = chainT[1]

		wT.flies.length = 0
		const fLo = wT.addFly(200, 200, 'F')
		if (!wT.ignite(fLo, lo.id)) roastProblems.push('两把都买了，却点不着打火机')
		else {
			if (fLo.burnLeft !== lo.burnMs) {
				roastProblems.push(`拿着打火机点火，燃烧时长却是 ${fLo.burnLeft}，应当是 ${lo.burnMs}`)
			}
			if (fLo.burnMul !== lo.mul) {
				roastProblems.push(`拿着打火机点火，倍率却是 ${fLo.burnMul}，应当是 ${lo.mul} —— 取成最高档了`)
			}
			if (fLo.burnBig) roastProblems.push('拿着打火机点出来的却是大火焰')
		}

		// 反过来：拿着喷火枪就是高档那一套
		const fHi = wT.addFly(600, 200, 'F')
		if (!wT.ignite(fHi, hi.id)) roastProblems.push('两把都买了，却点不着喷火枪')
		else {
			if (fHi.burnLeft !== hi.burnMs) roastProblems.push('拿着喷火枪点的燃烧时长不对')
			if (fHi.burnMul !== hi.mul) roastProblems.push('拿着喷火枪点的倍率不对')
			if (!fHi.burnBig) roastProblems.push('拿着喷火枪点出来的不是大火焰')
		}

		// 没买到那一档就点不着：只有打火机时，喷火枪必须被拒
		const wT2 = new World(W, H)
		wT2.reset()
		wT2.shop.roast = 1
		wT2.flies.length = 0
		const fX = wT2.addFly(400, 400, 'F')
		if (wT2.ignite(fX, hi.id)) {
			roastProblems.push('只买了打火机，却能用喷火枪点火 —— 拥有权闸门没生效')
		}
		// 认不出的工具 id 也要拒绝，不能默默按某一档算
		if (wT2.ignite(fX, 'nonsense')) roastProblems.push('用不存在的工具 id 居然点着了火')
	}

	// —— 3c. 养蝇人不碰正在烧的 ——
	//
	// 自动出售是玩家没在看的时候发生的。正在烧、马上要按倍率结账的那只
	// 被按原价卖掉，是玩家看得见的一笔损失
	{
		const wK = new World(W, H)
		wK.reset()
		wK.shop.roast = 1
		wK.flies.length = 0
		const f = wK.addFly(W / 2, H / 2, 'F')
		for (let i = 0; i < 600; i++) f.update(16, wK)
		wK.ignite(f, 'lighter')

		wK.keeper.sell = true
		// 卖**全部**档位 —— 只要有一只没被排除，它就会被卖掉
		wK.keeper.tiers = CONFIG.market.valueTiers.map((t) => t.id)
		wK.money = 0
		wK._keeperSell()
		if (wK.flies.indexOf(f) < 0) {
			roastProblems.push('养蝇人把正在烧的蝇按原价卖掉了 —— 它该被跳过')
		}
		if (!f.burning) roastProblems.push('养蝇人那一路把火弄灭了')
	}

	// —— 4. 烤炉：容量 5，装满自动开烤，8 秒后整炉卖钱 ——
	//
	// ⚠ 炉子从 1.18.0 起**不在烤制链上了**，所以这里**不需要设等级**。
	//   1.27.0 起它是商店里的一件买断道具（`market.shop` 里 oven 那条），
	//   摆的时候直接调 dropOven()，**和钱无关** —— 所以这里也不用管钱。
	//   时长和倍率都从 CONFIG.roast.oven 直接读
	const oven = w.dropOven()
	if (!oven) roastProblems.push('dropOven 没造出炉子')
	else {
		if (oven.capacity !== R.oven.capacity) {
			roastProblems.push(`炉子容量 ${oven.capacity}，配置里是 ${R.oven.capacity}`)
		}
		w.flies.length = 0
		const put = []
		for (let i = 0; i < 7; i++) {
			const f = w.addFly(100 + i, 100, i % 2 ? 'F' : 'M')
			if (f) put.push(f)
		}
		let accepted = 0
		for (const f of put) if (w.putInOven(oven, f)) accepted++
		if (accepted !== R.oven.capacity) {
			roastProblems.push(`往容量 ${R.oven.capacity} 的炉子里塞了 7 只，收下了 ${accepted} 只`)
		}

		// —— 核心：**放进去就开始烤，不用等装满** ——
		//
		// ⚠ 这一条是 1.21.0「单独烤制」的全部意义。留神别把它当成
		//   「反正最后都会烤完」：老机制下推进到容量上限才开烤，
		//   而这句断言要的是**每一只刚进去就已经在倒计时**了 ——
		//   只塞 1 只进去也应该立刻开烤（下面单独验）
		if (!oven.roasting) roastProblems.push('刚放进去没有开始烤 —— 现在应当是进炉即开烤')
		for (const f of oven.items) {
			if (!(f.roastTotal > 0)) {
				roastProblems.push(`进炉之后 roastTotal 是 ${f.roastTotal}，倒计时会变成 NaN`)
				break
			}
			if (f.roastTotal !== R.oven.roastMs) {
				roastProblems.push(`单只时长是 ${f.roastTotal}，CONFIG.roast.oven.roastMs 是 ${R.oven.roastMs}`)
				break
			}
			if (f.roastLeft !== f.roastTotal) {
				roastProblems.push(`刚进炉 roastLeft 就是 ${f.roastLeft}，应当等于总时长`)
				break
			}
		}

		// 先盯住「没到点不能出炉」——不先验这一条的话，
		// 「倒计时写成 0、一帧就出炉」这种错会被下面的最终断言当成「通过」
		const mulWant = R.oven.mul
		const half = Math.floor(R.oven.roastMs / 32)
		for (let i = 0; i < half; i++) w._updateOvens(16)
		if (!oven.roasting) roastProblems.push('才烤了一半就出炉了')
		if (oven.items.length !== accepted) {
			roastProblems.push(`烤到一半炉子里只剩 ${oven.items.length} 只，应当是 ${accepted} 只`)
		}

		// —— 跑到「还差最后一帧」——
		//
		// ⚠ 不直接一路跑到出炉。结算要**精确**断言「每只卖了 售价 × 倍率」，
		//   而 `_updateOvens` 是先 `f.update(dt)` 老化、再结算的 ——
		//   一路跑过去的话，最后一次老化已经推进了 age，我手上记的 value
		//   就和结算时读到的不一样，断言只能写成「差一帧的近似」。
		//   压到 0 再 `_updateOvens(0)`：dt=0 时 `f.update(0)` 不推进年龄，
		//   于是记下来的 value 就是结算时的那一个
		// ⚠ 倒计时现在**挂在每只虫身上**（`f.roastLeft`），不再有炉子级的
		//   `roastTimer`。所以「压到最后一帧」要逐只压
		while (oven.roasting) {
			let anyFar = false
			for (const f of oven.items) {
				if (f.roastLeft > 16) anyFar = true
			}
			if (!anyFar) break
			w._updateOvens(16)
		}
		for (const f of oven.items) f.roastLeft = 0

		const wantEach = oven.items.map((f) => f.value)
		// 出炉之后 oven.items 会被清空，所以先把这几只留下来查生死
		const willRoast = oven.items.slice()
		const beforeRemains = w.remains.length
		const beforeMoney = w.money
		const beforeSold = w.stats.sold ?? 0
		const beforeTexts = w.floatTexts.length

		w._updateOvens(0)

		if (oven.items.length !== 0) roastProblems.push('出炉之后炉子里还有果蝇没清空')
		if (oven.roasting) roastProblems.push('出炉之后还在烤')

		// —— 核心契约：不留尸体，直接变钱 ——
		//
		// ⚠ 这一条是这次改动的**全部意义**。没钉住的话，「炉子又掉一地尸体」
		//   或者「钱没到账」都不会报错 —— 前者只是地上多几具，
		//   后者只是钱没涨，而两件事都要玩到才发现
		const newRemains = w.remains.length - beforeRemains
		if (newRemains !== 0) {
			roastProblems.push(`出炉之后地上多了 ${newRemains} 具尸体 —— 炉子现在应当直接变成钱，不留东西`)
		}

		const wantTotal = wantEach.reduce((a, v) => a + v * mulWant, 0)
		const gotMoney = w.money - beforeMoney
		if (Math.abs(gotMoney - wantTotal) > 1e-9) {
			roastProblems.push(
				`一炉到账 ${formatMoney(gotMoney)}，按「每只售价 × ${mulWant}」应当是 ${formatMoney(wantTotal)}`,
			)
		}
		const gotSold = (w.stats.sold ?? 0) - beforeSold
		if (gotSold !== accepted) {
			roastProblems.push(`一炉卖出计数涨了 ${gotSold}，应当是 ${accepted} —— 统计和钱对不上`)
		}
		// 炉里那几只确实死了，而且死因是「烤」而不是「卖」——
		// ⚠ 两者差别不只是文案：_resolveLifecycles 是按 causeOfDeath 决定要不要
		//   留尸体的，写成 'sold' 的话它们会绕过「不留尸体」那条路
		for (const f of willRoast) {
			if (!f.dead) roastProblems.push('出炉之后那只果蝇还是活的')
			if (f.causeOfDeath !== 'roasted') {
				roastProblems.push(`出炉的果蝇死因是「${f.causeOfDeath}」，应当是 roasted`)
			}
		}

		// —— 每只各冒一个数字 ——
		const texts = w.floatTexts.slice(beforeTexts)
		if (texts.length !== accepted) {
			roastProblems.push(`出炉冒出 ${texts.length} 个飘字，应当是 ${accepted} 个（每只一个）`)
		}
		// ⚠ 这里只比**金额的集合**，不比顺序 —— 顺序是**后进先出**，
		//   和放进炉子的先后相反。
		//
		//   原因在 world._updateOvens：那一圈倒着遍历 oven.items（结账时要把
		//   这一只 splice 掉，正着走会漏掉紧跟着的那一只），所以同一帧里一起
		//   烤满的这几只按倒序结账，飘字也跟着倒序。1.21.0 改「各自计时」之前
		//   一炉只有一个整炉倒计时、根本不会同帧结算，这条断言当时是逐位写的；
		//   改完之后它会**偶尔**红（5 只身价一样时又看不出来，所以十次里红一次，
		//   最难查的那种）。
		//
		//   ⚠ 这个顺序玩家看不出来 —— 延后本来就是用来把几个数字错开的，
		//     谁先谁后都一样 —— 所以**刻意不钉它**：钉了的话，谁把遍历方向
		//     改成正着走（一件完全无害的事）都会撞红一条其实不成立的断言。
		//
		//   ⚠ 但**别**因此退化成「只数个数」：金额算错倍数、或者张冠李戴成
		//     另一个数，只能靠下面这次集合比对抓出来
		//
		//   ⚠ 要注意这条的**分辨率**：比的是 formatMoney 三位小数之后的字符串，
		//     而一炉的金额就在 $0.004 这一档，所以 ±10% 的偏差（$0.0036 → $0.0040）
		//     是**看不见**的 —— 拿 1.1 倍去试会绿着回来。真要验它有没有牙齿，
		//     得用 2 倍这种量级的扰动
		const wantTexts = wantEach.map((v) => '+' + formatMoney(v * mulWant))
		const gotSorted = texts.map((t) => t.text).sort()
		const wantSorted = wantTexts.slice().sort()
		if (gotSorted.join(' | ') !== wantSorted.join(' | ')) {
			roastProblems.push(
				`一炉飘字的金额对不上：冒出来的是 ${gotSorted.join(' / ')}，应当是 ${wantSorted.join(' / ')}`,
			)
		}
		texts.forEach((t, i) => {
			// ⚠ 延后**按结账次序**发下去（第 i 个结账的延后 i 步），
			//   所以这一条仍然是逐位比对的 —— 它钉的是「错开」本身，
			//   和上面那个「谁先谁后」不是一回事
			const wantDelay = i * CONFIG.roast.oven.float.delayStep
			if (Math.abs(t.delay - wantDelay) > 1e-9) {
				roastProblems.push(`第 ${i} 个飘字的延后是 ${t.delay}，应当是 ${wantDelay}`)
			}
			// ⚠ 延后期间必须**完全不可见**：alpha 不是 0 的话，
			//   5 个数字会同时出现（只是寿命错开），等于没做错开
			if (t.delay > 0 && t.alpha !== 0) {
				roastProblems.push(`第 ${i} 个飘字还在延后期，alpha 却是 ${t.alpha} —— 错开没生效`)
			}
		})
		// 排在最后那个等够时间之后必须真的出现（延后期间不能扣寿命）
		const last = texts[texts.length - 1]
		if (last) {
			const totalDelay = last.delay
			for (let el = 0; el < totalDelay + 16; el += 16) last.update(16)
			if (!(last.alpha > 0)) {
				roastProblems.push('最后一个飘字等过了延后期还是不显示 —— 延后期间大概把寿命也扣掉了')
			}
			// 而且它是往上飘的
			const y0 = last.y
			last.update(100)
			if (!(last.y < y0)) roastProblems.push('飘字没有往上飘')
		}

		console.log(
			`  烤炉：容量 ${oven.capacity}，塞 7 只收下 ${accepted} 只、**进炉即开烤**（不用等装满），` +
				`各烤 ${R.oven.roastMs / 1000} 秒后**各自到账**共 ${formatMoney(wantTotal)}（×${mulWant}）、` +
				`不留尸体、每只各冒一个数字`,
		)

		// —— 单独烤制：**只放 1 只**也要自己烤完自己到账 ——
		//
		// ⚠ 这是和老机制差别最大的地方，而且是最容易「改回去也没人发现」的一条：
		//   老版本要装满 5 只才开烤，只放 1 只进去会永远躺在那儿。
		//   上面那一大段塞的是满炉，**一路满着跑**，所以这条单独放一只来验
		const solo = w.dropOven()
		if (!solo) roastProblems.push('单独烤制用的第二个炉子没造出来')
		else {
			const f = w.addFly(500, 500, 'M')
			if (!f) roastProblems.push('单独烤制的探针果蝇没造出来')
			else if (!w.putInOven(solo, f)) roastProblems.push('往空炉子里放 1 只居然被拒了')
			else if (!solo.roasting) roastProblems.push('只放了 1 只，炉子没有开始烤')
			else {
				const before = w.money
				// 差一帧停住，再 dt=0 结账 —— 和上面同一个理由（别让 age 漂）
				while (solo.roasting && f.roastLeft > 16) w._updateOvens(16)
				f.roastLeft = 0
				// ⚠ 售价必须在**跑完之后、结账之前**读：`f.value` 是从 age 派生的
				//   getter，上面那个 while 每转一圈都在推进年龄。
				//   在 while **之前**读的话，拿到的是几分钟前的价钱 ——
				//   而两边的差只有几厘，断言报出来会是「到账 $0.004，应当是 $0.004」
				//   这种看着像相等的一句话
				const wantSolo = f.value * mulWant
				w._updateOvens(0)
				if (solo.items.length !== 0) roastProblems.push('单独烤的那只没有出炉')
				const got = w.money - before
				if (Math.abs(got - wantSolo) > 1e-9) {
					roastProblems.push(
						`单只烤制到账 ${formatMoney(got)}，应当是 ${formatMoney(wantSolo)}`,
					)
				}
			}
			solo.dead = true
			w.ovens = w.ovens.filter((o) => o !== solo)
		}

		// —— 老存档迁移：炉里的虫没有 per-fly 倒计时时要补上 ——
		//
		// ⚠ 1.20.x 及以前的存档里，炉子是**整炉一个倒计时**（Oven.roastTimer），
		//   虫身上没有 roastLeft。那种档读进来之后每一只都是 null = 「没在烤」，
		//   而 1.21.0 起**没有别的地方能给它开烤**（全靠 admit 时挂上）。
		//   不迁移的话那些果蝇会永远卡在炉子里：不烤、不卖、拿不出来，也不报错。
		//
		//   造一个「老格式」的存档来验：把 items 里的 roastLeft / roastTotal 删掉
		{
			const src = new World(W, H)
			const oldOven = src.dropOven()
			const inside = src.addFly(300, 300, 'M')
			// ⚠ 必须**真的塞进炉子**再存 —— 只是造出来放在场上，
			//   `ovens[0].items` 会是空的，这条断言就变成对空数组做的（恒真）
			if (!oldOven || !inside || !src.putInOven(oldOven, inside)) {
				roastProblems.push('老存档迁移用的炉子 / 探针没准备好')
			}
			const snap = src.serialize()
			// 手写一份老格式：虫身上没有那两个键
			for (const o of snap.ovens) for (const it of o.items) delete it.roastLeft
			const dst = new World(W, H)
			dst.restore(JSON.parse(JSON.stringify(snap)))
			const restored = dst.ovens[0]
			if (!restored || restored.items.length !== 1) {
				roastProblems.push('老格式存档读回来之后炉子是空的 —— 迁移那段把虫弄丢了')
			} else if (restored.items[0].roastLeft !== R.oven.roastMs) {
				roastProblems.push(
					`老存档里的炉中虫读回来 roastLeft 是 ${restored.items[0].roastLeft}，` +
						`应当被补成 ${R.oven.roastMs} —— 不然它会永远卡在炉子里`,
				)
			} else if (!restored.roasting) {
				roastProblems.push('老存档里的炉中虫读回来没有开始烤')
			} else {
				// 补上之后要真的能烤完、能到账
				const before = dst.money
				const f2 = restored.items[0]
				while (restored.roasting && f2.roastLeft > 16) dst._updateOvens(16)
				f2.roastLeft = 0
				const want = f2.value * R.oven.mul
				dst._updateOvens(0)
				if (restored.items.length !== 0) roastProblems.push('老存档迁移过来的那只没有出炉')
				if (Math.abs(dst.money - before - want) > 1e-9) {
					roastProblems.push('老存档迁移过来的那只到账金额不对')
				}
				console.log(`  老存档迁移：炉里的虫没有倒计时 → 自动补成 ${R.oven.roastMs}ms 并正常烤完`)
			}
			// oldOven / inside 只是造存档用的，不影响后面
			void oldOven
			void inside
		}
	}

	// —— 5. 出售：尸体按 price 结算（= 原价 × 掉价，**没有倍率这一档**）——
	//
	// ⚠ 这里原来挑的是「烤过的、倍率最高的那一具」。尸体不能再烤之后
	//   那个筛选条件恒为空 —— 而「筛出空数组 → toSell 是 undefined →
	//   报一句『没有烤好的可以卖』」看起来像前面红了，其实只是断言过时了。
	//   所以直接挑**最值钱的那一具**，顺便覆盖「尸体按原价卖」这条契约
	const toSell = w.remains
		.filter((r) => r.sellable)
		.sort((a, b) => b.price - a.price)[0]
	if (!toSell) roastProblems.push('一具能卖的尸体都没有，前面的断言多半已经红了')
	else {
		const moneyBefore = w.money
		const want = toSell.price
		// 尸体那一支**不吃**第二个参数（倍率只作用于活蝇），这里显式传一个，
		// 顺便钉住「传了也会被忽略」——不然有人会以为尸体也能吃倍率
		const got = w.sellFly(toSell, 1.8)
		if (Math.abs(got - want) > 1e-9) {
			roastProblems.push(`卖尸体拿到 ${got}，应当是原价 × 掉价 = ${want}`)
		}
		if (Math.abs(w.money - moneyBefore - want) > 1e-9) {
			roastProblems.push('卖了尸体但钱没有加上去')
		}
		if (w.remains.indexOf(toSell) >= 0) roastProblems.push('卖掉之后尸体还留在 world.remains 里')
		console.log(
			`  出售：尸体卖出 ${formatMoney(got)}` + `（原价 ${formatMoney(toSell.value)} · 只剩原价这一档）`,
		)
	}

	// —— 6. 可升级链：逐级扣款、钱不够不扣不升 ——
	const cw = new World(W, H)
	cw.reset()
	const prices = chain.map((t) => t.price)
	// ⚠ 这个 13 是**手写的字面量**，故意不写 `reduce` 自己的结果 ——
	//   它守的是「玩家实际要付多少钱」这件事。从 chain 现算等于不测：
	//   改价格时它会跟着一起变，永远绿。
	//   ⚠ 所以**调价调到这条变红是正常的** —— 把 13 改成新的合计即可，
	//     但改之前先想一眼「这个总价是不是自己想要的」（$3 打火机 + $10 喷火枪）
	if (Math.abs(prices.reduce((a, b) => a + b, 0) - 13) > 1e-9) {
		roastProblems.push(`两档价格合计 ${prices.reduce((a, b) => a + b, 0)}，应当是 13`)
	}
	if (chain.length !== 2) {
		roastProblems.push(`烤制链有 ${chain.length} 档，应当是 2（炉子已经挪去投放了）`)
	}

	// 钱不够：一分都不能扣，等级也不能动
	cw.money = prices[0] - 0.01
	const lv0 = cw.shopLevel('roast')
	if (cw.upgradeShopItem('roast')) roastProblems.push('钱不够却升级成功了')
	if (cw.money !== prices[0] - 0.01) roastProblems.push('升级失败却扣了钱')
	if (cw.shopLevel('roast') !== lv0) roastProblems.push('升级失败但等级变了')

	// 钱够：逐级升到满
	cw.money = 100
	const spent = []
	for (let i = 0; i < chain.length; i++) {
		const before = cw.money
		if (!cw.upgradeShopItem('roast')) roastProblems.push(`第 ${i + 1} 级升级失败`)
		spent.push(before - cw.money)
		if (cw.shopLevel('roast') !== i + 1) {
			roastProblems.push(`升完第 ${i + 1} 级，等级却是 ${cw.shopLevel('roast')}`)
		}
	}
	// 满级之后再升必须失败，而且不能再扣钱
	const moneyAtMax = cw.money
	if (cw.upgradeShopItem('roast')) roastProblems.push('满级之后还能继续升')
	if (cw.money !== moneyAtMax) roastProblems.push('满级之后的升级扣了钱')

	if (spent.join(',') !== prices.join(',')) {
		roastProblems.push(`逐级实际扣款 ${spent.join(',')}，配置里是 ${prices.join(',')}`)
	}
	console.log(
		`  升级链：逐级扣款 ${spent.map(formatMoney).join(' → ')}（合计 ${formatMoney(spent.reduce((a, b) => a + b, 0))}），满级后不可再升`,
	)

	// 等级存进 world.shop 之后要能原样往返 —— 它是个**数字**不是布尔，
	// 而 hasShopItem 的 `!!` 语义分不出 0 和「没买」，所以这条必须单独钉
	const rt = cw.serialize()
	const back2 = new World(W, H)
	back2.restore(JSON.parse(JSON.stringify(rt)))
	if (back2.shopLevel('roast') !== chain.length) {
		roastProblems.push(`存档往返之后等级从 ${chain.length} 变成了 ${back2.shopLevel('roast')}`)
	}
	// 存档往返之后倍率不能丢 —— 它决定点火器能卖多少钱。
	// ⚠ 以前这里比的是 `roastMul()`（一个跟着等级走的 getter），
	//   那条路随炉子出链一起删了，现在比的是**当前档位的 mul**
	if (cw.burnTier().mul !== back2.burnTier().mul) {
		roastProblems.push('存档往返之后点火倍率对不上')
	}

	// —— 6b. 老存档里的越界等级：链被改短之后不能把整个程序炸掉 ——
	//
	// 这是 1.18.0 **真实踩过**的坑：烤制链从三档砍到两档（烤炉出链，变成投放里
	// $5 的商品），而 1.17 的存档里写着 `shop.roast: 3`。
	// UI 那边 `chain[lv - 1].name` 于是读到 undefined 并抛 TypeError，
	// 而那一行跑在**渲染循环里**（ui.update → refreshStats → refreshShop）——
	// 一抛，主循环就再也排不上下一帧。玩家的表现是
	// 「读档之后屏幕上一个生物都没有」，还不弹任何错误。
	//
	// 这里钉的是**源头**：shopLevel 必须把等级夹回链长以内。
	// 只在 UI 里加个兜底是不够的 —— burnTier / ignite / 养蝇人全都在读它
	const staleOver = new World(W, H)
	staleOver.shop.roast = chain.length + 5
	const gotOver = staleOver.shopLevel('roast')
	const tierOk = !!staleOver.chainTier('roast', gotOver)
	const burnOk = !!staleOver.burnTier()
	// 越界应当表现为「已经满级」，而不是崩溃、也不是还能继续升
	const upgraded = staleOver.upgradeShopItem('roast')

	// 反向：手改存档塞进来的负数也不能变成负等级
	const staleNeg = new World(W, H)
	staleNeg.shop.roast = -3
	const gotNeg = staleNeg.shopLevel('roast')

	if (gotOver !== chain.length) {
		roastProblems.push(
			`越界的等级没被夹回来：存档里是 ${chain.length + 5}，shopLevel 给出 ${gotOver}`,
		)
	}
	// 夹回来之后必须还能取到一个**真的档位** —— UI 那一行的名字就靠它
	if (!tierOk) roastProblems.push('夹回来的等级在链里取不到档位，界面会读到 undefined')
	if (!burnOk) roastProblems.push('越界等级让 burnTier 取不到档位（点火倍率会变成 NaN）')
	if (upgraded) roastProblems.push('等级越界之后居然还能继续升级')
	if (gotNeg !== 0) roastProblems.push(`负数等级没被夹成 0，而是 ${gotNeg}`)

	// ⚠ 这一行打印的是**实测值**，不是写死的结论 ——
	//   上面那几条断言全红的时候，它必须跟着一起露馅
	console.log(
		`  越界等级：老存档里的 ${chain.length + 5} → ${gotOver}（档位${tierOk ? '取得到' : '取不到'}），` +
			`负数 -3 → ${gotNeg}，再升一级${upgraded ? '居然成功了' : '被拒（满级）'}`,
	)

	// —— 7. 尸体 / 烧着的蝇 / 烤炉都要能存档往返 ——
	//
	// ⚠ 这些东西**全靠 snapshot 的反黑名单机制**自动跟随 —— 也就是说
	//   这条断言的真正作用是：万一将来谁把这些字段塞进了 REF_FIELDS、
	//   或者把 snapshot 改成白名单，这里当场红
	cw.remains.length = 0
	cw.flies.length = 0
	const mk = cw.addFly(W / 2, H / 2, 'F')
	if (mk) {
		for (let i = 0; i < 600; i++) mk.update(16, cw)
		const rc = cw.addRemains(mk.x, mk.y, 'corpse', mk.size, 0, mk)
		if (rc) rc.age = 7 * 60000 // 停在掉价中途
	}
	// 再放一只**正在烧的**进去：burnLeft / burnMul / burnBig 三个字段
	// 也是自有属性，必须跟着存档往返 —— 读回来它会接着烧完并自己结账
	const burnMe = cw.addFly(W * 0.3, H / 2, 'M')
	if (burnMe) {
		cw.shop.roast = 2
		cw.ignite(burnMe, 'flamer')
		cw.shop.roast = chain.length
	}

	const rt2 = cw.serialize()
	const back3 = new World(W, H)
	back3.restore(JSON.parse(JSON.stringify(rt2)))
	if (back3.remains.length !== cw.remains.length) {
		roastProblems.push(`存档往返之后尸体数从 ${cw.remains.length} 变成了 ${back3.remains.length}`)
	}
	if (back3.ovens.length !== cw.ovens.length) {
		roastProblems.push(`存档往返之后烤炉数从 ${cw.ovens.length} 变成了 ${back3.ovens.length}`)
	}
	for (let i = 0; i < cw.remains.length; i++) {
		const a = cw.remains[i]
		const b = back3.remains[i]
		if (!b) continue
		if (a.value !== b.value) roastProblems.push('尸体的 value 在存档往返里丢了')
		if (a.rarity !== b.rarity || a.sex !== b.sex) {
			roastProblems.push('尸体的 rarity / sex 在存档往返里丢了')
		}
		if (Math.abs(a.price - b.price) > 1e-9) {
			roastProblems.push(`存档往返之后价钱从 ${a.price} 变成了 ${b.price}`)
		}
		// ⚠ 老存档里的 roasted / roastMul 会被 revive 写回来（那两个键已经删了，
		//   revive 是「原型上没有就新增」）。它们**无害** —— price 和 drawCorpse
		//   两处都不再读它们。这里显式钉一句，免得以后有人看到存档里的
		//   两个陌生键以为是 bug
		if (b.roasted !== undefined && b.roastMul !== undefined && b.price !== a.price) {
			roastProblems.push('老存档里的 roasted / roastMul 居然影响了价钱 —— 那两个键必须被彻底忽略')
		}
	}
	// 烧着的一只：三个字段原样往返
	{
		const bBurn = back3.flies.find((f) => f.sex === 'M')
		if (!burnMe) roastProblems.push('存档往返那组：addFly 失败')
		else if (!bBurn) roastProblems.push('存档往返之后那只烧着的蝇不见了')
		else {
			if (bBurn.burnLeft !== burnMe.burnLeft) {
				roastProblems.push(`烧着的蝇 burnLeft 从 ${burnMe.burnLeft} 变成了 ${bBurn.burnLeft}`)
			}
			if (bBurn.burnMul !== burnMe.burnMul) roastProblems.push('烧着的蝇 burnMul 在存档往返里丢了')
			if (bBurn.burnBig !== burnMe.burnBig) roastProblems.push('烧着的蝇 burnBig 在存档往返里丢了')
			if (!bBurn.burning) roastProblems.push('读档回来那只蝇不烧了 —— 它该接着烧完并结账')
		}
	}
	console.log(
		`  存档往返：等级 ${chain.length} 保留，尸体 ${cw.remains.length} 具 / ` +
			`烤炉 ${cw.ovens.length} 个逐字段一致`,
	)
}
// ---------------------------------------------------------------- 模式（正常 / 烦人）
console.log('\n—— 模式 ——')
const modeProblems = []
{
	const W2 = CONFIG.world
	const w = new World(W, H)
	w.reset()

	// —— 1. 正常模式：上限原样 ——
	if (w.annoying) modeProblems.push('新世界默认就是烦人模式')
	if (w.maxAdults !== W2.maxAdults) modeProblems.push(`正常模式 maxAdults ${w.maxAdults} ≠ ${W2.maxAdults}`)
	if (w.maxLarvae !== W2.maxLarvae) modeProblems.push('正常模式 maxLarvae 对不上')
	if (w.maxEggs !== W2.maxEggs) modeProblems.push('正常模式 maxEggs 对不上')
	if (w.atPopCap) modeProblems.push('正常模式下总闸不该生效')
	console.log(
		`  正常：成虫 ≤ ${w.maxAdults} / 幼虫 ≤ ${w.maxLarvae} / 卵 ≤ ${w.maxEggs}，总闸不生效`,
	)

	// —— 2. 烦人模式：各项 ×50 ——
	w.settings.annoying = true
	const mul = W2.annoyingMul
	if (w.maxAdults !== W2.maxAdults * mul) modeProblems.push(`烦人模式 maxAdults ${w.maxAdults} ≠ ${W2.maxAdults * mul}`)
	if (w.maxLarvae !== W2.maxLarvae * mul) modeProblems.push('烦人模式 maxLarvae 对不上')
	if (w.maxEggs !== W2.maxEggs * mul) modeProblems.push('烦人模式 maxEggs 对不上')
	console.log(
		`  烦人：成虫 ≤ ${w.maxAdults} / 幼虫 ≤ ${w.maxLarvae} / 卵 ≤ ${w.maxEggs}（×${mul}）`,
	)

	// —— 3. 食物和残留物**不跟着放大** ——
	//
	// 这条是防止「顺手把所有 maxCount 都乘一遍」的。那两类是性能杀手
	// （每份食物都要跑轮廓、霉斑、招蝇判定），跟着 ×50 会直接把帧率打穿，
	// 而且不会报错、不会崩，只是越来越卡 —— 最难归因的那种
	const foodCap = CONFIG.food.maxCount
	const remainsCap = CONFIG.remains.maxCount
	w.flies.length = 0
	w.foods.length = 0
	for (let i = 0; i < foodCap + 40; i++) w.addFood(rand(0, W), rand(0, H), 'apple')
	if (w.foods.length > foodCap) {
		modeProblems.push(`烦人模式下食物上限被放大了（放下 ${w.foods.length} 份 > ${foodCap}）—— 它不该跟着乘`)
	}
	console.log(`  食物 / 残留物上限不放大：仍是 ${foodCap} / ${remainsCap}`)

	// —— 4. 总数硬闸 ——
	//
	// 三项各自 ×50 加起来是 6000+，不设总闸就是「卡死」而不是「烦人」。
	// 这里直接灌满，看总数会不会越过 annoyingTotalCap
	w.flies.length = 0
	w.larvae.length = 0
	w.eggs.length = 0
	let guard = 0
	while (w.livingCount < W2.annoyingTotalCap + 200 && guard < 6000) {
		guard++
		const before = w.livingCount
		w.addFly(rand(0, W), rand(0, H), 'M')
		w.addLarva(rand(0, W), rand(0, H), null, 0)
		w.spawnEgg(rand(0, W), rand(0, H))
		if (w.livingCount === before) break // 顶住了
	}
	if (w.livingCount > W2.annoyingTotalCap) {
		modeProblems.push(
			`生命体总数 ${w.livingCount} 越过了硬闸 ${W2.annoyingTotalCap} —— 各项 ×50 叠起来会卡死`,
		)
	}
	console.log(`  总闸：灌到 ${w.livingCount} 就被拦住了（上限 ${W2.annoyingTotalCap}）`)

	// —— 5. 切回正常：上限立刻回去，**但不清场** ——
	const aliveBefore = w.livingCount
	w.settings.annoying = false
	if (w.maxAdults !== W2.maxAdults) modeProblems.push('切回正常后 maxAdults 没还原')
	if (w.livingCount < aliveBefore) {
		modeProblems.push('切回正常模式时把超额的果蝇杀掉了 —— 上限只该拦新增，不该清场')
	}
	console.log(`  切回正常：上限立刻还原，场上 ${aliveBefore} 只一只没少`)

	// —— 6. 模式要进存档 ——
	w.settings.annoying = true
	w.flies.length = 0
	w.larvae.length = 0
	w.eggs.length = 0
	const rt = w.serialize()
	const back = new World(W, H)
	back.restore(JSON.parse(JSON.stringify(rt)))
	if (!back.annoying) modeProblems.push('存档往返之后烦人模式丢了')
	if (back.maxAdults !== W2.maxAdults * mul) modeProblems.push('存档往返之后上限没跟着还原')

	// 老存档（根本没有 settings 字段）必须落回正常模式，不能变成 undefined
	const oldSave = JSON.parse(JSON.stringify(rt))
	delete oldSave.settings
	const back2 = new World(W, H)
	back2.restore(oldSave)
	if (back2.annoying) modeProblems.push('没有 settings 字段的老存档被读成了烦人模式')
	if (back2.maxAdults !== W2.maxAdults) modeProblems.push('老存档读进来之后上限不对')
	console.log('  存档往返：模式保留；老存档（无此字段）落回正常模式')
}
// ---------------------------------------------------------------- 外观差异 / 挥手惊蝇
console.log('\n—— 个体差异 / 挥手惊蝇 ——')
const lifeProblems = []
{
	const w = new World(W, H)
	w.reset()

	// —— 1. 蛆的「外虚内实」是两成 ——
	//
	// ⚠ 只跑十几只就断言 20% 是测不出来的（十只里出三只完全正常）。
	// 这里抽 4000 只，把区间卡在 ±3 个百分点 —— 既能抓住「写成了 0.5」
	// 或者「压根没生效（恒 false）」，也不会因为随机抖动误报
	// ⚠ 直接 new Larva，不走 world.addLarva —— 后者卡在 maxLarvae（40 上下），
	//   40 个样本里出 0 个或 15 个都算「正常」，根本判不出 20% 对不对。
	//   这里要的是「抽得够多」，不是「世界里有几只」
	w.larvae.length = 0
	const want = CONFIG.larva.translucentChance
	// ⚠ 先确认配置读得到。不查的话，键名写错（比如放进 visual 了）会得到
	//   undefined，于是 `Math.random() < undefined` 恒为 false、
	//   而 `Math.abs(share - undefined) > 0.03` 是 NaN > 0.03 = **false** ——
	//   两处都不报错，整条断言静悄悄地通过，一条透明的蛆都长不出来
	if (!(want > 0 && want < 1)) {
		lifeProblems.push(`CONFIG.larva.translucentChance 是 ${want}，应当是一个 0~1 之间的比例`)
	}
	const N = 4000
	let translucent = 0
	for (let i = 0; i < N; i++) {
		if (new Larva(0, 0).translucent) translucent++
	}
	const share = translucent / N
	if (Math.abs(share - want) > 0.03) {
		lifeProblems.push(`外虚内实的蛆占 ${(share * 100).toFixed(1)}%，配置里是 ${want * 100}%`)
	}
	console.log(`  蛆：${N} 只里 ${translucent} 只是外虚内实（${(share * 100).toFixed(1)}%）`)

	// —— 2. 挥手惊蝇：近的受惊、远的照旧 ——
	w.flies.length = 0
	w.larvae.length = 0
	const near = w.addFly(500, 500, 'M')
	const far = w.addFly(500 + CONFIG.tools.startleRadius + 400, 500, 'M')
	if (!near || !far) lifeProblems.push('探针果蝇没造出来')

	w.startle.x = 500
	w.startle.y = 500
	w.startle.power = 1
	w._applyStartle()
	if (!(near.startleMul > 1.5)) {
		lifeProblems.push(`指针正下方的果蝇只有 ${near.startleMul.toFixed(2)} 倍速度 —— 全速挥手时该接近上限`)
	}
	if (far.startleMul !== 1) {
		lifeProblems.push(`半径外的果蝇被惊到了（倍率 ${far.startleMul}）—— 只有指针附近的才该受影响`)
	}

	// 手停下 → 全部复位。⚠ 归 1 而不是留旧值：
	// 留着的话果蝇会一直保持「刚被吓到」的速度，而屏幕上什么都没发生
	w.startle.power = 0
	w._applyStartle()
	if (near.startleMul !== 1 || far.startleMul !== 1) {
		lifeProblems.push('手停下之后速度倍率没有复位')
	}

	// —— 3. 倍率真的作用在移动上（不是只写了个字段） ——
	//
	// ⚠ 量的是**飞行**，不是爬行。受惊会把正在走路的蝇强制转成飞行
	// （这正是下面第 5 条要保证的行为），所以「受惊时的爬行速度」
	// 已经不是一个有意义的量了 —— 第一版就是量爬行，结果得到 19 倍，
	// 因为量的其实是「走 → 飞」的落差，而不是速度倍率
	const STEP_MS = (1 / 60) * 1000
	const flightSpeed = (power) => {
		const f = w.addFly(500, 500, 'M', 'normal')
		f.mode = 'fly'
		f.targetSpeed = 1000
		f.dartTimer = 1e9
		f.modeTimer = 1e9
		f.hoverTimer = 0
		f.bait = null
		f.vx = 0
		f.vy = 0
		w.startle.x = f.x
		w.startle.y = f.y
		w.startle.power = power
		for (let i = 0; i < 90; i++) {
			w.startle.power = power
			// ⚠ 指针要**跟着果蝇走**。钉死在出生点的话，它一飞出去就出了
			// 190px 的半径，后面几十帧的倍率全是 1 —— 量出来只有 1.05 倍，
			// 看着像 startleMul 没生效，其实是它早跑远了
			w.startle.x = f.x
			w.startle.y = f.y
			w._applyStartle()
			// 受惊会把 aim 掰向背离指针的方向。这里只量**速度**，朝向钉回 0
			f.aim = 0
			f.angle = 0
			f.update(STEP_MS, w)
		}
		w.flies.length = 0
		// ⚠ 量的是**收敛后的瞬时速度**，不是累计路程 ÷ 时间。
		// 以 3500px/s 飞 1.5 秒会跑 5000 多像素、直接撞出屏幕边界，
		// 路程被截断之后算出来只有 2.6 倍，看着像倍率没吃满
		return Math.hypot(f.vx, f.vy)
	}
	const calm = flightSpeed(0)
	const panicked = flightSpeed(1)
	const measured = panicked / Math.max(1e-6, calm)
	// 指针正下方时 near = 1，所以倍率应当正好顶到上限
	if (!(Math.abs(measured - CONFIG.tools.startleMaxMul) < 0.2)) {
		lifeProblems.push(
			`正下方受惊的倍率是 ${measured.toFixed(2)}，应当是上限 ${CONFIG.tools.startleMaxMul} —— startleMul 没真的作用到移动上`,
		)
	}
	console.log(
		`  挥手：飞行 ${calm.toFixed(0)} → ${panicked.toFixed(0)} px/s（${measured.toFixed(2)} 倍，上限 ${CONFIG.tools.startleMaxMul}）`,
	)

	// —— 4. 罐中 / 炉中不受影响 ——
	//
	// 被关着的东西不该对外面的手有反应。⚠ 这条是**反向守卫**：
	// _applyStartle 只写 this.flies，所以那两条路天然写不到；
	// 但「进罐/进炉前身上带着的倍率」会留下来，所以 admit 里必须显式清零
	w.flies.length = 0
	w.jars.length = 0
	w.ovens.length = 0
	const jf = w.addFly(600, 400, 'M')
	const jar = w.addJar(600, 400)
	w.startle.x = 600
	w.startle.y = 400
	w.startle.power = 1
	w._applyStartle()
	if (!(jf.startleMul > 1)) lifeProblems.push('罐外那只没被惊到（构造数据时就错了）')
	jar.admit(jf)
	if (jf.startleMul !== 1) {
		lifeProblems.push(`进罐之后还带着 ${jf.startleMul} 倍速 —— 被关着的东西不该对外面的手有反应`)
	}

	const of = w.addFly(600, 400, 'M')
	w._applyStartle()
	const oven = w.addOven(600, 400)
	oven.admit(of)
	if (of.startleMul !== 1) lifeProblems.push('进烤炉之后还带着惊吓倍率')

	w.startle.power = 0
	console.log('  罐中 / 炉中：进门时清零，外面怎么挥手都不受影响')

	// —— 5. 受惊必须是**行为**上的改变，不只是数值 ——
	//
	// ⚠ 这里踩过一次：只乘速度的话，悬停中的蝇 `_fly` 里
	// `hoverTimer > 0 ? 0 : targetSpeed` 目标速度是 0，乘多少倍还是 0 ——
	// 手从它身上扫过去，它还在原地悬着。走路的那批也只是走快一点，不会起飞
	const wS = new World(W, H)
	wS.flies.length = 0
	const hoverer = wS.addFly(500, 500, 'M')
	hoverer.mode = 'fly'
	hoverer.hoverTimer = 5000 // 正在悬停
	wS.startle.x = 500
	wS.startle.y = 500
	wS.startle.power = 1
	wS._applyStartle()
	if (hoverer.hoverTimer !== 0) {
		lifeProblems.push('悬停中的果蝇受惊之后还在悬停 —— 会停在地上一动不动')
	}

	const walker = wS.addFly(520, 500, 'M')
	walker.mode = 'walk'
	walker.pausing = true
	walker.aim = 0
	wS.flies.length = 2
	// ⚠ 鼠标要放得**够近**：强度是「power × 距离衰减」，而衰减到边缘是 0。
	// 放在 180px 处（半径 190）时 k 只有 0.05，低于 startleWakeAt，
	// 于是「惊飞」不触发 —— 报出来是「没有起飞」，看着像行为没接上
	wS.startle.x = 600 // 鼠标在它右边 80px
	wS.startle.y = 500
	wS.startle.power = 1
	// ⚠ 要连着调几帧。转向是 angleLerp 混合出来的（startleTurn = 0.5），
	// 调一次只转一半 —— 实测正好停在 90° 上，报出来是「没有朝背离方向逃」，
	// 而真实运行里 _applyStartle 是每帧都跑的，几帧之内就转过去了
	for (let i = 0; i < 6; i++) wS._applyStartle()
	if (walker.mode !== 'fly') lifeProblems.push('走路的果蝇被惊到之后没有起飞')
	if (walker.pausing) lifeProblems.push('受惊之后还停在原地「停顿」')
	// 应当朝**背离**鼠标的方向（鼠标在右边，所以是 -x，角度 ≈ ±π）。
	// 角度先收敛到 (-π, π] 再比 —— aim 是累加出来的，会漂到区间外
	const aimNorm = Math.atan2(Math.sin(walker.aim), Math.cos(walker.aim))
	if (!(Math.abs(Math.abs(aimNorm) - Math.PI) < 0.9)) {
		lifeProblems.push(`受惊之后没有朝背离指针的方向逃（aim=${aimNorm.toFixed(2)}，应当在 ±π 附近）`)
	}
	console.log('  受惊：悬停的被踢出悬停、走路的起飞、方向背离指针')

	// ⚠ 灵敏度。这条来自用户的**第二次**反馈：「成虫太容易被吓走了，
	//   灵敏度调低一点」—— 而第一次是**反过来**的（「鼠标移动就会受惊飞走」）。
	//   所以两头都要钉：中等强度**不许**起飞，贴脸全速**必须**起飞。
	//   只钉一头的话，把 startleWakeAt 改回 0.06 或直接调到 1.0 都会全绿
	const wokeAt = (power, dist) => {
		wS.flies.length = 0
		const f = wS.addFly(500, 500, 'M')
		f.mode = 'walk'
		f.pausing = true
		f.aim = 0
		wS.startle.x = 500 + dist
		wS.startle.y = 500
		wS.startle.power = power
		wS._applyStartle()
		return f.mode === 'fly'
	}
	// 中等强度 = 「稍微动一下手」。⚠ 这个点的 k 不是随手挑的 ——
	// 它正是旧阈值 0.06 会误判成「起飞」的那一类，也就是用户抱怨的那种手感
	const midK = 0.3 * (1 - 100 / CONFIG.tools.startleRadius)
	if (wokeAt(0.3, 100)) {
		lifeProblems.push(
			`中等强度的挥手（k≈${midK.toFixed(2)}）就把果蝇惊飞了 —— ` +
				`startleWakeAt=${CONFIG.tools.startleWakeAt} 太低，灵敏度又回去了`,
		)
	}
	if (!wokeAt(1, 10)) {
		lifeProblems.push('贴脸全速挥手都惊不飞果蝇 —— startleWakeAt 调过头了')
	}
	console.log(
		`  灵敏度：中等挥手（k≈${midK.toFixed(2)}）不惊飞、贴脸全速（k≈1）才飞` +
			`（阈值 ${CONFIG.tools.startleWakeAt}）`,
	)

	// —— 6. 饥饿：吃不到就饿死，留下尸体 ——
	const wL = new World(W, H)
	wL.reset()
	wL.larvae.length = 0
	const STEPMS = 1000 / 60
	const runHungry = (l, limitFrames = 60 * 300) => {
		let n = 0
		while (!l.dead && n < limitFrames) {
			l.ateLastTick = false // 一口都吃不到
			l.update(STEPMS, wL)
			n++
		}
		return (n * STEPMS) / 60000 // 分钟
	}

	const hungry = wL.addLarva(400, 400)
	hungry.starveAfter = 60000 // 1 分钟，好在测试里跑完
	const diedAt = runHungry(hungry)
	if (!hungry.dead) lifeProblems.push('一直吃不到东西的幼虫没有饿死')
	else if (hungry.causeOfDeath !== 'starved') {
		lifeProblems.push(`饿死的幼虫死因是「${hungry.causeOfDeath}」，应当是 starved`)
	}
	if (Math.abs(diedAt - 1) > 0.15) {
		lifeProblems.push(`饿死用了 ${diedAt.toFixed(2)} 分钟，阈值设的是 1 分钟`)
	}

	// 吃到东西就清零
	const fed = wL.addLarva(400, 400)
	fed.hunger = 50000
	for (let i = 0; i < 60; i++) {
		fed.ateLastTick = true
		fed.update(STEPMS, wL)
	}
	if (fed.hunger !== 0) lifeProblems.push('吃到了东西，饥饿值却没有清零')

	// ⚠ 蛹**不**累计饥饿。蛹本来就不吃东西，照常累计的话每一只都会在羽化前饿死
	const pupa2 = wL.addLarva(400, 400)
	pupa2.age = CONFIG.larva.pupateAt + 60000
	pupa2.starveAfter = 1000
	for (let i = 0; i < 600; i++) {
		pupa2.ateLastTick = false
		pupa2.update(STEPMS, wL)
	}
	if (pupa2.dead) lifeProblems.push('蛹饿死了 —— 蛹本来就不吃东西，不该累计饥饿')

	// 饿死的要由 world 留下尸体，而且那具尸体不能烤（蛆没有售价）
	wL.larvae.length = 0
	wL.remains.length = 0
	const corpse = wL.addLarva(400, 400)
	corpse.dead = true
	corpse.causeOfDeath = 'starved'
	wL._resolveLifecycles()
	const grubs = wL.remains.filter((r) => r.kind === 'grub')
	if (grubs.length !== 1) {
		lifeProblems.push(`饿死一只幼虫留下了 ${grubs.length} 具尸体，应当是 1 具`)
	}
	if (grubs[0] && grubs[0].roastable) {
		lifeProblems.push('蛆的尸体被当成能烤的了 —— 它 value 是 0，本来就卖不掉')
	}
	if (grubs[0] && !(grubs[0].rotTime > 0)) {
		lifeProblems.push('蛆的尸体不会腐烂 —— 那样永远不用清理')
	}
	console.log(
		`  饥饿：每只抽 ${CONFIG.larva.starveMin / MIN}~${CONFIG.larva.starveMax / MIN} 分钟，饿死留尸体（不可烤），蛹期不计`,
	)
}
console.log('')

// ---------------------------------------------------------------- 基因突变
console.log('—— 基因突变验证 ——')

const geneProblems = []
{
	const wG = new World(W, H)
	wG.reset()
	wG.flies.length = 0
	wG.larvae.length = 0
	wG.eggs.length = 0
	wG.foods.length = 0

	// —— 1. 子代的突变率：**和父母有没有完全无关** ——
	//
	// ⚠ 这一节**曾经**测的是遗传率（单方 1-(1-c)(1-p)、双方 1-(1-c)²(1-p)）。
	//   用户要求去掉遗传，现在全项目只有 rollDeNovo() 一条路，
	//   所以正确的断言变成了**反过来的那一条**：
	//
	//     父母带不带某种突变，对子代的出现率**没有任何影响**。
	//     两侧都应当 ≈ 该突变自己的 chance。
	//
	//   「单方」和「双方」两组数字**因此应该几乎一样**。这一点很值得钉：
	//   如果哪天有人把遗传加回来，两组会重新分开，而这条会立刻报警 ——
	//   这比「写一句注释说不要加回来」有用得多
	//
	// ⚠ 期望值从 config 现读、**不写死**，这样被断言的是「和 chance 一致」，
	//   而不是「有没有人偷偷改过那个数」
	const ALL = MUTATION_TYPES.map((t) => t.id)
	const mom = wG.addFly(300, 300, 'F', 'normal', ALL)
	const dad = wG.addFly(340, 300, 'M', 'normal', ALL)
	const lone = wG.addFly(380, 300, 'M', 'normal', [])
	if (!mom || !dad || !lone) {
		geneProblems.push('造不出带突变的亲本')
	} else {
		const TRIALS = 4000
		// 无论「父母带什么」，产下的卵都走同一个 rollDeNovo()。
		// ⚠ 参数留着不删是**刻意的**：它把「这里本该和父母有关」这件事
		//   摆在签名上，谁想加回遗传就得先动这个函数
		const rates = (_parentsGenes) => {
			const out = {}
			for (const t of MUTATION_TYPES) out[t.id] = 0
			for (let i = 0; i < TRIALS; i++) {
				// 直接调骰子，绕开繁殖 —— 要测的是**规则**本身，
				// 掺进产卵 / 孵化 / 上限那些环节只会让失败原因变得难查
				for (const id of rollDeNovo()) out[id]++
			}
			return out
		}

		// 4000 次的标准误约 0.008，所以 ±0.03 是 4 个标准差。
		// ⚠ 别收到 0.02 以下：下面两组各查五种，取的是**最大偏差**，
		//   等于把「4σ 才算异常」放松成了「10 次里有一次 4σ」
		const TOL = 0.03

		// 子代带上某个突变的概率**就是它自己的 chance**，没有别的项要并
		const expect = (t) => t.chance

		// 情况一：只有母亲携带
		const oneSide = rates(lone.mutations)
		let worstOne = 0
		let worstOneType = null
		for (const t of MUTATION_TYPES) {
			const d = Math.abs(oneSide[t.id] / TRIALS - expect(t))
			if (d > worstOne) {
				worstOne = d
				worstOneType = t
			}
		}
		console.log(
			`  只有母方携带 × ${TRIALS} 次：五种突变的出现率 ${MUTATION_TYPES.map((t) => (oneSide[t.id] / TRIALS * 100).toFixed(1) + '%').join(' / ')}` +
				`（期望 ${MUTATION_TYPES.map((t) => (expect(t) * 100).toFixed(1) + '%').join(' / ')}，就是各自的 chance）`,
		)
		if (worstOne > TOL) {
			geneProblems.push(
				`母方携带时「${worstOneType.name}」在子代里的出现率偏离它的 chance ` +
					`${(expect(worstOneType) * 100).toFixed(1)}% 达 ${(worstOne * 100).toFixed(1)} 个百分点`,
			)
		}

		// 情况二：双方都携带
		const both = rates(dad.mutations)
		let worstBoth = 0
		let worstBothType = null
		for (const t of MUTATION_TYPES) {
			const d = Math.abs(both[t.id] / TRIALS - expect(t))
			if (d > worstBoth) {
				worstBoth = d
				worstBothType = t
			}
		}
		console.log(
			`  双方都携带 × ${TRIALS} 次：出现率 ${MUTATION_TYPES.map((t) => (both[t.id] / TRIALS * 100).toFixed(1) + '%').join(' / ')}`,
		)
		if (worstBoth > TOL) {
			geneProblems.push(
				`双方携带时「${worstBothType.name}」在子代里的出现率偏离它的 chance ` +
					`达 ${(worstBoth * 100).toFixed(1)} 个百分点`,
			)
		}

		// ⚠⚠ **这一条是整节的重点**：父母带不带，子代的出现率必须一样。
		//
		//   上面两条各自按 chance 去卡，遗传只要不太重（比如 inheritChance
		//   很小）就可能都过；而「双方明显高于单方」正是遗传的**定义**，
		//   加回来一定会在这一条上露出来。
		//
		//   容差取 3 个百分点：两组各 4000 次、标准误各约 0.008，
		//   差值分布的标准误约 0.011，0.03 差不多是 3σ。
		//   ⚠ 别收到 0.02 以下 —— 那会变成偶发误报（同上面那段注释的教训）
		let worstGap = 0
		let worstGapType = null
		for (const t of MUTATION_TYPES) {
			const d = Math.abs(both[t.id] - oneSide[t.id]) / TRIALS
			if (d > worstGap) {
				worstGap = d
				worstGapType = t
			}
		}
		console.log(
			`  两组之差（应当为 0）：最大 ${(worstGap * 100).toFixed(1)} 个百分点（${worstGapType.id}）`,
		)
		if (worstGap > 0.03) {
			geneProblems.push(
				`父母带不带「${worstGapType.name}」，子代出现率差了 ${(worstGap * 100).toFixed(1)} 个百分点 —— ` +
					'突变**不该**从父母遗传，每颗卵只按自己的 chance 骰一次（见 mutations.js 文件头）',
			)
		}
	}

	// —— 2. 新发突变 ——
	//
	// 父母都是野生型时，子代只可能来自新发。九种概率加起来约 9%，
	// 所以「一只都没有」和「每只都有」都是错的
	{
		const TRIALS = 6000
		let withAny = 0
		for (let i = 0; i < TRIALS; i++) {
			if (rollDeNovo().length) withAny++
		}
		const rate = withAny / TRIALS
		// 「至少中一种」的准确值，不是概率之**和** ——
		// 各种突变是独立骰的，所以要用 1 - Π(1-p) 算并集。
		// 拿和当期望会偏高（8.9% vs 实际的 8.7%），是个很容易顺手写错的地方
		//
		// ⚠ 期望值从 chance 现算，所以这条断言验的是「实测和配置一致」，
		//   不锁具体数值 —— 调 chance 不会把它弄红
		const want = 1 - MUTATION_TYPES.reduce((s, t) => s * (1 - t.chance), 1)
		console.log(`  野生型双亲 ${TRIALS} 次产卵：新发突变出现率 ${(rate * 100).toFixed(1)}%（期望约 ${(want * 100).toFixed(1)}%）`)
		if (!(Math.abs(rate - want) < 0.02)) {
			geneProblems.push(`新发突变率是 ${(rate * 100).toFixed(1)}%，期望约 ${(want * 100).toFixed(1)}%`)
		}

		// —— 只报数，**不卡** ——
		//
		// ⚠ 「一颗卵有多普通」是玩家真正感觉到的那个数（四个 chance 的乘积），
		//   但它是个**手感值**，不是正确性标准：用户随时可能要求调大调小。
		//   钉死它的话，每次调 chance 都要先来这里改常量 —— 那是噪音。
		//   所以只打印出来，让人一眼看见「这次改动把普通率挪到哪了」。
		//   见 config.js 里 mutation 那一段的说明
		console.log(`  一颗卵是普通蝇的概率：${((1 - want) * 100).toFixed(2)}%（四个 chance 的乘积）`)

		// ⚠ 星云**永远不能**从新发里冒出来 —— 它唯一的来源是幼虫吃星空苹果。
		//   这一条比上面那条更直接：上面那条看的是**总**发生率，
		//   星云真要是混进去了，也只让总数涨一点点（0.1 对 8.7%），
		//   完全可能落在容差里静悄悄地过去
		let nebulaDeNovo = 0
		for (let i = 0; i < TRIALS; i++) {
			if (rollDeNovo().includes('nebula')) nebulaDeNovo++
		}
		console.log(`  新发抽奖 ${TRIALS} 次里骰到星云：${nebulaDeNovo} 次`)
		if (nebulaDeNovo > 0) {
			geneProblems.push(
				`新发抽奖骰出了 ${nebulaDeNovo} 次星云 —— 它只能靠吃星空苹果得到，` +
					`chance 必须是 0（现在是 ${CONFIG.mutation.types.find((t) => t.id === 'nebula').chance}）`,
			)
		}
	}

	// —— 3. ⚠ 每一颗卵的基因必须是**各自独立的对象** ——
	//
	// 这是最容易踩的一个坑：`_lay` 里如果把一个事先算好的数组直接发出去，
	// 整窝卵会指向**同一个数组对象**，于是给第 1 颗卵加的突变会同时
	// 出现在所有同胞身上。性状看着还挺像「遗传」，所以很难发现。
	//
	// ⚠ 这条在遗传删掉之后**更重要**了：现在每颗卵是各骰各的，
	//   共享数组会让「一窝全带同一个突变」这种假象重新出现 ——
	//   而那正好是用户要求去掉的那个东西
	{
		const wC = new World(W, H)
		wC.reset()
		wC.flies.length = 0
		wC.larvae.length = 0
		wC.eggs.length = 0
		const m2 = wC.addFly(400, 500, 'F', 'normal', ['golden'])
		m2.age = CONFIG.adult.matureAge + 1000
		m2.cooldown = 0
		m2.beginClutch(wC)
		let guard = 0
		while ((m2.laying || m2.laySite) && guard++ < 60 * 60) wC.update(STEP)
		const kids = wC.eggs
		console.log(`  一窝 ${kids.length} 颗卵`)
		if (kids.length < 2) {
			geneProblems.push(`一窝只产了 ${kids.length} 颗卵，测不出「各颗基因是否独立」`)
		} else {
			// 数组必须是各自独立的**对象**。
			// ⚠ 从下标 1 开始比 —— 拿 kids[0] 和它自己比恒为真，
			//   那样这条断言会**无条件报错**，而看起来还像是真发现了共享
			const shared = kids.slice(1).some((e) => e.mutations === kids[0].mutations)
			if (shared) {
				geneProblems.push('同一窝的卵共用同一个 mutations 数组 —— 给一颗加突变会传染给整窝')
			}
			// 母亲身上带的 golden **一颗都不该传下去** ——
			// 这是「遗传去掉」在生产路径上的直接体现：
			// 走的是真正的产卵流程（beginClutch → _lay → spawnEgg），
			// 不是直接调骰子，所以它比第 1 节那几条更接近玩家看到的东西
			//
			// ⚠ 一窝只有 2~6 颗，而 golden 的新发概率是 3% ——
			//   「整窝一颗都没有」是**预期结果**，不是失败。
			//   所以这里只在「整窝都有」时才报错：那必然是遗传又回来了
			//   （或者是共享数组，上面那条会先报）
			const allHave = kids.every((e) => e.mutations.includes('golden'))
			if (kids.length >= 3 && allHave) {
				geneProblems.push(
					`母亲带 golden，一窝 ${kids.length} 颗卵**全部**也有 —— ` +
						'突变不该从父母遗传，每颗卵只按自己的 chance 骰一次',
				)
			}
		}
	}

	// —— 4. 售价倍率 ——
	{
		const price = (genes) => {
			const f = new World(100, 100).addFly(10, 10, 'M', 'normal', genes)
			return f.value
		}
		const base = price([])
		const gold = price(['golden'])
		const crystal = price(['crystal'])
		const both = price(['golden', 'crystal'])
		console.log(
			`  售价倍率：点石成金 ${(gold / base).toFixed(2)}× / 炫彩 ${(crystal / base).toFixed(2)}× / 两者兼有 ${(both / base).toFixed(2)}×`,
		)
		if (Math.abs(gold / base - 1.3) > 1e-6) geneProblems.push(`点石成金的自身倍率是 ${(gold / base).toFixed(3)}，应当是 1.3`)
		if (Math.abs(crystal / base - 2) > 1e-6) geneProblems.push(`炫彩的自身倍率是 ${(crystal / base).toFixed(3)}，应当是 2`)
		// 连乘而不是相加：1.3 × 2 = 2.6，不是 1 + 0.3 + 1 = 2.3
		if (Math.abs(both / base - 2.6) > 1e-6) {
			geneProblems.push(`两种价值突变同时存在时是 ${(both / base).toFixed(3)}×，应当是连乘 2.6×`)
		}

		// —— 星云：价值 ×1.2、速度 ×2 ——
		//
		// ⚠ 速度这一条量的是 `speedScale` 这个**消费点**，不是某个字段。
		//   星云的 ×2 并进了 Fly.speedScale 的 getter，而 _walk / _fly /
		//   updateJarred 三条路都读它 —— 在这里量等于把三条路一起钉住了。
		//   写进 targetSpeed 之类的地方是**不生效**的（每帧会被重写），
		//   那种错法在这里会立刻现形
		const nebulaPrice = price(['nebula'])
		console.log(
			`  星云：价值 ${(nebulaPrice / base).toFixed(2)}× / 速度 ${speedMulOf(['nebula'])}×`,
		)
		if (Math.abs(nebulaPrice / base - 1.2) > 1e-6) {
			geneProblems.push(`星云的价值倍率是 ${(nebulaPrice / base).toFixed(3)}，应当是 1.2`)
		}
		if (speedMulOf(['nebula']) !== 2) {
			geneProblems.push(`星云的速度倍率是 ${speedMulOf(['nebula'])}，应当是 2`)
		}
		// 虫身上真的读到了这个倍率 —— 配置里写了 2 但没接上去的话，
		// 上面那条照样绿（它只读 config），这条不会
		const nebFly = new World(100, 100).addFly(10, 10, 'M', 'normal', ['nebula'])
		const plainFly = new World(100, 100).addFly(10, 10, 'M', 'normal', [])
		const ratio2 = nebFly.speedScale / plainFly.speedScale
		console.log(`  星云蝇的 speedScale 是普通蝇的 ${ratio2.toFixed(2)} 倍`)
		if (Math.abs(ratio2 - 2) > 1e-6) {
			geneProblems.push(`星云蝇的 speedScale 只有普通蝇的 ${ratio2.toFixed(3)} 倍，应当是 2 —— 倍率没接到消费点上`)
		}
		// 和体格**相乘**而不是相加：极端变异 0.3 × 2 = 0.6
		const nebExtreme = new World(100, 100).addFly(10, 10, 'M', 'extreme', ['nebula'])
		const extreme = new World(100, 100).addFly(10, 10, 'M', 'extreme', [])
		if (Math.abs(nebExtreme.speedScale / extreme.speedScale - 2) > 1e-6) {
			geneProblems.push('星云和体格倍率没有相乘 —— 极端变异 + 星云应当正好是它的 2 倍')
		}

		// 石化：体重 ×1.5（售价跟着走，因为 value = priceOf(weight)）
		const plain = new World(100, 100).addFly(10, 10, 'M', 'normal', [])
		const stone = new World(100, 100).addFly(10, 10, 'M', 'normal', ['stone'])
		plain.growth, stone.growth // 同稀有度、同年龄 → 只差一个体重倍率
		const wRatio = stone.weight / plain.weight
		console.log(`  石化的体重倍率 ${wRatio.toFixed(2)}×`)
		if (Math.abs(wRatio - weightMulOf(['stone'])) > 1e-9) {
			geneProblems.push(`石化的体重倍率是 ${wRatio.toFixed(3)}×，应当和配置一致`)
		}
	}

	// —— 5. 金光光环 ——
	//
	// ⚠ 这一节真正要钉死的是**复位**：goldAura 是自有字段，会进存档。
	//   只设不复位的话，那个 1.1 会被永久写进存档、重启后依然生效 ——
	//   金蝇早就没了，加成还在，是一笔查不出来的通胀
	{
		const wA = new World(W, H)
		wA.reset()
		wA.flies.length = 0
		wA.larvae.length = 0
		wA.eggs.length = 0
		wA.foods.length = 0

		const gold = wA.addFly(500, 500, 'M', 'normal', ['golden'])
		const near = wA.addFly(540, 500, 'M', 'normal', [])
		const far = wA.addFly(1200, 900, 'M', 'normal', [])

		wA._applyGoldAura()
		const nearBoosted = near.goldAura
		const goldSelf = gold.goldAura
		const farPlain = far.goldAura
		console.log(`  金蝇在边上时：邻居 ×${nearBoosted} / 金蝇自己 ×${goldSelf} / 远处的 ×${farPlain}`)
		if (Math.abs(nearBoosted - 1.1) > 1e-9) geneProblems.push(`金蝇旁边的成虫没有被加成（goldAura = ${nearBoosted}）`)
		if (Math.abs(goldSelf - 1) > 1e-9) {
			geneProblems.push(`金蝇给自己也加了光环（goldAura = ${goldSelf}）—— 它已经拿了 1.3 的自身倍率`)
		}
		if (Math.abs(farPlain - 1) > 1e-9) geneProblems.push(`远处的成虫不该有光环（goldAura = ${farPlain}）`)

		// 走远之后必须复位
		near.x = 1400
		near.y = 900
		wA._applyGoldAura()
		if (Math.abs(near.goldAura - 1) > 1e-9) {
			geneProblems.push(`邻居走远后 goldAura 还是 ${near.goldAura} —— 光环没有复位`)
		}
		// 金蝇没了之后，全场都要复位
		near.x = 540
		near.y = 500
		wA._applyGoldAura()
		gold.dead = true
		wA._applyGoldAura()
		if (Math.abs(near.goldAura - 1) > 1e-9) {
			geneProblems.push(`金蝇死后邻居的 goldAura 还是 ${near.goldAura} —— 提前返回那条路没有复位`)
		}

		// 进罐子必须清掉（容器里跑不到那个 pass）
		const wJ = new World(W, H)
		wJ.reset()
		wJ.flies.length = 0
		wJ.larvae.length = 0
		wJ.eggs.length = 0
		const jGold = wJ.addFly(600, 400, 'M', 'normal', ['golden'])
		const jNear = wJ.addFly(610, 400, 'M', 'normal', [])
		wJ._applyGoldAura()
		const boostedBeforeJar = jNear.goldAura
		wJ.addJar(600, 400)
		wJ.catchFlies(600, 400)
		if (jNear.goldAura !== 1) {
			geneProblems.push(
				`进罐子后 goldAura 还是 ${jNear.goldAura}（外面 ${boostedBeforeJar}）—— ` +
					'容器里跑不到光环 pass，必须在 admit 里清掉，否则它会带着永久 +10% 被卖出去',
			)
		} else {
			console.log(`  进罐子前 ×${boostedBeforeJar} → 进罐子后 ×${jNear.goldAura}（已重置）`)
		}
		// 存档往返之后仍然是 1
		const round = snapshot(jNear)
		if (round.goldAura !== 1) geneProblems.push(`存档里的 goldAura 是 ${round.goldAura}，应当是 1`)
	}

	// —— 6. 生命值 ——
	{
		const wH = new World(W, H)
		wH.reset()
		wH.flies.length = 0
		wH.larvae.length = 0
		wH.eggs.length = 0
		const f = wH.addFly(400, 400, 'M', 'normal', [])

		if (!(f.hp === f.hpMax)) {
			geneProblems.push(`刚出生的成虫 hp ${f.hp} ≠ hpMax ${f.hpMax} —— 取整方式两边不一致`)
		}
		if (!(f.hpMax >= 16 && f.hpMax <= 25)) {
			geneProblems.push(`成虫满血 ${f.hpMax}，按 16~25 分钟的寿命应当在 16~25 之间`)
		}

		// ⚠ 伤害**不能**影响体重 / 价值。
		//   这是「用 wounds 而不是推进 age」那个决定的守卫：
		//   推进 age 的话 growth 会变大 → 变重 → 变贵，
		//   被咬一口反而升值，是个反向激励
		const wBefore = f.weight
		const vBefore = f.value
		f.takeDamage(3)
		if (f.wounds !== 3 * MIN) geneProblems.push(`挨了 3 点伤害，wounds 是 ${f.wounds}，应当是 ${3 * MIN} 毫秒`)
		if (f.hp !== f.hpMax - 3) geneProblems.push(`挨了 3 点伤害后 hp 是 ${f.hp}，应当是 ${f.hpMax - 3}`)
		if (Math.abs(f.weight - wBefore) > 1e-12 || Math.abs(f.value - vBefore) > 1e-12) {
			geneProblems.push('伤害改变了体重 / 售价 —— 说明它是推进 age 实现的，会让被害者反而升值')
		}
		console.log(`  成虫 hp ${f.hpMax} → 挨 3 点 → ${f.hp}（体重 / 售价未变）`)

		// 打够就该死，而且死因是 killed 不是 natural
		f.takeDamage(999)
		if (!f.dead) geneProblems.push('伤害超过剩余寿命之后没有死')
		if (f.causeOfDeath !== 'killed') {
			geneProblems.push(`被打死的死因是 ${f.causeOfDeath}，应当是 killed —— 否则统计会把它记成自然老死`)
		}

		// 幼虫：固定 1~2 点，挨成虫一口必死
		const l = wH.addLarva(400, 460, null, 0, [])
		if (!(l.hpMax === 1 || l.hpMax === 2)) geneProblems.push(`幼虫满血是 ${l.hpMax}，应当固定 1~2`)
		l.takeDamage(1)
		if ((l.hpMax === 1) !== l.dead) {
			geneProblems.push(`幼虫（满血 ${l.hpMax}）挨 1 点之后的死亡状态不对`)
		}
		console.log(`  幼虫 hp 固定 1~2，挨 1 点即死（本次满血 ${l.hpMax}）`)
	}

	// —— 7. 疯狂：自限、够不着容器 ——
	{
		const B = MUTATION_TYPES.find((t) => t.id === 'berserk')
		const wB = new World(W, H)
		wB.reset()
		wB.flies.length = 0
		wB.larvae.length = 0
		wB.eggs.length = 0

		// 两只疯狂蝇贴在一起：目标池里必须**包含**另一只疯狂的
		const a = wB.addFly(500, 500, 'M', 'normal', ['berserk'])
		const b = wB.addFly(510, 500, 'F', 'normal', ['berserk'])
		let hitSelf = false
		for (let i = 0; i < 200; i++) {
			const t = wB._pickBerserkTarget(a, B.radius * B.radius)
			if (t === b) hitSelf = true
		}
		console.log(`  疯狂蝇会咬其他疯狂个体：${hitSelf ? '会（自限成立）' : '不会'}`)
		if (!hitSelf) {
			geneProblems.push('疯狂蝇不会攻击其他疯狂个体 —— 它就有了绝对生存优势，几代之内会把种群吃光')
		}
		// 但它不该咬自己
		for (let i = 0; i < 50; i++) {
			if (wB._pickBerserkTarget(a, B.radius * B.radius) === a) {
				geneProblems.push('疯狂蝇把自己当成了目标')
				break
			}
		}

		// ⚠ 罐子 / 烤炉里的虫必须是安全的。
		//   那两个数组里的 x/y 是**相对容器的偏移**，拿屏幕坐标去减是荒谬的
		wB.flies.length = 0
		wB.larvae.length = 0
		const jar = wB.addJar(800, 500)
		const victim = wB.addFly(800, 500, 'M', 'normal', [])
		wB.catchFlies(800, 500)
		const jarredHpBefore = victim.hp
		const inJar = jar.flies.includes(victim)
		// 在罐子正中放一只疯狂蝇（屏幕坐标上它「就在罐子上」）
		const bz = wB.addFly(800, 500, 'M', 'normal', ['berserk'])
		for (let i = 0; i < 60 * 60; i++) wB._updateBerserk(1000 / 60)
		if (!inJar) {
			geneProblems.push('罐装流程没把果蝇放进罐子，这一条测不到')
		} else if (victim.hp !== jarredHpBefore || victim.dead) {
			geneProblems.push('疯狂蝇咬到了罐子里的果蝇 —— 容器里的坐标是相对偏移，绝不能被扫到')
		} else {
			console.log('  罐中果蝇在疯狂蝇旁边呆 60 秒：安然无恙')
		}
		if (bz.dead) geneProblems.push('什么都没咬到的疯狂蝇自己死了')
	}

	// —— 8. 石化：吓也飞不起来 ——
	{
		const wS = new World(W, H)
		wS.reset()
		wS.flies.length = 0
		wS.larvae.length = 0
		wS.eggs.length = 0
		const st = wS.addFly(600, 400, 'M', 'normal', ['stone'])
		const nm = wS.addFly(620, 400, 'M', 'normal', [])
		if (st.canFly) geneProblems.push('石化蝇的 canFly 是 true')
		if (!nm.canFly) geneProblems.push('普通蝇的 canFly 是 false')

		// 受惊是最隐蔽的那个入口：只在玩家挥鼠标时才会走到，
		// 漏掉它的症状是「平时都在地上爬，一晃鼠标就飞起来了」
		st.mode = 'walk'
		wS.startle.x = 600
		wS.startle.y = 400
		wS.startle.power = 1
		wS._applyStartle()
		if (st.mode === 'fly') geneProblems.push('石化蝇被鼠标吓到之后飞起来了 —— _applyStartle 里漏了 canFly 判断')

		// 走满一轮模式计时也不该自己飞起来
		st.modeTimer = 0
		for (let i = 0; i < 60 * 20; i++) {
			st.modeTimer = 0
			st.update(STEP * 1000, wS)
		}
		if (st.mode === 'fly') geneProblems.push('石化蝇在 _updateMode 里自己起飞了')
		console.log('  石化蝇：受惊不起飞、走满计时也不起飞')
	}

	// —— 9. 疯狂蝇寿命砍半 ——
	//
	// 成虫乘 lifespan，幼虫乘 starveAfter（它唯一的死亡时钟）。
	// 两边都要查 —— 只做一半的话，症状是「成虫活得短了，幼虫照旧」，
	// 而玩家几乎不可能从画面上分辨出来
	{
		const B = MUTATION_TYPES.find((t) => t.id === 'berserk')
		const mul = B.lifespanMul
		const wZ = new World(W, H)
		wZ.reset()
		wZ.flies.length = 0
		wZ.larvae.length = 0
		wZ.eggs.length = 0

		// 多抽几只取平均：lifespan 是区间随机的，单只比没有意义。
		//
		// ⚠ 用 `new Fly` / `new Larva` 直接造，**不要**走 world.addFly / addLarva ——
		//   那两个带种群上限（40 / 45），第 41 只起返回 null，
		//   再读 .kind 就是 TypeError。而且这种写法会把 probes 塞进 world，
		//   影响不了别处但也没必要
		const avg = (genes, n, make) => {
			let sum = 0
			for (let i = 0; i < n; i++) {
				const e = make(genes)
				sum += e.kind === 'adult' ? e.lifespan : e.starveAfter
			}
			return sum / n
		}
		const N = 400
		const lifeNormal = avg([], N, (g) => new Fly(0, 0, 'M', 'normal', g))
		const lifeBerserk = avg(['berserk'], N, (g) => new Fly(0, 0, 'M', 'normal', g))
		const starveNormal = avg([], N, (g) => new Larva(0, 0, null, 0, g))
		const starveBerserk = avg(['berserk'], N, (g) => new Larva(0, 0, null, 0, g))

		const rLife = lifeBerserk / lifeNormal
		const rStarve = starveBerserk / starveNormal
		console.log(
			`  成虫寿命：普通 ${(lifeNormal / MIN).toFixed(1)} 分 / 疯狂 ${(lifeBerserk / MIN).toFixed(1)} 分（${rLife.toFixed(2)}×）`,
		)
		console.log(
			`  幼虫挨饿上限：普通 ${(starveNormal / MIN).toFixed(1)} 分 / 疯狂 ${(starveBerserk / MIN).toFixed(1)} 分（${rStarve.toFixed(2)}×）`,
		)
		if (Math.abs(rLife - mul) > 0.05) {
			geneProblems.push(`疯狂成虫的寿命倍率是 ${rLife.toFixed(2)}×，配置是 ${mul}×`)
		}
		if (Math.abs(rStarve - mul) > 0.05) {
			geneProblems.push(
				`疯狂幼虫的挨饿上限倍率是 ${rStarve.toFixed(2)}×，配置是 ${mul}× —— ` +
					'幼虫没有 lifespan，减半要落在 starveAfter 上',
			)
		}
	}
}
console.log('')

// ---------------------------------------------------------------- 养蝇人
console.log('—— 养蝇人验证 ——')

const keeperProblems = []
{
	// 一次检查跨过去（checkMs 是 2 秒），省得每次都要跑满
	const tick = (w) => {
		w.keeperTimer = 0
		w._updateKeeper(16)
	}

	// —— 1. 没买（Lv0）什么都不做 ——
	{
		const w = new World(W, H)
		w.reset()
		w.larvae.length = 0
		w.flies.length = 0
		w.foods.length = 0
		w.money = 100
		w.shop = {}

		const before = w.money
		tick(w)
		if (w.foods.length !== 0) keeperProblems.push('没买养蝇人却自动投了食物')
		if (w.money !== before) keeperProblems.push('没买养蝇人却扣了钱')
	}

	// —— 2. Lv1 + 没食物 + 有钱 → 投，且钱正好少那么多 ——
	{
		const w = new World(W, H)
		w.reset()
		w.larvae.length = 0
		w.flies.length = 0
		w.foods.length = 0
		w.shop = { keeper: 1 }
		w.money = 100
		w.setKeeperOption('food', 'apple')
		w.setKeeperOption('foodN', 3)

		const unit = foodPrice('apple')
		const want = bulkPrice(unit, 3)
		const before = w.money
		tick(w)

		const spent = Math.round((before - w.money) * 1000) / 1000
		console.log(`  Lv1 自动投放：放了 ${w.foods.length} 份，扣了 ${formatMoney(spent)}（期望 ${formatMoney(want)}）`)
		if (w.foods.length !== 3) keeperProblems.push(`Lv1 应当一次投 3 份，实际 ${w.foods.length} 份`)
		if (Math.abs(spent - want) > 1e-9) {
			keeperProblems.push(`自动投放扣了 ${spent}，按 bulkPrice 应当是 ${want} —— 检查是不是绕过了 buyFood`)
		}
		if (w.keeper.fed !== 1) keeperProblems.push(`自动投放计数是 ${w.keeper.fed}，应当是 1`)

		// 场上已经有食物了 → 不该再投
		const moneyAfterFirst = w.money
		tick(w)
		if (w.foods.length !== 3) keeperProblems.push('场上还有食物却又投了一次')
		if (w.money !== moneyAfterFirst) keeperProblems.push('场上还有食物却扣了钱')
	}

	// —— 3. Lv1 + 没食物 + 没钱 → 不投，且钱不会变成负数 ——
	{
		const w = new World(W, H)
		w.reset()
		w.larvae.length = 0
		w.flies.length = 0
		w.foods.length = 0
		w.shop = { keeper: 1 }
		w.money = 0

		tick(w)
		tick(w)
		if (w.foods.length !== 0) keeperProblems.push('没钱却投下了食物')
		if (w.money < 0) keeperProblems.push(`自动投放把钱扣成了负数（${w.money}）`)
		console.log(`  Lv1 没钱时：不投，余额仍是 ${formatMoney(w.money)}`)
	}

	// —— 4/5/6. 自动出售 ——
	{
		// 造一只能卖出高价的蝇：稀有度 extreme + 年龄拉满（growth → 1 → 体重到顶）
		const richFly = (w, rarity, genes) => {
			const f = w.addFly(400, 400, 'M', rarity, genes)
			f.age = f.lifespan
			return f
		}

		const w = new World(W, H)
		w.reset()
		w.larvae.length = 0
		w.flies.length = 0
		w.foods.length = 0
		w.jars.length = 0
		w.shop = { keeper: 1 }
		w.money = 100

		// ⚠ 一律走 _updateKeeper，**不要**直接调 _keeperSell。
		//   等级判断（Lv2 才有自动出售）在 _updateKeeper 里，
		//   _keeperSell 是个私有助手，它假设调用方已经查过了 ——
		//   直接调它等于绕过了那道闸门，测出来的是「没有闸门时的行为」。
		//   第一版就是这么写的，于是报了「Lv1 就把果蝇卖了」，
		//   而实际功能是对的

		// Lv1 只有自动投放，**没有**自动出售
		const f0 = richFly(w, 'extreme', [])
		const v0 = f0.value
		w.keeper.sell = true
		w.keeper.tier = valueTierOf(f0.value).id
		tick(w)
		if (!w.flies.includes(f0)) {
			keeperProblems.push('Lv1 就把果蝇卖了 —— 自动出售是 Lv2 才有的功能')
		}

		// 升到 Lv2
		w.shop.keeper = 2

		// 普通**体重档**的那只：价值档也对不上（它只有 $0.002 上下），不该卖
		//
		// ⚠ 这一条钉的是「筛的是**价值档**，不是体重档」。
		//   下面三只的体重档分别是 normal / extreme / extreme ——
		//   要是 _keeperSell 写回 `f.rarity !== K.tier`，fMut 和 fLay 会跟着 f0
		//   一起被卖掉（它们的体重档都是 extreme），这两条断言立刻会红
		const fPoor = richFly(w, 'normal', [])
		// 带突变的那只：勾了「不含突变」时不该卖
		const fMut = richFly(w, 'extreme', ['crystal'])
		// 正在产卵的母体：不该卖
		const fLay = richFly(w, 'extreme', [])
		fLay.sex = 'F'
		fLay.laying = true

		// 门槛那一档必须**真的**是这只果蝇的价值档 —— 写死一个字符串的话，
		// 下面「符合条件的那只没有被卖掉」会因为「压根没匹配上」而假绿
		if (valueTierOf(f0.value).id !== w.keeper.tier) {
			keeperProblems.push('筛选用的档位和这只果蝇自己的价值档对不上，这条断言测不到东西')
		}

		w.keeper.mutants = false
		tick(w)

		if (!w.flies.includes(fPoor)) keeperProblems.push('自动出售卖掉了价值档不匹配的果蝇')
		if (!w.flies.includes(fMut)) keeperProblems.push('勾了「不含突变」却把带突变的卖掉了')
		if (!w.flies.includes(fLay)) keeperProblems.push('自动出售卖掉了正在产卵的母体')
		if (w.flies.includes(f0)) keeperProblems.push('符合条件的那只没有被卖掉')
		console.log(
			`  仅一只 ${formatMoney(v0)}（${valueTierOf(v0).name}档）符合条件 → 卖出 ${w.keeper.sold} 只，其余三只留下`,
		)

		// 打开「含突变」→ 带突变的那只也该卖
		//
		// ⚠⚠ 这里有个**真实的耦合**，第一版测试就栽在上面：
		//   fMut 带的是 crystal，而 crystal 的价值倍率是 ×2 ——
		//   它**同时把这只是的价值档也抬了一格**。
		//   于是「含不含突变」和「卖哪档」这两个筛选条件**不是正交的**：
		//   一只带了价值类突变的蝇很可能已经跑到别的档里去了。
		//
		//   所以这一步必须先把门槛挪到**它自己那一档**。不挪的话它会被
		//   「档位不匹配」挡在外面，而那跟 mutants 开关一点关系都没有 ——
		//   报出来却是「勾了含突变却没卖」，指错方向
		//
		// ⚠ 也**不要**为了「让测试好写」把价值突变换成不带倍率的（比如疯狂）——
		//   那就绕开了这个耦合，而它正是玩家会遇到的：设了「只卖稀有档」
		//   却发现带了炫彩的那批怎么都不卖，原因就在这里
		const mutTier = valueTierOf(fMut.value).id
		const tierMoved = mutTier !== w.keeper.tier
		w.keeper.mutants = true
		w.keeper.tier = mutTier
		const soldBefore = w.keeper.sold
		tick(w)
		if (w.flies.includes(fMut)) keeperProblems.push('勾了「含突变」、门槛也对着它那一档，却仍然没卖带突变的那只')
		if (w.keeper.sold !== soldBefore + 1) {
			keeperProblems.push(`「含突变」那次的计数没有 +1（${soldBefore} → ${w.keeper.sold}）`)
		}
		console.log(
			`  带炫彩的那只：×2 之后价值档${tierMoved ? '**离开了** f0 那一档' : '仍在同一档'}，` +
				`现在是「${valueTierOf(fMut.value).name}」—— 勾上「含突变」并对着它那一档之后卖掉了`,
		)

		// —— 罐中果蝇必须够不着 ——
		//
		// ⚠ 这一条是「只扫 this.flies」那个设计的守卫。罐中果蝇挂在 jar.flies 上，
		//   遍历 this.flies 天然碰不到 —— 但要是有人图省事改成遍历「所有生物」，
		//   玩家的藏品就会被自动卖掉，而且很难查出是哪一步干的
		const wJ = new World(W, H)
		wJ.reset()
		wJ.larvae.length = 0
		wJ.flies.length = 0
		wJ.foods.length = 0
		wJ.jars.length = 0
		wJ.shop = { keeper: 2 }
		wJ.money = 100
		wJ.keeper.sell = true

		// ⚠ 果蝇和罐子要放在**同一个位置**：catchFlies 的半径很小，
		//   隔着两百像素是网不到的（第一版就栽在这，报的是
		//   「罐装流程没把果蝇放进罐子」，看起来像罐子坏了）
		const kept = richFly(wJ, 'extreme', [])
		kept.x = 600
		kept.y = 400
		wJ.addJar(600, 400)
		wJ.catchFlies(600, 400)
		const inJar = wJ.jars[0] && wJ.jars[0].flies.includes(kept)
		tick(wJ)
		if (!inJar) {
			keeperProblems.push('罐装流程没把果蝇放进罐子，这条断言测不到')
		} else if (wJ.keeper.sold !== 0) {
			keeperProblems.push('自动出售卖掉了罐子里的果蝇 —— 玩家的藏品被偷了')
		} else {
			console.log('  罐中那只（同样符合条件）：安然无恙')
		}
	}

	// —— 7. 配置与等级走一遍存档往返 ——
	{
		const w = new World(W, H)
		w.reset()
		w.shop = { keeper: 2 }
		w.money = 42
		w.setKeeperOption('food', 'gold')
		w.setKeeperOption('foodN', 10)
		w.setKeeperOption('sell', true)
		w.setKeeperOption('tier', 'epic')
		w.setKeeperOption('mutants', true)

		const data = w.serialize()
		const w2 = new World(W, H)
		w2.restore(data)

		if (w2.shopLevel('keeper') !== 2) keeperProblems.push('存档往返后养蝇人的等级丢了')
		if (w2.keeper.food !== 'gold') keeperProblems.push('存档往返后「投什么」丢了')
		if (w2.keeper.foodN !== 10) keeperProblems.push('存档往返后「投几个」丢了')
		if (w2.keeper.tier !== 'epic') keeperProblems.push('存档往返后「卖哪档」丢了')
		if (w2.keeper.mutants !== true) keeperProblems.push('存档往返后「含突变」丢了')
		console.log('  存档往返：等级与五项配置全部保留')

		// 老存档（没有 keeper 字段）应当拿到一份完整默认值，而不是 undefined
		const legacy = new World(W, H)
		legacy.restore({ ...data, keeper: undefined })
		if (!legacy.keeper || legacy.keeper.food !== 'apple') {
			keeperProblems.push('老存档（没有 keeper 字段）没有拿到默认配置')
		}

		// 白名单校验：乱七八糟的值必须被拒掉
		const w3 = new World(W, H)
		if (w3.setKeeperOption('food', 'pizza')) keeperProblems.push('setKeeperOption 接受了不存在的食物类型')
		if (w3.setKeeperOption('tier', 'gold')) keeperProblems.push('setKeeperOption 接受了不存在的价值档')
		if (w3.keeper.food !== 'apple') keeperProblems.push('被拒绝的赋值却改了状态')

		// —— 价格门槛**整条删掉了** ——
		//
		// ⚠ 这一节是**反向**断言：那根对数价格滑条删掉之后，配置和状态里
		//   都不该再留着它。查这两处而不是查 market 里那两个换算函数 ——
		//   函数留成死代码不会有人受害，而下面这两处留着就是活的 bug：
		//
		//     · keeperOptions.valueMin / valueMax → 看着像还有这个功能
		//     · world.keeper.minValue → **界面没了、门槛还在**：自动出售被
		//       一个看不见、也改不了的数拦着，玩家只会觉得
		//       「开了自动出售怎么不卖」，而任何「点了没反应」式的断言
		//       都抓不到它
		if ('valueMin' in CONFIG.market.keeperOptions || 'valueMax' in CONFIG.market.keeperOptions) {
			keeperProblems.push('keeperOptions 里还留着 valueMin / valueMax')
		}
		const probe = new World(W, H)
		if ('minValue' in probe.keeper) {
			keeperProblems.push('world.keeper 上还有 minValue —— 界面没了但门槛还在拦人')
		}
		if (probe.setKeeperOption('minValue', 1)) {
			keeperProblems.push('setKeeperOption 还认 minValue 这个键')
		}
		console.log('  价格门槛：keeperOptions 上下限、world.keeper.minValue 都已删干净（筛选只剩「卖哪档」+「含突变」）')
	}
}
console.log('')

const problems = [
	...foodProblems,
	...layProblems,
	...clutchProblems,
	...shapeProblems,
	...walkProblems,
	...feedProblems,
	...toolProblems,
	...pupaProblems,
	...jarProblems,
	...moneyProblems,
	...buyProblems,
	...saveProblems,
	...roastProblems,
	...modeProblems,
	...lifeProblems,
	...geneProblems,
	...keeperProblems,
	...magnifierProblems,
	...fxProblems,
	...broomProblems,
]
if (nanAt) problems.push(`坐标出现 NaN（${nanAt.kind}，第 ${fmt(nanAt.sec)}）`)
if (marks.egg == null) problems.push('整段模拟没有产卵 —— 检查 mating.seekRadius / matureAge')
if (marks.larva == null) problems.push('没有幼虫孵化 —— 检查 egg.hatchMin/Max')
// ⚠ 「首只成虫羽化」这一条有个正当的豁免：**疯狂蝇爆发**。
//
// 一局里如果出现了疯狂突变，它可能把整群成虫咬死、再把幼虫压得长不到蛹期，
// 于是 120 分钟里一只成虫都没羽化 —— 这是设定好的生态动力学，
// 不是生命周期坏了。实测带着这个豁免写之前，sim 大约每十次红两次，
// 而每次红都长着「emergeAt 配错了」的样子，实际上种群是**被咬光的**。
//
// 判据用 stats.killed：它是「被疯狂咬死」的专账（见 world._resolveLifecycles），
// 自然老死 / 饿死 / 拍死都不计在内。只有**大规模**非自然死亡才豁免 ——
// 偶尔咬死一两只不该掩盖真正的羽化故障
const outbreak = world.stats.killed > 5
if (marks.adult == null) {
	if (outbreak) {
		console.log(
			`\n  （本次没有成虫羽化，但被疯狂咬死了 ${world.stats.killed} 只 —— 判定为疯狂爆发，不计为故障）`,
		)
	} else {
		problems.push('没有成虫羽化 —— 检查 larva.emergeAt')
	}
}
if (marks.death == null) problems.push('没有死亡 —— 检查 adult.lifespan')
if (world.livingCount === 0 && marks.adult != null) problems.push('最终种群灭绝了')
if (!(travel1 > 0) || !(travel2 > 0)) problems.push('擦拭路程异常')
if (travel2 <= travel1) problems.push('腐烂后并不比新鲜时更难擦 —— 检查 remains.wipeScrubFresh/Rotten')

// ====================================================================
//  Banhammer + 「封禁」突变
// ====================================================================
//
// 这个工具同时踩了三件容易静默失效的事，所以断言比别的工具密：
//   ① 位移有**六个**积分点，只堵一半会变成「大部分时候不动、偶尔滑一段」
//   ② 卖幼虫走的是 `sellLarva`（`sellFly` 传幼虫进去会**静默返回 0**），
//      而且必须 splice —— 只置 dead 会被 `_resolveLifecycles` 记成拍死
//   ③ 授予突变必须调 `_noteGenes`，漏了图鉴那一格永远灰、成就永远不弹

const banProblems = []
// 贴边的封禁蝇被钳制弹开了多少 px。修好之后应当是 0 ——
// 打进日志是为了下次有人动 `_walk` 那一段时能直接看到数
let banEdgeSnap = 0
// 金锤一锤发多少颗粒子（关掉 ring 之后的下限就在下面那条断言里）
let banStrikeParticles = 0
{
	const B = CONFIG.tools.ban
	const R = B.radius
	const w = new World(1920, 1080)
	const clear = () => {
		w.flies.length = 0
		w.larvae.length = 0
		w.eggs.length = 0
		w.foods.length = 0
		w.remains.length = 0
		w.floatTexts.length = 0
		w.particles.length = 0
		w.seenGenes.length = 0
	}

	// —— 半径边界 ——
	// ⚠ 圈外那两只才是这条断言的重点。只查「圈内的中了」的话，
	//   半径写成 1000 照样绿
	clear()
	const inside = w.addFly(500, 500, {})
	const edgeIn = w.addFly(500 + R - 2, 500, {})
	const edgeOut = w.addFly(500 + R + 2, 500, {})
	const larvaIn = w.addLarva(500, 500 + 50, {})
	const r1 = w.banStrike(500, 500)
	if (r1.marked !== 3) banProblems.push(`半径内应当封 3 只，实得 ${r1.marked}`)
	if (!inside.hasMutation('ban') || !edgeIn.hasMutation('ban')) banProblems.push('圈内的成虫没被封上')
	if (edgeOut.hasMutation('ban')) banProblems.push(`半径 ${R} 之外（${R + 2}px）的成虫也被封了 —— 判定没按半径来`)
	if (!larvaIn.hasMutation('ban')) banProblems.push('幼虫没被封上 —— 它和成虫应当一视同仁')
	if (!w.seenGenes.includes('ban')) {
		banProblems.push('封禁没有进 seenGenes —— 图鉴那一格会永远是灰的，成就也永远不弹')
	}

	// —— 完全不能移动：六条路各一条 ——
	//
	// ⚠ 每条都要先给一个「本来会动」的前提，否则断言是空的：
	//   不给食物、不给速度的话，它本来就不动
	const bx = inside.x
	const by = inside.y
	for (let i = 0; i < 120; i++) w.update(1 / 60)
	if (inside.x !== bx || inside.y !== by) {
		banProblems.push(`封禁的成虫 120 帧挪了 (${bx},${by}) → (${inside.x},${inside.y}) —— 它该纹丝不动`)
	}
	if (inside.mode !== 'walk') {
		banProblems.push(`封禁的成虫 mode 是 ${inside.mode} —— 被敲中时如果在飞，应当被按回地面`)
	}

	// —— 受惊（挥手惊蝇）——
	//
	// ⚠ 这一条是**用户在实际游玩里发现的**：「被封禁的成虫跟着光标动」。
	//   六个**位移**积分点全堵上了，可 `_panic` 改的是 `aim`（朝向）——
	//   那是**行为**不是位移，`_shift` 那道闸门拦不住它。
	//   症状正是「虫不动，但它的头一直跟着你的鼠标转」。
	//
	// ⚠ **直接调 `_panic`，不经过 `update`。**
	//
	//   绕开 `update` 是因为 `_walk` 里有随机数（重新挑方向、停顿计时），
	//   同一个探针跑两遍本来就差一点 —— 拿「跑两遍的角度」对比是**测不准**的。
	//   实测：有光标 0.078 / 没光标 0.088 弧度，差得和被修掉的那个信号
	//   （3.1 弧度）不在一个量级上，但足以让「必须完全相等」变成一条永远红的断言。
	//   直接调就一个随机数都掺不进来，判据可以写成「一点都不许变」
	const panicCase = (genes) => {
		clear()
		const f = w.addFly(600, 600, {})
		f.mutations = genes
		f.aim = 1
		f.pausing = true
		f.hoverTimer = 500
		const before = { aim: f.aim, dart: f.dartTimer, pausing: f.pausing, hover: f.hoverTimer }
		w._panic(f, 2.5)
		return { f, before }
	}

	const pb = panicCase(['ban'])
	if (pb.f.aim !== pb.before.aim) {
		banProblems.push(
			`world._panic 改了封禁蝇的 aim（${pb.before.aim} → ${pb.f.aim}）—— ` +
				'它一步都动不了，却会原地跟着光标转头。那道闸门要判 canMove',
		)
	}
	if (pb.f.dartTimer !== pb.before.dart) {
		banProblems.push('world._panic 改了封禁蝇的 dartTimer')
	}
	if (pb.f.pausing !== pb.before.pausing || pb.f.hoverTimer !== pb.before.hover) {
		banProblems.push('world._panic 动了封禁蝇的停滞 / 悬停状态 —— 它该整段跳过')
	}

	// ⚠ 对照一：普通成虫必须真的被惊动。少了它，「没反应」在
	//   「受惊整个没生效」时也会绿
	const pc = panicCase([])
	if (pc.f.aim === pc.before.aim) {
		banProblems.push('普通成虫都没被 _panic 惊动 —— 上面那条「封禁不受惊」不算数')
	}

	// ⚠ 对照二：**石化蝇仍然要躲**。它 canFly 是 false 但 canMove 是 true，
	//   「失去飞行」只该让它爬着走、不该把它定住。
	//   那道闸门要是被写成 canFly，这一条当场就红 —— 而症状
	//   （石化蝇被吓了不吭声）几乎没人会去试
	const ps = panicCase(['stone'])
	if (ps.f.aim === ps.before.aim) {
		banProblems.push(
			'石化蝇也不躲了 —— 受惊那道闸门多半判成了 canFly。' +
				'它只该拦「动不了的」，不该拦「飞不起来的」',
		)
	}

	// 端到端再过一遍：指针贴着它甩 90 帧，坐标一个像素都不许动
	// （位置是确定的 —— `_shift` 吞掉之后 x/y 和随机数无关，所以这条不会飘）
	const startleRun = (genes) => {
		clear()
		const f = w.addFly(600, 600, {})
		f.mutations = genes
		const before = { x: f.x, y: f.y, mode: f.mode }
		w.startle.x = f.x + 8
		w.startle.y = f.y
		w.startle.power = 1
		for (let i = 0; i < 90; i++) w.update(1 / 60)
		w.startle.power = 0
		return { f, before }
	}
	const ran = startleRun(['ban'])
	if (ran.f.x !== ran.before.x || ran.f.y !== ran.before.y) {
		banProblems.push(
			`被封禁的成虫被光标惊动了：(${ran.before.x},${ran.before.y}) → ` +
				`(${ran.f.x},${ran.f.y}) —— 它该纹丝不动`,
		)
	}
	// ⚠ 这里**不能**写成「模式不许变」：封禁蝇被敲中时如果在飞，
	//   本来就该被按回地面（那条断言在上面）。要查的是「受惊没把它弄上天」
	if (ran.f.mode !== 'walk') {
		banProblems.push(`被封禁的成虫受惊之后 mode 是 ${ran.f.mode} —— 它该一直待在地面`)
	}

	// —— 贴边的钳制 ——
	//
	// ⚠ 和受惊同一类：`_walk` 末尾那段「撞到边就掉头」是**直接写 this.x**
	//   的，不走 `_shift`。被敲中时它恰好贴边的话，会被一下弹进来十几像素
	//   （朝向那条不在这里查 —— 它自己走路也会转，见上面那段注释）
	clear()
	const ef = w.addFly(5, 600, {})
	ef.mutations = ['ban']
	ef.aim = 0
	const efx = ef.x
	for (let i = 0; i < 30; i++) w.update(1 / 60)
	if (ef.x !== efx) {
		banProblems.push(`贴边的封禁蝇被钳制弹了 ${(ef.x - efx).toFixed(1)}px —— 撞边那段是直接写 x 的`)
	}
	banEdgeSnap = ef.x - efx

	// 产卵中的阻尼滑停（六个位移里最容易漏的那个）
	clear()
	const mom = w.addFly(700, 700, {})
	mom.mutations = ['ban']
	mom.laying = true
	mom.vx = 300
	const mx = mom.x
	for (let i = 0; i < 60; i++) w.update(1 / 60)
	if (mom.x !== mx) banProblems.push(`产卵中的封禁蝇往前滑了 ${(mom.x - mx).toFixed(1)}px —— _lay 那处位移没堵`)

	// 罐里也不游
	clear()
	const jf = w.addFly(900, 900, {})
	jf.mutations = ['ban']
	const jar0 = w.dropJar(900, 900)
	if (jar0) {
		jar0.admit(jf)
		w.flies.splice(w.flies.indexOf(jf), 1)
		const jx = jf.x
		for (let i = 0; i < 60; i++) w.update(1 / 60)
		if (jf.x !== jx) banProblems.push('罐里的封禁蝇还在游 —— updateJarred 那处位移没堵')
	}

	// 扫帚推不动
	clear()
	const bl = w.addLarva(400, 400, {})
	bl.mutations = ['ban']
	const blx = bl.x
	const pushed = w.broom(400, 400, 120)
	for (let i = 0; i < 60; i++) w.update(1 / 60)
	if (pushed !== 0) banProblems.push(`扫帚推到了 ${pushed} 只封禁幼虫 —— 它该推不动`)
	if (bl.x !== blx || bl.pushVx !== 0) banProblems.push('被扫的封禁幼虫动了')

	// —— 砸下去那一下的动静 ——
	//
	// ⚠ 不能只查「粒子数 > 0」：那样把三层砍成一层也照样绿，
	//   而「看着少了点」正是这个项目里最不会有人去查的那种退化。
	//   所以给下限，而且**火星单独数一遍** —— 它和 ring 是两种东西
	//   （ring 摆在圆周上、速度 30~70；火星从圆心甩出去、150~380），
	//   混在一个总数里的话，少了火星也看不出来
	clear()
	w.addFly(500, 500, {})
	const pBefore = w.particles.length
	w.banStrike(500, 500)
	const made = w.particles.length - pBefore
	banStrikeParticles = made
	if (made < 40) {
		banProblems.push(`金锤一锤只发了 ${made} 颗粒子 —— 砸下去看不出动静`)
	}
	const sparks = w.particles.filter((p) => Math.hypot(p.vx, p.vy) > 120).length
	if (sparks < 8) {
		banProblems.push(`金锤那一下只有 ${sparks} 颗高速火星 —— burstSparks 没发出来`)
	}

	// —— 售价 ×1.5 ——
	//
	// ⚠ 同时钉住 weightMul 是 1：走成石化那条路（借体重顺带涨价）的话，
	//   图鉴写着 ×1.5，实际涨得更多，而单价断言只比 value 是看不出来的
	clear()
	const f1 = w.addFly(600, 600, {})
	f1.age = f1.lifespan * 0.8
	const v0 = f1.value
	f1.mutations = ['ban']
	const v1 = f1.value
	if (Math.abs(v1 / v0 - 1.5) > 1e-9) banProblems.push(`封禁的售价倍率是 ${(v1 / v0).toFixed(6)}，应当是 1.5`)
	if (weightMulOf(['ban']) !== 1) banProblems.push('封禁动了 weightMul —— 它该只乘 valueMul，不然售价会涨两次')

	// —— 不参与抽奖 ——
	//
	// ⚠ 只断言 `chance === 0` 是空的：把它改成 0.0001 照样绿。
	//   真骰两万次才算数
	const banType = MUTATION_TYPES.find((t) => t.id === 'ban')
	if (!banType) banProblems.push('CONFIG.mutation.types 里没有 ban')
	else {
		if (banType.chance !== 0) banProblems.push(`封禁的 chance 是 ${banType.chance}，应当恒为 0（它只能由金锤给）`)
		if (banType.adultOnly) banProblems.push('封禁写了 adultOnly —— 幼虫也该吃得到')
		let rolled = 0
		for (let i = 0; i < 20000; i++) if (rollDeNovo().includes('ban')) rolled++
		if (rolled > 0) banProblems.push(`两万次新发抽奖里出现了 ${rolled} 次封禁 —— 它不该在抽奖池里`)
	}

	// —— 两锤：先封后卖，无状态 ——
	clear()
	w.money = 0
	const s1 = w.addFly(800, 800, {})
	const s2 = w.addFly(830, 800, {})
	const s3 = w.addLarva(800, 830, {})
	const first = w.banStrike(800, 800)
	if (first.marked !== 3 || first.sold !== 0) {
		banProblems.push(`第一锤应当是「封 3 卖 0」，实得「封 ${first.marked} 卖 ${first.sold}」`)
	}
	const moneyBefore = w.money
	const soldBefore = w.stats.sold
	const second = w.banStrike(800, 800)
	if (second.marked !== 0 || second.sold !== 3) {
		banProblems.push(`第二锤应当是「封 0 卖 3」，实得「封 ${second.marked} 卖 ${second.sold}」`)
	}
	if (Math.abs(second.gain - (w.money - moneyBefore)) > 1e-9) {
		banProblems.push(`卖掉之后钱加了 ${(w.money - moneyBefore).toFixed(3)}，返回值却说 ${second.gain.toFixed(3)}`)
	}
	if (w.stats.sold !== soldBefore + 3) banProblems.push('stats.sold 没有 +3')
	if (w.flies.length !== 0 || w.larvae.length !== 0) banProblems.push('卖掉之后虫子还留在数组里')
	// 第三锤：什么都没了，两个数都该是 0
	const third = w.banStrike(800, 800)
	if (third.marked !== 0 || third.sold !== 0) banProblems.push('空锤还打出了东西')

	// —— 卖掉不留尸体、不被记成死亡 ——
	//
	// ⚠ **必须再跑一帧再数**：尸体是 `_resolveLifecycles` **下一帧**才落的。
	//   卖完立刻数 remains 的话，虫子还没被收尸，这条断言是空的
	const remainsBefore = w.remains.length
	const deathsBefore = w.stats.deaths
	const swattedBefore = w.stats.swatted
	const killedBefore = w.stats.killed
	w.update(1 / 60)
	if (w.remains.length !== remainsBefore) {
		banProblems.push(`卖掉之后多出了 ${w.remains.length - remainsBefore} 块残留 —— 卖不该留尸体`)
	}
	if (w.stats.deaths !== deathsBefore) banProblems.push('卖掉被记成了死亡')
	if (w.stats.swatted !== swattedBefore || w.stats.killed !== killedBefore) {
		banProblems.push('卖掉被记成了拍死 / 咬死 —— sellLarva 没有把幼虫从 larvae 里摘掉')
	}

	// —— 幼虫售价：落在区间内，而且不是常数 ——
	clear()
	const prices = []
	for (let i = 0; i < 200; i++) {
		// ⚠ 这个 null 检查是**断言**，不是防御性代码：
		//   `sellLarva` 忘了把幼虫从 `this.larvae` 里摘掉的话，卖掉的会越积越多，
		//   很快撞上 `maxLarvae`，然后 addLarva 返回 null —— 再往下就是
		//   「TypeError: null is not an object」，整段断言**一个字都打不出来**
		const l = w.addLarva(300, 300, {})
		if (!l) {
			banProblems.push('幼虫池早早满了 —— 卖掉的幼虫没从 larvae 里摘掉，一直在攒')
			break
		}
		l.mutations = ['ban']
		const g = w.sellLarva(l)
		if (g > 0) prices.push(g)
	}
	if (prices.length !== 200) banProblems.push(`200 只封禁幼虫只卖掉了 ${prices.length} 只`)
	if (prices.length) {
		const lo = Math.min(...prices)
		const hi = Math.max(...prices)
		if (lo < B.larvaValueMin - 1e-9 || hi > B.larvaValueMax + 1e-9) {
			banProblems.push(`幼虫售价 ${lo} ~ ${hi} 超出配置区间 ${B.larvaValueMin} ~ ${B.larvaValueMax}`)
		}
		// ⚠ 只查上界的话，`return 0.001` 这种常数实现照样绿
		if (!(lo < hi)) banProblems.push(`200 只幼虫卖出的价钱全一样（${lo}）—— 说好的随机区间呢`)
	}

	// —— 罐子和烤炉打不进去（和苍蝇拍同一条规矩）——
	clear()
	const inJar = w.addFly(1000, 1000, {})
	const jar1 = w.dropJar(1000, 1000)
	if (jar1) {
		jar1.admit(inJar)
		w.flies.splice(w.flies.indexOf(inJar), 1)
		const r = w.banStrike(1000, 1000)
		if (r.marked !== 0 || inJar.hasMutation('ban')) banProblems.push('金锤打进了罐子 —— 它只该作用在场上')
	}

	// —— 商店归类 ——
	//
	// ⚠ 漏了 shopCats 的商品会从商店里**静默消失**，什么错都不报
	const inCats = CONFIG.market.shopCats.some((c) => c.items.includes('banhammer'))
	if (!inCats) banProblems.push('banhammer 不在任何 shopCats 分组里 —— 它不会出现在商店')
	const shopEntry = CONFIG.market.shop.find((it) => it.id === 'banhammer')
	if (!shopEntry) banProblems.push('CONFIG.market.shop 里没有 banhammer')
	else if (shopEntry.price !== 999) banProblems.push(`金锤的价格是 ${shopEntry.price}，用户指定的是 999`)

	// —— 成就 ——
	const ach = CONFIG.achievements.find((a) => a.id === 'ban')
	if (!ach) banProblems.push('成就表里没有 ban 那一条')
	else if (ach.gene !== 'ban') banProblems.push(`ban 成就挂的基因是 ${ach.gene}`)

	console.log(
		`\n—— 封禁 / Banhammer ——\n` +
			`  半径 ${R}px：圈内 ${r1.marked} 只全中，圈外 1 只没被误伤；成虫和幼虫一视同仁\n` +
			`  完全不能移动：爬 / 飞 / 产卵滑停 / 罐中 / 扫帚推力 / **受惊** / 贴边钳制 七条路` +
			`各跑 30~120 帧，坐标一个像素没变（贴边那条钳制弹了 ${banEdgeSnap.toFixed(1)}px，应当是 0）；` +
			`光标贴着它甩，aim 一点没动\n` +
			`  砸下去那一下：一锤 ${banStrikeParticles} 颗粒子（外圈 + 内圈 + 火星三层）\n` +
			`  售价 ×${(v1 / v0).toFixed(2)}（${v0.toFixed(4)} → ${v1.toFixed(4)}），weightMul 恒为 1（不是石化那条路）\n` +
			`  两锤：第一锤封 3 卖 0 → 第二锤封 0 卖 3（+${second.gain.toFixed(3)}）→ 第三锤打出 0\n` +
			`  卖掉不留尸体、不计死亡、不算拍死（跑满一帧再数的）\n` +
			`  幼虫售价 ${prices.length} 次抽样全落在 $${B.larvaValueMin}~$${B.larvaValueMax} 之间且有大有小\n` +
			`  两万次新发抽奖里封禁出现 0 次（它只能靠金锤）；罐子打不进去；商店 $${shopEntry ? shopEntry.price : '?'}`,
	)
}
problems.push(...banProblems)

if (problems.length === 0) {
	console.log('\n  没有发现问题：生命周期跑通，工具行为符合预期。')
} else {
	console.log('')
	for (const p of problems) console.log(`  [问题] ${p}`)
	process.exitCode = 1
}
