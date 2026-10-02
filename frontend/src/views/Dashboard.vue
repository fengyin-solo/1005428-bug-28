<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <h3 style="margin:18px 0 8px">核销工作台</h3>
    <p class="notice">
      工作台与隐患核销列表、核销详情抽屉读的是同一份核销单（clearance 数据源），状态与核销依据以列表页落库为准。
    </p>
    <table class="data-table">
      <thead>
        <tr><th>核销编号</th><th>所属隐患点</th><th>核销依据</th><th>复核人</th><th>核销结论</th><th>当前状态</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in clearanceRows" :key="String(row.id)" :class="{ 'row-extreme': isExtreme(row) }">
          <td>{{ row['核销编号'] || '—' }}</td>
          <td>{{ row['所属隐患点'] || '—' }}</td>
          <td>{{ row['核销依据'] || '—' }}</td>
          <td>{{ row['复核人'] || '—' }}</td>
          <td>{{ row['核销结论'] || '—' }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!clearanceRows.length">
          <td colspan="6" class="empty-state">暂无核销单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import {
  checkBasisExtreme,
  listClearance,
} from '@/api/clearance-service'
import type { EntryRow } from '@/data/types'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const clearanceRows = ref<EntryRow[]>([])

function isExtreme(row: EntryRow): boolean {
  return String(row.status) === '已驳回'
    || (String(row.status) === '复核中' && checkBasisExtreme(row['核销依据']).extreme)
}

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  clearanceRows.value = listClearance()
}

onMounted(refresh)
</script>
