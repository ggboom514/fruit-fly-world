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
import { ensureNebula, nebulaInfo } from './nebula.js'

const canvas = document.getElementById('stage')
const renderer = new Renderer(canvas)
const world = new World(window.innerWidth, window.innerHeight)

/** 纯表现层状态，不参与模拟 */
const view = {
	// 'none' | 'inspect' | 'glove' | 'swatter' | 'net' | 'cloth' | 'squirt'
	// | 'lighter' | 'flamer' | 'broom'
	//
	// ⚠ 点火那两档是**两个独立的 tool id**（不是「一个 roast + 一个档位」）——
	//   两颗按钮各自是一颗 `data-tool`，点亮哪一颗就是哪一颗
	//
	// ⚠ showCursor 已经删掉了。工具图案（含自绘光标）全部取消，
	//   现在一律用**系统指针** —— 留着那个字段会让人以为还有一层自绘光标要接
	tool: 'none',
	mouse: { x: -999, y: -999 },
	bootOpen: false, // 启动选择框开着时，整屏都要接管鼠标
	donateOpen: false, // 捐款弹窗同理 —— 它上面有点得着的东西（见 ui.setDonateOpen）
	settingsOpen: false, // 设置卡。和捐款卡同一套「居中小卡」的规矩
	// 重置走到第几道确认（0 = 三道全关）。⚠ 是一个数字不是三个布尔：
	// 三张卡不可能同时开，用三个布尔就会多出「同时开两张」这种没意义的状态
	resetStep: 0,
	keeperOpen: false, // 养蝇人配置卡。同上，入口在商店那一行里
	sellAllOpen: false, // 罐子「全部出售」的二次确认卡。同上
	feedOpen: false, // 投放弹窗。同上
	shopOpen: false, // 商店弹窗。同上
	codexOpen: false, // 图鉴弹窗。同上
	dropJar: null, // 拎着成虫时指针底下的那个罐子。每个渲染在画，所以放这里
	dropOven: null, // 同理，指针底下的烤炉（和 dropJar 互斥，同一时刻只会有一个非空）

	// ⚠ 这里原来还有一个 `roastLevel`（烤制档位 0~3，推给渲染层决定火苗大小）。
	//   点火器拆成两颗独立按钮之后，渲染层不再需要知道档位 ——
	//   火苗大小由 `world.toolFx.big` 一个布尔表达

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
// ⚠ 反向引用：重置要连存档一起删（ui._doReset 里调 save.clear()）。
//   不是可有可无的 —— 少了它 `.clear?.()` 那个可选链会**静默不做事**，
//   看起来一切正常，只有存档文件静静地留着
ui.save = save

/**
 * 世界要不要推进。
 *
 * 启动时如果弹着「继续 / 重新开始」，就先冻住：玩家犹豫的这几秒里，
 * 那个还没被恢复的世界（构造函数里随机生成的那几只）不该自顾自地跑起来 ——
 * 否则选「继续」的那一刻，果蝇已经被放出去飞了好几秒了。
 */
let running = false

let lastTime = performance.now()

/**
 * 出错的帧数。只为了给下面那条「别刷屏」的日志计数
 */
let frameErrors = 0

/** 同样的错每帧都会再抛一次，刷屏没有意义 —— 前几次照打，之后每 300 帧打一次 */
function reportFrameError(what, e) {
	frameErrors++
	if (frameErrors <= 3 || frameErrors % 300 === 0) {
		console.error(`[main] ${what} 抛了异常（第 ${frameErrors} 次，循环继续）:`, e)
	}
}

/**
 * 主循环的一帧。
 *
 * ⚠ **每一步都要兜住，而且排下一帧必须放在 finally 里。**
 *   以前是「先跑三步、再 requestAnimationFrame」，中间任何一步抛异常，
 *   这一帧就再也不排下一帧 —— 整个循环当场死掉。
 *
 * ⚠ 而且**界面和画布必须分开兜**。1.18.0 的真实事故是：
 *   老存档里 `shop.roast: 3`、而烤制链只剩两档，
 *   `ui.update → refreshStats → refreshShop → _chainRow` 里
 *   `chain[lv - 1].name` 抛 TypeError。它在 `renderer.draw` **前面**，
 *   所以就算把循环保住了，只要两件事写在同一个 try 里，
 *   画布照样一帧都画不出来 —— 屏幕上一个生物都没有，而面板（DOM）
 *   好好地挂着，看着完全不像崩溃。
 *
 *   一个**商店面板**的越界数字，不该让**桌面上的虫**消失。这是个桌宠，
 *   画布上的虫才是本体，面板只是附属。
 */
function frame(now) {
	// 窗口被盖住、或者系统卡了一下之后，dt 可能大得离谱。
	// 掐在 100ms 以内，免得果蝇瞬移或者幼虫直接穿模出屏幕。
	const rawDt = Math.min((now - lastTime) / 1000, 0.1)
	lastTime = now

	try {
		// 没在跑的时候也要继续排下一帧，否则 running 一翻就没有循环了。
		// lastTime 上面已经无条件刷新过，所以「等待玩家选择」的那段时间
		// 不会攒成一个巨大的 dt 在开跑的瞬间砸下来。
		if (running) {
			try {
				world.update(rawDt)
				ui.update(rawDt)
				// 世界这一帧里出生了哪些突变 → 交给 ui 去合并并落盘。
				//
				// ⚠ 每帧抽一次，而不是开定时器：长度检查是 O(1)，比一个 timer
				//   便宜，而且**不会漏掉「刚出生就死掉」的虫** —— 它们可能
				//   活不过一个定时器的间隔，而图鉴要记的正是「出现过」
				if (world.seenGenes.length) {
					ui.noteSeenGenes(world.seenGenes)
					world.seenGenes.length = 0
				}
			} catch (e) {
				reportFrameError('模拟 / 界面', e)
			}
			try {
				renderer.draw(world, view)
			} catch (e) {
				reportFrameError('绘制', e)
			}
		}
	} finally {
		// 外层 finally 是最后一道保险：以后谁往上面那个 try 里加了新语句，
		// 循环也不会因为一次异常就永远停摆
		requestAnimationFrame(frame)
	}
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
	// 把手同理 —— 它是可以拖到屏幕任何地方的，缩小窗口时更容易整个跑到外面
	ui._placeHandle()
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
// ⚠ nebulaInfo 也给出去：自检要问「星云贴图到底加载出来了没有」。
//   路径写错时 `new Image()` **不报错、不抛**，只是永远不 onload ——
//   表现是「星空苹果是一块纯紫果肉」，看着像美术选择，其实是 404
window.__pet = { world, view, renderer, ui, save, config: CONFIG, swatterHeadAt, nebulaInfo }

// —— 启动 ——
//
// 有存档就先问「继续还是重新开始」，问完才开跑；
// 没有存档时 begin() 只是一次读盘 + 版本判断，几毫秒就回来了。
// 无论走哪条路都要把循环放起来 —— 出错了也只是少了个存档，
// 桌宠本身必须能玩，不能因为读档失败就整个白屏。
//
// ⚠ 星云贴图要在 `running` 之前**解码完**：图鉴的食物格是**同步**画的
//   （见 ui._codexFoodCell），没解码完就打开图鉴，那一格会画成一块纯紫果肉，
//   而且之后不会自己重画 —— 看起来就像「星空苹果没有星空」。
//   ensureNebula 自带 3 秒超时并且**永远 resolve**，图坏了也只是降级成纯色
;(async () => {
	try {
		await save.begin()
	} catch (e) {
		console.error('[save] 启动流程异常，按新局开始:', e)
	}

	await ensureNebula()

	// 解锁状态是**跨局**的（单独一个小文件，不在存档里），所以单独读一次。
	// ⚠ silent：启动时按已解锁恢复，不该在开程序的那一瞬间放一遍星尘
	try {
		const res = await window.pet?.loadUnlock?.()
		// 见过的突变也在同一个文件里。⚠ 先灌 seen 再设 star：setStarUnlocked
		// 会走 _persistUnlock 把**两个键一起**写下去，反过来的话
		// 这一拍会把刚读出来的 seen 用空数组覆盖掉
		ui.setSeenGenes(res?.data?.seen)
		ui.setStarUnlocked(!!res?.data?.star, { silent: true })
	} catch (e) {
		console.error('[unlock] 读解锁状态失败，按未解锁处理:', e)
	}

	running = true
	save.startAutosave()
})()
