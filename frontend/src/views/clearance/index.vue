<template>
  <section class="page" data-module="clearance">
    <header class="page-head">
      <div>
        <h2>隐患核销管理</h2>
        <p class="page-desc">维护核销单，围绕核销编号、所属隐患点、核销依据、复核人做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记核销单</button>
        <button class="btn" type="button" @click="exportRows">导出隐患核销清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
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
          <th>办理</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDrawer(Number(row.id))">
              {{ actionLabel(row.status) }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无隐患核销数据，可先登记核销单</td>
        </tr>
      </tbody>
    </table>

    <section class="reconcile-panel">
      <h3>支挡结构台账 · 核销依据比对</h3>
      <p class="page-desc">
        核销收尾会在支挡结构台账幂等生成一条「重新建档」项（同一核销编号只此一条）。
        两处核销依据口径<strong>以隐患核销单（持久化那份）为准</strong>，台账副本不一致时可按核销单对齐。
      </p>
      <table v-if="mismatches.length" class="data-table">
        <thead>
          <tr>
            <th>核销编号</th>
            <th>核销单核销依据（优先）</th>
            <th>台账留存核销依据</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in mismatches" :key="item.clearanceId">
            <td>{{ item.核销编号 }}</td>
            <td>{{ item.clearanceBasis }}</td>
            <td>{{ item.wallBasis }}</td>
            <td>
              <button class="link" type="button" @click="syncOne(item.clearanceId)">按核销单对齐台账</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">已核销核销单与支挡结构台账的核销依据全部一致</p>
      <p v-if="syncMessage" :class="syncOk ? 'ok-text' : 'error-text'">{{ syncMessage }}</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条隐患核销记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <ReviewDrawer
      :open="drawerOpen"
      :id="drawerId"
      @close="closeDrawer"
      @changed="reload"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  basisMismatches,
  CLEARANCE_STATUSES,
  syncBasisFromClearance,
} from '@/api/clearance-service'
import type { EntryRow } from '@/data/types'

import ReviewDrawer from './ReviewDrawer.vue'

const meta = moduleMeta('clearance')
const columns = ["核销编号", "所属隐患点", "核销依据", "复核人", "复核日期", "核销结论", "归档日期", "核销状态"]
const statuses = [...CLEARANCE_STATUSES]
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const drawerOpen = ref(false)
const drawerId = ref<number | null>(null)
const syncMessage = ref('')
const syncOk = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计卡片直接读当前列表（与表格同源），不再写死 0。
const statCards = computed(() => [
  { label: '待复核核销单', value: countByStatus('待复核') },
  { label: '已核销隐患点', value: countByStatus('已核销') },
  { label: '已驳回申请', value: countByStatus('已驳回') },
])

const mismatches = computed(() => basisMismatches())

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function actionLabel(status: string): string {
  switch (status) {
    case '待复核':
      return '提交复核'
    case '复核中':
      return '继续复核'
    case '已驳回':
      return '核对退回'
    default:
      return '查看核销单'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '核销单登记入口尚未接入审批流'
}

function openDrawer(id: number) {
  drawerId.value = id
  drawerOpen.value = true
}

function closeDrawer() {
  drawerOpen.value = false
  drawerId.value = null
  reload()
}

function syncOne(id: number) {
  const result = syncBasisFromClearance(id)
  syncMessage.value = result.message
  syncOk.value = result.ok
  if (result.ok) {
    reload()
  }
}

function reload() {
  errorMessage.value = ''
  syncMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '隐患核销列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.reconcile-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.reconcile-panel h3 { margin: 0 0 6px; font-size: 15px; }
.reconcile-panel .data-table { margin-top: 10px; }
.ok-text { color: #067647; }
</style>
