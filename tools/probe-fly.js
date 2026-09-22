/** 临时探针：单只果蝇 + 一份烂香蕉，逐秒打印它在干嘛 */
import { World } from '../renderer/src/world.js'
import { CONFIG } from '../renderer/src/config.js'

const W = 1920
const H = 1080
const world = new World(W, H)

world.flies.length = 0
world.larvae.length = 0
world.eggs.length = 0
world.foods.length = 0
world.remains.length = 0

const bait = world.addFood(900, 540, 'banana')
// 注意：rot 是每帧从 age 推导出来的，直接赋值会被立刻覆盖 —— 要催熟得改 age
bait.age = CONFIG.food.rotTime * 0.9

const fly = world.addFly(900 + 230, 540, 'F')
console.log(`食物 (${bait.x}, ${bait.y})  果蝇 (${fly.x.toFixed(0)}, ${fly.y.toFixed(0)})`)
console.log(`flyScentRadius=${CONFIG.food.flyScentRadius}  flyDartSpread=${CONFIG.food.flyDartSpread}  flyPull=${CONFIG.food.flyPull}`)
console.log('')

const d0 = Math.hypot(fly.x - bait.x, fly.y - bait.y)

for (let s = 0; s < 20; s++) {
	for (let i = 0; i < 60; i++) world.update(1 / 60)

	const d = Math.hypot(fly.x - bait.x, fly.y - bait.y)
	const toward = Math.atan2(bait.y - fly.y, bait.x - fly.x)
	// aim 与「指向食物」的夹角，0 表示正对着食物飞
	let err = ((fly.aim - toward) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI

	console.log(
		`${String(s + 1).padStart(2)}s  距离 ${d.toFixed(0).padStart(4)}  ` +
			`坐标 (${fly.x.toFixed(0).padStart(4)}, ${fly.y.toFixed(0).padStart(4)})  ` +
			`aim偏差 ${(err * 57.3).toFixed(0).padStart(4)}°  ` +
			`速度 ${Math.hypot(fly.vx, fly.vy).toFixed(0).padStart(3)}  ` +
			`bait=${fly.bait ? '有' : '无'}  ` +
			`产卵=${fly.laying ? '是' : '否'}  ` +
			`dead=${fly.dead}`,
	)
}

console.log(`\n起始 ${d0.toFixed(0)}px → 结束 ${Math.hypot(fly.x - bait.x, fly.y - bait.y).toFixed(0)}px`)
