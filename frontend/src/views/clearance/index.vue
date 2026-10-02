<template>
  <section class="page" data-module="clearance">
    <header class="page-head">
      <div>
        <h2>隐患核销管理</h2>
        <p class="page-desc">核销单按 待复核 → 复核中 → 已核销 逐步流转；驳回一次落库退回待复核并清空本次复核内容。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记核销单</button>
        <button class="btn" type="button" @click="reconcile">核销依据对账</button>
        <button class="btn" type="button" @click="exportRows">导出隐患核销清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p class="notice">
      状态只能按 待复核 → 复核中 → 已核销 的次序逐步流转，跳级会被挡回；「已驳回」为极值依据核对态，仅可由复核中退回。
      {{ basisPriority }}
    </p>
    <p v-if="extremeRows.length" class="notice warn">
      检测到 {{ extremeRows.length }} 条核销依据为极值的核销单，已单独标出，请退回核对后再办核销。
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-extreme': isExtreme(row) }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '核销编号'">
              <button class="link" type="button" @click="openDetail(row)">{{ row[column] ?? '—' }}</button>
              <span v-if="isExtreme(row)" class="badge extreme">极值退回</span>
            </template>
            <template v-else>{{ displayValue(row, column) }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action.label"
              class="link"
              :class="{ danger: action.tone === 'danger' }"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action.label }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无隐患核销数据，可先登记核销单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条隐患核销记录</span>
      <span v-if="noticeMessage" class="notice" style="margin:0">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情抽屉：与工作台、列表同读 clearance-service 里的同一份核销单 -->
    <template v-if="detailRow">
      <div class="overlay" @click="closeDetail" />
      <aside class="modal drawer" role="dialog" aria-label="核销单详情">
        <div class="modal-head">
          <h3>核销单详情 · {{ detailRow['核销编号'] }}</h3>
          <button class="modal-close" type="button" @click="closeDetail">×</button>
        </div>
        <dl class="detail-list">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ displayValue(detailRow, field) }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detailRow.status }}</dd>
          <template v-if="linkedLedger(detailRow)">
            <dt>支挡台账依据</dt>
            <dd>
              {{ linkedLedger(detailRow)?.['核销依据快照'] || '—' }}
              <span
                v-if="linkedLedger(detailRow)?.['核销依据快照'] !== detailRow['核销依据']"
                class="badge extreme"
              >与核销单不一致，以核销单为准</span>
            </dd>
          </template>
          <template v-if="detailRow['驳回原因']">
            <dt>退回原因</dt>
            <dd>{{ detailRow['驳回原因'] }}</dd>
          </template>
        </dl>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
          <button
            v-if="String(detailRow.status) === '复核中'"
            class="btn primary"
            type="button"
            @click="openReview(detailRow)"
          >
            办理复核
          </button>
        </div>
      </aside>
    </template>

    <!-- 复核弹窗：表单只操作弹窗草稿，确认/驳回时一次落库，绝不残留半成品 -->
    <template v-if="reviewRow">
      <div class="overlay" @click="closeReview" />
      <div class="modal modal-dialog" role="dialog" aria-label="核销复核">
        <div class="modal-head">
          <h3>核销复核 · {{ reviewRow['核销编号'] }}</h3>
          <button class="modal-close" type="button" @click="closeReview">×</button>
        </div>
        <p class="notice">
          {{ basisPriority }}
          列表页、工作台与本弹窗读的是同一份核销单；驳回将清空本次填写并退回待复核。
        </p>
        <div class="form-grid">
          <label class="form-field">
            <span>核销依据 *</span>
            <textarea v-model="draft.basis" placeholder="填写复核认定的核销依据（数值须在 0 至 1000000 之间）"></textarea>
          </label>
          <label class="form-field">
            <span>复核人 *</span>
            <input v-model="draft.reviewer" placeholder="复核人姓名" />
          </label>
          <label class="form-field">
            <span>复核日期</span>
            <input v-model="draft.reviewDate" type="date" />
          </label>
          <label class="form-field">
            <span>核销结论</span>
            <input v-model="draft.conclusion" placeholder="默认：复核通过，同意核销" />
          </label>
        </div>
        <p v-if="draftBasisExtreme" class="notice warn">当前核销依据为极值（{{ draftBasisReason }}），不能确认核销，请退回核对。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeReview">取消</button>
          <button class="btn danger" type="button" @click="doReturnExtreme" :disabled="!draftBasisExtreme">极值退回</button>
          <button class="btn danger" type="button" @click="doReject">驳回申请</button>
          <button class="btn primary" type="button" @click="doConfirm">确认核销</button>
        </div>
      </div>
    </template>

    <!-- 已驳回（极值）核销单的更正重提弹窗 -->
    <template v-if="fixRow">
      <div class="overlay" @click="fixRow = null" />
      <div class="modal modal-dialog" role="dialog" aria-label="核销依据更正">
        <div class="modal-head">
          <h3>核销依据更正 · {{ fixRow['核销编号'] }}</h3>
          <button class="modal-close" type="button" @click="fixRow = null">×</button>
        </div>
        <p class="notice warn">退回原因：{{ fixRow['驳回原因'] || '核销依据为极值' }}。更正为有效依据后重新进入待复核。</p>
        <div class="form-grid">
          <label class="form-field">
            <span>核销依据 *</span>
            <textarea v-model="fixBasis" placeholder="重新填写有效核销依据"></textarea>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="fixRow = null">取消</button>
          <button class="btn primary" type="button" @click="doResubmit">更正并重提</button>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  checkBasisExtreme,
  CLEARANCE_BASIS_PRIORITY,
  clearanceStatusSummary,
  confirmClearance,
  extremeClearanceRows,
  getClearance,
  listClearance,
  reconcileWallBasis,
  rejectClearance,
  resubmitReturnedClearance,
  returnExtremeClearance,
  submitClearance,
} from '@/api/clearance-service'
import { downloadEntries } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { WALL_LEDGER_CLEAR_NO, WALL_LEDGER_SOURCE } from '@/data/domain/clearance'
import type { EntryRow } from '@/data/types'

