import { commitRows, listRows } from '@/data/local-store'
import {
  BASIS_EXTREME_LIMIT,
  CLEARANCE_ARCHIVE_DATE_FIELD,
  CLEARANCE_BASIS_FIELD,
  CLEARANCE_BASIS_FIXED_FLAG,
  CLEARANCE_CONCLUSION_FIELD,
  CLEARANCE_INTERMEDIATE_FIELDS,
  CLEARANCE_KEY,
  CLEARANCE_NO_FIELD,
  CLEARANCE_REVIEW_DATE_FIELD,
  CLEARANCE_REVIEWER_FIELD,
  CLEARANCE_STATE_FIELD,
  CLEARANCE_STATUSES,
  WALL_KEY,
  WALL_LEDGER_BASIS,
  WALL_LEDGER_CLEAR_NO,
  WALL_LEDGER_SOURCE,
  WALL_LEDGER_SOURCE_VALUE,
  WALL_NO_FIELD,
  checkBasisExtreme,
  forwardGuard,
  normalizeClearanceRow,
} from '@/data/domain/clearance'
import type { ActionResult, EntryRow } from '@/data/types'

// 隐患核销服务：列表、工作台与详情抽屉都只通过这里读核销单；
// 所有写动作都走 commitRows 一次落库（核销单与支挡台账在同一笔写入里完成）。

export type ClearanceDraft = {
  basis: string
  reviewer: string
  reviewDate: string
  conclusion: string
}

export const CLEARANCE_BASIS_PRIORITY =
  '核销依据口径以隐患核销单（clearance）为准；支挡结构台账中的核销依据仅为核销时的快照，两处不一致时以核销单覆盖台账。'

export function listClearance(): EntryRow[] {
  return listRows(CLEARANCE_KEY).map((row) => normalizeClearanceRow(row))
}

export function getClearance(id: number): EntryRow | undefined {
  const row = listRows(CLEARANCE_KEY).find((item) => Number(item.id) === id)
  return row ? normalizeClearanceRow(row) : undefined
}

export function clearanceStatusSummary(rows: EntryRow[] = listClearance()) {
  return CLEARANCE_STATUSES.map((status) => ({
    status,
    count: rows.filter((row) => String(row.status) === status).length,
  }))
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function findIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

function save(clearanceRows: EntryRow[], wallRows?: EntryRow[]): void {
  commitRows(
    wallRows
      ? { [CLEARANCE_KEY]: clearanceRows, [WALL_KEY]: wallRows }
      : { [CLEARANCE_KEY]: clearanceRows },
  )
}

// 提交复核：待复核 → 复核中，只能前进一格。
export function submitClearance(id: number): ActionResult {
  const rows = listRows(CLEARANCE_KEY)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的核销单` }
  }
  const current = String(rows[index].status)
  const guard = forwardGuard(current, '复核中')
  if (!guard.ok) {
    return guard
  }
  const next = [...rows]
  next[index] = normalizeClearanceRow({
    ...rows[index],
    status: '复核中',
    pending: true,
    abnormal: false,
  })
  delete next[index][CLEARANCE_BASIS_FIXED_FLAG]
  save(next)
  return { ok: true, message: '核销单已提交复核，当前状态「复核中」' }
}

// 驳回申请：一次落库退回「待复核」，本次复核填写的中间态整批清空，
// 落库的就是页面重新进入后读到的那一份。
export function rejectClearance(id: number, reason = ''): ActionResult {
  const rows = listRows(CLEARANCE_KEY)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的核销单` }
  }
  const current = String(rows[index].status)
  if (current === '待复核') {
    return { ok: false, message: '核销单已是「待复核」，无需重复驳回' }
  }
  if (current !== '复核中') {
    return {
      ok: false,
      message: `只有「复核中」的核销单可以驳回，当前「${current}」不能驳回`,
    }
  }
  const reset: EntryRow = { ...rows[index] }
  for (const field of CLEARANCE_INTERMEDIATE_FIELDS) {
    reset[field] = ''
  }
  reset.status = '待复核'
  reset[CLEARANCE_STATE_FIELD] = '待复核'
  reset.pending = true
  reset.abnormal = false
  delete reset[CLEARANCE_BASIS_FIXED_FLAG]
  if (reason) {
    reset['驳回原因'] = reason
  } else {
    delete reset['驳回原因']
  }
  const next = [...rows]
  next[index] = reset
  save(next)
  return { ok: true, message: '核销单已驳回：本次复核内容已清空，退回「待复核」' }
}

