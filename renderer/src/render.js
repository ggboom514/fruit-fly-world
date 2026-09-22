/**
 * render.js — 所有 Canvas 绘制
 *
 * 约定：
 *   - 每个实体的局部坐标都是「头朝 +x」，靠 ctx.rotate(angle) 转过去，
 *     所以画的时候不用关心它在往哪个方向飞
 *   - 所有尺寸都乘以体型 s，10px 和 28px 共用同一套画法
 *   - 细节按体型分级：太小的时候腿和翅是亚像素的，画了只是浪费性能
 */

import { CONFIG, clamp, alarmLevel, FOOD_DRAW_RADIUS } from './config.js'
import { TAU, lerp, seeded } from './utils.js'
// ⚠ 放大镜要按**价值档**筛（玩家勾的是档位，不是一个价格门槛），
//   而分档这件事只有 market.valueTierOf 一份定义，别在这里另写一套边界
import { valueTierOf } from './market.js'
// 星云贴图。没加载好时 nebulaPattern() 返回 null，调用方直接跳过那一层 ——
// 见文件末尾 foodTexture 和 nebula.js 顶部那段「失败的样子」
import { nebulaPattern } from './nebula.js'

// ====================================================================
//  颜色小工具
// ====================================================================

/**
 * 解析一个颜色，支持 `#rgb` / `#rrggbb` / `rgb(r,g,b)` / `rgba(r,g,b,a)`。
 *
 * ⚠ **必须支持 `rgb(...)`**，因为 `mixHex()` 的返回值就是这个格式，
 * 而「先混一次、再拿结果混第二次」是再自然不过的写法。
 *
 * 早先这里只认 `#rrggbb`。于是 `mixHex(mixHex(...), ...)` 会把 `'rgb(221,211,189)'`
 * 按十六进制去切，解析出 NaN，拼成 `'rgb(NaN,NaN,NaN)'` —— 而这个字符串交给
 * `fillStyle` 时会被画布**静默忽略**：不报错、不抛异常，只是继续沿用**上一个颜色**。
 * 现象就是「蛹突然变成半透明 / 变成别的颜色」，而且换个绘制顺序现象还会跟着变，
 * 几乎没法从代码上看出来。这个坑真踩过一次（见下面 mixHex 的注释）。
 */
function parseColor(c) {
	if (typeof c !== 'string') return null
	const s = c.trim()

	if (s[0] === '#') {
		const h = s.slice(1)
		if (h.length === 3) {
			return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
		}
		if (h.length === 6) {
			return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
		}
		return null
	}

	const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
	if (m) return [+m[1], +m[2], +m[3]]

	return null
}

/**
 * 两个颜色按 t 混合，返回 `rgb()` 字符串。
 * 入参可以是十六进制，也可以是本函数自己吐出来的 `rgb()` —— 可以链式混。
 * 透明度不参与混合：返回值一律不透明。
 */
