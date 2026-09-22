/** 通用数学 / 随机工具 */

export const TAU = Math.PI * 2

export function lerp(a, b, t) {
	return a + (b - a) * t
}

/** 平方距离。比较远近时用它，省掉一次开方 */
export function dist2(ax, ay, bx, by) {
	const dx = bx - ax
	const dy = by - ay
	return dx * dx + dy * dy
}

export function dist(ax, ay, bx, by) {
	return Math.sqrt(dist2(ax, ay, bx, by))
}

/**
 * 角度插值，走最短的那条弧。
 * 直接用 lerp 插角度会在 ±π 处突然反向转一大圈，这里把差值折回 [-π, π]。
 */
export function angleLerp(from, to, t) {
	let d = (to - from) % TAU
	if (d > Math.PI) d -= TAU
	if (d < -Math.PI) d += TAU
	return from + d * t
}

/** 数组里随机取一个 */
export function pick(arr) {
	return arr[(Math.random() * arr.length) | 0]
}

/**
 * 由种子生成稳定的伪随机数（0~1）。
 * 尸体的形状要在每一帧都长得一样，不能每帧 Math.random()，
 * 所以用固定的 seed 生成一组「随机但不变」的偏移量。
 */
export function seeded(seed, salt = 0) {
	const s = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
	return s - Math.floor(s)
}

/** 把 v 从 [a1,b1] 映射到 [a2,b2] */
export function remap(v, a1, b1, a2, b2) {
	if (b1 === a1) return a2
	return a2 + ((v - a1) / (b1 - a1)) * (b2 - a2)
}
