# 调参速查 —— 想改什么，改哪个文件

**一句话：想改数值，先看 `renderer/src/config.js`。** 这个项目几乎所有能调的东西都塞在那一个文件里，按生态分节（成虫 / 步行 / 交配 / 卵 / 蛹 / 幼虫 / 食物 / 玻璃罐 / 工具 / 经济 / 世界 / 突变 / 表现层）。

> **怎么找字段**：下面每一行只给**字段名**，不写行号 —— 那不是偷懒，
> 行号每改一次代码就全烂一遍（这份文档初版写的行号在两次改动之后就全部对不上了，
> 而且错得很安静：照着跳过去会落到另一个字段上）。直接在编辑器里
> 搜字段名（`Ctrl+F` 搜 `swatRadius` 这种）永远准，而且一秒就到。

改完**重启应用**生效。开发时是 `bun run start`。

---

## ⚠ 先记住两件事

### 1. 时间是**毫秒**，但源码里用 `SEC` / `MIN` 拼出来

```js
lifespanMin: 16 * MIN,      // ✅ 照抄这种写法
lifespanMin: 960000,        // ❌ 别写裸数字，半年后没人看得懂
```

`SEC` = 1000，`MIN` = 60 * SEC，定义在 `config.js` 顶部（搜 `export const SEC`）。

### 2. 尺寸是**像素**（CSS 像素，和高分屏无关）

---

## 生态节奏

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 成虫寿命 | `config.js` | `adult.lifespanMin` / `lifespanMax` | 16 ~ 25 分钟 |
| 羽化后多久能交配 | `config.js` | `adult.matureAge` | 20 秒 |
| **交配冷却（种群总闸）** | `config.js` | `mating.cooldown` | 90 秒 |
| 一次产几颗卵 | `config.js` | `mating.eggsMin` / `eggsMax` | 2 ~ 10 |
| 卵多久孵化 | `config.js` | `egg.hatchMin` / `hatchMax` | 2 ~ 6 分钟 |
| 一窝卵的孵化时间差 | `config.js` | `egg.clutchJitter` | 8 秒 |
| 幼虫多久化蛹 / 羽化 | `config.js` | `larva.pupateAt` / `emergeAt` | 20 / 25 分钟 |
| 幼虫多久吃不到就饿死 | `config.js` | `larva.starveMin` / `starveMax` | 10 ~ 18 分钟 |
| 几成幼虫是「外圈微透」 | `config.js` | `larva.translucentChance` | 0.3 |
| 幼虫集群 | `config.js` | `swarm.enabled` / `idleMin` / `idleMax`… | 开 / 30 ~ 90 秒一次 |

> `mating.cooldown` 是**最容易把种群搞崩**的一个数：它一变短，果蝇数量是指数增长的。注释里写着调到 45 秒时 4 小时能产 19584 枚卵。

## 场上最多有多少东西

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 成虫上限 | `config.js` | `world.maxAdults` | 40 |
| 幼虫上限 | `config.js` | `world.maxLarvae` | 45 |
| 卵上限 | `config.js` | `world.maxEggs` | 40 |
| 开局几只 | `config.js` | `world.initialFemales` / `Males` / `Larvae` | 2 雌 2 雄 0 幼虫 |
| 一次「投蝇」补几只 | `config.js` | `world.spawnBatch` | 2 |
| 烦人模式倍率 | `config.js` | `world.annoyingMul` | ×50 |
| 烦人模式硬上限 | `config.js` | `world.annoyingTotalCap` | 800 |

## 飞行 / 爬行手感

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 飞多快 | `config.js` | `adult.speedMin` / `speedMax` | 300 ~ 1700 px/s |
| 多久换一次飞行意图 | `config.js` | `adult.dartIntervalMin` / `Max` | 0.08 ~ 0.45 秒 |
| 原地悬停的概率 | `config.js` | `adult.hoverChance` | 0.2 |
| 转向有多干脆 | `config.js` | `adult.turnResponse` | 18（越大越干脆） |
| 爬行速度 | `config.js` | `walk.speed` | 58 px/s |
| 走一阵停一下的节奏 | `config.js` | `walk.boutMin` / `boutMax` / `pauseChance` | 0.7~2.6 秒 / 0.45 |
| 飞完落地走的概率 | `config.js` | `behavior.landChance` | 0.45 |
| …已经飞到果子跟前时落地的概率 | `config.js` | `behavior.landChanceNearFood` | 0.7 |
| **离果子多近才算「跟前」** | `config.js` | `behavior.foodLandRadius` | 90 px |