function mixHex(a, b, t) {
	const A = parseColor(a)
	const B = parseColor(b)
	if (!A || !B) {
		// 解析不出来就给一个刺眼的洋红，而不是让 fillStyle 被静默忽略。
		// 静默忽略的表现是「这个东西用的是别的颜色 / 是透明的」，
		// 根本追不到源头；洋红至少一眼能看出是这里出的问题
		console.error('[render] 颜色解析失败:', a, b)
		return 'rgb(255,0,255)'
	}
	return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`
}

/**
 * 在当前路径里撒一层很细的颗粒，做出「表面不是一整块塑料」的质感。
 *
 * 调用前必须先 beginPath() + 把形状建好 —— 这个函数会拿**当前路径**去 clip，
 * 所以撒出来的颗粒天然被限制在形状内部，不会糊到边上去。
 *
 * 位置由 seed 决定而不是 Math.random()：必须每帧固定，否则颗粒会每个点都在跳，
 * 看着像一片沙沙响的噪点，比不做还糟。这和尸体 / 食物用 seed 定形状是同一个理由。
 *
 * @param {number} sx,sy 撒点范围的两个半径。分开给是因为要贴合的形状常常是扁的
 *   （蛹是细长的米粒，用同一个半径的话长轴上一颗颗粒都没有）
 */
function speckle(ctx, seed, count, cx, cy, sx, sy, color) {
	ctx.save()
	ctx.clip()
	ctx.fillStyle = color
	// 颗粒半径跟着撒点范围走，保证小虫子身上的颗粒也小得合适
	const r = Math.max(0.3, Math.min(sx, sy) * 0.11)
	for (let i = 0; i < count; i++) {
		const a = seeded(seed, i) * TAU
		const x = cx + Math.cos(a) * seeded(seed, i + 50) * sx
		const y = cy + Math.sin(a) * seeded(seed, i + 90) * sy
		ctx.beginPath()
		ctx.arc(x, y, r, 0, TAU)
		ctx.fill()
	}
	ctx.restore()
}

/**
 * 把一串点用「中点 + 二次曲线」连成平滑路径。
 *
 * 传进来的点必须按顺序排好。closed=true 时首尾相接成一圈。
 * 折线直接用 lineTo 会在拐弯处露出棱角 —— 轮廓点够密的时候看不出来，
 * 但一龄幼虫（体长才 5px）和塌陷的空壳上就明显了。
 */
function traceSmooth(ctx, pts, closed = true) {
	if (pts.length < 2) return
	ctx.beginPath()

	if (closed) {
		const first = pts[0]
		const last = pts[pts.length - 1]
		ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2)
		for (let i = 0; i < pts.length; i++) {
			const cur = pts[i]
			const nxt = pts[(i + 1) % pts.length]
			ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + nxt.x) / 2, (cur.y + nxt.y) / 2)
		}
		ctx.closePath()
		return
	}

	// 开放段：两端各自保留，不做「中点到中点」——
	// 那样会把首尾两个点砍掉半个身位，缺口会比预想的大一圈
	ctx.moveTo(pts[0].x, pts[0].y)
	for (let i = 1; i < pts.length - 1; i++) {
		const nxt = pts[i + 1]
		ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + nxt.x) / 2, (pts[i].y + nxt.y) / 2)
	}
	const last = pts[pts.length - 1]
	ctx.lineTo(last.x, last.y)
}

/**
 * 把**世界锚定**的贴图铺进当前路径。星云苹果和星云生物都靠它。
 *
 * 原理是 Canvas 规范里的两句话，缺一不可：
 *
 *   · 建路径时：「the points passed to the methods, and the resulting lines
 *     added to current default path by these methods, must be transformed
 *     according to the current transformation matrix **before being added
 *     to the path**」—— 路径坐标在加进去的那一刻就被 CTM 烘死了
 *   · 填充时：「the stroke style is affected by the transformation during
 *     painting, **even if the current default path is used**」——
 *     样式（含 pattern）用的是**画的时候**那个 CTM，路径不再跟着动
 *
 * 于是：在生物自己的变换下把轮廓建好，再把 CTM 设回世界坐标系去 fill()，
 * 轮廓还钉在虫身上，贴图却铺在世界坐标系里 —— 虫成了星云上的一扇窗，
 * 移动的时候透出来的是星云的不同部分，而不是「贴图跟着虫一起挪」。
 *
 * 实测过（无头 Chromium，和 Electron 44 同一个引擎）：identity 下建一个
 * `rect(10,10,20,20)`，再 `setTransform(2,0,0,2,0,0)` 去 fill()，
 * 墨迹仍然落在 10,10..29,29。
 *
 * ⚠⚠ **只对「当前默认路径」成立，绝不能重构成 `Path2D`。**
 *   规范里 Path2D 是「使用时」才变换的（"must be transformed according to
 *   the current transformation matrix … when used by these methods"），
 *   改过去贴图就会跟着虫一起转 —— 那正是不要的那个效果。
 *   而且它**看起来是合理的**，不会有人来报 bug。别「顺手清理」成 Path2D。
 *
 * ⚠ `save()/restore()` **不包含当前路径**。这里靠的是「中间没人碰过路径」，
 *   不是靠 save 把它存下来了 —— 所以调用点和建路径之间不能插任何 `beginPath()`。
 *
 * @param {CanvasPattern|null} pattern 图没加载好时是 null，直接跳过这一层
 */
function fillWorldTexture(ctx, pattern) {
	if (!pattern) return
	ctx.save()
	// ⚠ 单位矩阵，不是 dpr 那个：canvas.width 是**设备像素**，
	//   路径在构建时已经被 dpr 变换过了，两者必须落在同一个空间里。
	//   贴图分块也按 canvas.width/height 造（见 nebula.js），口径一致
	ctx.setTransform(1, 0, 0, 1, 0, 0)
	ctx.fillStyle = pattern
	ctx.fill()
	ctx.restore()
}

/**
 * 一只成虫的**腹部 + 胸部**合成轮廓（**不含头**）。
 *
 * 这两个椭圆原来在 drawFly 里散着写了两遍（颗粒裁剪、石化暗边），
 * 星云贴图是第三个用户 —— 再来一份的话，改一处忘一处会变成
 * 「贴图比身体大一圈」，不报错、不崩，只是假。
 *
 * ⚠ 腹部 / 胸部**各自单独上色**那两处不在这里收：它们是分开的两次 fill
 *   （各带自己的亮暗渐变），合成一条路径反而填不出那个渐变。
 *
 * @param {number} s 体型（体长）
 */
function flyBodyPath(ctx, s, sex) {
	const female = sex === 'F'
	ctx.beginPath()
	ctx.ellipse(-s * 0.26, 0, s * (female ? 0.34 : 0.31), s * (female ? 0.26 : 0.22), 0, 0, TAU)
	ctx.ellipse(s * 0.07, 0, s * 0.21, s * 0.18, 0, 0, TAU)
}

// 蛆的身体轮廓系数已经搬到 config.js 的 larva.profile ——
// 因为 simulate.js 要拿它算「渲染出来的宽长比」，两边各留一份的话，
// 改了一边另一边就悄悄失去意义。取用走 config 的 larvaProfileAt()。

// ====================================================================
//  变异外观
// ====================================================================

/**
 * 石化蝇的调色板：整只换成灰阶，眼睛也不再是红的。
 *
 * ⚠ 眼睛必须一起去色。只把身体变灰、留着两只红眼睛的话，
 *   读起来是「一只被调成灰度的正常果蝇」，而不是石头 ——
 *   红眼是整只虫子上饱和度最高的东西，它一留，去色就白做了
 */
const STONE_PALETTE = {
	bodyColor: '#8d8a84',
	bodyColorLight: '#a8a5a0',
	bodyColorDark: '#5f5c58',
	thoraxColor: '#7a7772',
	thoraxColorLight: '#96938e',
	headColor: '#6e6b66',
	eyeColor: '#9a9792',
	eyeColorHi: '#c2bfba',
	eyeColorLo: '#575450',
	legColor: 'rgba(70, 68, 65, 0.9)',
	bristleColor: 'rgba(60, 58, 55, 0.55)',
	femaleStripeColor: 'rgba(80, 78, 74, 0.45)',
	maleAbdomenTip: 'rgba(70, 68, 64, 0.62)',
	// 颗粒比默认重得多：石头要有肉眼可见的材质，
	// 一块均匀的灰色只是个剪影，和「塑料片」没区别
	bodyGrainColor: 'rgba(40, 38, 35, 0.24)',
	wingColor: 'rgba(150, 148, 144, 0.24)',
	wingRootColor: 'rgba(165, 163, 159, 0.40)',
	_rim: 'rgba(52, 50, 47, 0.55)',
}

/**
 * 点石成金蝇的调色板：通体金色。
 */
const GOLD_PALETTE = {
	bodyColor: '#d9a32b',
	bodyColorLight: '#f2cc63',
	bodyColorDark: '#8f6412',
	thoraxColor: '#c08f1f',
	thoraxColorLight: '#e8bd4e',
	headColor: '#a8761a',
	eyeColor: '#8a1f18',
	eyeColorHi: '#d4564a',
	eyeColorLo: '#5c1109',
	legColor: 'rgba(110, 74, 12, 0.9)',
	bristleColor: 'rgba(120, 84, 16, 0.5)',
	femaleStripeColor: 'rgba(140, 96, 20, 0.45)',
	maleAbdomenTip: 'rgba(120, 82, 14, 0.62)',
	bodyGrainColor: 'rgba(120, 84, 14, 0.14)',
	wingColor: 'rgba(196, 160, 70, 0.26)',
	wingRootColor: 'rgba(214, 178, 84, 0.42)',
	_gold: true,
}

/**
 * 按基因组合取调色板。没有突变就返回 CONFIG.visual 本身（零开销）。
 *
 * ⚠ 结果要**缓存**。drawFly 是每帧对每只果蝇各调一次，
 *   40 只 × 60 帧 = 每秒 2400 次；每次现拼一个对象的话，
 *   光这个就会给 GC 制造一堆没必要的垃圾。
 *   键是基因组合的字符串 —— 组合只有十几种，缓存会一直很小。
 */
const PALETTE_CACHE = new Map()

function flyVisual(f) {
	const genes = f.mutations
	if (!genes || genes.length === 0) return CONFIG.visual

	const key = genes.join('|')
	const hit = PALETTE_CACHE.get(key)
	if (hit) return hit

	// 叠加顺序：先石化再点石成金。两个都有时金色胜出 ——
	// 金是更稀有、更「值钱」的那一个，被灰盖掉会很莫名其妙
	let v = CONFIG.visual
	if (genes.includes('stone')) v = { ...v, ...STONE_PALETTE }
	if (genes.includes('golden')) v = { ...v, ...GOLD_PALETTE }
	// 结晶不改颜色（它整只是透明的），但要走缓存，所以也得有个条目
	if (v === CONFIG.visual) v = { ...CONFIG.visual }

	PALETTE_CACHE.set(key, v)
	return v
}

/**
 * 成虫的**整体轮廓**，用来给结晶蝇描边。
 *
 * ⚠ 为什么不能直接描那三个椭圆：腹部、胸部、头是三段独立画上去的椭圆
 *   （见下面 drawFly），各自 stroke() 的话会得到**三个互相穿插的圈**，
 *   中间还有接缝 —— 看起来像三个呼啦圈叠在一起，不是一只虫的边。
 *
 * 做法：沿 x 轴取样，每个位置取三段椭圆里**最高**的那个半高，
 * 拼成一条上缘 + 一条下缘，再用 traceSmooth 平滑地连起来。
 * 这样得到的是一条真正意义上的剪影轮廓
 */
function flySilhouette(s, sex) {
	const female = sex === 'F'
	const parts = [
		{ cx: -s * 0.26, rx: s * (female ? 0.34 : 0.31), ry: s * (female ? 0.26 : 0.22) },
		{ cx: s * 0.07, rx: s * 0.21, ry: s * 0.18 },
		{ cx: s * 0.3, rx: s * 0.13, ry: s * 0.14 },
	]

	let minX = Infinity
	let maxX = -Infinity
	for (const p of parts) {
		minX = Math.min(minX, p.cx - p.rx)
		maxX = Math.max(maxX, p.cx + p.rx)
	}

	// 某个 x 处剪影的半高 = 三段椭圆里在该 x 处仍然存在的那几段的半高中的最大值
	const halfAt = (x) => {
		let h = 0
		for (const p of parts) {
			const dx = (x - p.cx) / p.rx
			if (dx <= -1 || dx >= 1) continue
			h = Math.max(h, p.ry * Math.sqrt(1 - dx * dx))
		}
		return h
	}

	const N = 22
	const pts = []
	for (let i = 0; i <= N; i++) {
		const x = minX + ((maxX - minX) * i) / N
		pts.push({ x, y: -halfAt(x) }) // 上缘，左 → 右
	}
	for (let i = N; i >= 0; i--) {
		const x = minX + ((maxX - minX) * i) / N
		pts.push({ x, y: halfAt(x) }) // 下缘，右 → 左
	}
	return pts
}

/**
 * 结晶蝇的那圈炫彩描边。
 *
 * 色相是沿着身体**横向铺开**的（一条线性渐变上取六个色标），
 * 再叠一个随时间走的偏移 —— 于是颜色会顺着身体流动，而不是整只一起闪。
 * 整只一起闪看起来像霓虹灯坏了，顺着流才像晶体在转。
 *
 * canvas 直接吃 hsl() 字符串，所以不需要在 utils 里加 HSL 工具
 * （那边也没有，mixHex 是 RGB-only 的）
 */
function crystalRim(ctx, f, s) {
	const t = performance.now() / 1000
	const g = ctx.createLinearGradient(-s * 0.62, 0, s * 0.45, 0)
	const shift = t * 70 + f.seed * 0.6
	for (let i = 0; i <= 5; i++) {
		g.addColorStop(i / 5, `hsl(${(shift + (i / 5) * 360) % 360}, 88%, 70%)`)
	}
	ctx.strokeStyle = g
	// ⚠ 线宽系数必须和**结晶幼虫**那条一致（drawLarva 里的 `l.size * 0.11`）。
	//
	//   这里原来是 0.055 —— 正好是幼虫的一半。同样的颜色、同样的流动，
	//   画出来却只是一根头发丝：用户的原话是「结晶成虫好像没有特殊效果」，
	//   其实效果全在，只是细到看不见（成虫还在以 300~1700px/s 飞）。
	//
	//   幼虫那边多一个 `/0.85`，是因为 drawLarva 有一层 `ctx.scale(1, 0.85)`
	//   会把描边一起压扁，得补偿回去；成虫这边没有那层变换，所以直接用系数
	ctx.lineWidth = Math.max(0.7, s * 0.11)
	ctx.lineJoin = 'round'
	traceSmooth(ctx, flySilhouette(s, f.sex))
	ctx.stroke()
}

/**
 * 点石成金蝇身上的闪光。
 *
 * 位置由 seed 固定（不然每帧乱跳，像雪花噪点），
 * 但**亮度**跟着时间走，所以是「有几个点在轮流亮」。
 * 用 seeded 而不是 Math.random() 的理由和 speckle 完全一样
 */
function drawGoldSparkle(ctx, f, s) {
	const t = performance.now() / 1000
	const n = 5
	for (let i = 0; i < n; i++) {
		const a = seeded(f.seed, i + 300) * TAU
		const r = 0.12 + seeded(f.seed, i + 400) * 0.36
		const x = -s * 0.26 + Math.cos(a) * s * r
		const y = Math.sin(a) * s * r * 0.72

		// 每颗自己的闪烁相位，错开才不会齐亮齐灭
		const tw = Math.sin(t * 3.1 + f.seed * 0.9 + i * 2.3)
		if (tw <= 0.25) continue // 大部分时间应该是暗的，亮的一直在的话就成麻子了

		ctx.globalAlpha = (tw - 0.25) / 0.75
		ctx.fillStyle = '#fff8d8'
		ctx.beginPath()
		ctx.arc(x, y, Math.max(0.4, s * 0.04), 0, TAU)
		ctx.fill()
	}
	ctx.globalAlpha = 1
}

// ====================================================================
//  成虫
// ====================================================================

/**
 * @param {number} ox 额外的 x 偏移。罐中果蝇的 f.x 是相对罐心的偏移，
 *   得加上罐子自己的位置才能落到屏幕上
 */
function drawFly(ctx, f, ox = 0, oy = 0) {
	const s = f.size
	const V = flyVisual(f)
	const detailed = s > 13 // 太小就不画腿了，反正看不见
	const crystal = f.mutations && f.mutations.includes('crystal')
	// 星云的**身体贴图**。和 crystal 一样每帧直接读基因数组 ——
	// 它们都是「这只虫现在长什么样」的判据，没有第二处状态
	const nebula = f.mutations && f.mutations.includes('nebula')

	ctx.save()
	ctx.translate(f.x + ox, f.y + oy)
	ctx.rotate(f.angle)

	// 结晶蝇：整个身体几乎全透明，只剩最后描的那圈炫彩边。
	//
	// ⚠ 只设一次、放在这里，靠下面的 ctx.restore() 自动还原 ——
	//   别在各个 fill 之前反复设，那样漏掉一处就是一块不透明的补丁，
	//   而且看起来只像是「这只结晶蝇画得不太对」
	if (crystal) ctx.globalAlpha = 0.14

	// —— 腿：画在身体之前，才会被身体压住根部 ——
	if (detailed) {
		ctx.strokeStyle = V.legColor
		ctx.lineWidth = Math.max(0.5, s * 0.028)
		ctx.lineCap = 'round'

		// 爬行时用三角步态：前左 / 中右 / 后左 为一组，两组相位差半周期。
		//
		// 用连续正弦而不是「抬起 / 落下」的二值切换 —— 二值会让腿一格一格地跳。
		// 步态相位跟着**实际走过的距离**推进，所以走得快腿倒得快、停下来腿也停，
		// 比按固定频率打拍子自然得多。
		const walking = f.mode === 'walk'
		const stepping = walking && !f.pausing
		const tripodOffset = (i, side) => ((i + (side > 0 ? 1 : 0)) % 2) * Math.PI

		for (const side of [-1, 1]) {
			for (let i = 0; i < 3; i++) {
				// 停顿时四条腿都落地，只有走动时才交替抬起
				const lifted = stepping ? Math.max(0, Math.sin(f.gaitPhase * Math.PI + tripodOffset(i, side))) : 0
				const reach = lifted * 0.11

				let wiggle = 0
				if (!walking) {
					wiggle = Math.sin(f.legPhase + i * 0.9 + (side > 0 ? 0 : 1.6)) * s * 0.02
				}

				const bx = s * (0.16 - i * 0.15)
				const by = side * s * 0.12
				const kx = bx - s * (0.06 - reach * 0.5) + wiggle // 膝
				const ky = side * s * (0.32 - reach * 0.7)
				const fx = bx - s * (0.2 + i * 0.05 - reach) // 足
				const fy = side * s * (0.44 + i * 0.03 - reach * 1.5)

				ctx.beginPath()
				ctx.moveTo(bx, by)
				ctx.lineTo(kx, ky)
				ctx.lineTo(fx, fy)
				ctx.stroke()
			}
		}
	}

	// —— 翅膀 ——
	// 飞：张开、高速扇动
	// 落地（爬行 / 产卵）：向后收拢贴着身体、完全静止
	// 这个区别是「在空中」和「在地上」最直接的信号，比任何特效都管用。
	const grounded = f.mode === 'walk' || f.laying
	const flap = grounded ? 0 : Math.sin(f.wingPhase) * 0.3
	const spread = grounded ? 0.06 : 0.45
	const wingLen = s * (grounded ? 0.43 : 0.36)
	const wingWid = s * (grounded ? 0.082 : 0.11)

	// 翅膜不是一块均匀的灰片：靠身体那半（翅根）更厚更实，越往翅尖越薄越透。
	// 用一道沿翅长方向的渐变做出来。**两只翅膀共用同一个渐变对象** ——
	// 它建在身体的局部坐标系里，两边只有 translate/rotate 不同，渐变本身通用。
	const wingGrad = ctx.createLinearGradient(wingLen * 0.17, 0, -wingLen * 1.83, 0)
	wingGrad.addColorStop(0, V.wingRootColor)
	wingGrad.addColorStop(1, V.wingColor)

	// 只有填充，没有描边 —— 翅膀是半透明的，给它勾一圈白边反而会
	// 在身体两侧画出两道生硬的白线（见文件末尾「关于描边」那段）
	ctx.save()
	ctx.fillStyle = wingGrad
	for (const side of [-1, 1]) {
		ctx.save()
		ctx.translate(s * 0.04, side * s * 0.08)
		ctx.rotate(-side * (spread + flap))
		// 沿翅膀自己的长轴翻一下。两片翅膀是**镜像**，不是同一片转个角度 ——
		// 不翻的话翅脉会朝同一边弓，远看像两片叶子朝一个方向倒。
		// 椭圆本身关于长轴对称，所以这一翻不会改变翅膀的轮廓。
		ctx.scale(1, side)
		ctx.beginPath()
		ctx.ellipse(-wingLen * 0.83, 0, wingLen, wingWid, 0, 0, TAU)
		ctx.fill()
		if (detailed) drawWingVeins(ctx, wingLen, wingWid)
		ctx.restore()
	}
	ctx.restore()

	// —— 腹部 ——
	const female = f.sex === 'F'
	const abdRx = s * (female ? 0.34 : 0.31)
	const abdRy = s * (female ? 0.26 : 0.22)
	// 横跨腹部的一道浅渐变：背侧受光、腹侧压暗，身体就鼓起来了。
	// 用**局部**坐标而不是屏幕坐标 —— 果蝇一直在转，跟着屏幕打光的话
	// 光会从四面八方来，反而更像一张纸片。
	// 上端不只到 bodyColor 就停：再往暗面压一档，弧度才明显
	const abdGrad = ctx.createLinearGradient(0, -abdRy, 0, abdRy)
	abdGrad.addColorStop(0, V.bodyColorLight)
	abdGrad.addColorStop(0.45, V.bodyColor)
	abdGrad.addColorStop(1, mixHex(V.bodyColor, V.bodyColorDark, 0.55))
	ctx.fillStyle = abdGrad
	ctx.beginPath()
	ctx.ellipse(-s * 0.26, 0, abdRx, abdRy, 0, 0, TAU)
	ctx.fill()

	if (detailed) {
		if (female) {
			// 雌性：腹部的黑色环纹
			ctx.strokeStyle = V.femaleStripeColor
			ctx.lineWidth = Math.max(0.4, s * 0.035)
			for (let i = 1; i <= 2; i++) {
				const x = -s * (0.18 + i * 0.11)
				const w = abdRy * Math.sqrt(Math.max(0, 1 - ((x + s * 0.26) / abdRx) ** 2)) * 0.85
				ctx.beginPath()
				ctx.moveTo(x, -w)
				ctx.lineTo(x, w)
				ctx.stroke()
			}
		} else {
			// 雄性：腹部末端有一块深色（真实黑腹果蝇的特征）
			ctx.fillStyle = V.maleAbdomenTip
			ctx.beginPath()
			ctx.ellipse(-s * 0.44, 0, s * 0.115, s * 0.115, 0, 0, TAU)
			ctx.fill()
		}
	}

	// —— 胸部 ——
	const thGrad = ctx.createLinearGradient(0, -s * 0.18, 0, s * 0.18)
	thGrad.addColorStop(0, V.thoraxColorLight)
	thGrad.addColorStop(0.5, V.thoraxColor)
	thGrad.addColorStop(1, mixHex(V.thoraxColor, V.bodyColorDark, 0.5))
	ctx.fillStyle = thGrad
	ctx.beginPath()
	ctx.ellipse(s * 0.07, 0, s * 0.21, s * 0.18, 0, 0, TAU)
	ctx.fill()

	// 胸背上的刚毛。真实果蝇这一块特别显眼，但**必须画得很短很淡** ——
	// 28px 的果蝇胸部才 12px 宽，刚毛一长就变成刺猬，比不做还糟。
	// 只画背侧那三根，朝后上方伸（果蝇的刚毛就是向后倒伏的）
	if (detailed) {
		ctx.strokeStyle = V.bristleColor
		ctx.lineWidth = Math.max(0.4, s * 0.022)
		ctx.lineCap = 'round'
		ctx.beginPath()
		for (let i = 0; i < 3; i++) {
			const a = -Math.PI * (0.18 + i * 0.17) // 从上前方扫到正上方
			const bx = s * 0.07 + Math.cos(a) * s * 0.19
			const by = Math.sin(a) * s * 0.16
			ctx.moveTo(bx, by)
			ctx.lineTo(bx - s * 0.075, by - s * 0.04)
		}
		ctx.stroke()
	}

	// —— 一层很细的颗粒质感 ——
	//
	// 把腹部和胸部合成一条路径来裁剪（**不含头**，免得颗粒撒到复眼上），
	// 撒一层几乎看不出的颗粒。目的是让它读起来像个有壳的实体，
	// 而不是一块纯色的贴纸 —— 但必须「几乎看不出」，
	// 颗粒一旦看得清就会变成脏点。
	//
	// 太小的果蝇（体长不到 13px）跳过：那个尺寸下颗粒是亚像素的，画了只是浪费
	if (detailed) {
		flyBodyPath(ctx, s, f.sex)
		speckle(ctx, f.seed, 14, -s * 0.1, 0, s * 0.4, s * 0.26, V.bodyGrainColor)
	}

	// —— 头 + 复眼 ——
	// ⚠ 用 headColor（暗红），不是 bodyColorDark ——
	// 后者是给腹部 / 胸部压暗用的深棕，混用的话头就不是红的了
	ctx.fillStyle = V.headColor
	ctx.beginPath()
	ctx.ellipse(s * 0.3, 0, s * 0.13, s * 0.14, 0, 0, TAU)
	ctx.fill()

	// 复眼：红底上一个偏上前方的高光 + 压暗的边缘 =「鼓起来的球面」。
	// 每只眼单独建渐变 —— 两只眼在 y 上差了 0.17s，共用一个的话
	// 高光会跑到两只眼中间去，看着像额头上有个亮点。
	if (detailed) {
		for (const side of [-1, 1]) {
			const ex = s * 0.33
			const ey = side * s * 0.085
			const eg = ctx.createRadialGradient(ex - s * 0.02, ey - s * 0.03, 0, ex, ey, s * 0.1)
			eg.addColorStop(0, V.eyeColorHi)
			eg.addColorStop(0.45, V.eyeColor)
			eg.addColorStop(1, V.eyeColorLo)
			ctx.fillStyle = eg
			ctx.beginPath()
			ctx.ellipse(ex, ey, s * 0.085, s * 0.075, 0, 0, TAU)
			ctx.fill()
		}
	} else {
		// 体长不到 13px 时整只眼才 1px 出头，渐变是亚像素的，纯属浪费
		ctx.fillStyle = V.eyeColor
		for (const side of [-1, 1]) {
			ctx.beginPath()
			ctx.ellipse(s * 0.33, side * s * 0.085, s * 0.085, s * 0.075, 0, 0, TAU)
			ctx.fill()
		}
	}

	// —— 星云：把世界坐标系里的贴图，透过身体这扇窗露出来 ——
	//
	// ⚠ 位置是三件事一起定的：
	//   1. 在**头之后** —— 眼睛先画完，贴图盖不住它。红眼是整只虫最认得出的
	//      东西，盖掉之后只剩一团星云，读不出这是只果蝇
	//   2. 形状**不含头**（flyBodyPath 只有腹 + 胸），和上面那层颗粒共用同一条 ——
	//      那边的理由写得很清楚：「免得颗粒撒到复眼上」
	//   3. 在**石化暗边之前** —— 石化的暗边是给「灰身体的实心边界」用的，
	//      压在贴图上面才对
	//
	// ⚠ 结晶赢：它整只是 0.14 的幽灵 + 一圈炫彩边，盖一层不透明的贴图上去
	//   会把它整个抹掉，两个效果同归于尽。判据和 drawLarva 里
	//   「结晶优先于 translucency」一模一样 —— 更稀有、更该被一眼认出的那个赢
	if (nebula && !crystal) {
		flyBodyPath(ctx, s, f.sex)
		fillWorldTexture(ctx, nebulaPattern(ctx))
	}

	// 石化的那层人工暗边。石头是有明确轮廓的硬东西，
	// 而灰身体的亮度和浅色桌面很接近，不勾边就只是地上一块色斑
	if (V._rim && detailed) {
		ctx.strokeStyle = V._rim
		ctx.lineWidth = Math.max(0.4, s * 0.022)
		flyBodyPath(ctx, s, f.sex)
		ctx.stroke()
	}

	// 闪光画在最上层，否则会被后画的身体盖住
	if (V._gold) drawGoldSparkle(ctx, f, s)

	// ⚠ 炫彩轮廓最后画，而且要**先把不透明度还原** ——
	//   结晶蝇的身体是 0.14 的 alpha，描边要是也吃这个值，
	//   那圈彩虹会淡到看不见，整个结晶就等于只有一团鬼影
	if (crystal) {
		ctx.globalAlpha = 1
		crystalRim(ctx, f, s)
	}

	ctx.restore()
}

/**
 * 翅脉：一条主纵脉 + 两条横脉，都很淡。
 *
 * 真实果蝇的翅脉密得多（还有一整套「翅室」），但**这个尺度上画全了就是一团网** ——
 * 果蝇最大才 28px，翅膀长约 10px，塞五六条线进去只会糊成一片灰雾。
 * 所以只留「一条纵脉 + 两条横脉」这个最低限度的骨架，刚好够让翅膀读成一片**膜**，
 * 而不是一块灰色色块。
 *
 * 必须先裁进翅膀的椭圆里：翅脉是翅膜**内部**的线，出了头就变成描边了。
 * 这也正是文件末尾「关于描边」那一节允许的那类线 —— 和雌蝇腹部的环纹一样，
 * 属于内部结构，不是给形状勾边，所以用 stroke 是正当的。
 *
 * 坐标约定：u=0 是翅根、u=1 是翅尖（翅沿 -x 方向伸出去）。
 */
function drawWingVeins(ctx, wingLen, wingWid) {
	const V = CONFIG.visual
	const wAt = (u) => wingLen * (0.17 - 2.0 * u)
	const vAt = (u) => wingWid * (-0.2 + 0.3 * u) // 主纵脉在该处的高度

	ctx.save()
	ctx.beginPath()
	ctx.ellipse(-wingLen * 0.83, 0, wingLen, wingWid, 0, 0, TAU)
	ctx.clip()

	ctx.strokeStyle = V.wingVeinColor
	// 翅脉要**细**：粗一点点就从「膜上的纹路」变成「画在翅膀上的线」。
	// 28px 的果蝇翅膀才 10px 长，这个宽度落到屏幕上不到 1px —— 正好
	ctx.lineWidth = Math.max(0.4, wingLen * 0.06)
	ctx.lineCap = 'round'

	// 主纵脉：从翅根偏上弓到翅尖
	ctx.beginPath()
	ctx.moveTo(wAt(0), vAt(0))
	ctx.quadraticCurveTo(wAt(0.5), vAt(0.5) - wingWid * 0.3, wAt(1), vAt(1))
	ctx.stroke()

	// 两条横脉：从主纵脉向后缘（+y 侧）连下去
	for (const u of [0.34, 0.6]) {
		ctx.beginPath()
		ctx.moveTo(wAt(u), vAt(u))
		ctx.quadraticCurveTo(wAt(u), wingWid * 0.35, wAt(u + 0.05), wingWid * 0.9)
		ctx.stroke()
	}

	ctx.restore()
}

// ====================================================================
//  卵
// ====================================================================

function drawEgg(ctx, e) {
	const E = CONFIG.egg
	const p = e.progress
	// 每颗卵的大小和胖瘦都不一样：母体的个性 + 逐颗抖动，再叠上各自的 aspect
	const L = E.length * e.scale
	const W = L * e.aspect

	// 快孵化时会轻微扭动
	const wob = p > 0.82 ? Math.sin(e.wobble) * 0.14 : 0

	ctx.save()
	ctx.translate(e.x, e.y)
	ctx.rotate(e.angle)
	ctx.scale(1 + wob, 1 - wob)

	// 只留轮廓，没有高光 —— 高光会让它看着像颗塑料珠，
	// 而卵实际是贴在桌面上的一个哑光小颗粒。
	// 深浅逐颗不同：在「深」和「浅」两个色之间按这一颗的 shade 取一个位置。
	// 区间开得很窄（config.egg.shadeMin/Max），所以只是让一窝卵不至于像
	// 同一个色号复制出来的，凑近才看得出来
	ctx.fillStyle = mixHex(CONFIG.visual.eggColorDark, CONFIG.visual.eggColorLight, e.shade)
	ctx.beginPath()
	ctx.ellipse(0, 0, L, W, 0, 0, TAU)
	ctx.fill()

	ctx.restore()
}

// ====================================================================
//  幼虫
// ====================================================================

function drawLarva(ctx, l) {
	const s = l.size
	const L = CONFIG.larva
	const V = CONFIG.visual

	ctx.save()
	ctx.translate(l.x, l.y)

	// —— 蛹期：一粒米（蛹壳 / puparium）——
	if (l.pupa) {
		ctx.rotate(l.angle)

		const P = CONFIG.pupa
		// 蛹沿用这一只的长短胖瘦，不然蛆和蛹对不上号。
		// 形状比幼虫短、比幼虫细，像一粒米
		const pl = s * l.lengthScale * P.lengthScale
		const pw = s * lerp(P.widthFat, P.widthSlim, l.slim)

		// 壳色分两段：
		//   前 tanTime（30 秒）—— 从米白慢慢变成褐色。这一段是「看着它化蛹」
		//   之后到羽化前 —— 再往深褐走一点，幅度很小
		//
		// 起点用 pupaColorFresh 而不是 larvaColor，原因写在 config 那一条上：
		// 幼虫色偏灰，和浅色壁纸同亮度，糊成一片会被误读成「透明」
		let shell = mixHex(V.pupaColorFresh, V.pupaColor, l.tanProgress)
		shell = mixHex(shell, V.pupaShellDark, l.pupaProgress * P.ripenShare)

		ctx.fillStyle = shell
		ctx.beginPath()
		ctx.ellipse(0, 0, pl, pw, 0, 0, TAU)
		ctx.fill()

		// —— 壳内侧一圈淡淡的暗边 ——
		//
		// ⚠ 这一段是「蛹看着透明」的真正解药，别删。
		//   之前量过：蛹中心 pixel 是 rgb(221,211,189) / alpha 255，横排扫过去
		//   半透明像素 0 个 —— 它从头到尾就是不透明的。看上去透明是因为
		//   米白和浅色桌面的**亮度一样**，一个纯平的色块没有边界、没有厚度，
		//   眼睛只能把它读成「一层盖在桌面上的半透明东西」。
		//   所以解法是给壳一点厚度暗示（内侧压暗），而不是去动 alpha。
		//
		// 用径向渐变而不是描边：描边是均匀一圈，看着像贴纸的裁切线；
		// 渐变的暗部从边缘往里化开，才像一枚有弧度的壳。
		ctx.save()
		ctx.scale(1, pw / pl) // 把椭圆拉成圆，径向渐变才能贴合长轴
		const shade = ctx.createRadialGradient(0, 0, pl * 0.5, 0, 0, pl)
		shade.addColorStop(0, 'rgba(0, 0, 0, 0)')
		shade.addColorStop(1, V.pupaEdgeShade)
		ctx.fillStyle = shade
		ctx.beginPath()
		ctx.arc(0, 0, pl, 0, TAU)
		ctx.fill()
		ctx.restore()

		// 淡淡一层轮廓，压在暗边最外沿上，把边界钉死。
		// 之前按「全场不留轮廓」去掉过，但蛹是一枚实心硬壳，
		// 完全没有边界在浅色桌面上会整个化开
		ctx.strokeStyle = V.pupaRim
		ctx.lineWidth = Math.max(0.6, s * 0.028)
		ctx.beginPath()
		ctx.ellipse(0, 0, pl, pw, 0, 0, TAU)
		ctx.stroke()

		// 壳面的颗粒质感（和成虫同一套）
		speckle(ctx, l.seed, P.speckles, 0, 0, pl * 0.85, pw * 0.8, V.pupaSpeckle)

		ctx.restore()
		return
	}

	ctx.rotate(l.angle)
	ctx.scale(1, 0.85) // 蛆是扁的，不是圆柱

	// —— 身体：一条平滑的闭合形状，**不分节、不描边、不用渐变** ——
	//
	// 轮廓来自 l.bodyOutline()：它是把「脊柱」（世界坐标的一串点）换算到头的
	// 局部坐标、撑出左右两条轮廓线、两端补上半圆头之后的闭合折线。
	// 身体之所以会弯，就是因为那些点**没有**跟着头转。
	//
	// 放在 Larva 上而不是写在这里，自检才能拿到同一条轮廓去断言 ——
	// 「尾巴是不是被切平了」就是靠它测出来的。
	const outline = l.bodyOutline()
	traceSmooth(ctx, outline)

	// —— 上色 ——
	//
	// 两种长相，孵化那一刻就定下来了（见 Larva.translucent）：
	//
	//   普通（八成）：整条同色的实心蛆
	//   透的（两成）：中间实、外圈微微透 —— 体壁薄的那种感觉
	//
	// 两成那个比例是有意的：全都做成透的，一窝蛆就没了「个体差异」，
	// 反而更像一排复制品；夹着几条不同的，扫一眼才有活物的意思
	// 结晶幼虫：**优先于 translucency**。两者都是「透明」，但同时表达不出来 ——
	// 外圈微透是「体壁薄」，结晶是「整条只剩描边」，混在一起只会两不像。
	// 结晶更稀有、也更该被一眼认出来，所以它赢
	const crystal = l.mutations && l.mutations.includes('crystal')
	const nebula = l.mutations && l.mutations.includes('nebula')

	// —— 星云（幼虫）——
	//
	// 幼虫这边比成虫省事得多：`bodyOutline()` 已经是一条现成的闭合路径
	// （本来就是给描边用的），`traceSmooth` 刚刚把它铺成了**当前路径**，
	// 直接 fill 就是满满一条，不需要再拼轮廓。
	//
	// ⚠ 结晶赢，理由和成虫那边一字不差：结晶是「整条只剩一圈描边」，
	//   盖一层不透明的贴图上去就把它抹掉了
	//
	// ⚠ 这里只填贴图、**不加描边**。深紫的星云在浅色桌面上对比度本来就够，
	//   而描边会让它和结晶幼虫长得像 —— 两者是不同突变，不该撞脸。
	//   （真在深色桌面上糊了，那是「换一张亮一点的星云图」的事）
	//
	// ⚠⚠ **这一支的 `ctx.restore()` 不能省。** 函数开头（`ctx.save()` +
	//   `ctx.translate(l.x, l.y)`）压进去了一层状态，下面那条
	//   `ctx.rotate/scale` 也还在这一层里。直接 return 的话——
	//   · 这一层**永远弹不出来**，而且每帧每只星云幼虫都再压一层，越堆越高
	//   · 更要命的是**画布上的变换也留着**：后面画的每一只虫 / 食物 / 粒子
	//     都会先被平移到这条幼虫的位置、再按它的角度转一下
	//   表现是「虫全被钉在某个点上、跟着它一起晃」——因为那个「锚点」
	//   就是最后画的那只星云幼虫，它一动，整屏跟着动
	if (nebula && !crystal) {
		fillWorldTexture(ctx, nebulaPattern(ctx))
		ctx.restore()
		return
	}

	if (crystal) {
		ctx.save()
		ctx.globalAlpha = 0.14
		ctx.fillStyle = V.larvaColor
		ctx.fill()
		ctx.restore()

		// 幼虫的轮廓是**现成**的：bodyOutline() 已经是一条闭合的身体折线，
		// traceSmooth 也已经把它铺成了当前路径，直接 stroke 就是完美的一圈边。
		//
		// ⚠ 上面 ctx.scale(1, 0.85) 会把描边一起压扁 ——
		//   线宽在纵向只有横向的 0.85 倍。数量级上差得不多，但对一条
		//   本来就细的边来说看得出来（横边比竖边粗），所以补偿回去
		const t = performance.now() / 1000
		const g = ctx.createLinearGradient(-l.size * 0.6, 0, l.size * 0.6, 0)
		const shift = t * 70 + l.seed * 0.6
		for (let i = 0; i <= 5; i++) {
			g.addColorStop(i / 5, `hsl(${(shift + (i / 5) * 360) % 360}, 88%, 70%)`)
		}
		ctx.strokeStyle = g
		ctx.lineWidth = Math.max(0.7, l.size * 0.11) / 0.85
		ctx.lineJoin = 'round'
		ctx.stroke()

		ctx.restore()
		return
	}

	if (!l.translucent) {
		ctx.fillStyle = V.larvaColor
		ctx.fill()
	} else {
		// ⚠ 渐变要贴着身体的长轴，不能直接用圆。身体是细长的，
		//   正圆渐变会让两头先淡掉、中间还实着 —— 看起来像一根两头化开的糖。
		//   这里把坐标系按 bbox 的宽高比压扁，圆就变成了贴合身体的椭圆
		ctx.save()
		ctx.clip()

		let minX = Infinity
		let maxX = -Infinity
		let minY = Infinity
		let maxY = -Infinity
		for (const p of outline) {
			if (p.x < minX) minX = p.x
			if (p.x > maxX) maxX = p.x
			if (p.y < minY) minY = p.y
			if (p.y > maxY) maxY = p.y
		}
		const bx = (minX + maxX) / 2
		const by = (minY + maxY) / 2
		const rx = Math.max((maxX - minX) / 2, 1)
		const ry = Math.max((maxY - minY) / 2, 1)

		ctx.translate(bx, by)
		ctx.scale(1, ry / rx)
		const g = ctx.createRadialGradient(0, 0, rx * 0.45, 0, 0, rx * 1.02)
		g.addColorStop(0, V.larvaColor)
		g.addColorStop(1, V.larvaEdgeColor)
		ctx.fillStyle = g
		// 铺满裁剪区。夹在上面的缩放里，矩形的坐标也是缩放后的
		ctx.fillRect(-rx * 2, -rx * 2, rx * 4, rx * 4)
		ctx.restore()
	}

	ctx.restore()
}

// ====================================================================
//  蛹壳 — 羽化后留下的那枚空壳
//
//  它必须一眼看得出「是空的」，否则玩家会以为那还是一只蛹。
//  三条线索叠在一起，从强到弱：
//
//    1. **形状是瘪的**（最强）—— 轮廓向内塌陷几处，见 Shell.dents。
//       活蛹是饱满的椭圆，壳是凹进去的。形状是第一眼线索，
//       不用比对就看得出来
//    2. 颜色比活蛹浅得多、也薄得多
//    3. 轮廓上留一个缺口 —— 成虫就是从那一端钻出来的
//
//  早先只有 2 和 3，玩家会把空壳当成「透明的蛹」——
//  颜色得比一比才看出来，缺口太小也常常被忽略。形状才是管用的那条。
// ====================================================================

/** 羽化缺口的角度半宽。轮廓上 [-0.75, 0.75] 这一段不画 */
const SHELL_GAP = 0.75

function drawShell(ctx, sh) {
	const s = sh.size
	const V = CONFIG.visual

	ctx.save()
	ctx.translate(sh.x, sh.y)
	ctx.rotate(sh.angle)

	const loop = sh.outline()

	// 壳体：一圈向内塌陷的闭合轮廓
	ctx.fillStyle = V.shellColor
	traceSmooth(ctx, loop, true)
	ctx.fill()

	// 轮廓，但在一端留个缺口 = 成虫钻出来的那个洞。
	// ⚠ 用的是**同一条塌陷轮廓**上的一段，而不是另画一个正椭圆 ——
	// 那样缺口两端会和瘪掉的壳体对不上，接缝处露出一小截毛刺。
	// outline() 的每个点都带着自己的角度 t，挑出这一段就行
	let i0 = 0
	while (i0 < loop.length && loop[i0].t < SHELL_GAP) i0++
	let i1 = loop.length - 1
	while (i1 > i0 && loop[i1].t > TAU - SHELL_GAP) i1--

	if (i1 - i0 >= 1) {
		ctx.strokeStyle = V.shellRim
		ctx.lineWidth = Math.max(0.6, s * 0.026)
		traceSmooth(ctx, loop.slice(i0, i1 + 1), false)
		ctx.stroke()
	}

	ctx.restore()
}

// ====================================================================
//  残留物：尸体 / 汁渍
// ====================================================================

/**
 * 一具尸体。
 *
 * 尸体仍然**值钱**（拖进出售区能按原价换钱），所以它要说清楚「我烂到几成了」——
 * 越烂越不值钱，也越难擦。
 *
 * ⚠ 这里原来还有一个「烤过的」分支：整体焦褐 + 体积缩一圈 + 不再腐烂。
 *   1.18.0 起**地上的尸体不能再烤了**（点火器改成点着活蝇），所以整段删掉。
 *   **必须连绘制一起删**：`revive()` 会把老存档里残留的 `roasted: true`
 *   原样写回去，只删价钱里的倍率、留着这个分支的话，
 *   那批老尸体会**全部画成焦褐色** —— 看起来像「还能烤」，其实已经不是了
 */
function drawCorpse(ctx, r) {
	const V = CONFIG.visual
	const s = r.size
	const rot = r.rot
	// 擦过之后会「糊开」，所以一边变淡一边摊大
	const smear = r.clean * 0.55 + rot * 0.28
	const alpha = 1 - r.clean * 0.72
	ctx.save()
	ctx.globalAlpha = alpha
	ctx.translate(r.x, r.y)
	ctx.rotate(r.angle)

	// 体色。
	//
	// ⚠ 渐变必须在 **translate / rotate 之后**建 —— createLinearGradient 的
	// 坐标是「建的那一刻」的当前坐标系。写在 save() 之前的话它锚在世界原点，
	// 每具尸体拿到的都是同一条横贯全屏的色带（而且各自的取色还不一样），
	// 症状是「有几具尸体是纯黑的、有几具正常」，极难联想到渐变
	const body = mixHex(V.corpseColor, V.corpseRotColor, rot)

	// 腐烂渗出来的一圈
	if (rot > 0.12) {
		ctx.globalAlpha = alpha * rot * 0.32
		ctx.fillStyle = V.corpseRotColor
		ctx.beginPath()
		ctx.ellipse(0, 0, s * (0.56 + smear * 0.5), s * (0.42 + smear * 0.42), 0, 0, TAU)
		ctx.fill()
		ctx.globalAlpha = alpha
	}

	// 蜷起来的六条腿
	ctx.strokeStyle = body
	ctx.lineWidth = Math.max(0.55, s * 0.042)
	ctx.lineCap = 'round'
	for (const side of [-1, 1]) {
		for (let i = 0; i < 3; i++) {
			const bx = s * (0.16 - i * 0.15)
			const by = side * s * 0.1
			ctx.beginPath()
			ctx.moveTo(bx, by)
			ctx.quadraticCurveTo(bx - s * 0.14, side * s * 0.3, bx + s * 0.08, side * s * 0.34)
			ctx.stroke()
		}
	}

	// 皱掉的翅膀。
	//
	// ⚠ 这两个三元原来是「烤过的收得更拢、也更焦」。尸体不能再烤之后,
	//   两个分支都只剩「没烤过」那一支 —— 忘了改的话这里会引用一个
	//   **已经删掉的变量**，而那是个 ReferenceError：每帧只要有尸体就抛，
	//   整个 canvas 一帧都画不出来。
	//   自检当时没抓到它，因为那条像素断言会把 remains 暂时清空
	ctx.fillStyle = 'rgba(205, 205, 205, 0.18)'
	for (const side of [-1, 1]) {
		ctx.save()
		ctx.translate(-s * 0.06, side * s * 0.1)
		ctx.rotate(-side * 0.8)
		ctx.beginPath()
		ctx.ellipse(-s * 0.26, 0, s * 0.3, s * 0.08, 0, 0, TAU)
		ctx.fill()
		ctx.restore()
	}

	// 身体三节
	ctx.fillStyle = body
	ctx.beginPath()
	ctx.ellipse(-s * 0.24, 0, s * 0.34 * (1 + smear * 0.35), s * 0.22 * (1 + smear * 0.4), 0, 0, TAU)
	ctx.fill()
	ctx.beginPath()
	ctx.ellipse(s * 0.1, 0, s * 0.24 * (1 + smear * 0.3), s * 0.2 * (1 + smear * 0.35), 0, 0, TAU)
	ctx.fill()
	ctx.beginPath()
	ctx.arc(s * 0.34, 0, s * 0.12 * (1 + smear * 0.3), 0, TAU)
	ctx.fill()

	ctx.restore()
}

function drawStain(ctx, r) {
	const s = r.size
	const V = CONFIG.visual
	const spread = 1 + r.rot * CONFIG.remains.spread * 0.8
	const alpha = (0.7 - r.rot * 0.22) * (1 - r.clean * 0.82)
	const color = mixHex(V.stainColor, V.corpseRotColor, r.rot * 0.8)

	if (alpha <= 0.01) return

	ctx.save()
	ctx.globalAlpha = alpha
	ctx.fillStyle = color
	ctx.translate(r.x, r.y)
	ctx.rotate(r.angle)

	// 用几坨「固定随机」位置的重叠圆拼出不规则形状。
	// 位置由 seed 决定而不是每帧 Math.random()，否则它会疯狂抖动。
	for (let i = 0; i < 6; i++) {
		const a = seeded(r.seed, i) * TAU
		const d = seeded(r.seed, i + 100) * s * 0.5 * spread
		const rr = (0.26 + seeded(r.seed, i + 200) * 0.4) * s * spread
		ctx.beginPath()
		ctx.arc(Math.cos(a) * d, Math.sin(a) * d, rr, 0, TAU)
		ctx.fill()
	}

	ctx.restore()
}

// ====================================================================
//  食物
//
//  画的都是「掉在桌上的一点点碎屑」，不是完整水果：
//  一小块苹果屑、一片香蕉皮、单颗葡萄。
//  三者共用一套处理流程：腐烂 → 颜色往褐黑靠；被啃 → 整体缩小干瘪；
//  烂到一定程度 → 长出位置固定的霉斑。轮廓各画各的。
// ====================================================================

/**
 * 一块不规则形状的苹果屑。
 *
 * 轮廓由这块食物自己的 seed 生成 —— 顶点数、每个顶点的角度和半径都不同，
 * 所以同一屏上出现的几块形状各不相同，看不出是同一个贴图在重复。
 *
 * 用直线段而不是贝塞尔曲线：掰下来的碎块本来就是有棱角的，
 * 曲线太顺滑反而显得卡通，正是要去掉的那种感觉。
 */
/**
 * 这一种食物要不要盖星云贴图。要盖就返回 pattern，否则 null。
 *
 * ⚠ **只有一个判据**，场上和図鉴共用 —— 图鉴存在的意义就是
 *   「让我认得出屏幕上那个是什么」，两边画得不一样就白做了
 *   （这条规矩是从 drawAppleScrap 上面那段注释里继承下来的）。
 *
 * ⚠ 每次重取一次 pattern 而不是缓存到模块变量：它内部按 ctx 缓存，
 *   取一次只是一次 Map 查表；而自检会**临时换掉 renderer.ctx** 去做像素探针，
 *   存到模块变量上的话，换回来的那一帧就画到别的画布上去了
 */
function foodTexture(ctx, type) {
	if (type !== 'star') return null
	return nebulaPattern(ctx)
}

function drawAppleScrap(ctx, s, skin, flesh, seedColor, seed, texture = null) {
	const r = s * 0.5
	const n = 7 + Math.floor(seeded(seed, 90) * 4) // 7~10 个顶点

	// 先把轮廓点算出来 —— 果皮要沿着同一组点描，形状才对得上。
	//
	// ⚠ 顶点系数的**上限**（= 半径 `size × FOOD_DRAW_RADIUS`）对外是有意义的：
	//   `world.dropFoods` 用它算投放区的内缩量，好让整个果子落在区内。
	//   所以上限从那个常量**反推**，不在这里另写一个 1.22 ——
	//   两处各写一份的话，改了一边另一边会静默失准（果子悄悄压出投放区，
	//   而画面上只是「有点出格」，几乎看不出来）
	const RR_MAX = FOOD_DRAW_RADIUS * 2 // 1.22
	const RR_MIN = 0.66 // 下限纯粹是形状上的选择，不参与任何对外契约
	const pts = []
	for (let i = 0; i < n; i++) {
		const a = (i / n) * TAU + seeded(seed, 30) * 0.6
		const rr = r * (RR_MIN + seeded(seed, i) * (RR_MAX - RR_MIN))
		pts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr * 0.86 })
	}

	const trace = (from, count) => {
		ctx.beginPath()
		for (let k = 0; k <= count; k++) {
			const p = pts[(from + k) % n]
			if (k === 0) ctx.moveTo(p.x, p.y)
			else ctx.lineTo(p.x, p.y)
		}
	}

	// 果肉。同色描边 + round join 把尖角稍微磨圆，
	// 纯折线画出来会像纸片，加一点倒角才像块果肉。
	ctx.fillStyle = flesh
	ctx.strokeStyle = flesh
	ctx.lineWidth = r * 0.2
	ctx.lineJoin = 'round'
	trace(0, n)
	ctx.closePath()
	ctx.fill()
	ctx.stroke()

	// —— 星云贴图：盖在果肉上、果皮之下 ——
	//
	// ⚠ 位置**必须正好在这里**：上面那条闭合路径就是果肉多边形，
	//   fillWorldTexture 复用的就是它。往下挪一行，果皮那次 `trace()`
	//   会重新 beginPath，路径一换就画到「果皮那两段弧」上去了。
	//
	// 果皮弧和果核画在它之后，所以星空苹果外缘仍然是一条正常的果皮 ——
	// 「这是一块掰下来的苹果屑」这件事不被贴图吃掉。
	//
	// 果肉那次 stroke 比多边形大出 r*0.1（lineWidth = r*0.2、round join），
	// 所以贴图外面天然留了一圈果肉色 —— 那正是想要的「果肉里嵌着一小块星空」
	if (texture) fillWorldTexture(ctx, texture)

	// 果皮：只沿外缘的一小段，不是包一圈
	ctx.strokeStyle = skin
	ctx.lineWidth = Math.max(1.1, s * 0.15)
	ctx.lineCap = 'round'
	ctx.lineJoin = 'round'
	trace(Math.floor(seeded(seed, 60) * n), 2 + Math.floor(seeded(seed, 70) * 2))
	ctx.stroke()

	// 一两粒果核碎屑
	ctx.fillStyle = seedColor
	ctx.globalAlpha = 0.7
	for (let i = 0; i < 2; i++) {
		const a = seeded(seed, i + 40) * TAU
		const d = r * 0.25 * seeded(seed, i + 45)
		ctx.beginPath()
		ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d, r * 0.075, r * 0.12, a, 0, TAU)
		ctx.fill()
	}
	ctx.globalAlpha = 1
}

function drawFood(ctx, f) {
	const V = CONFIG.visual
	const F = CONFIG.food
	const s = f.size
	const palette = V.food[f.type] ?? V.food.apple

	// ⚠ 必须读 f.eaten（0→1），**不能**写 `1 - f.nutrition` ——
	//   nutrition 是**总量**（最大 durabilityMax = 20），写反了会得到 -19，
	//   果子被画成 5 倍大。小果子上两者恰好相等，所以只在 200px 的大果子上爆
	const eaten = f.eaten
	const skin = mixHex(palette.skin, V.foodRotColor, f.rot * 0.75)
	const flesh = mixHex(palette.flesh, V.foodRotColor, f.rot * 0.55 + eaten * 0.2)
	const scale = (1 - eaten * 0.22) * (1 - f.rot * 0.06)

	// —— 金苹果的光晕 ——
	//
	// 画在苹果**下面**，是一层以食物中心为心的径向渐变。
	// 注意这是**发光不是投影**：投影有方向、会把东西从桌面上「拎」起来，
	// 而那正是这套美术风格明确避开的（全场没有阴影）。
	// 光晕是为了让「这个苹果不一样」在余光里也认得出 —— 两种苹果差 10 倍价钱，
	// 只靠颜色深浅区分的话，缩到 19px 就分不清了。
	//
	// 用实时时间做呼吸，所以它本身也带一点「这是个道具」的暗示
	if (f.type === 'gold' && !f.depleted) {
		const pulse = 0.78 + Math.sin(f.age / 620) * 0.22
		// 半径只比苹果本身大一圈（0.92 × size）。1.15 那版的光晕比苹果大出一倍，
		// 看着是「一颗小苹果浮在一大团光里」，而不是苹果自己在发光
		const r = s * 0.92
		const glow = ctx.createRadialGradient(f.x, f.y, s * 0.34, f.x, f.y, r)
		glow.addColorStop(0, V.foodGoldGlow)
		glow.addColorStop(1, 'rgba(255, 205, 90, 0)')
		ctx.save()
		ctx.globalAlpha = pulse * (1 - f.rot * 0.6) // 烂掉之后光也暗下去
		ctx.fillStyle = glow
		ctx.beginPath()
		ctx.arc(f.x, f.y, r, 0, TAU)
		ctx.fill()
		ctx.restore()
	}

	ctx.save()
	ctx.translate(f.x, f.y)
	ctx.rotate(f.angle)
	ctx.scale(scale, scale)

	// 目前只有「苹果屑」一种画法，两种苹果共用它、只是配色不同。
	// 要加别的**形状**就在这里按 f.type 分派，入口在 config.food.types。
	drawAppleScrap(ctx, s, skin, flesh, palette.seed, f.seed, foodTexture(ctx, f.type))

	// 霉斑：烂到 moldAt 之后逐渐长出来，位置由 seed 决定所以不会每帧乱跳
	if (f.rot > F.moldAt) {
		ctx.globalAlpha = ((f.rot - F.moldAt) / (1 - F.moldAt)) * 0.75
		ctx.fillStyle = V.moldColor
		for (let i = 0; i < 5; i++) {
			const a = seeded(f.seed, i) * TAU
			const d = seeded(f.seed, i + 50) * s * 0.36
			const r = (0.08 + seeded(f.seed, i + 90) * 0.1) * s
			ctx.beginPath()
			ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, TAU)
			ctx.fill()
		}
		ctx.globalAlpha = 1
	}

	ctx.restore()
}

// ====================================================================
//  玻璃罐
//
//  **平面 2D 画法**：就是一个圆角矩形加一道罐口横线，不模仿 3D 圆柱 ——
//  没有椭圆罐口、没有径向渐变、没有弧形高光。整屏其余部分也都是扁平的
//  （生命体刻意不带投影），罐子做成立体的反而格格不入。
//
//  和之前一样分「背板 / 前壁」两次画，中间夹着罐里的果蝇：
//  这样果蝇被那层半透明底色压住一点，读起来才像是在玻璃后面，
//  而不是浮在罐子上方。
//
//  透明玻璃的要诀还是那句：**几乎不填色，只画边缘**。
//  280×410 这么大一块，填充 alpha 只要超过 0.1 就会变成一块磨砂塑料。
// ====================================================================

const JAR_RADIUS = 10 // 圆角半径。直角太硬，圆角太大又像按钮

/** 罐子的矩形路径。背板和前壁共用，保证两者严丝合缝 */
function jarPath(ctx, jar) {
	const hw = jar.halfW
	const hh = jar.halfH
	ctx.beginPath()
	ctx.roundRect(-hw, -hh, hw * 2, hh * 2, JAR_RADIUS)
}

function drawJarBack(ctx, jar) {
	const V = CONFIG.visual

	ctx.save()
	ctx.translate(jar.x, jar.y)

	// 一层极淡的底色。它同时干两件事：让人看出「这块是玻璃」，
	// 以及把里面的果蝇稍微压暗一点，做出「隔着玻璃」的层次
	ctx.fillStyle = V.jarGlass
	jarPath(ctx, jar)
	ctx.fill()

	ctx.restore()
}

/**
 * @param {boolean} [dropHot] 拎着成虫正压在这个罐子上 —— 描线和盖子都点亮，
 *   让「松手就装进去」这件事在松手**之前**就看得出来
 */
function drawJarFront(ctx, jar, dropHot = false) {
	const V = CONFIG.visual
	const J = CONFIG.jar
	const hw = jar.halfW
	const hh = jar.halfH
	// 盖子的半宽，和它压在罐身上沿之上的高度
	const cw = J.capWidth / 2
	const ch = J.capHeight

	ctx.save()
	ctx.translate(jar.x, jar.y)

	// —— 盖子 ——
	//
	// 实心棕色，**坐在罐身上沿之上**（y 从 -hh-ch 到 -hh）。
	// 早先这里是一道画在罐身内部的「罐口横线」，那读起来始终像个方框加一横；
	// 真正让它像罐子的是上面这个比罐身窄一截的实心脑袋。
	// 四角给一点点圆角，和罐身的圆角呼应
	ctx.fillStyle = dropHot ? V.jarDropHot : V.jarCap
	ctx.beginPath()
	ctx.roundRect(-cw, -hh - ch, cw * 2, ch, 3)
	ctx.fill()

	// —— 罐身：半透明天蓝的圆角矩形轮廓 ——
	ctx.strokeStyle = dropHot ? V.jarDropHot : V.jarRim
	ctx.lineWidth = dropHot ? 2.4 : 1.6
	jarPath(ctx, jar)
	ctx.stroke()

	// 左内壁一道竖线，给一点反光的意思。就一道，多了又会变成立体
	ctx.strokeStyle = V.jarHighlight
	ctx.lineWidth = 1.6
	ctx.beginPath()
	ctx.moveTo(-hw + 6, -hh + 8)
	ctx.lineTo(-hw + 6, hh - 8)
	ctx.stroke()

	// 容量小字。⚠ 摆在**盖子之上**（-hh - ch），不是罐身上沿 ——
	// 摆在 -hh 会被盖子整个压住，一个字都看不见
	if (jar.flies.length > 0) {
		ctx.fillStyle = V.jarLabel
		ctx.font = "11px 'Microsoft YaHei UI', system-ui, sans-serif"
		ctx.textAlign = 'center'
		ctx.textBaseline = 'bottom'
		ctx.fillText(`${jar.flies.length}/${jar.capacity}`, 0, -hh - ch - 5)
	}

	ctx.restore()
}

// ====================================================================
//  粒子 / 特效
//
//  ⚠ 这里原来还有一个 drawSwing（挥拍动画：一圈扩散的环 + 命中时的放射线）。
//     工具图案整体取消之后，它的位置被 `world.burstRing` 顶掉了 ——
//     同样是「以杀伤半径勾一圈」，但那是一圈真粒子，会自己散掉。
//     想改挥拍反馈就去改 burstRing 的调用点（world.swat 末尾），别在这里加回来。
// ====================================================================

function drawParticle(ctx, p) {
	ctx.globalAlpha = p.alpha
	ctx.fillStyle = p.color
	// grow：正数 = 越淡越大（灰尘扩散），负数 = 越淡越小（火苗收尖），0 = 不变
	const r = p.size * (0.5 + p.alpha * 0.5 + (1 - p.alpha) * (p.grow ?? 0))
	ctx.beginPath()
	ctx.arc(p.x, p.y, Math.max(0.2, r), 0, TAU)
	ctx.fill()
	ctx.globalAlpha = 1
}

/**
 * 往上飘的一行字（烤炉整炉结账 / 烧着的蝇烧完自动卖，都会冒）。
 *
 * ⚠ **先描边再填字**，而且描边不能省：这个字会飘过炉子、飞过的果蝇、
 *   偶尔还有玻璃罐 —— 那些底色从深褐到浅黄什么都有。只填一层金色的话，
 *   飘到亮色背景上就糊成一团，而它写的偏偏是**钱**
 */
function drawFloatText(ctx, t) {
	// 样式在 CONFIG.floatText（两个来源共用），不是炉子那一节
	const F = CONFIG.floatText
	const a = t.alpha
	if (a <= 0) return

	ctx.save()
	ctx.globalAlpha = a
	ctx.font = F.font
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.lineWidth = 2.6
	ctx.strokeStyle = F.stroke
	ctx.strokeText(t.text, t.x, t.y)
	ctx.fillStyle = t.color
	ctx.fillText(t.text, t.x, t.y)
	ctx.restore()
}

/**
 * 抹布拖尾：擦过的地方留下一小片淡淡的水痕。
 *
 * ⚠ **这是工具图案删掉之后唯一活下来的「范围可视化」**，而且是顺带的：
 *   它的半径恰好就是 `wipeRadius`（判定半径），所以「刚才擦到哪儿」看得见。
 *   这不是故意留的例外，是它本来就画的是**擦过的痕迹**而不是抹布本身 ——
 *   别照着它给别的工具加回一圈常驻的线。
 */
function drawWipeTrail(ctx, t) {
	const a = clamp(t.life / 0.4, 0, 1)
	ctx.save()
	ctx.globalAlpha = a * 0.22
	ctx.fillStyle = '#cfe6ff'
	ctx.beginPath()
	ctx.arc(t.x, t.y, CONFIG.tools.wipeRadius * (1.1 - a * 0.2), 0, TAU)
	ctx.fill()
	ctx.restore()
}

// ====================================================================
//  关于描边：什么该有、什么不该有
//
//  这个文件里用 stroke 的东西分三类，改的时候别混：
//
//  【轮廓】给一个填充形状勾一圈边 —— **一律不要**。
//    翅膀、卵、蛹壳、幼虫身体都属于这一类，现在全是纯填充。
//    勾边会让形状「浮」在桌面上、看着像贴纸，和这里
//    「东西就长在桌面上」的整体风格是冲突的
//    （同一个理由，全场没有任何投影 —— 见 config.visual 末尾那段注释）。
//
//  【本身就是线的东西】腿、雌蝇腹纹、苹果果皮、玻璃罐的边框和罐口 —— **保留**。
//    它们的 stroke 不是在勾勒某个轮廓，去掉等于把那个部件删了：
//    果蝇会变成没有腿的椭圆；罐子会直接消失（它的填充只有 6% 透明度，
//    看得见全靠那圈边框）。所以「取消所有描边」要按这条线来切，不能一刀切。
//
//  【工具反馈】—— **一个图案都不留**。
//    ⚠ 这里原来写着「挥拍圈 / 工具光标 / 抹布拖尾 / 放大镜环 —— 保留」。
//      用户要求把所有工具的**样子和范围描边**全删掉，只留系统鼠标指针，
//      改成粒子。所以：球拍 / 网兜 / 抹布 / 水线 / 查看圈 / 火苗形状
//      连同它们各自那圈虚线**全部不存在了** —— 想改工具反馈，
//      去 world 的 `_emitOneParticle` / `burstRing`，**不要往这个文件里加回任何
//      以指针为中心画的图形**。
//
//    现在还剩两处「以屏幕元素为参照画出来的东西」，都不是工具图案：
//      · **放大镜的高亮环** —— 那是信息叠加层（「这几只值钱」），
//        和「你手里拿着什么」无关，玩家不拿任何工具时它照样该亮
//      · **抹布拖尾** —— 画的是「擦过留下的水痕」，也就是**做过的痕迹**，
//        不是抹布本身。顺带它还承担了抹布的范围提示（半径恰好等于 wipeRadius）
//
//    删掉的那一圈虚线原来负责「打得到哪儿」，现在由 `world.burstRing` 顶上：
//    命中/挥空的那一刻沿判定半径撒一圈粒子，亮 0.3 秒再散掉。
//    改挥拍 / 撒网的反馈就去改那两个调用点。
//
//  【已批准的例外】**结晶变异**的身体轮廓（crystalRim / drawLarva 里那段）。
//    它明确违反第一条 —— 就是给幼虫和成虫的身体勾了一圈边。
//    这么做的理由：结晶的设定就是「全身透明、只剩描边」，
//    而一个 alpha 0.14 的填充在浅色桌面上基本等于没有，
//    不勾边的话这个变异在画面上根本不存在。它描的也**不是普通填色形状**，
//    而是一只本来就没有实体的东西唯一的可见部分。
//
//    ⚠ 这是**唯一**的例外。别拿它当先例给别的实体加描边 ——
//      当年正是「给每个填充都勾一圈」把这个文件搞得像贴纸的。
//      另外结晶的边**不参与**「生命体一律不描边」那条规则，
//      所以在改成通用逻辑之前，先回来看这一条。
//
//  【石化变异】的暗边（drawFly 里 V._rim 那段）不算例外：
//    它描的是灰色的身体，和蛹壳的 pupaRim 是同一类 ——
//    灰／米白这类和桌面亮度接近的实体，不勾边会整块糊掉。
// ====================================================================

// ====================================================================
//  放大镜的高亮环
//
//  商店里买下放大镜之后，价值过线的成虫身上会套一圈会呼吸的光环。
//  **屏幕上的、罐子里的、烤炉里的都算** —— 「全场值钱的」就是字面意思，
//  罐中果蝇本来就是玩家特意存下来的那批，不给它高亮才奇怪。
//
//  颜色是固定的**白色**，不跟着价值分档变色：分档色本身带着「越贵越花」
//  的含义，套在会呼吸的光环上读起来像又一层稀有度（见 drawMagnifier 里的注释）。
//
//  画在果蝇之后（压在身体上）而不是之前，否则会被翅膀盖掉一半；
//  也要画在罐子和烤炉**之后**，否则容器里的那些会被前壁盖掉
// ====================================================================
/**
 * 警报器：罐中果蝇快寿终时给它套一圈会呼吸的光环。
 *
 * 橙 = 还剩 20%，红 = 还剩 10%，阈値来自 CONFIG.market.shop 里 alarm 那一项。
 *
 * ⚠ **只管罐子里的**。外面满屏飞的果蝇不点亮 —— 那会变成一片闪烁的彩色点，
 * 而且外面的果蝇本来就该自然生灭，不值得逐个盯。
 * 罐子才是「你特意存起来的那几只」，提醒才有意义 —— 这也是这个道具存在的理由：
 * 罐中寿命是外面的两倍，正因为活得久，才更容易在你没注意的时候悄悄到头。
 *
 * 画在罐中果蝇**之后**、罐子前壁**之前** —— 光环压在果蝇身上，
 * 但会被前壁那层极淡的底色罩一下，读起来才像是「在玻璃里面」。
 */
function drawJarAlarm(ctx, jar) {
	const V = CONFIG.visual
	const t = performance.now() / 1000

	for (const f of jar.flies) {
		// 阈值判断走 alarmLevel()，和模拟器测的是同一份代码
		const level = alarmLevel(f)
		if (!level) continue
		const red = level === 2
		const color = red ? V.alarmRed : V.alarmOrange

		// ⚠ 罐中果蝇的 x / y 是**相对罐心**的偏移，得加上罐子自己的坐标
		const x = jar.x + f.x
		const y = jar.y + f.y
		// 越快到头闪得越急，两档在余光里也分得开
		const rate = red ? 7 : 3.6
		const pulse = 0.55 + 0.45 * Math.sin(t * rate + f.seed)
		const r = f.size * (0.62 + pulse * 0.16)

		ctx.save()
		ctx.globalAlpha = 0.35 + pulse * 0.55
		// 一层柔光 + 一圈实线。只有柔光的话在浅色桌面上看不见，
		// 只有实线又像给果蝇勾了个描边（那违反「生命体一律不描边」）
		const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 2)
		glow.addColorStop(0, color)
		glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
		ctx.fillStyle = glow
		ctx.beginPath()
		ctx.arc(x, y, r * 2, 0, TAU)
		ctx.fill()

		ctx.strokeStyle = color
		ctx.lineWidth = 1.6
		ctx.beginPath()
		ctx.arc(x, y, r, 0, TAU)
		ctx.stroke()
		ctx.restore()
	}
}

/**
 * 放大镜该给哪些果蝇套光环 —— 返回**屏幕坐标**下的 { fly, x, y }。
 *
 * 单独抽出来是为了能被测：光环画在哪儿是渲染细节，
 * 但「罐子/烤炉里的果蝇有没有加上容器的偏移」是个**坐标换算**上的对错，
 * 而那正是最容易写错、又最难看出来的地方（画错的表现是「光环全叠在屏幕左上角」，
 * 而虫子好好地画在罐子里）。抽成纯函数之后，自检可以直接对坐标下断言。
 *
 * ⚠ 三种来源的 x / y **不是同一个坐标系**：
 *   · world.flies  —— 就是屏幕坐标，直接用
 *   · jar.flies    —— **相对罐心**的偏移，要加 jar.x / jar.y
 *   · oven.items   —— **相对炉心**的偏移，要加 oven.x / oven.y
 *   （同一个坑在 drawJarAlarm 那边也有，那边是加对了的）
 */
export function magnifierTargets(world, tiers) {
	const out = []
	// 勾中的档位集合。⚠ 传进来的是**价值档 id 数组**（valueTiers 的 id），
	//   不是以前那个单一的价格门槛 —— 「值钱」对不同玩家是两回事，
	//   有人想盯刚长起来的变异蝇，有人只想收传说
	const want = new Set(tiers ?? [])
	/** 不在勾选的档里、或者已经死了的不算 */
	const push = (f, x, y) => {
		if (f.dead || !want.has(valueTierOf(f.value).id)) return
		out.push({ fly: f, x, y })
	}
	for (const f of world.flies) push(f, f.x, f.y)
	for (const jar of world.jars) for (const f of jar.flies) push(f, jar.x + f.x, jar.y + f.y)
	for (const oven of world.ovens) for (const f of oven.items) push(f, oven.x + f.x, oven.y + f.y)
	return out
}

/**
 * 把**一份食物**画在一个小画布里（图鉴的格子在用）。
 *
 * ⚠ 复用 `drawAppleScrap` 而不是另写一套：那是食物唯一的绘制入口，
 *   图鉴里再写一份的话，两边的形状迟早会长得不一样 ——
 *   而图鉴存在的意义恰恰是「让玩家认得出这是什么」。
 *
 * 调用方负责把 ctx 的原点移到格子中心（并清干净上一帧）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} type 食物类型（apple / gold）
 * @param {number} size 画多大（**直径**，和 Food.size 一个口径）
 * @param {number} [seed] 形状种子。同一个种子每次画出来一样 ——
 *   不传就固定用一个，免得图鉴里的苹果每次打开都换个形状
 */
export function drawFoodIcon(ctx, type, size, seed = 7) {
	const V = CONFIG.visual
	const palette = V.food[type] ?? V.food.apple

	// 金苹果的那层淡光晕。图鉴里留着它 —— 那是它和普通苹果唯一的
	// 「一眼分得开」的地方（光看调色板得比一比才认得出）
	if (type === 'gold') {
		const r = size * 0.92
		const glow = ctx.createRadialGradient(0, 0, size * 0.34, 0, 0, r)
		glow.addColorStop(0, V.foodGoldGlow)
		glow.addColorStop(1, 'rgba(255, 205, 90, 0)')
		ctx.fillStyle = glow
		ctx.beginPath()
		ctx.arc(0, 0, r, 0, TAU)
		ctx.fill()
	}

	drawAppleScrap(ctx, size, palette.skin, palette.flesh, palette.seed, seed, foodTexture(ctx, type))
}

// ⚠ 这里原来有个 magnifierMinValue()，读 magnifier 的 `minValue` 当门槛。
//   门槛换成「玩家勾选的档位集合」之后它就没有意义了 —— 留着会是个谎：
//   全局只有一个门槛这件事已经不存在了，而它还会被别处当成真话用

function drawMagnifier(ctx, world) {
	const tiers = world.magnifierTiers
	const t = performance.now() / 1000

	/**
	 * 给一只果蝇套光环。x / y 是**屏幕坐标** ——
	 * 容器里的果蝇存的是相对容器的偏移，magnifierTargets 已经加好了
	 */
	const ring = (f, x, y) => {
		// ⚠ 这里**不**再重复判一次档位 —— magnifierTargets 已经筛过了。
		//   原来这里还有一句 `f.value >= min` 的重复检查，是历史遗留：
		//   留着就等于「门槛有两处定义」，改一处忘一处时目标和光环对不上，
		//   而且症状很隐蔽（有些蝇有目标、没光环）

		// 呼吸：半径和透明度一起小幅起伏，比一个静止的圈显眼得多，
		// 而且不会盖住果蝇本身的形状。相位用 f.seed 错开，
		// 否则一屏光环会整齐划一地一起明灭，像有人在打拍子
		const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + f.seed)

		ctx.save()
		ctx.translate(x, y)

		// ⚠ 颜色是**固定白色**，不再取自价值分档。
		//
		// 早先用 tier.color 上色，问题是它和面板边框、金苹果、金色 UI
		// 抢同一种视觉语言 —— 而且分档颜色本身就有「越贵越花」的含义，
		// 套在会在屏幕上呼吸的光环上，读起来像是又一层稀有度。
		// 白色是这里唯一**没有别的东西在用**的高亮色，一眼就知道是「工具标的」，
		// 也不会和果蝇自己的变异外观（金 / 灰 / 透明）混起来

		// 外面一圈柔光，负责「一眼看到」
		const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, f.size * 0.75 + 12 + pulse * 3)
		glow.addColorStop(0, 'rgba(255, 255, 255, 0.55)')
		glow.addColorStop(1, 'rgba(255, 255, 255, 0)')
		ctx.globalAlpha = 0.30 + pulse * 0.28
		ctx.fillStyle = glow
		ctx.beginPath()
		ctx.arc(0, 0, f.size * 0.75 + 12 + pulse * 3, 0, TAU)
		ctx.fill()

		// 里面一圈细实线，负责「看清是哪一只」。
		// 白色实线在浅色桌面上会糊掉，所以下面再垫一圈很淡的暗色描边 ——
		// 一明一暗两条线，深色和浅色壁纸上都立得住
		ctx.globalAlpha = 0.30 + pulse * 0.20
		ctx.strokeStyle = 'rgba(20, 18, 16, 0.9)'
		ctx.lineWidth = 2.6
		ctx.beginPath()
		ctx.arc(0, 0, f.size * 0.75 + 4 + pulse * 2, 0, TAU)
		ctx.stroke()

		ctx.globalAlpha = 0.70 + pulse * 0.30
		ctx.strokeStyle = '#ffffff'
		ctx.lineWidth = 1.5
		ctx.beginPath()
		ctx.arc(0, 0, f.size * 0.75 + 4 + pulse * 2, 0, TAU)
		ctx.stroke()

		ctx.restore()
	}

	// ⚠ 坐标换算（加上罐心 / 炉心）在 magnifierTargets 里做了，这里只管画
	for (const c of magnifierTargets(world, tiers)) ring(c.fly, c.x, c.y)
}

// ====================================================================
//  渲染器
// ====================================================================

export class Renderer {
	constructor(canvas) {
		this.canvas = canvas
		this.ctx = canvas.getContext('2d')
		this.dpr = 1
		this.resize()
	}

	resize() {
		const dpr = window.devicePixelRatio || 1
		this.dpr = dpr
		const w = window.innerWidth
		const h = window.innerHeight

		this.canvas.width = Math.floor(w * dpr)
		this.canvas.height = Math.floor(h * dpr)
		this.canvas.style.width = w + 'px'
		this.canvas.style.height = h + 'px'
	}

	/**
	 * @param {import('./world.js').World} world
	 * @param {{tool:string, mouse:{x:number,y:number}, showCursor:boolean}} view
	 */
	draw(world, view) {
		const ctx = this.ctx

		// 全部按 CSS 像素坐标系来画，高分屏靠这个变换兜底
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
		ctx.clearRect(0, 0, world.w, world.h)
		ctx.lineJoin = 'round'

		// —— 从下往上叠 ——
		// 残留物贴在最底层（它们是「落在桌面上的」），
		// 然后是卵和幼虫，成虫飞在最上面，最后才是粒子和特效。
		for (const r of world.remains) {
			if (r.kind === 'stain') drawStain(ctx, r)
			else if (r.kind === 'grub') drawGrubCorpse(ctx, r)
			else drawCorpse(ctx, r)
		}

		// 蛹壳和残留物一样是「落在地上没人管的东西」，贴在底层
		for (const sh of world.shells) drawShell(ctx, sh)

		// 食物摆在「桌面上」，所以在残留物之上、幼虫之下
		for (const f of world.foods) drawFood(ctx, f)

		for (const e of world.eggs) drawEgg(ctx, e)

		for (const t of world.wipeTrail) drawWipeTrail(ctx, t)

		for (const l of world.larvae) drawLarva(ctx, l)

		// —— 玻璃罐 ——
		// 背板 → 罐里的果蝇 → 前壁。夹在中间画，果蝇才像是在玻璃里面。
		// 罐中果蝇的 x / y 是相对罐心的偏移，所以要额外传罐子自己的坐标进去。
		// 警报器是件一次性道具，买没买在整帧里是同一个答案，提到循环外读一次
		const alarmOn = world.hasShopItem('alarm')
		for (const jar of world.jars) {
			drawJarBack(ctx, jar)
			for (const f of jar.flies) drawFly(ctx, f, jar.x, jar.y)
			if (alarmOn) drawJarAlarm(ctx, jar)
			drawJarFront(ctx, jar, jar === view.dropJar)
		}

		// 烤炉和罐子同一套画法（背板 → 炉里的果蝇 → 前壁）。
		// 炉里的果蝇 x / y 同样是相对炉心的偏移，所以要把炉心传进去
		for (const oven of world.ovens) {
			drawOvenBack(ctx, oven)
			for (const f of oven.items) drawFly(ctx, f, oven.x, oven.y)
			drawOvenFront(ctx, oven, oven === view.dropOven)
		}

		// 自由果蝇画在罐子之后 —— 它们会从罐子前面飞过，这个遮挡关系是对的
		for (const f of world.flies) drawFly(ctx, f)

		// 放大镜的高亮环画在果蝇**之后**，压在身上。
		// 它是**信息叠加层**（「这几只值钱」），不是工具光标 ——
		// 所以其它工具图案都删掉之后它留了下来，见文件顶部「关于描边」
		//
		// ⚠ 位置必须在**罐子和烤炉都画完之后** —— 容器里的果蝇也算「高价值的」，
		//   光环要压在它们的身体上。提前到那两段之前的话，光环会被罐子前壁
		//   和炉子面板盖掉，看起来像「罐子里的不亮」
		if (world.hasShopItem('magnifier')) drawMagnifier(ctx, world)

		// 粒子画在最上层：工具的反馈现在全靠它们（火苗 / 灰尘 / 水雾 / 挥拍圈）
		for (const p of world.particles) drawParticle(ctx, p)

		// 飘字（烤炉卖出的 +$x）在**粒子之上**，也就是整帧的最顶层。
		//
		// ⚠ 顺序不能反。它写的是钱 —— 被火苗或者罐子盖掉一半的话，
		//   玩家看到的是「钱莫名其妙多了」。粒子少看几颗没人会发现，
		//   账目少看一个数字会
		for (const t of world.floatTexts) drawFloatText(ctx, t)
	}
}

// --------------------------------------------------------------------
//  烤串 / 烤炉 / 烤制进度
// --------------------------------------------------------------------

/**
 * 饿死的蛆留下的尸体。
 *
 * ⚠ 不能复用 drawCorpse：那是**成虫**的尸体，有翅膀有六条腿。
 * 一条蛆没有这些 —— 照搬过去会画出一只很小的苍蝇，读起来完全不对。
 *
 * 形状就一个瘪掉的长条：活着的时候是饱满的，饿死之后塌下去、变短。
 * 颜色和成虫尸体走同一条腐烂曲线，所以「越烂越难擦」那套对它是自动生效的
 */
function drawGrubCorpse(ctx, r) {
	const V = CONFIG.visual
	const rot = r.rot
	const s = r.size * (1 - rot * 0.22) // 烂掉的过程中会缩
	const smear = r.clean * 0.55 + rot * 0.3
	const alpha = 1 - r.clean * 0.72

	ctx.save()
	ctx.globalAlpha = alpha
	ctx.translate(r.x, r.y)
	ctx.rotate(r.angle)
	ctx.scale(1, 0.7) // 和活着的时候一样是扁的

	// 渗出来的一圈
	if (rot > 0.12) {
		ctx.globalAlpha = alpha * rot * 0.3
		ctx.fillStyle = V.corpseRotColor
		ctx.beginPath()
		ctx.ellipse(0, 0, s * (0.46 + smear * 0.4), s * (0.3 + smear * 0.34), 0, 0, TAU)
		ctx.fill()
		ctx.globalAlpha = alpha
	}

	// 瘪掉的身体。用两段椭圆接起来 —— 一头大一头小，像条塌下去的虫子
	ctx.fillStyle = mixHex(V.corpseColor, V.corpseRotColor, rot)
	ctx.beginPath()
	ctx.ellipse(-s * 0.1, 0, s * 0.34, s * 0.2, 0, 0, TAU)
	ctx.fill()
	ctx.beginPath()
	ctx.ellipse(s * 0.2, 0, s * 0.2, s * 0.13, 0, 0, TAU)
	ctx.fill()

	ctx.restore()
}

/** 烤炉的背板（炉膛底色）。夹在炉里的果蝇**之下**，果蝇才像在炉子里 */
function drawOvenBack(ctx, oven) {
	const O = CONFIG.roast.oven

	ctx.save()
	ctx.translate(oven.x, oven.y)
	ctx.fillStyle = O.bodyColor
	ctx.beginPath()
	ctx.roundRect(-oven.halfW, -oven.halfH, oven.w, oven.h, 8)
	ctx.fill()
	ctx.restore()
}

/**
 * 烤炉的前壁：边框、炉口横档、正在烤时的火光、容量小字
 *
 * @param {boolean} [dropHot] 拎着成虫正压在这个炉子上 —— 边框点亮加粗。
 *   和罐子那个 dropHot 一个用途：让「松手就放进去」在松手**之前**看得见
 */
function drawOvenFront(ctx, oven, dropHot = false) {
	const O = CONFIG.roast.oven

	ctx.save()
	ctx.translate(oven.x, oven.y)

	ctx.strokeStyle = dropHot ? CONFIG.visual.jarDropHot : O.rimColor
	ctx.lineWidth = dropHot ? 2.8 : 2
	ctx.beginPath()
	ctx.roundRect(-oven.halfW, -oven.halfH, oven.w, oven.h, 8)
	ctx.stroke()

	// 炉口的横档 —— 让「这是个炉子」而不是「一个方框」读得出来
	ctx.lineWidth = 1.6
	ctx.beginPath()
	ctx.moveTo(-oven.halfW + 8, -oven.halfH + 9)
	ctx.lineTo(oven.halfW - 8, -oven.halfH + 9)
	ctx.stroke()

	// 炉里还有东西在烤 → 炉膛里透出火光。
	//
	// ⚠ 火光和进度条是**两件事**：火光是「炉子在工作」的氛围，
	//   进度条是「这只还剩多少」的读数。光靠火光读不出进度 ——
	//   它只是透明度从 0.28 变到 0.63，在一台 150px 宽、还压着几只果蝇的
	//   炉子上根本看不出来
	//
	// ⚠ 从 1.21.0 起每只各自计时，所以这里的透明度取的是**炉里最靠前的那一只**
	//   的进度；进度条则**每条虫各画一条**（见下面那一段）。
	//   原来那条横贯炉膛下沿的整炉进度条删掉了 —— 现在每只进度都不一样，
	//   一条公共的槽已经表达不了任何东西
	if (oven.roasting) {
		let t = 0
		for (const f of oven.items) {
			if (f.roastLeft === null || !(f.roastTotal > 0)) continue
			t = Math.max(t, clamp(1 - f.roastLeft / f.roastTotal, 0, 1))
		}
		ctx.globalAlpha = 0.28 + t * 0.35
		const g = ctx.createRadialGradient(0, oven.halfH * 0.2, 2, 0, oven.halfH * 0.2, oven.halfW)
		g.addColorStop(0, O.glowColor)
		g.addColorStop(1, 'rgba(224, 118, 44, 0)')
		ctx.fillStyle = g
		ctx.beginPath()
		ctx.roundRect(-oven.halfW, -oven.halfH, oven.w, oven.h, 8)
		ctx.fill()
	}

	// —— 每只虫各一条小进度条，画在它自己头顶 ——
	//
	// 底槽**一直在**（哪怕进度是 0）：有槽才看得出「这只排上队了」，
	// 否则刚放进去那一下会像个没动静的空炉子
	ctx.globalAlpha = 1
	const bw = O.barWidth
	const bh = O.barHeight
	const br = bh / 2
	for (const f of oven.items) {
		if (f.roastLeft === null || !(f.roastTotal > 0)) continue
		const p = clamp(1 - f.roastLeft / f.roastTotal, 0, 1)
		const bx = f.x - bw / 2
		const by = f.y - O.barOffsetY

		ctx.fillStyle = O.barTrackColor
		ctx.beginPath()
		ctx.roundRect(bx, by, bw, bh, br)
		ctx.fill()

		// ⚠ 进度不到 1px 时不画 —— 圆角半径是 barHeight/2，宽度比它小的圆角矩形
		//   在 canvas 上会画出一个奇怪的豆子，而且每帧都在变
		const filled = bw * p
		if (filled >= 1) {
			ctx.fillStyle = O.barColor
			ctx.beginPath()
			ctx.roundRect(bx, by, filled, bh, Math.min(br, filled / 2))
			ctx.fill()
		}
	}

	// 容量小字，摆在炉子上沿之上（和罐子那行同一个位置习惯）
	if (oven.items.length > 0) {
		ctx.globalAlpha = 1
		ctx.fillStyle = CONFIG.visual.jarLabel
		ctx.font = "11px 'Microsoft YaHei UI', system-ui, sans-serif"
		ctx.textAlign = 'center'
		ctx.textBaseline = 'bottom'
		ctx.fillText(`${oven.items.length}/${oven.capacity}`, 0, -oven.halfH - 5)
	}

	ctx.restore()
}

// 这里原本有一个 drawRoastProgress()：一圈绕着目标的进度环，
// 配合「按住鼠标烤 5 秒」。两代机制之前就删掉了。
//
// ⚠ 这句注释原来还写着「工具光标那一圈火苗还在（见 drawToolCursor 的 'roast' 分支）」——
//   `drawToolCursor` 早就整个删掉了（工具图案全改粒子），那句话是死引用。
//   点火现在的视觉是**火焰粒子**：手里的火苗见 world._emitOneParticle，
//   烧着的蝇身上那一路见 world._emitBurnFx。这里没有任何要画的东西
