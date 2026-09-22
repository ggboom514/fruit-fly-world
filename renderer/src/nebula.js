/**
 * nebula.js — 星云贴图：加载 + 「世界锚定」的分块 pattern
 *
 * 这是项目里**第一个** JS 侧加载的图像资源。在那之前只有 index.html 里
 * 那个 `<img class="donate-qr">`，那是浏览器自己加载的、失败了也看不见。
 * 自己加载就得自己负责两件事：**没加载好时不能画坏**，以及**能自检**。
 *
 * ---------------------------------------------------------------- 世界锚定
 *
 * 贴图钉在**屏幕坐标系**上，不跟着画的东西走。一只星云果蝇飞过去，
 * 身体像一扇窗，窗外是同一片星云 —— 移动时透出来的是星云的不同部分。
 *
 * 机制本身在 render.js 的 `fillWorldTexture` 里（路径在**构建时**就被 CTM
 * 烘死、pattern 受**绘制时**的 CTM 影响）。这里只负责「把一整块画布大小的图
 * 预先缩好、缓存成一个 pattern」，也就是把「接缝」和「缩放」两件事
 * 挡在绘制路径之外。
 *
 * -------------------------------------------------------------- 失败的样子
 *
 * 这里**永远不抛**。`nebulaPattern()` 拿不到图就返回 null，调用方跳过那一层：
 *
 *   · 星空苹果 → 一块紫果肉（配色本来就在 CONFIG.visual.food.star 里）
 *   · 星云果蝇 → 一只普通果蝇
 *   · 解锁那一下的星尘 → 还剩一圈紫色渐晕（见 style.css 里 .starfield 的第二层）
 *
 * 三者都不像坏了。**绝不能做成「贴图没来就画不出东西」** ——
 * 一张美术资源不该让整个生态消失。
 */

/**
 * ⚠ 用 `import.meta.url` 拼绝对路径，**不要**写 './assets/...'。
 *   相对路径的基准是**页面**（renderer/index.html），而这里是 src/ 下的模块，
 *   两者不是一回事 —— 将来页面挪个位置就静默 404。
 *   404 的表现和二维码那条一模一样：不报错、不抛，只是永远不 onload。
 */
const SRC = new URL('../assets/star-nebula.png', import.meta.url).href

let img = null
let ready = false
let failed = false

/**
 * ctx → { key, pattern }。
 *
 * ⚠ 用 WeakMap 而不是模块级变量：自检会**临时换掉 renderer.ctx** 去离屏画布上
 *   做像素探针（见 main.js 里那段），缓存挂到模块变量上的话，
 *   换回来的那一帧就画到别的画布上去了
 */
const CACHE = new WeakMap()

/**
 * 开始加载。**可以重复调用**，只有第一次真的建 Image。
 *
 * @param {number} [timeoutMs] 兜底超时。图没来也必须让游戏开跑 ——
 *   卡在加载上比没有贴图糟得多
 * @returns {Promise<boolean>} 拿到了没有（失败和超时都返回 false，不抛）
 */
export function ensureNebula(timeoutMs = 3000) {
	if (!img) {
		img = new Image()
		img.onload = () => {
			ready = img.naturalWidth > 0
			if (!ready) failed = true
		}
		img.onerror = () => {
			failed = true
			console.error('[nebula] 星云贴图加载失败:', SRC)
		}
		img.src = SRC
	}
	if (ready || failed) return Promise.resolve(ready)

	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(false), timeoutMs)
		const done = () => {
			clearTimeout(t)
			resolve(ready)
		}
		img.addEventListener('load', done, { once: true })
		img.addEventListener('error', done, { once: true })
	})
}

/**
 * 只读状态。**给自检用** —— 二维码那条断言量的就是同一组东西
 * （`qr.complete && qr.naturalWidth !== 0`），这里换成 Image 的等价物。
 *
 * 尺寸也是契约：分块的 cover 缩放按原图尺寸算，换成一张小图会被整套拉成一片糊。
 */
export function nebulaInfo() {
	return {
		ready,
		failed,
		src: SRC,
		w: img ? img.naturalWidth : 0,
		h: img ? img.naturalHeight : 0,
	}
}

/**
 * 取这块画布上的星云 pattern。**没就绪返回 null**，调用方直接跳过那一层。
 *
 * 分块（tile）按目标画布的**设备像素**尺寸现造，内容是把星云按 cover 缩放
 * 铺满它。于是 `repeat` 在可视区里永远绕不回第二块 —— 接缝问题从根上没有了，
 * 也不需要把一张 1686×766 的图修成可无缝平铺的。
 *
 * ⚠ cover 而不是 contain：contain 会在两侧留出**空白带**，而那一条上没有星云，
 *   画上去就是一块死色，比接缝还显眼。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @returns {CanvasPattern|null}
 */
export function nebulaPattern(ctx) {
	if (!ready || !img || !img.naturalWidth || !ctx || !ctx.canvas) return null

	const w = Math.max(1, Math.round(ctx.canvas.width))
	const h = Math.max(1, Math.round(ctx.canvas.height))
	const key = w + 'x' + h

	const hit = CACHE.get(ctx)
	if (hit && hit.key === key) return hit.pattern

	const tile = document.createElement('canvas')
	tile.width = w
	tile.height = h
	const t = tile.getContext('2d')

	const k = Math.max(w / img.naturalWidth, h / img.naturalHeight)
	const dw = img.naturalWidth * k
	const dh = img.naturalHeight * k
	t.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)

	// ⚠ 图没解码好时 createPattern 返回 null（而不是抛），照样要兜住
	const pattern = ctx.createPattern(tile, 'repeat')
	CACHE.set(ctx, { key, pattern })
	return pattern
}