> ⚠ `foodLandRadius` 决定的是**在哪儿落地**，不是要不要落地。
> 调大到接近 `food.flyScentRadius`（600px）的话，果蝇会在刚闻到味道的那一瞬间
> 就落地 —— 而那是离果子最远的地方，接下来只能**一路爬过去**。
> 实测调到 600px 时落点中位 593px、落地后还要爬 10 秒；
> 90px 时落点中位 83px、爬 1.4 秒就吃上了。
> `bun run sim` 里有一条断言盯着这个（判据是「落地后还要爬几秒」）。

## 食物

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 尺寸范围 | `config.js` | `food.sizeMin` / `sizeMax` | 24 / 200 px |
| 「正常尺寸」的上界 | `config.js` | `food.sizeNormalMax` | 30 px |
| 正常尺寸占几成 | `config.js` | `food.sizeNormalChance` | 0.95（剩下 5% 是巨型） |
| 巨型里越大越少 | `config.js` | `food.sizeBias` | 3（只管巨型那一段） |
| 最耐啃的果子几倍营养 | `config.js` | `food.durabilityMax` | 20× |
| 一只幼虫独吞要多久 | `config.js` | `food.larvaMealTime` | 60 分钟 |
| 一份能同时供几只幼虫 | `config.js` | `food.eatersPerSize` | size × 2 |
| 场上最多几份 | `config.js` | `food.maxCount` | 30 |
| 自动掉食物 | `config.js` | `food.autoSpawn` / `autoIntervalMin` / `Max` | 关 / 8 ~ 20 分钟 |
| 果子烂透要多久 | `config.js` | `food.rotTime` | 9 分钟 |
| 啃光后留几块污渍 | `config.js` | `food.huskStains` | 3 |
| 单块污渍最大尺寸 | `config.js` | `food.stainMaxSize` | 34 px |
| 金苹果快多少 | `config.js` | `food.growthBonus` | 苹果 1× / 金苹果 1.5× |
| **投放区在哪** | `config.js` | `food.zone` 的 `x` / `y` / `w` / `h` | 左上角，屏幕的 21% × 39%（都是比例，不是像素） |
| 想看见投放区边框 | `config.js` | `food.zone.show` 改 `true` | 关 |

> `food.zone` 的四个数都是**屏幕比例**（0~1），换分辨率不会跑偏。调完想确认位置，把 `show` 打开会在屏幕上画出虚线框。

## 工具手感

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 苍蝇拍杀伤半径 | `config.js` | `tools.swatRadius` | 28 px |
| 拍面相对指针的倾角 | `config.js` | `tools.swatAngle` | -0.6 rad（左上方） |
| 两次挥拍的最小间隔 | `config.js` | `tools.swatCooldown` | 0.22 秒 |
| 一拍是不是全拍死 | `config.js` | `tools.swatKillAll` | `true`（成虫/幼虫/卵都死） |
| 挥手惊飞的范围 | `config.js` | `tools.startleRadius` | 190 px |
| 多快算「全速挥手」 | `config.js` | `tools.startleFullSpeed` | 1700 px/s |
| 最慌时快几倍 | `config.js` | `tools.startleMaxMul` | 3.5× |
| 惊飞后多久恢复 | `config.js` | `tools.startleDecay` | 0.3 秒 |
| 捕虫网半径 | `config.js` | `tools.netRadius` | 62 px |
| 「查看」点击 / 移开的半径 | `config.js` / `:887` | `tools.hoverRadius` / `inspectReleaseRadius` | 16 / 28 px |
| 手套抓虫的半径 | `config.js` | `tools.grabFlyRadius` | 26 px |
| 石化蝇拖起来有多沉 | `config.js` | `tools.stoneDragFollow` | 0.12（越小越沉） |
| 喷水枪长度范围 / 一次滚多少 | `config.js` | `tools.squirtLenMin` / `Max` / `Step` | 100 / 400 / 20 px |
| 喷水枪一次转多少度 | `config.js` | `tools.squirtTurnStep` | `Math.PI / 12`（15°） |
| 抹布擦除半径 | `config.js` | `tools.wipeRadius` | 16 px |

