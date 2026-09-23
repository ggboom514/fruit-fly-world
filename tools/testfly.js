/**
 * tools/testfly.js — 给你的**真实存档**里造一只值钱的果蝇（测试用）
 *
 *   bun run testfly                 # 造一只 $2000 的
 *   bun run testfly -- 5000         # 造一只 $5000 的
 *   bun run testfly -- --restore    # 从备份还原（撤销上一次）
 *
 * ## 为什么需要它
 *
 * 有些东西（金锤 $999、养蝇人 Lv2 $17、警报器……）要攒很久才买得起，
 * 想测一下就得先有钱。跑一次这个就够了 —— 不用改配置、不用重新打包，
 * 也不用在 DevTools 里手搓。
 *
 * ## 它到底改了什么
 *
 * 只改存档里**一只果蝇的两个字段**：
 *
 *   weightMax —— 反解出来的满重，让它的价值正好是你给的那个数
 *   rarity    —— 改成 extreme（巨兽）
 *
 * ⚠ 稀有度一起改是必须的：售价 = 体重 × 单价，想要 $2000 就得让体重
 *   到 20 万 mg，而数据面板上「稀有度」那一行读的是**独立的一个字段**。
 *   不改的话面板会显示「稀有度：轻盈 · 体重 200000mg」，自相矛盾得像个 bug。
 *   代价是它会飞得慢一些（极端体格的设定），不过测试时反而更好抓。
 *
 * ## 三条安全规矩
 *
 *   ⚠ **游戏必须先关掉。** 它每 30 秒自动存一次，开着的话你改完
 *     不到半分钟就被它内存里的旧状态覆盖回去了 —— 而且看起来像「没生效」
 *   ⚠ 改之前**先备份**成 save.before-testfly.bak（已经有一份就**不覆盖**，
 *     免得把「真正的原始存档」冲掉）
 *   ⚠ 只改那两个字段，**不把整个世界过一遍 serialize** ——
 *     序列化会重写文件里每一个字段，万一有它不认的（将来加的），
 *     就等于顺手删掉了。改存档这种事，diff 越小越安全
 */

import fs from 'node:fs'
import path from 'node:path'
import { World } from '../renderer/src/world.js'
import { CONFIG } from '../renderer/src/config.js'
import { valueMulOf, weightMulOf } from '../renderer/src/mutations.js'
import { priceOf } from '../renderer/src/market.js'

const SAVE = path.join(process.env.APPDATA, 'fruit-fly-pet', 'save.json')
const BAK = path.join(process.env.APPDATA, 'fruit-fly-pet', 'save.before-testfly.bak')

const args = process.argv.slice(2).filter((a) => a !== '--')
const restore = args.includes('--restore')
const target = Number(args.find((a) => /^[0-9.]+$/.test(a)) ?? 2000)

if (!fs.existsSync(SAVE)) {
	console.log('找不到存档：' + SAVE)
	console.log('（先启动一次游戏，让它写出第一份存档）')
	process.exit(1)
}

// —— 撤销 ——
if (restore) {
	if (!fs.existsSync(BAK)) {
		console.log('没有备份可以还原：' + BAK)
		process.exit(1)
	}
	fs.copyFileSync(BAK, SAVE)
	console.log('已从备份还原：' + BAK)
	console.log('→ ' + SAVE)
	process.exit(0)
}

if (!(target > 0)) {
	console.log('目标价值要是个正数，收到的是 ' + JSON.stringify(args))
	process.exit(1)
}

// —— 备份（已经有一份就留着，不覆盖）——
if (!fs.existsSync(BAK)) {
	fs.copyFileSync(SAVE, BAK)
	console.log('已备份到 ' + BAK)
} else {
	console.log('备份已存在，保持不动（想重新开始就手动删掉它）：' + BAK)
}

const raw = JSON.parse(fs.readFileSync(SAVE, 'utf8'))
const world = new World(raw.world.w, raw.world.h)
world.restore(raw.world)

// 挑**成长进度最高**的那只：growth 越小，下面反解要除以一个越小的数，
// weightMax 会大得离谱（虽然也能用，但数字难看）
let pick = null
let pickIdx = -1
for (let i = 0; i < world.flies.length; i++) {
	const f = world.flies[i]
	if (f.dead) continue
	if (!pick || f.growth > pick.growth) {
		pick = f
		pickIdx = i
	}
}
if (!pick) {
	console.log('场上没有活着的成虫 —— 先去游戏里投点食物养几只')
	process.exit(1)
}

console.log(
	`选中第 ${pickIdx} 只：${pick.sex === 'F' ? '雌' : '雄'}，` +
		`成长 ${(pick.growth * 100).toFixed(1)}%，现在值 $${pick.value.toFixed(3)}`,
)

// —— 反解 weightMax ——
//
// 公式（entities.js:249-267）：
//   weight = weightAt(rarity, weightMax, growth) × weightMulOf(mutations)
//   value  = weight × pricePerMg × valueMulOf(mutations) × goldAura
//   weightAt = lerp(birthWeight, weightMax, growth)
//
// ⚠ 这里只是**算一个候选值**，写完会用真实的 `restore` + getter 读回来核对。
//   自己算的公式和实体里那份不一致的话，核对那一步会当场发现
const birth = CONFIG.market.birthWeight
const perMg = CONFIG.market.pricePerMg
const vm = valueMulOf(pick.mutations)
const wm = weightMulOf(pick.mutations)
const g = Math.max(pick.growth, 0.02) // 太小会除爆，兜一下
const aura = pick.goldAura || 1

const weightAtNeed = target / (wm * perMg * vm * aura)
const newWeightMax = birth + (weightAtNeed - birth) / g

console.log(`  突变倍率 ${vm} · 体重倍率 ${wm} · 金光 ${aura} → 满重 ${newWeightMax.toFixed(1)}mg`)

// —— 只改那两个字段 ——
raw.world.flies[pickIdx].weightMax = newWeightMax
raw.world.flies[pickIdx].rarity = 'extreme'
fs.writeFileSync(SAVE, JSON.stringify(raw, null, 2), 'utf8')
console.log('已写回 ' + SAVE)

// —— 读回来核对 ——
const check = JSON.parse(fs.readFileSync(SAVE, 'utf8'))
const w2 = new World(check.world.w, check.world.h)
w2.restore(check.world)
const after = w2.flies[pickIdx]
console.log(
	`\n读回来核对：稀有度 ${after.rarity} · 体重 ${after.weight.toFixed(1)}mg · ` +
		`价值 $${after.value.toFixed(3)}`,
)
const off = after.value - target
console.log(Math.abs(off) < 1 ? '✅ 对上了' : `⚠ 差 $${off.toFixed(3)} —— 多半是成长进度的小数误差，可忽略`)
console.log('\n⚠ 价值会随年龄**略微上涨**（体重跟着成长走）。想撤销：bun run testfly -- --restore')
