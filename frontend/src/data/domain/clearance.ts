import type { EntryRow } from '../types'

// 隐患核销领域常量与规则：状态机、中间态字段、极值依据、支挡台账联动都集中在此，
// 页面（列表 / 工作台 / 详情抽屉 / 复核弹窗）与本地服务共用同一份口径。

export const CLEARANCE_KEY = 'clearance'
export const WALL_KEY = 'wall'

// 环节只能按这个次序向前流转：待复核 → 复核中 → 已核销；
// 「已驳回」是极值依据被单独退回的核对态，只能由「复核中」退回，不能从待复核直接跳。
export const CLEARANCE_STATUSES = ['待复核', '复核中', '已核销', '已驳回'] as const
export type ClearanceStatus = (typeof CLEARANCE_STATUSES)[number]

// 复核环节填写的中间态：驳回时必须整批清空，核销单回到与落库一致的待复核态。
export const CLEARANCE_INTERMEDIATE_FIELDS = [
  '核销依据',
  '复核人',
  '复核日期',
  '核销结论',
] as const

// 建单时就应存在的登记字段，驳回不清这些。
export const CLEARANCE_FIXED_FIELDS = ['核销编号', '所属隐患点', '归档日期'] as const

export const CLEARANCE_NO_FIELD = '核销编号'
export const CLEARANCE_BASIS_FIELD = '核销依据'
export const CLEARANCE_REVIEWER_FIELD = '复核人'
export const CLEARANCE_REVIEW_DATE_FIELD = '复核日期'
export const CLEARANCE_CONCLUSION_FIELD = '核销结论'
export const CLEARANCE_ARCHIVE_DATE_FIELD = '归档日期'
export const CLEARANCE_STATE_FIELD = '核销状态'

// 极值依据更正重提后挂的标记：带这个标记的待复核单保留更正后的依据，
// 规整中间态时不能把它当残留清掉；重新提交/驳回/核销后随中间态一并摘除。
export const CLEARANCE_BASIS_FIXED_FLAG = '依据已更正'

// 支挡结构台账中「核销联动重新建档」项的标记字段。
export const WALL_LEDGER_SOURCE = '建档来源'
export const WALL_LEDGER_SOURCE_VALUE = '核销联动重新建档'
export const WALL_LEDGER_CLEAR_NO = '来源核销编号'
export const WALL_LEDGER_BASIS = '核销依据快照'
export const WALL_NO_FIELD = '结构编号'

// 核销依据极值阈值：依据里出现数值且绝对值达到该量级（或 0 / 负数 / Infinity / NaN），
// 视为极值，不允许直接核销，单独退回核对。
export const BASIS_EXTREME_LIMIT = 1_000_000

type BasisExtremeReason =
  | 'empty'
  | 'not-a-number'
  | 'zero-or-negative'
  | 'over-limit'
  | 'infinity'

const EXTREME_LABEL: Record<BasisExtremeReason, string> = {
  empty: '核销依据为空',
  'not-a-number': '核销依据不是有效数值',
  'zero-or-negative': '核销依据为零或负值',
  'over-limit': `核销依据绝对值超过 ${BASIS_EXTREME_LIMIT}`,
  infinity: '核销依据为无穷大',
}

export type BasisCheck = {
  extreme: boolean
  reason?: string
}

// 从依据文本里抽取数值（支持「位移 9999999 mm」这类带单位的写法）。
function extractNumber(text: string): number | null {
  const matched = text.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
  if (!matched) {
    return null
  }
  return Number(matched[0])
}

// 极值核对：核销依据必须是落在 (0, BASIS_EXTREME_LIMIT) 区间内的数值。
export function checkBasisExtreme(rawBasis: unknown): BasisCheck {
  const basis = String(rawBasis ?? '').trim()
  if (basis === '') {
    return { extreme: true, reason: EXTREME_LABEL.empty }
  }
  if (/inf/i.test(basis)) {
    return { extreme: true, reason: EXTREME_LABEL.infinity }
  }
  const value = extractNumber(basis)
  if (value === null || Number.isNaN(value)) {
    return { extreme: true, reason: EXTREME_LABEL['not-a-number'] }
  }
  if (!Number.isFinite(value)) {
    return { extreme: true, reason: EXTREME_LABEL.infinity }
  }
  if (value <= 0) {
    return { extreme: true, reason: EXTREME_LABEL['zero-or-negative'] }
  }
  if (Math.abs(value) >= BASIS_EXTREME_LIMIT) {
    return { extreme: true, reason: EXTREME_LABEL['over-limit'] }
  }
  return { extreme: false }
}

// 正向次序：只能一步一步往后走，跳级要挡回。返回 null 表示合法。
export function forwardGuard(
  current: string,
  target: string,
): { ok: false; message: string } | { ok: true } {
  const from = CLEARANCE_STATUSES.indexOf(current as ClearanceStatus)
  const to = CLEARANCE_STATUSES.indexOf(target as ClearanceStatus)
  if (from < 0 || to < 0) {
    return { ok: false, message: `核销单状态「${current}」不在受控状态内，不能流转` }
  }
  if (to !== from + 1 || target === '已驳回') {
    return {
      ok: false,
      message: `核销单只能按 待复核 → 复核中 → 已核销 的次序逐步流转，当前「${current}」不能直接跳到「${target}」`,
    }
  }
  return { ok: true }
}

// 历史数据规整：状态与「核销状态」展示字段必须同源；已离开复核中的单子
// 不允许残留中间态（旧版本驳回没清干净的在这里兜底清掉）。
export function normalizeClearanceRow(row: EntryRow): EntryRow {
  const status = CLEARANCE_STATUSES.includes(row.status as ClearanceStatus)
    ? (row.status as ClearanceStatus)
    : '待复核'
  const next: EntryRow = { ...row, status }
  next[CLEARANCE_STATE_FIELD] = status
  if (status === '待复核') {
    next.pending = true
    // 驳回退回的待复核单：本次复核内容必须清空；
    // 但极值项「更正重提」后的依据是登记口径，带标记时保留。
    if (!next[CLEARANCE_BASIS_FIXED_FLAG]) {
      for (const field of CLEARANCE_INTERMEDIATE_FIELDS) {
        next[field] = ''
      }
    } else {
      for (const field of CLEARANCE_INTERMEDIATE_FIELDS) {
        if (field !== CLEARANCE_BASIS_FIELD) {
          next[field] = ''
        }
      }
    }
  } else if (status === '复核中') {
    next.pending = true
    next.abnormal = false
  } else if (status === '已核销') {
    next.pending = false
    next.abnormal = false
  } else if (status === '已驳回') {
    next.pending = true
    next.abnormal = true
  }
  return next
}

// 支挡台账行规整：核销联动建档项以来源核销编号为幂等键。
export function normalizeWallRow(row: EntryRow, linkedClearNo?: string): EntryRow {
  const clearNo =
    linkedClearNo ?? (row[WALL_LEDGER_CLEAR_NO] !== undefined ? String(row[WALL_LEDGER_CLEAR_NO]) : undefined)
  if (clearNo === undefined) {
    return { ...row }
  }
  return {
    ...row,
    [WALL_LEDGER_SOURCE]: WALL_LEDGER_SOURCE_VALUE,
    [WALL_LEDGER_CLEAR_NO]: clearNo,
  }
}