### 扫帚（免费工具，不进商店）

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 半径范围 / 滚轮一格多大 | `config.js` | `tools.broom.radiusMin` / `Max` / `Step` | 30 / 200 / 20 px |
| 出场时多大 | `config.js` | `tools.broom.radiusStart` | 90 px |
| 推得多快（圆心处） | `config.js` | `tools.broom.pushSpeed` | 260 px/s |
| 推力的硬上限 | `config.js` | `tools.broom.pushMaxSpeed` | 320 px/s |
| 松手后多久停 | `config.js` | `tools.broom.pushDrag` | 6（越大停得越快） |
| 被推时朝外转多少 | `config.js` | `tools.broom.turnMix` | 0.55 |

> ⚠ `pushSpeed` 是**速度本身**，不是「每次调用往上加」。早先写成累加，
> 结果是手感随帧率变（60Hz 和 144Hz 推得不一样快）、而且停手之后幼虫会带着
> 攒了一秒的速度继续飞出去。**别改回累加**。
>
> ⚠ 扫帚**照常惊飞成虫**（惊扰的白名单里只有观察和查看）。所以在成虫旁边扫幼虫，
> 成虫会被吓走 —— 这是已知的取舍，不是 bug。

### 工具粒子特效（`tools.fx`）

工具图案和范围圈**全部删掉了**，现在「手里拿着什么、作用范围多大」只靠粒子表达。
所以这一节不是装饰，动之前想清楚。

| 想改什么 | 字段 | 现在 |
| --- | --- | --- |
| 打火机**手里**多密 / 火苗多长 | `fx.flameRate` / `flameLife` | 34 颗每秒 / 0.34 秒 |
| 喷火枪（更密更长） | `fx.flameRateBig` / `flameLifeBig` | 62 颗每秒 / 0.5 秒 |
| 扫帚空转 / 真扫 | `fx.broomIdleRate` / `broomRate` / `broomLife` | 5 / 26 颗每秒 / 0.6 秒 |
| 喷水枪空转 / 真喷 | `fx.squirtIdleRate` / `squirtRate` / `squirtLife` | 12 / 78 颗每秒 / 0.45 秒 |
| 抹布水珠 | `fx.clothRate` / `clothLife` | 26 颗每秒 / 0.5 秒 |
| 挥拍 / 撒网勾范围那一圈亮多久 | `fx.ringLife` | 0.34 秒 |
| 单帧最多补发几颗 | `fx.maxPerTick` | 4 |

> ⚠ **两套单位**：`Rate` 是**每秒几颗**，`Life` 是**毫秒**（源码里写成 `0.34 * SEC`）。
> `Life` 要是直接写 `0.34`，粒子会在第一帧就死掉（`0.34 - 16.7 < 0`）——
> 表现是「举着打火机一颗粒子都没有」，**不报错**。sim 里有一条断言专门盯着这个。
>
> ⚠ 「空转那一档」（`IdleRate`）**不能删**：喷水枪的长度、扫帚的半径都是
> **松开鼠标时**用滚轮调的。只在按下时发粒子的话，滚轮会变成「按了没反应」。

## 玻璃罐 / 烤制

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 罐子尺寸 | `config.js` | `jar.width` / `height` | 194 × 246 px |
| 一个罐子装几只 | `config.js` | `jar.capacity` | 8 |
| 最多摆几个罐子 | `config.js` | `jar.maxCount` | 4 |
| 罐中寿命几倍 | `config.js` | `jar.lifespanBonus` | 2× |
| 罐里的虫能不能交配 | `config.js` | `jar.mateInside` | `true`（改成 `false` 就退回「完全隔离」） |
| 卵产在罐外多大范围 | `config.js` | `jar.laySpreadX` / `laySpreadY` | 0.55 / 0.18（罐子半宽 / 半高的倍数） |
| 罐中飞得多快 | `config.js` | `jar.flySpeedMin` / `Max` | 60 ~ 150 px/s |
| 尸体多久开始掉价 / 掉多久 | `config.js` | `roast.decayStartMs` / `decaySpanMs` | 5 分钟后开始，15 分钟掉到底 |
| 掉到几成 | `config.js` | `roast.decayTo` | 0.1（剩一成） |
| 尸体 / 污渍多久烂透 | `config.js` | `remains.rotTime` / `rotTimeStain` | 6 / 4 分钟 |
| 擦新鲜 / 擦烂的要多用力 | `config.js` | `wipeScrubFresh` / `wipeScrubRotten` | 70 / 300 px |

