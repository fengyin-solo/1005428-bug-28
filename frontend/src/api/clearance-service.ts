import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 核销单专属领域服务：
// 列表页与详情抽屉的所有读写都收敛到这里，保证两个入口读的是同一份持久化核销单。
// 任何状态变更都由本文件构造完整新行后一次性写回（一次落库），不允许页面先改半份再补写。

export const CLEARANCE_KEY = 'clearance'
const WALL_KEY = 'wall'

// 环节次序：待复核 → 复核中 → 已核销；已驳回是极值依据「单独退回核对」的终态。
// 只能在相邻环节间流转，跳到后面的动作一律挡回。
export const CLEARANCE_STATUSES = ['待复核', '复核中', '已核销', '已驳回'] as const

// 复核环节本次填写的中间态字段：普通驳回时必须随「退回待复核」一起在同一次落库里清空。
const REVIEW_DRAFT_FIELDS = ['核销依据', '复核人', '复核日期', '核销结论', '归档日期'] as const

// 核销依据极值阈值：绝对值达到 1e8，或直接填 Infinity / 极大，视为极值，单独退回核对。
const EXTREME_ABS = 1e8

export type ReviewDraft = Partial<
  Record<'核销依据' | '复核人' | '复核日期' | '核销结论', string>
>

export type BasisMismatch = {
  clearanceId: number
  wallId: number
  核销编号: string
  clearanceBasis: string
  wallBasis: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 两个入口（工作台列表、详情抽屉）的唯一读出口：每次都返回持久化数据的副本，
// 页面上的草稿编辑不会回写到缓存，避免两个入口读出来的核销依据不一样。
export function listClearance(): EntryRow[] {
  return clone(listRows(CLEARANCE_KEY))
}

export function getClearance(id: number): EntryRow | null {
  const row = listRows(CLEARANCE_KEY).find((item) => Number(item.id) === id)
  return row ? clone(row) : null
}

export function isExtremeBasis(input: string): boolean {
  const text = input.trim()
  if (text === '') {
    return false
  }
  if (/infinity|∞|极大/i.test(text)) {
    return true
  }
  const tokens = text.match(/-?\d+(?:\.\d+)?/g) ?? []
  return tokens.some((token) => Math.abs(Number(token)) >= EXTREME_ABS)
}

function nextWallId(wallRows: EntryRow[]): number {
  return wallRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 核销收尾驱动支挡结构台账：同一核销编号只幂等 upsert 一条「重新建档」项，
// 重复复核 / 重复确认都不会再冒出第二条；核销依据随核销单同步更新。
function upsertWallRebuild(wallRows: EntryRow[], clearance: EntryRow): EntryRow[] {
  const code = String(clearance['核销编号'] ?? '')
  const basis = String(clearance['核销依据'] ?? '')
  const index = wallRows.findIndex((row) => String(row['核销编号'] ?? '') === code)
  if (index >= 0) {
    const next = [...wallRows]
    next[index] = { ...next[index], 核销依据: basis }
    return next
  }
  const item: EntryRow = {
    id: nextWallId(wallRows),
    status: '待浇筑',
    pending: true,
    abnormal: false,
    核销编号: code,
    // 台账侧留存核销依据副本，仅用于与核销单比对；口径有冲突时以核销单为准。
    核销依据: basis,
    结构编号: `建档-${code}`,
    所属工程: String(clearance['所属隐患点'] ?? ''),
    结构形式: '核销后重新建档',
    结构长度: '',
    结构高度: '',
    基础埋深: '',
    验收日期: '',
    结构状态: '待浇筑',
  }
  return [...wallRows, item]
}

// 一次落库：先台账后核销单，两次写入在同一同步调用里完成，中间不存在半成品状态。
function commit(clearanceRows: EntryRow[], wallRows?: EntryRow[]): void {
  if (wallRows) {
    saveRows(WALL_KEY, wallRows)
  }
  saveRows(CLEARANCE_KEY, clearanceRows)
}

function withDraft(row: EntryRow, draft: ReviewDraft): EntryRow {
  const next = { ...row }
  for (const [field, value] of Object.entries(draft)) {
    if (value !== undefined) {
      next[field] = value
    }
  }
  return next
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// 核销单状态机。各动作只允许在指定环节发起，跳到后面环节的动作在此挡回。
// 提交复核：待复核 → 复核中
// 确认核销：复核中 → 已核销（核销依据为极值时 → 已驳回，单独退回核对，保留所填内容）
// 驳回申请：复核中 → 待复核（同一次落库清空本次中间态）
// 核对退回：已驳回 → 待复核（极值依据人工核对修正后，重新进入流程）
export function runClearanceAction(
  id: number,
  action: string,
  draft: ReviewDraft = {},
): ActionResult {
  const rows = listRows(CLEARANCE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的核销单` }
  }

  const current = String(rows[index].status)
  const base = withDraft(rows[index], draft)
  const next = [...rows]

  if (action === '提交复核') {
    if (current === '复核中') {
      return { ok: false, message: '该核销单已在复核中，同一核销编号重复提交只算一次' }
    }
    if (current === '已核销') {
      return { ok: false, message: '该核销单已核销，不能再次复核' }
    }
    if (current === '已驳回') {
      return { ok: false, message: '该核销单已退回核对，请先核对修正后再重新发起' }
    }
    if (current !== '待复核') {
      return { ok: false, message: `当前为「${current}」，不能跳到复核中` }
    }
    next[index] = { ...base, status: '复核中', pending: true, abnormal: false, 核销状态: '复核中' }
    commit(next)
    return { ok: true, message: '核销单已进入复核中' }
  }

  if (action === '驳回申请') {
    if (current === '待复核') {
      return { ok: false, message: '核销单还在待复核，须先进入复核中才能驳回' }
    }
    if (current === '已核销') {
      return { ok: false, message: '该核销单已核销，不能再驳回' }
    }
    if (current === '已驳回') {
      return { ok: false, message: '该核销单已退回核对，无需重复驳回' }
    }
    if (current !== '复核中') {
      return { ok: false, message: `当前为「${current}」，不能执行驳回` }
    }
    // 驳回一次落库：状态退回待复核 + 清空本次填写的全部中间态，写在同一条新记录上。
    const cleared: EntryRow = {
      ...base,
      status: '待复核',
      pending: true,
      abnormal: false,
      核销状态: '待复核',
      驳回备注: '',
    }
    for (const field of REVIEW_DRAFT_FIELDS) {
      cleared[field] = ''
    }
    next[index] = cleared
    commit(next)
    return { ok: true, message: '已驳回并清空本次复核内容，核销单退回待复核' }
  }

  if (action === '确认核销') {
    if (current === '待复核') {
      return { ok: false, message: '核销单还在待复核，不能跳过复核中直接核销' }
    }
    if (current === '已核销') {
      return { ok: false, message: '该核销单已核销，同一核销编号重复复核只算一次' }
    }
    if (current === '已驳回') {
      return { ok: false, message: '该核销单已退回核对，请核对修正后重新走复核流程' }
    }
    if (current !== '复核中') {
      return { ok: false, message: `当前为「${current}」，不能执行确认核销` }
    }
    const basis = String(base['核销依据'] ?? '').trim()
    const reviewer = String(base['复核人'] ?? '').trim()
    if (basis === '' || reviewer === '') {
      return { ok: false, message: '请先填齐核销依据与复核人，再确认核销' }
    }
    // 极值依据不走正常驳回，单独退回核对：保留所填内容，落到「已驳回」终态等待人工核对。
    if (isExtremeBasis(basis)) {
      next[index] = {
        ...base,
        status: '已驳回',
        pending: true,
        abnormal: true,
        核销状态: '已驳回',
        驳回备注: '核销依据疑似极值，已单独退回核对',
      }
      commit(next)
      return { ok: false, message: '核销依据疑似极值，已单独退回核对，暂不核销' }
    }
    const approved: EntryRow = {
      ...base,
      核销依据: basis,
      复核人: reviewer,
      复核日期: String(base['复核日期'] ?? '').trim() || today(),
      核销结论: String(base['核销结论'] ?? '').trim() || '复核通过，准予核销',
      归档日期: String(base['归档日期'] ?? '').trim() || today(),
      status: '已核销',
      pending: false,
      abnormal: false,
      核销状态: '已核销',
      驳回备注: '',
    }
    next[index] = approved
    // 核销收尾驱动支挡结构台账（同一核销编号幂等，只此一条重新建档项）。
    const wallRows = upsertWallRebuild(listRows(WALL_KEY), approved)
    commit(next, wallRows)
    return { ok: true, message: '核销单已核销，支挡结构台账已同步生成/更新重新建档项' }
  }

  if (action === '核对退回') {
    if (current !== '已驳回') {
      return { ok: false, message: '只有已退回核对的核销单才能执行核对退回' }
    }
    const basis = String(base['核销依据'] ?? '').trim()
    if (basis === '') {
      return { ok: false, message: '请核对并补正核销依据后再退回' }
    }
    if (isExtremeBasis(basis)) {
      return { ok: false, message: '核销依据仍为极值，请核对修正后再退回' }
    }
    // 核对修正后重新进入待复核：保留已核对的核销依据，清空其余复核中间态。
    const corrected: EntryRow = {
      ...base,
      核销依据: basis,
      复核人: '',
      复核日期: '',
      核销结论: '',
      归档日期: '',
      status: '待复核',
      pending: true,
      abnormal: false,
      核销状态: '待复核',
      驳回备注: '',
    }
    next[index] = corrected
    commit(next)
    return { ok: true, message: '核对完成，核销单已退回待复核' }
  }

  return { ok: false, message: `核销单不支持「${action}」这个动作` }
}

// 两处比对：已核销核销单的核销依据 vs 支挡结构台账里同核销编号的重新建档项。
export function basisMismatches(): BasisMismatch[] {
  const wallRows = listRows(WALL_KEY)
  const result: BasisMismatch[] = []
  for (const row of listRows(CLEARANCE_KEY)) {
    if (String(row.status) !== '已核销') {
      continue
    }
    const code = String(row['核销编号'] ?? '')
    const wall = wallRows.find((item) => String(item['核销编号'] ?? '') === code)
    if (!wall) {
      continue
    }
    const clearanceBasis = String(row['核销依据'] ?? '')
    const wallBasis = String(wall['核销依据'] ?? '')
    if (clearanceBasis !== wallBasis) {
      result.push({
        clearanceId: Number(row.id),
        wallId: Number(wall.id),
        核销编号: code,
        clearanceBasis,
        wallBasis,
      })
    }
  }
  return result
}

// 口径优先级：核销依据以隐患核销单（持久化那份）为准，台账副本按核销单覆盖对齐。
export function syncBasisFromClearance(clearanceId: number): ActionResult {
  const clearanceRows = listRows(CLEARANCE_KEY)
  const index = clearanceRows.findIndex((row) => Number(row.id) === clearanceId)
  if (index < 0) {
    return { ok: false, message: '没有找到该核销单' }
  }
  const clearance = clearanceRows[index]
  if (String(clearance.status) !== '已核销') {
    return { ok: false, message: '只有已核销的核销单才能核对台账依据' }
  }
  const code = String(clearance['核销编号'] ?? '')
  const wallRows = listRows(WALL_KEY)
  const wallIndex = wallRows.findIndex((row) => String(row['核销编号'] ?? '') === code)
  if (wallIndex < 0) {
    // 台账缺项时补齐，仍只落一条。
    commit(clearanceRows, upsertWallRebuild(wallRows, clearance))
    return { ok: true, message: '台账缺少重新建档项，已按核销单补齐' }
  }
  const nextWall = [...wallRows]
  nextWall[wallIndex] = {
    ...nextWall[wallIndex],
    核销依据: String(clearance['核销依据'] ?? ''),
  }
  commit(clearanceRows, nextWall)
  return { ok: true, message: '已按核销单口径对齐支挡结构台账' }
}

// 支挡结构侧的核销重新建档项（带核销编号字段的台账行）。
export function listWallRebuilds(): EntryRow[] {
  return clone(listRows(WALL_KEY).filter((row) => String(row['核销编号'] ?? '') !== ''))
}