// 极值依据单独退回：复核中发现核销依据填成极值的，不允许核销，
// 同一次落库里清空中间态并转入「已驳回」核对态，等更正后重提。
export function returnExtremeClearance(id: number): ActionResult {
  const rows = listRows(CLEARANCE_KEY)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的核销单` }
  }
  const row = rows[index]
  if (String(row.status) !== '复核中') {
    return {
      ok: false,
      message: `只有「复核中」的核销单可以退回核对，当前「${String(row.status)}」`,
    }
  }
  const check = checkBasisExtreme(row[CLEARANCE_BASIS_FIELD])
  if (!check.extreme) {
    return { ok: false, message: '该核销单核销依据未达极值，不应走极值退回' }
  }
  const returned: EntryRow = { ...row }
  for (const field of CLEARANCE_INTERMEDIATE_FIELDS) {
    returned[field] = ''
  }
  returned.status = '已驳回'
  returned[CLEARANCE_STATE_FIELD] = '已驳回'
  returned.pending = true
  returned.abnormal = true
  delete returned[CLEARANCE_BASIS_FIXED_FLAG]
  returned['驳回原因'] = check.reason ?? '核销依据为极值，单独退回核对'
  const next = [...rows]
  next[index] = returned
  save(next)
  return {
    ok: true,
    message: `核销依据异常（${check.reason}），已单独退回核对，状态「已驳回」`,
  }
}

// 极值项更正后重提：已驳回 → 待复核，依据改对了才能重新排队。
export function resubmitReturnedClearance(
  id: number,
  draft: Pick<ClearanceDraft, 'basis'>,
): ActionResult {
  const basis = draft.basis.trim()
  const check = checkBasisExtreme(basis)
  if (check.extreme) {
    return { ok: false, message: `核销依据仍未通过核对：${check.reason}` }
  }
  const rows = listRows(CLEARANCE_KEY)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的核销单` }
  }
  if (String(rows[index].status) !== '已驳回') {
    return { ok: false, message: '只有「已驳回」的核销单可以更正重提' }
  }
  const next = [...rows]
  // 更正重提要保留更正后的核销依据（它是登记口径，不是本次复核的中间态），
  // 其余复核中间态仍清空。
  const corrected: EntryRow = { ...rows[index] }
  for (const field of CLEARANCE_INTERMEDIATE_FIELDS) {
    corrected[field] = ''
  }
  corrected[CLEARANCE_BASIS_FIELD] = basis
  corrected.status = '待复核'
  corrected[CLEARANCE_STATE_FIELD] = '待复核'
  corrected.pending = true
  corrected.abnormal = false
  corrected[CLEARANCE_BASIS_FIXED_FLAG] = true
  delete corrected['驳回原因']
  next[index] = corrected
  save(next)
  return { ok: true, message: '核销依据已更正，核销单重新进入「待复核」' }
}

function nextWallId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 核销收尾 → 支挡结构台账：同一核销编号只建一条重新建档项（幂等）。
// 台账里存核销依据快照；若快照与核销单对不上，以核销单为准就地更新，绝不新增第二条。
function upsertWallLedger(wallRows: EntryRow[], clearance: EntryRow): EntryRow[] {
  const clearNo = String(clearance[CLEARANCE_NO_FIELD] ?? '')
  const basis = String(clearance[CLEARANCE_BASIS_FIELD] ?? '')
  const index = wallRows.findIndex(
    (row) =>
      row[WALL_LEDGER_SOURCE] === WALL_LEDGER_SOURCE_VALUE &&
      String(row[WALL_LEDGER_CLEAR_NO] ?? '') === clearNo,
  )
  if (index >= 0) {
    const prev = wallRows[index]
    const merged: EntryRow = {
      ...prev,
      ...Object.fromEntries(
        (['结构编号', '所属工程', '结构形式', '结构长度', '结构高度', '基础埋深', '验收日期', '结构状态'] as const).map(
          (field) => [field, prev[field] ?? ''],
        ),
      ),
      [WALL_LEDGER_SOURCE]: WALL_LEDGER_SOURCE_VALUE,
      [WALL_LEDGER_CLEAR_NO]: clearNo,
      [WALL_LEDGER_BASIS]: basis,
    }
    const next = [...wallRows]
    next[index] = merged
    return next
  }
  const created: EntryRow = {
    id: nextWallId(wallRows),
    status: '待浇筑',
    pending: true,
    abnormal: false,
    [WALL_NO_FIELD]: `WALL-CLEA-${clearNo.replace(/[^A-Za-z0-9]/g, '') || 'NEW'}`,
    所属工程: String(clearance['所属隐患点'] ?? ''),
    结构形式: '核销后重新建档',
    结构长度: '',
    结构高度: '',
    基础埋深: '',
    验收日期: '',
    结构状态: '待建档',
    [WALL_LEDGER_SOURCE]: WALL_LEDGER_SOURCE_VALUE,
    [WALL_LEDGER_CLEAR_NO]: clearNo,
    [WALL_LEDGER_BASIS]: basis,
  }
  return [...wallRows, created]
}