## 点火（打火机 / 喷火枪）

⚠ **从 1.18.0 起，这两把烧的是活着的成虫**，不再是地上的尸体。
碰一下就点着 → 带着火焰惊慌乱飞 → 烧满时长后**自动按倍率卖掉**，不留尸体。

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 打火机烧多久 / 倍率 / 价格 | `config.js` | `market.roastChain[0].burnMs` / `.mul` / `.price` | 5 秒 / ×1.2 / $3 |
| 喷火枪同上 | `config.js` | `market.roastChain[1]` 同名三个字段 | 3 秒 / ×1.5 / 再 $8 |
| 判定「指针底下有活蝇」的半径 | `config.js` | `market.roastChain[].pickRadius` | 打火机 26 px / **喷火枪 60 px** |
| 烧着的蝇有多慌 | `config.js` | `roast.burnPanicMul` | 2.4（乘在挥手受惊之上） |

> ⚠ `burnMs` 是**烧多久**（不是「按住多久」）。按住只是「一路扫过去」，
> 每只只吃一次倍率由 `world.ignite` 里的判重保证 —— 反复蹭同一只**不会**刷新倒计时。
>
> ⚠ `pickRadius` 是**按档**的，不是共用一个：喷火枪「有一小圈范围」就是靠
> 它比打火机大一圈表达的。读数走 `world.burnRadiusFor(tool)`，
> **按手里那把查、不是按等级**（买到喷火枪之后回头拿打火机，半径要跟着手里那把走）。
>
> ⚠ 两把枪**都是单目标**（只点着半径内最近的那一只），不是「圈里全烧」。
> 想改成范围攻击：`ui._useTool` 里那一行换成遍历 `world.flies` 收集再逐个
> `ignite` —— 但那样喷火枪会变成清屏工具，倍率得一起重调。
>
> ⚠ 想加第三档点火器：`roastChain` 里加一条 + `index.html` 里加一颗
> `data-tool` 按钮 + `ui.refreshToolButtons` 里补一对映射。三处都要，漏了不报错。

## 烤炉

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 价格（在**投放 → 其他**里买） | `config.js` | `market.prices.oven` | $5 |
| 尺寸 / 装几只 / 最多几个 | `config.js` | `roast.oven.width` / `height` / `capacity` / `maxCount` | 150×108 / 5 只 / 3 个 |
| **每只**烤多久 / 倍率 | `config.js` | `roast.oven.roastMs` / `mul` | 8 秒 / ×1.8 |
| 进度条尺寸 / 画在虫上方多高 | `config.js` | `roast.oven.barWidth` / `barHeight` / `barOffsetY` | 20×3 px / 往上 7 px |
| 进度条颜色 | `config.js` | `roast.oven.barColor` / `barTrackColor` | 橙 `#ffb454` / 半黑底槽 |
| 同一帧出锅的多个数字错开多久 | `config.js` | `roast.oven.float.delayStep` | 110 ms（第 n 只延后 n× 这个） |

> ⚠ 从 1.21.0 起炉子是**每只各自计时、各自到账**：放进去就开始烤，
> 谁先烤满谁先冒钱走人，**不用等装满**。
> 所以 `roastMs` 是**单只**的时长，不是整炉的；`delayStep` 只在
> 「同一帧里恰好有好几只同时烤满」时才起作用（连着拖进去的、或者存档读回来的）。
>
> ⚠ 每只的状态挂在**虫身上**（`Fly.roastLeft` / `roastTotal`），不在炉子上 ——
> 炉子级的 `roastTimer` / `roastTotal` 已经删了。`roastLeft` 用 **null** 表示
> 「没在烤」，**不是 0**：0 是「这一帧刚好烤满、该结账了」那个瞬间的值，
> 两者混起来的话结算那一帧分不出「刚烤好的」和「压根没进过炉子的」。

## 卖出金额的飘字（炉子 / 烧蝇共用）

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 飘多久 / 飘多快 | `config.js` | `floatText.life` / `rise` | 1.5 秒 / 34 px/s |
| 颜色 / 字号 / 描边 | `config.js` | `floatText.color` / `font` / `stroke` | 金色 `#ffd76a` / 粗体 12px |
| 屏幕上最多同时挂几个 | `config.js` | `floatText.maxCount` | 60 |

