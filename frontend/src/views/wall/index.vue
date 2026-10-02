<template>
  <section class="page" data-module="wall">
    <header class="page-head">
      <div>
        <h2>支挡结构管理</h2>
        <p class="page-desc">维护支挡结构，围绕结构编号、所属工程、结构形式、结构长度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记支挡结构</button>
        <button class="btn" type="button" @click="exportRows">导出支挡结构清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无支挡结构数据，可先登记支挡结构</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条支挡结构记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="rebuild-panel">
      <h3>核销收尾 · 重新建档项</h3>
      <p class="page-desc">
        隐患核销确认后在此幂等生成重新建档项，同一核销编号只保留一条；
        留存的核销依据用于与核销单比对，口径冲突时<strong>以隐患核销单为准</strong>，请到「隐患核销」页核对对齐。
      </p>
      <table v-if="rebuilds.length" class="data-table">
        <thead>
          <tr>
            <th>核销编号</th>
            <th>结构编号</th>
            <th>所属工程（隐患点）</th>
            <th>结构形式</th>
            <th>核销依据（台账副本）</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rebuilds" :key="String(row.id)">
            <td>{{ row['核销编号'] ?? '—' }}</td>
            <td>{{ row['结构编号'] ?? '—' }}</td>
            <td>{{ row['所属工程'] ?? '—' }}</td>
            <td>{{ row['结构形式'] ?? '—' }}</td>
            <td>{{ row['核销依据'] ?? '—' }}</td>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无核销收尾产生的重新建档项</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listWallRebuilds } from '@/api/clearance-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('wall')
const columns = ["结构编号", "所属工程", "结构形式", "结构长度", "结构高度", "基础埋深", "验收日期", "结构状态"]
const actions = ["确认浇筑", "提交验收", "确认通过"]
const statuses = ["待浇筑", "施工中", "待验收", "已验收"]
const stats = [{"label": "施工中结构", "value": 0}, {"label": "待验收结构", "value": 0}, {"label": "结构总长度", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 核销收尾生成的重新建档项：同一核销编号只此一条，列表与核销页比对面板同源。
const rebuilds = computed(() => listWallRebuilds())

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '支挡结构登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '支挡结构列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.rebuild-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.rebuild-panel h3 { margin: 0 0 6px; font-size: 15px; }
.rebuild-panel .data-table { margin-top: 10px; }
</style>