// 确认核销：复核中 → 已核销。同一核销编号重复确认只算一次：
// 已核销的单子再点直接挡回；台账联动按来源核销编号幂等，不产生第二条。
export function confirmClearance(id: number, draft: ClearanceDraft): ActionResult {
  const basis = draft.basis.trim()
  const reviewer = draft.reviewer.trim()
  const reviewDate = draft.reviewDate.trim() || today()
  const conclusion = draft.conclusion.trim() || '复核通过，同意核销'
  if (!basis || !reviewer) {
    return { ok: false, message: '核销依据与复核人不能为空' }
  }
  const check = checkBasisExtreme(basis)
  if (check.extreme) {
    return {
      ok: false,
      message: `核销依据为极值（${check.reason}），不能核销，请先单独退回核对`,
    }
  }
  const rows = listRows(CLEARANCE_KEY)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的核销单` }
  }
  const current = String(rows[index].status)
  if (current === '已核销') {
    return { ok: false, message: '该核销编号已完成核销，重复复核只算一次' }
  }
  const guard = forwardGuard(current, '已核销')
  if (!guard.ok) {
    return guard
  }

  const archivedDate = today()
  const finalized: EntryRow = {
    ...rows[index],
    status: '已核销',
    [CLEARANCE_STATE_FIELD]: '已核销',
    pending: false,
    abnormal: false,
    [CLEARANCE_BASIS_FIELD]: basis,
    [CLEARANCE_REVIEWER_FIELD]: reviewer,
    [CLEARANCE_REVIEW_DATE_FIELD]: reviewDate,
    [CLEARANCE_CONCLUSION_FIELD]: conclusion,
    [CLEARANCE_ARCHIVE_DATE_FIELD]: archivedDate,
  }
  delete finalized[CLEARANCE_BASIS_FIXED_FLAG]
  delete finalized['驳回原因']
  const nextClearance = [...rows]
  nextClearance[index] = finalized

  // 核销收尾结果驱动支挡结构台账：与核销单同一笔落库。
  const nextWall = upsertWallLedger(listRows(WALL_KEY), finalized)
  save(nextClearance, nextWall)
  return { ok: true, message: '核销完成：已同步在支挡结构台账建立重新建档项' }
}

// 两处核销依据对账：以核销单为准，把台账里对不上的快照刷成核销单口径。
export function reconcileWallBasis(): {
  ok: boolean
  message: string
  synced: string[]
} {
  const clearanceRows = listRows(CLEARANCE_KEY)
  const wallRows = listRows(WALL_KEY)
  const basisByNo = new Map(
    clearanceRows
      .filter((row) => String(row.status) === '已核销')
      .map((row) => [String(row[CLEARANCE_NO_FIELD] ?? ''), String(row[CLEARANCE_BASIS_FIELD] ?? '')]),
  )
  const synced: string[] = []
  const nextWall = wallRows.map((row) => {
    if (row[WALL_LEDGER_SOURCE] !== WALL_LEDGER_SOURCE_VALUE) {
      return row
    }
    const clearNo = String(row[WALL_LEDGER_CLEAR_NO] ?? '')
    const canonical = basisByNo.get(clearNo)
    if (canonical === undefined) {
      return row
    }
    if (String(row[WALL_LEDGER_BASIS] ?? '') === canonical) {
      return row
    }
    synced.push(clearNo)
    return { ...row, [WALL_LEDGER_BASIS]: canonical }
  })
  if (synced.length > 0) {
    commitRows({ [WALL_KEY]: nextWall })
  }
  return {
    ok: true,
    synced,
    message:
      synced.length > 0
        ? `已按核销单口径同步 ${synced.length} 条支挡台账的核销依据（${synced.join('、')}）`
        : '两处核销依据已一致，无需同步',
  }
}

export function extremeClearanceRows(rows: EntryRow[] = listClearance()): EntryRow[] {
  return rows.filter((row) => {
    if (String(row.status) === '已驳回') {
      return true
    }
    if (String(row.status) !== '复核中') {
      return false
    }
    return checkBasisExtreme(row[CLEARANCE_BASIS_FIELD]).extreme
  })
}

export { BASIS_EXTREME_LIMIT, checkBasisExtreme, CLEARANCE_BASIS_FIELD }
