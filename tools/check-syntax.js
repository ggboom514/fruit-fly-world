/**
 * check-syntax.js — 把每个源文件单独解析一遍，抓语法错误。
 *
 * ## 为什么需要它
 *
 * `main.js` 里的自检是一整块**模板字符串**（从 `executeJavaScript(` 那个反引号
 * 一直包到文件后面）。模板字符串的规则是：里面**不能出现反引号，也不能出现 `${`**
 * —— 一旦出现，那块字符串提前结束，整个 main.js 直接语法错误。
 *
 * 而那个错误的表现特别误导人：
 *   · electron 报的是 `App threw an error during load` + `SyntaxError: missing )`
 *   · 自检的那个 15 秒超时**根本没机会注册**（它在 app ready 之后才跑）
 *   · 于是 `npm run selftest` **永远挂着不退出**，看起来像卡死而不是编译失败
 *
 * 这个坑已经踩过三次，每次都是在注释里顺手写了个反引号（比如想引用
 * `e.target` 这种标识符）。所以把它做成一条独立的检查：秒级出结果，
 * 而且直接指到出问题的那一行。
 *
 * 跑：`bun run check`
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

function walk(dir) {
	const out = []
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name)
		if (e.isDirectory()) out.push(...walk(p))
		else if (e.name.endsWith('.js')) out.push(p)
	}
	return out
}

const files = [
	join(ROOT, 'main.js'),
	join(ROOT, 'preload.js'),
	...walk(join(ROOT, 'renderer', 'src')),
	...walk(join(ROOT, 'tools')),
]

let bad = 0
for (const f of files) {
	const src = readFileSync(f, 'utf8')
	try {
		// 只解析、不执行。Bun 的 transpiler 在语法错误时会抛，
		// 而且带上行号和一段上下文
		new Bun.Transpiler({ loader: 'js' }).transformSync(src)
	} catch (e) {
		bad++
		const rel = f.slice(ROOT.length + 1)
		console.log(`✗ ${rel}`)
		console.log('  ' + String(e.message).split('\n').slice(0, 6).join('\n  '))
	}
}

if (bad) {
	console.log(`\n${bad} 个文件有语法错误。`)
	console.log('如果报的是 main.js，八成是自检那块模板字符串里混进了反引号或 ${ —— 见本文件顶部。')
	process.exitCode = 1
} else {
	console.log(`语法检查通过：${files.length} 个文件`)
}
