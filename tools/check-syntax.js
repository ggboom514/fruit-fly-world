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
 * 这个坑已经踩过**八次**，每次都是在注释里顺手写了个反引号（比如想引用
 * `e.target` 这种标识符）。
 *
 * ⚠ 所以这里除了「解析一遍」，还有一条**专门盯着 main.js 自检区**的检查
 *   （见下面 countStrayBackticks）：光靠解析器报错虽然也能发现，
 *   但 Bun 报的是「missing )」这种指错方向的消息，得自己往回找。
 *   直接把违规的行号打出来，一眼就到
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

/**
 * 自检那一大块模板字符串里，混进来的反引号。
 *
 * 定位方式：从模板字符串**开引号那一行**开始，到 `})()` 结束，
 * 中间除了最外层那一对，**不允许再有任何反引号**（也不允许 `${`）。
 *
 * ⚠ 起点认的是 `` `(async () => { ``，**不是** `executeJavaScript(` ——
 *   后者在 main.js 里不止一处（自检开始前还有一次给渲染进程递变量的调用），
 *   认它的话区间会从一个不相关的行开始，把模板开头那个合法的反引号
 *   当成违规报出来
 *
 * ⚠ 为什么不用「数一数总共几个」那种土办法：main.js 里**别处也有合法的**
 *   反引号（`console.error` 那一句、结尾拼摘要那一串），数量对不上只会误报。
 *   掐区间才准。
 *
 * @returns {{line:number, text:string}[]} 违规的行
 */
function countStrayBackticks(src) {
	const lines = src.split('\n')
	const start = lines.findIndex((l) => l.includes('`(async () => {'))
	if (start < 0) return []
	const end = lines.findIndex((l, i) => i > start && l.trim() === '})()`)')
	if (end < 0) return []

	const out = []
	for (let i = start + 1; i < end; i++) {
		// 模板字符串里的 ${ 会在**外层**求值，同样会把这段代码搞坏
		if (lines[i].includes('`') || lines[i].includes('${')) {
			out.push({ line: i + 1, text: lines[i].trim() })
		}
	}
	return out
}

let bad = 0
for (const f of files) {
	const src = readFileSync(f, 'utf8')
	const rel = f.slice(ROOT.length + 1)

	// 先单独查自检区 —— 它给出的行号比解析器的报错准得多
	if (f.endsWith('main.js')) {
		const stray = countStrayBackticks(src)
		if (stray.length) {
			bad++
			console.log(`✗ ${rel}`)
			console.log('  自检那块模板字符串里混进了反引号或 ${（第 ' + stray.length + ' 处）：')
			for (const s of stray) console.log('    line ' + s.line + ': ' + s.text)
			console.log('  把那些反引号去掉，写成普通文字即可。')
			continue
		}
	}

	try {
		// 只解析、不执行。Bun 的 transpiler 在语法错误时会抛，
		// 而且带上行号和一段上下文
		new Bun.Transpiler({ loader: 'js' }).transformSync(src)
	} catch (e) {
		bad++
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