> ⚠ 这几项**故意放在顶层**，不在 `roast.oven` 里 —— 炉子和点火两条路都在用，
> 挂在炉子下面的话，改炉子飘字颜色会莫名其妙改到烧蝇。

> ⚠ **点火器和烤炉是两条不同的路**，改的时候别串了：
>
> | | 打火机 / 喷火枪 | 烤炉 |
> | --- | --- | --- |
> | 输入 | 场上**活着的成虫**（碰到就点着） | 手套抓 **5 只活蝇**塞进去 |
> | 操作 | 拿工具**扫过去**，一只一只点 | 装满**自动**开烤，等进度条 |
> | 产出 | 每只**单独**结账，一边烧一边冒钱 | **整炉一起**结账 |
> | 掉价 | 不吃 —— 没有等待期 | 不吃 |
>
> ⚠ **地上的尸体两条路都不认**。它现在只能按原价卖掉、或者拿抹布擦掉。
> 那套「拿打火机烤尸体、再拖去出售区」的玩法在 1.18.0 整个取消了 ——
> `Remains` 上的 `roasted` / `roastMul` 两个字段也一起删了。

## 钱和商品

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 出生体重 | `config.js` | `market.birthWeight` | 0.2 mg |
| **售价公式** | `config.js` | `market.pricePerMg` | 0.01（每 0.1mg 得 $0.001） |
| 体格三档（轻盈/超重/巨兽） | `config.js` | `market.rarity[]` | 出现率 / 满成长体重 / 速度倍率 |
| 价值六档（白蓝紫金红淡彩） | `config.js` | `market.valueTiers[]` | 价格上界 / 颜色 / 有没有流动特效 |
| **商店里卖什么** | `config.js` | `market.shop[]` | 名字 / 价格 / 说明 |
| 商店怎么分组 | `config.js` | `market.shopCats` | 分组 **和渲染顺序**的唯一来源 |
| 投放弹窗怎么分组 | `config.js` | `market.feedCats` | 同上 |
| 烤制链每级价格 | `config.js` | `market.roastChain[]` | — |
| 养蝇人两级价格 | `config.js` | `market.keeperChain[]` | $2 → $5 |
| 养蝇人配置项 | `config.js` | `market.keeperOptions` | 投什么 / 投几个 / 卖哪档 / 多久查一次 |
| 投放单价 | `config.js` | `market.prices` | 苹果 $0.001 / 金苹果 $0.01 / 星空苹果 $1 / 投蝇 $0.005 |
| 罐子要点几下才解锁星空苹果 | `config.js` | `easterEgg.tapsToUnlock` | 10 |
| 放大镜勾哪几档才高光 | `config.js` | `market.magnifier.tiers` | `rare` / `epic` / `legendary` / `mythic` |

> 放大镜那一项是**多选**：六档价值档各一颗按钮，勾哪几档就亮哪几档，一档不勾也允许
> （等于关掉高光）。存档里存的是这些 id，所以**别改 `valueTiers` 的 id**。
>
> ⚠ `legendary` / `mythic` 目前**实际够不着**（全场售价天花板约 $429，落在这两档之外），
> 所以六颗按钮里有俩是死的。这是刻意的 —— 和养蝇人「卖哪档」一样保留完整六档，
> 免得以后数值涨上去时忘了还有这两档。

> ⚠ **加了商品一定要去 `shopCats` 里归类**，不然它不会出现在商店里 —— 而且不报错。sim 里有一条断言专门盯着「每件商品恰好出现在一个分类里」。

## 突变

| 想改什么 | 文件 | 字段 | 现在 |
| --- | --- | --- | --- |
| 各突变的**新发**概率和效果 | `config.js` | `mutation.types[]` | 疯狂 2.9% / 点石成金 3% / 石化 2% / 结晶 1.1% / 星云 **0** |
| 遗传率 | `config.js` | `mutation.inheritChance` | 0.2（单方这一路 20%、双方 36%） |
| 幼虫吃星空苹果长出星云的概率 | `config.js` | `mutation.nebulaFromStar` | 0.1 |
| 星云的价值 / 速度倍率 | `config.js` | `mutation.types[]` 里 nebula 那条 | `valueMul: 1.2` / `speedMul: 2` |

