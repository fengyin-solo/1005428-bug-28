// 核销状态机行为验证：用内存 localStorage 跑完整流转，node test/run.mjs 执行。
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  },
}

import {
  listClearance,
  getClearance,
  runClearanceAction,
  basisMismatches,
  syncBasisFromClearance,
  listWallRebuilds,
} from '../src/api/clearance-service'

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('PASS:', msg)
  }
}

// seed: id1 待复核, id2 复核中, id3 已核销
const row = (id: number) => getClearance(id)!

// 1. 跳环节：待复核直接确认核销要挡回
let r = runClearanceAction(1, '确认核销')
assert(!r.ok && row(1).status === '待复核', '待复核直接确认核销被挡回，状态不变')

// 2. 正常进入复核中，填写中间态
r = runClearanceAction(1, '提交复核')
assert(r.ok && row(1).status === '复核中', '提交复核：待复核 → 复核中')

r = runClearanceAction(1, '驳回申请', {
  核销依据: '现场已治理并销号依据X',
  复核人: '张三',
  复核日期: '2026-10-01',
  核销结论: '同意',
})
// 驳回时 draft 仅在复核中已被持久化的场景才有意义；这里直接构造一个先写内容再驳回的序列
assert(r.ok, '驳回动作返回成功')

// 3. 驳回一次落库：退回待复核 + 中间态全清 + 核销状态同步
const afterReject = row(1)
assert(afterReject.status === '待复核', '驳回后状态退回待复核')
assert(afterReject['核销状态'] === '待复核', '驳回后核销状态字段同步为待复核')
assert(
  ['核销依据', '复核人', '复核日期', '核销结论', '归档日期'].every(
    (f) => String(afterReject[f] ?? '') === '',
  ),
  '驳回后本次填写的核销依据/复核人/复核日期/核销结论/归档日期全部清空',
)

// 4. 重新进入页面（重新从存储读取）状态一致
assert(listClearance().find((x) => Number(x.id) === 1)!.status === '待复核', '重新读取与持久化一致（待复核）')

// 5. 同一核销编号重复复核只算一次
runClearanceAction(1, '提交复核')
r = runClearanceAction(1, '提交复核')
assert(!r.ok, '复核中重复提交复核被挡回')

// 6. 确认核销幂等驱动台账
r = runClearanceAction(2, '确认核销', {
  核销依据: '验收报告 W-2026-02',
  复核人: '李四',
})
assert(r.ok && row(2).status === '已核销', '复核中确认核销 → 已核销')
const wallsAfterFirst = listWallRebuilds().filter((w) => w['核销编号'] === 'CLEA-0002')
assert(wallsAfterFirst.length === 1, '台账生成恰好 1 条重新建档项')

// 已核销再确认
r = runClearanceAction(2, '确认核销')
assert(!r.ok, '已核销重复复核被挡回')
const wallsAfterSecond = listWallRebuilds().filter((w) => w['核销编号'] === 'CLEA-0002')
assert(wallsAfterSecond.length === 1, '重复复核不产生第二条台账项')

// 7. 极值依据单独退回核对：保留所填内容，落已驳回，不驱动台账
runClearanceAction(1, '提交复核')
r = runClearanceAction(1, '确认核销', {
  核销依据: '位移 999999999999 mm',
  复核人: '王五',
})
assert(!r.ok && row(1).status === '已驳回', '极值依据 → 已驳回单独退回核对')
assert(String(row(1)['核销依据']) === '位移 999999999999 mm', '极值退回保留核销依据供核对')
assert(row(1).abnormal === true, '极值退回标记 abnormal')
assert(
  listWallRebuilds().every((w) => w['核销编号'] !== 'CLEA-0001'),
  '极值退回不生成台账建档项',
)

// 已驳回不能直接确认核销 / 提交复核
assert(!runClearanceAction(1, '确认核销').ok, '已驳回不能直接确认核销')
assert(!runClearanceAction(1, '提交复核').ok, '已驳回不能直接提交复核')

// 仍是极值不能核对退回
assert(
  !runClearanceAction(1, '核对退回', { 核销依据: '位移 999999999999 mm' }).ok,
  '仍是极值不能核对退回',
)
r = runClearanceAction(1, '核对退回', { 核销依据: '复核监测报告 CLEA-001' })
assert(r.ok && row(1).status === '待复核', '核对修正后退回待复核')
assert(String(row(1)['核销依据']) === '复核监测报告 CLEA-001', '核对退回保留已修正依据')
assert(String(row(1)['复核人']) === '', '核对退回清空其余复核中间态')

// 8. 两处比对 + 以核销单为准同步
assert(basisMismatches().every((m) => m.核销编号 !== 'CLEA-0002'), '初始台账与核销单依据一致')

// 手动改坏台账副本（模拟两处口径不一致），通过 storage 写回
const ls = await import('../src/data/local-store')
const wallRows = ls.listRows('wall')
const wi = wallRows.findIndex((w) => w['核销编号'] === 'CLEA-0002')
wallRows[wi] = { ...wallRows[wi], 核销依据: '台账旧口径' }
ls.saveRows('wall', wallRows)

const mm = basisMismatches()
assert(mm.some((m) => m.核销编号 === 'CLEA-0002'), '能检出两处核销依据不一致')
r = syncBasisFromClearance(2)
assert(r.ok, '以核销单为准对齐成功')
assert(
  listWallRebuilds().find((w) => w['核销编号'] === 'CLEA-0002')!['核销依据'] ===
    '验收报告 W-2026-02',
  '对齐后台账副本等于核销单口径',
)
assert(basisMismatches().length === 0, '对齐后无不一致项')

console.log('done')

// 9. 中间态在提交复核时就已落库，后续驳回不带草稿也必须清干净（原 bug 场景）
runClearanceAction(1, '提交复核', { 核销依据: '复核时落库的依据', 复核人: '赵六', 复核日期: '2026-10-02', 核销结论: '拟同意' })
assert(String(getClearance(1)!['核销依据']) === '复核时落库的依据', '中间态在复核中已落库')
assert(runClearanceAction(1, '驳回申请').ok, '不带草稿驳回成功')
const stale = getClearance(1)!
assert(stale.status === '待复核', '驳回后回到待复核（原复核中结论不再停留）')
assert(String(stale['核销依据']) === '' && String(stale['复核人']) === '' && String(stale['核销结论']) === '', '此前落库的中间态被同一次落库清空')

// 10. 列表读取返回副本：页面改动不污染存储（两个入口读同一份）
const { listEntries } = await import('../src/api/local-service')
const a = listEntries('clearance').items.find((x) => Number(x.id) === 1)!
a['核销依据'] = '页面上的临时脏值'
const b = listEntries('clearance').items.find((x) => Number(x.id) === 1)!
assert(String(b['核销依据']) === '', '列表/抽屉读取互不干扰，均等于持久化值')
