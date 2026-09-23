/**
 * tools/make-manifest.js — 生成一份「版本清单」，传上网盘/静态托管
 *
 *   bun run manifest -- "https://你的下载页" "这一版改了什么"
 *
 * 两个参数都是可选的：
 *   · 不写地址 → 清单里就没有 `url` 那一行，游戏会退回 config 里的
 *     `update.downloadPage`（那条兜底路）
 *   · 不写说明 → 就没有 `note`，设置卡上只显示「有新版本 1.28.0」
 *
 * 产物写在**仓库根目录**的 `version.json`，这个文件是要**提交进 git** 的：
 * 游戏查的那份清单，走的就是 GitHub 的 raw 链接
 * （`raw.githubusercontent.com/<用户名>/<仓库>/main/version.json`），
 * 而 raw 只认得**提交进仓库**的文件。
 *
 * ⚠ 所以它**不能**放 `dist/` —— 那一整个目录都在 `.gitignore` 里。
 *
 * ## 为什么要有这个小工具
 *
 * 清单里的 `version` **必须和 package.json 里的一模一样**。手写的话迟早
 * 会出现「package.json 升到 1.29.0，清单忘了改」—— 而症状特别隐蔽：
 * 游戏老老实实地说「已经是最新的」，作者还以为更新检查坏了。
 * 从 package.json 读就不会对不上。
 *
 * ## 清单里到底该放什么
 *
 * ```json
 * {
 *   "version": "1.28.0",
 *   "url": "https://夸克分享页的地址",
 *   "note": "这一版改了什么（可选，一句话）"
 * }
 * ```
 *
 * ⚠ `url` 想直接填夸克分享页的话，那个链接**必须是 https 直链**。
 *   夸克的分享页是给人看的网页（要过验证码、要点「保存到我的网盘」），
 *   程序抓不到也没关系 —— 这个 url 只是**点「去下载」时用浏览器打开**的，
 *   不会被程序抓取。真正被程序抓取的是这份 `version.json` 本身，
 *   它得放在一个能直接 GET 到 JSON 的地方。
 *
 * 详见 README 的「发布新版本」一节。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// 参数里的引号是 PowerShell / bash 都要的处理，这里只管把空串滤掉
const args = process.argv.slice(2).filter((a) => a !== '--' && a.trim() !== '')
const [url = '', note = ''] = args

const manifest = { version: pkg.version }
if (url) manifest.url = url
if (note) manifest.note = note

const out = join(ROOT, 'version.json')
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log('版本清单已写出：' + out)
console.log(JSON.stringify(manifest, null, 2))
console.log('')
console.log('接下来：')
console.log('  1. git add version.json && git commit && git push')
console.log('  2. 催一下 jsDelivr 的缓存（它对分支引用有 12 小时缓存，不催的话')
console.log('     玩家最坏要等半天才收到「有新版本」）：')
console.log('     https://purge.jsdelivr.net/gh/ggboom514/fruit-fly-world@main/version.json')
console.log('  3. 浏览器打开下面这个地址，看到白底黑字的 JSON 才算数：')
console.log('     https://cdn.jsdelivr.net/gh/ggboom514/fruit-fly-world@main/version.json')
if (!url) {
	console.log('')
	console.log('⚠ 这次没给下载地址 —— 游戏会退回 config 里的 update.downloadPage。')
	console.log('   两个都没配的话，「去下载」那颗按钮不会出现（但版本提示照常）。')
}