> 「新发」是每颗卵自己骰的、和父母无关；「遗传」是父母带了的往下一代传。
> **子代最终带上某个突变的概率是两条路取并集** —— 所以实测是单方约 22%、
> 双方约 38%，比上面那两个数各高一点（高出来的是新发那一路）。
>
> ⚠ **星云是这条规律唯一的例外**：它的 `chance` 是 **0**（不在新发抽奖池里），
> 所以实测正好是干净的 20% / 36%。它唯一的来源是**幼虫吃星空苹果**，
> 每只幼虫一辈子只骰一次（见 `world._updateFeeding`）。
> 拿到之后**照常能遗传**，和别的突变没区别。
>
> ⚠ 别顺手把 `chance: 0` 删掉 —— 删了是 `undefined < x` 恒为 false，照样能跑，
> 但下一个人得自己琢磨「这是本意还是巧合」。sim 里有两条断言钉着它。

> 每个突变的效果就是它自己那个对象的几个字段：`valueMul`（售价倍率）、`weightMul`（体重倍率）、`lifespanMul`（寿命倍率）、`adultDamageMin/Max`（疯狂咬人）…… 改数值不用动 `mutations.js`。

## 颜色

| 想改什么 | 文件 | 位置 |
| --- | --- | --- |
| 果蝇身体 / 复眼 / 翅膀 / 腿 | `config.js` 起 | `visual.bodyColor*` / `eyeColor*` / `wing*` / `legColor` |
| 卵 / 幼虫 / 蛹 / 空壳 / 尸体 / 污渍 | `config.js` 起 | `eggColor*` / `larvaColor` / `pupaColor*` / `shellColor` / `corpseColor` / `stainColor` |
| 食物 / 霉斑 | `config.js` 起 | `visual.food` / `moldColor` / `foodRotColor` |
| 金苹果光晕 / 警报器橙红 | `config.js` 起 | `foodGoldGlow` / `alarmOrange` / `alarmRed` |
| 玻璃罐 | `config.js` 起 | `jarGlass` / `jarRim` / `jarCap` / `jarHighlight` |
| 面板底色 / 文字 / 金色 | `style.css` 和 `style.css` | `--bg` / `--text` / `--muted` / `--gold` / `--gold-hi` |

> 颜色几乎全是 `rgba(...)` —— **最后的 alpha 就是这个部件有多透**。想把翅膀画实一点，调 `wingColor` 那个 0.24。

---

## ⚠ 这几个**别乱改**

| 字段 | 为什么 |
| --- | --- |
| `market.rarity[].id` | 存档里存的是这些 id。名字（`name`）随便改，id 改了老存档会对不上（不会崩，但设置会丢） |
| `market.valueTiers[].id` | 同上 —— 养蝇人「卖哪档」存的就是它 |
| `mutation.types[].id` | 基因名，存档里存着 |
| `food.types` | 只有 `apple` 一项，**金苹果和星空苹果是刻意不在里面的**（它们走另一条路，只能花钱买）。往里加会同时影响投放区和价格表，还会**白送彩蛋** —— sim 里有两条断言分别钉着这两样 |
| `renderer/assets/star-nebula.png` | 星云贴图，**打包的硬依赖**（`package.json` 的 `files` 里那个 `renderer/**/*` 覆盖到了）。谁要是把 glob 收窄了，失败形态是**静默 404**：不报错、不抛，只是星空苹果变成一块纯紫果肉 —— 看着像美术选择 |
| `main.js` 的自检 | 那一大段住在模板字符串里，**里面不能出现反引号或 `${`** —— 混进去会让整个文件加载失败、自检静默挂住，屏幕上只开出一个空窗口 |
| `tools.fx` 里的 `Life` 系列 | 单位是**毫秒**。写成秒（`0.34`）不会报错，只会让那个特效整个看不见 |
| `body.tool-active` 这个 CSS 类 | **不要加回来**。它配的 CSS 是 `cursor: none`，而自绘的工具光标已经全删了 —— 加回来会让拿着工具时屏幕上**一个指针都没有**。自检里有一条断言专门盯着这个 |

## config.js 底部还有几个导出的东西

