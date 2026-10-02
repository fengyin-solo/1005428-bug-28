<template>
  <div v-if="open" class="drawer-mask" @click.self="close">
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="核销单复核">
      <header class="drawer-head">
        <h3>核销单复核 · {{ row?.['核销编号'] ?? '' }}</h3>
        <button class="btn ghost" type="button" @click="close">关闭</button>
      </header>

      <div v-if="row" class="drawer-body">
        <dl class="detail-grid">
          <template v-for="field in readOnlyFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ row[field] === '' || row[field] == null ? '—' : row[field] }}</dd>
          </template>
        </dl>

        <p class="drawer-tip">
          当前环节：<strong>{{ row.status }}</strong>。环节次序为
          <em>待复核 → 复核中 → 已核销</em>，跳到后面的操作会被挡回；已驳回为极值依据单独退回核对态。
        </p>
        <p v-if="row['驳回备注']" class="error-text">退回说明：{{ row['驳回备注'] }}</p>

        <form class="draft-form" @submit.prevent="submitAction">
          <label class="draft-item">
            <span>核销依据</span>
            <textarea
              v-model="draft['核销依据']"
              rows="3"
              :disabled="!canWrite"
              placeholder="填写本次复核采用的核销依据"
            ></textarea>
          </label>
          <label class="draft-item">
            <span>复核人</span>
            <input v-model="draft['复核人']" type="text" :disabled="!canWrite" placeholder="填写复核人" />
          </label>
          <label class="draft-item">
            <span>复核日期</span>
            <input v-model="draft['复核日期']" type="date" :disabled="!canWrite" />
          </label>
          <label class="draft-item">
            <span>核销结论</span>
            <textarea
              v-model="draft['核销结论']"
              rows="2"
              :disabled="!canWrite"
              placeholder="填写核销结论"
            ></textarea>
          </label>

          <div class="drawer-actions">
            <button
              v-for="option in actionOptions"
              :key="option.action"
              class="btn"
              :class="option.primary ? 'primary' : ''"
              :data-action="option.action"
              type="submit"
            >
              {{ option.label }}
            </button>
          </div>
        </form>
      </div>

      <footer class="drawer-foot">
        <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
        <span class="muted-text">核销依据口径以持久化的核销单为准，支挡结构台账据此对齐。</span>
      </footer>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import {
  getClearance,
  runClearanceAction,
  type ReviewDraft,
} from '@/api/clearance-service'
import type { ActionResult, EntryRow } from '@/data/types'

const props = defineProps<{ open: boolean; id: number | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>()

const readOnlyFields = ['核销编号', '所属隐患点']

const row = ref<EntryRow | null>(null)
const draft = reactive<ReviewDraft>({})
const message = ref('')
const messageOk = ref(false)

// 只有复核中和已驳回（核对修正）两个环节允许在抽屉里写本次内容；
// 待复核、已核销只读，杜绝在终态或起始环节把中间态写回去。
const canWrite = computed(() => row.value?.status === '复核中' || row.value?.status === '已驳回')

const actionOptions = computed(() => {
  switch (row.value?.status) {
    case '待复核':
      return [{ action: '提交复核', label: '提交复核', primary: true }]
    case '复核中':
      return [
        { action: '确认核销', label: '确认核销', primary: true },
        { action: '驳回申请', label: '驳回申请', primary: false },
      ]
    case '已驳回':
      return [{ action: '核对退回', label: '核对修正后退回', primary: true }]
    default:
      return []
  }
})

const DRAFT_KEYS: (keyof ReviewDraft)[] = ['核销依据', '复核人', '复核日期', '核销结论']

function loadDraft() {
  for (const key of DRAFT_KEYS) {
    draft[key] = row.value ? String(row.value[key] ?? '') : ''
  }
  message.value = ''
}

watch(
  () => [props.open, props.id] as const,
  ([open]) => {
    if (!open || props.id === null) {
      row.value = null
      return
    }
    // 抽屉每次打开都从持久化核销单重新取数，与列表页同源，不使用页面上的旧草稿。
    row.value = getClearance(props.id)
    loadDraft()
  },
  { immediate: true },
)

function close() {
  emit('close')
}

function submitAction(event: SubmitEvent) {
  const button = event.submitter?.dataset.action
  if (!button || props.id === null) {
    return
  }
  const result: ActionResult = runClearanceAction(
    props.id,
    button,
    {
      核销依据: draft['核销依据'] ?? '',
      复核人: draft['复核人'] ?? '',
      复核日期: draft['复核日期'] ?? '',
      核销结论: draft['核销结论'] ?? '',
    },
  )
  message.value = result.message
  messageOk.value = result.ok

  // 驳回/极值退回/确认后都重新从持久化读取，抽屉状态立即与存储同步。
  row.value = getClearance(props.id)
  loadDraft()
  emit('changed')
}
</script>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: 460px;
  max-width: 92vw;
  height: 100%;
  background: #fff;
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.18);
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.drawer-head h3 { margin: 0; font-size: 16px; }
.drawer-body { flex: 1; overflow-y: auto; padding: 14px 18px; }
.detail-grid {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 6px 12px;
  margin: 0 0 12px;
  font-size: 13px;
}
.detail-grid dt { color: var(--muted); }
.detail-grid dd { margin: 0; }
.drawer-tip { font-size: 12px; color: var(--muted); background: #eef2f7; border-radius: 6px; padding: 8px 10px; }
.drawer-tip em { font-style: normal; color: #1f2937; }
.draft-form { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.draft-item span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.draft-item input,
.draft-item textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
}
.draft-item input:disabled,
.draft-item textarea:disabled { background: #f1f5f9; color: #475569; }
.drawer-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.drawer-foot {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.muted-text { color: var(--muted); }
.ok-text { color: #067647; }
</style>