const columns = ['核销编号', '所属隐患点', '核销依据', '复核人', '复核日期', '核销结论', '归档日期', '核销状态']
const detailFields = ['核销编号', '所属隐患点', '核销依据', '复核人', '复核日期', '核销结论', '归档日期']
const basisPriority = CLEARANCE_BASIS_PRIORITY

type RowAction = {
  key: string
  label: string
  tone?: 'danger'
}

const rows = ref<EntryRow[]>([])
const allClearance = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const detailId = ref<number | null>(null)
const reviewId = ref<number | null>(null)
const fixRow = ref<EntryRow | null>(null)
const fixBasis = ref('')

const draft = ref({ basis: '', reviewer: '', reviewDate: '', conclusion: '' })

const detailRow = computed(() => (detailId.value === null ? null : getClearance(detailId.value) ?? null))
const reviewRow = computed(() => (reviewId.value === null ? null : getClearance(reviewId.value) ?? null))

const statusSummary = computed(() => clearanceStatusSummary(allClearance.value))
const statsCards = computed(() => [
  { label: '待复核核销单', value: countByStatus('待复核') },
  { label: '复核中核销单', value: countByStatus('复核中') },
  { label: '已核销隐患点', value: countByStatus('已核销') },
  { label: '已驳回申请', value: countByStatus('已驳回') },
])
const extremeRows = computed(() => extremeClearanceRows(allClearance.value))
const draftBasisCheck = computed(() => checkBasisExtreme(draft.value.basis))
const draftBasisExtreme = computed(() => draftBasisCheck.value.extreme)
const draftBasisReason = computed(() => draftBasisCheck.value.reason ?? '')

function countByStatus(status: string): number {
  return allClearance.value.filter((row) => String(row.status) === status).length
}

function isExtreme(row: EntryRow): boolean {
  return String(row.status) === '已驳回'
    || (String(row.status) === '复核中' && checkBasisExtreme(row['核销依据']).extreme)
}

function displayValue(row: EntryRow, field: string): string {
  if (field === '核销状态') {
    return String(row.status)
  }
  const value = row[field]
  return value === undefined || value === '' ? '—' : String(value)
}

function linkedLedger(row: EntryRow) {
  const clearNo = String(row['核销编号'] ?? '')
  return listRows('wall').find(
    (item) =>
      item[WALL_LEDGER_SOURCE] === '核销联动重新建档' &&
      String(item[WALL_LEDGER_CLEAR_NO] ?? '') === clearNo,
  )
}

function actionsFor(row: EntryRow): RowAction[] {
  switch (String(row.status)) {
    case '待复核':
      return [{ key: 'submit', label: '提交复核' }]
    case '复核中':
      return [
        { key: 'review', label: '办理复核' },
        { key: 'reject', label: '驳回申请', tone: 'danger' },
      ]
    case '已核销':
      return []
    case '已驳回':
      return [{ key: 'fix', label: '更正重提' }]
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('clearance')
}

function openCreate() {
  errorMessage.value = '核销单登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
}

function closeDetail() {
  detailId.value = null
}

function openReview(row: EntryRow) {
  detailId.value = null
  reviewId.value = Number(row.id)
  draft.value = {
    basis: String(row['核销依据'] ?? ''),
    reviewer: String(row['复核人'] ?? ''),
    reviewDate: String(row['复核日期'] ?? ''),
    conclusion: '',
  }
}

function closeReview() {
  reviewId.value = null
}

function handleResult(result: { ok: boolean; message: string }) {
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  reviewId.value = null
  detailId.value = null
  fixRow.value = null
  reload()
}

function runAction(action: RowAction, row: EntryRow) {
  errorMessage.value = ''
  const id = Number(row.id)
  if (action.key === 'submit') {
    handleResult(submitClearance(id))
  } else if (action.key === 'reject') {
    handleResult(rejectClearance(id))
  } else if (action.key === 'review') {
    openReview(row)
  } else if (action.key === 'fix') {
    fixRow.value = row
    fixBasis.value = String(row['核销依据'] ?? '')
  }
}

function doConfirm() {
  if (!reviewRow.value) {
    return
  }
  handleResult(confirmClearance(Number(reviewRow.value.id), { ...draft.value }))
}

function doReject() {
  if (!reviewRow.value) {
    return
  }
  handleResult(rejectClearance(Number(reviewRow.value.id)))
}

function doReturnExtreme() {
  if (!reviewRow.value) {
    return
  }
  handleResult(returnExtremeClearance(Number(reviewRow.value.id)))
}

function doResubmit() {
  if (!fixRow.value) {
    return
  }
  handleResult(resubmitReturnedClearance(Number(fixRow.value.id), { basis: fixBasis.value }))
}

function reconcile() {
  const result = reconcileWallBasis()
  reload()
  noticeMessage.value = result.message
}

function reload() {
  errorMessage.value = ''
  allClearance.value = listClearance()
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  rows.value = pairs.length
    ? allClearance.value.filter((row) =>
        pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
      )
    : allClearance.value
  total.value = rows.value.length
}

onMounted(reload)
</script>