| 名字 | 是什么 |
| --- | --- |
| `SEC` / `MIN` | 时间单位常量，写时长就靠它俩 |
| `FOOD_DRAW_RADIUS` | 食物轮廓的**最大半径 ÷ size**（= 0.61）。`world.js` 和 `render.js` 共用，改苹果形状时要跟着改 |
| `clamp` / `rand` / `randInt` | 小工具函数 |

---

## 改完怎么验证

```bash
bun run check      # 秒级，专抓语法错误（尤其是 main.js 那个模板字符串）
bun run sim        # 不开窗口，把生态跑一遍 + 一堆数值断言
bun run selftest   # 真的开一个窗口把 UI 跑一遍；读写的是 save.selftest.json，不碰你的真存档
```

`sim` 里有一批**写死的期望值**（「六档价值档齐全」「耐用性 1~20 倍」「商店每件商品恰好属于一个分类」…）。改配置改到把断言弄红是**正常的** —— 那说明你改的东西确实影响了行为。按报出来的那句话去看是哪里对不上，别直接把断言删了。

## 不是数值的东西，分别在哪个文件

| 想改什么 | 文件 |
| --- | --- |
| 面板上的文字、按钮、弹窗结构 | `renderer/index.html` |
| 颜色、间距、圆角、字体 | `renderer/style.css` |
| 工具怎么响应鼠标键盘、面板开关逻辑 | `renderer/src/ui.js` |
| 东西画出来长什么样 | `renderer/src/render.js` |
| 生态规则（谁吃谁、什么时候死、怎么产卵） | `renderer/src/world.js` |
| 单只果蝇 / 幼虫 / 食物自己的行为 | `renderer/src/entities.js` |
| 售价公式、分档换算、养蝇人选项 | `renderer/src/market.js` |
| 突变怎么遗传、怎么叠加 | `renderer/src/mutations.js` |
| 存档格式 | `renderer/src/save.js` |
| 窗口、托盘、鼠标穿透 | `main.js` |

---

## 界面上的文案在哪改

### ⚠ 先记住这一条：**大部分说明文字不在任何「文案文件」里，是现算的**

因为写死的文案改了数值就会变成假话，而图鉴正是玩家拿来「查这个世界有什么」的地方。
所以查到某句说明时，先想一下它是不是从 `config.js` 拼出来的 —— 是的话，
**改 config 里的数值/名字，那句话自动跟着变**，不用动界面代码。

| 想改什么 | 文件 | 位置 |
| --- | --- | --- |
| **图鉴**分几组、组名（「食物」「基因」） | `renderer/src/ui.js` | `refreshCodex()` |
| 图鉴里食物那格的名字 | `renderer/src/ui.js` | `_codexFoodCell()` 里的 `name.textContent` |
| 图鉴里食物那格的说明（价格 · 成长 ×N） | —— | **现算**，改 `config.js` 的 `market.prices.food` / `food.growthBonus` |
| 图鉴里基因胶囊上的字（⚡ 疯狂） | —— | **现算**，改 `config.js` 的 `mutation.types[].icon` / `.name` |
| 图鉴里基因那格的效果句 | `renderer/src/ui.js` | `_mutationEffect()` ← 纯措辞只有这里要手改 |
| 图鉴里基因那格的概率行 | `renderer/src/ui.js` | `_codexGeneCell()` 里的 `desc.textContent` |
| 工具按钮的**显示名**和**悬停提示** | `renderer/index.html` | 每颗 `<button class="tool" data-tool="…" title="…">显示名</button>` |
| 工具面板那行的快捷键总提示 | `renderer/index.html` | `fold-toggle id="btn-tools"` 的 `title` |
| 烤制按钮的名字和提示 | —— | **现算**，改 `config.js` 的 `roastChain[].name` / `.desc`；「点一下摆一个 / 按住烤」那句后缀在 `ui.js` 的 `refreshToolButtons()` |
| 商店里每件商品的说明 | `config.js` | `market.shop[].desc`、`roastChain[].desc`、`keeperChain[].desc` |
| 操作失败时的提示条 | `renderer/src/ui.js` | 搜 `_flashHint(` —— 例如「抹布要按住来回滑动才擦得掉」 |

> 加一件新工具时，**三个地方都要动**：`index.html` 里加按钮、
> 那行快捷键总提示补一个键、`ui.js` 的 `_onKey` 里加一个 `case`。
> 漏掉哪个都不会报错，只是那个入口不存在。
