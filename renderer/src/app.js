/**
 * app.js — 渲染进程入口
 *
 * 主循环就三件事：推进世界 → 处理输入 → 画一帧。
 * 刻意不做固定步长累加：world.update() 内部已经会分步积分，
 * 这里只要把「真实经过了多少秒」老实传进去就行。
 *
 * 启动流程多了一步：先问存档要不要继续，再开始跑（见文件末尾）。
 */

import { CONFIG, swatterHeadAt } from './config.js'
import { World } from './world.js'
import { Renderer } from './render.js'
import { UI } from './ui.js'
import { SaveManager } from './save.js'

const canvas = document.getElementById('stage')
const renderer = new Renderer(canvas)
const world = new World(window.innerWidth, window.innerHeight)

/** 纯表现层状态，不参与模拟 */
const view = {
	// 'none' | 'inspect' | 'glove' | 'swatter' | 'net' | 'cloth' | 'squirt' | 'roast' | 'broom'
	//
	// ⚠ showCursor 已经删掉了。工具图案（含自绘光标）全部取消，
	//   现在一律用**系统指针** —— 留着那个字段会让人以为还有一层自绘光标要接
	tool: 'none',
	mouse: { x: -999, y: -999 },
	bootOpen: false, // 启动选择框开着时，整屏都要接管鼠标
	donateOpen: false, // 捐款弹窗同理 —— 它上面有点得着的东西（见 ui.setDonateOpen）
	settingsOpen: false, // 设置卡。和捐款卡同一套「居中小卡」的规矩
	resetOpen: false, // 重置确认卡。同上
	keeperOpen: false, // 养蝇人配置卡。同上，入口在商店那一行里
	sellAllOpen: false, // 罐子「全部出售」的二次确认卡。同上
	feedOpen: false, // 投放弹窗。同上
	shopOpen: false, // 商店弹窗。同上
	codexOpen: false, // 图鉴弹窗。同上
	dropJar: null, // 拎着成虫时指针底下的那个罐子。每个渲染在画，所以放这里
	dropOven: null, // 同理，指针底下的烤炉（和 dropJar 互斥，同一时刻只会有一个非空）
	roastLevel: 0, // 烤制道具的档位 0~3，由 ui.refreshToolButtons 推进来给渲染层用

	// 喷水枪那条水线的**朝向和长度**（纯表现 + 输入状态，不进存档）。
	// 角度单位和别处一致（弧度，0 = 指向 +x）；长度由滚轮在
	// CONFIG.tools.squirtLenMin~Max 之间调。线以**指针为中心向两头**伸
	// 长度直接读配置 —— 不在这里再写一个数，否则改 squirtLenStart 时
	// 那个配置项会静默地不生效（而界面上看起来「能调」，查起来很费劲）
	squirt: { angle: -Math.PI / 2, len: CONFIG.tools.squirtLenStart },

	// 扫帚的半径（px）。滚轮在 CONFIG.tools.broom.radiusMin~Max 之间调。
	// 和 squirt 一样直接读配置起步 —— 在别处再写一个 90 的话，
	// 改 radiusStart 时那个配置项会静默地不生效
	broom: { r: CONFIG.tools.broom.radiusStart },
}

const ui = new UI(world, view)
const save = new SaveManager(world, ui)

/**
 * 世界要不要推进。
 *
 * 启动时如果弹着「继续 / 重新开始」，就先冻住：玩家犹豫的这几秒里，
 * 那个还没被恢复的世界（构造函数里随机生成的那几只）不该自顾自地跑起来 ——
 * 否则选「继续」的那一刻，果蝇已经被放出去飞了好几秒了。
 */
let running = false

let lastTime = performance.now()

function frame(now) {
	// 窗口被盖住、或者系统卡了一下之后，dt 可能大得离谱。
	// 掐在 100ms 以内，免得果蝇瞬移或者幼虫直接穿模出屏幕。
	const rawDt = Math.min((now - lastTime) / 1000, 0.1)
	lastTime = now

	// 没在跑的时候也要继续排下一帧，否则 running 一翻就没有循环了。
	// lastTime 上面已经无条件刷新过，所以「等待玩家选择」的那段时间
	// 不会攒成一个巨大的 dt 在开跑的瞬间砸下来。
	if (running) {
		world.update(rawDt)
		ui.update(rawDt)
		renderer.draw(world, view)
	}

	requestAnimationFrame(frame)
}

requestAnimationFrame(frame)

window.addEventListener('resize', () => {
	renderer.resize()
	world.resize(window.innerWidth, window.innerHeight)
	// 食物投放区是按窗口比例算的，尺寸一变框就得跟着重摆
	ui.refreshFoodZone()
	// 罐中果蝇小窗的位置是像素坐标，窗口变小之后可能整个跑到屏幕外，
	// 得夹回来（_placeJarWindow 内部会顺带把结果夹进可视区）
	ui._placeJarWindow()
})

// 方便在 DevTools 里临时调参数玩：window.__pet.world / .view / .config
//
// config 也一起暴露：想试试「金苹果改成 3 倍」「投放区挪到右下角」这类改动，
// 改完立刻就能看到效果，不用为了看一眼去重启。
// 自检也靠它 —— 否则「参考框按配置摆位」那条断言只能自己重算一遍公式，
// 测的就成了断言自己的算术，而不是 ui.refreshFoodZone() 有没有读配置
// ⚠ swatterHeadAt 也一起给出去：自检要把它打在**同一只虫身上**验证杀伤点，
// 而不是照着 swatRadius × swatReachFactor 自己再算一遍 ——
// 那样测的是断言自己的算术，函数改了也照样绿
window.__pet = { world, view, renderer, ui, save, config: CONFIG, swatterHeadAt }

// —— 启动 ——
//
// 有存档就先问「继续还是重新开始」，问完才开跑；
// 没有存档时 begin() 只是一次读盘 + 版本判断，几毫秒就回来了。
// 无论走哪条路都要把循环放起来 —— 出错了也只是少了个存档，
// 桌宠本身必须能玩，不能因为读档失败就整个白屏。
save
	.begin()
	.catch((e) => console.error('[save] 启动流程异常，按新局开始:', e))
	.finally(() => {
		running = true
		save.startAutosave()
	})
