import { SEED_ROWS } from './seed'
import {
  CLEARANCE_KEY,
  WALL_KEY,
  WALL_LEDGER_CLEAR_NO,
  normalizeClearanceRow,
  normalizeWallRow,
} from './domain/clearance'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 核销相关数据的历史落库做规整：旧版本留下的中间态残留、状态与「核销状态」字段
// 不一致、同一核销编号在支挡台账里重复建档，都在这里收敛，保证两个入口读到同一份。
function normalizeAll(
  data: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  const next = { ...data }
  if (next[CLEARANCE_KEY]) {
    // 同一核销编号只保留一条，重复行直接丢弃，不允许一码两单。
    const byNo = new Map<string, EntryRow>()
    for (const row of next[CLEARANCE_KEY]) {
      byNo.set(String(row['核销编号'] ?? ''), row)
    }
    next[CLEARANCE_KEY] = [...byNo.values()].map((row) => normalizeClearanceRow(row))
  }
  if (next[WALL_KEY]) {
    // 支挡台账里同一核销编号只允许一条重新建档项：重复复核冒出来的第二条要并掉。
    const ledgerByNo = new Map<string, EntryRow>()
    const ordinary: EntryRow[] = []
    for (const row of next[WALL_KEY]) {
      const linkedNo = row[WALL_LEDGER_CLEAR_NO]
      if (linkedNo !== undefined && linkedNo !== '') {
        const key = String(linkedNo)
        const prev = ledgerByNo.get(key)
        ledgerByNo.set(
          key,
          prev ? normalizeWallRow({ ...prev, ...row }, key) : normalizeWallRow(row, key),
        )
      } else {
        ordinary.push(normalizeWallRow(row))
      }
    }
    const merged = [...ordinary, ...ledgerByNo.values()]
    // 合并后重排 id，杜绝同一台账里出现两个相同主键。
    next[WALL_KEY] = merged.map((row, i) => ({ ...row, id: i + 1 }))
  }
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = normalizeAll(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return normalizeAll({ ...clone(SEED_ROWS), ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ [key]: rows })
}

// 一次落库：跨模块的联动（核销 + 支挡台账）必须在同一个写动作里完成，
// 不允许先改核销单、再补一条台账这种半成品状态留在库里。
export function commitRows(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
