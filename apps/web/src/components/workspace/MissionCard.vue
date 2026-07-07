<script setup lang="ts">
import { computed, reactive } from "vue";
import type { PipelineStage, MissionHistoryItem, LiveActivityItem, TimelineEvent } from "./types";

const props = defineProps<{
  mission: MissionHistoryItem | null;
  missionPipeline: PipelineStage[];
  liveActivity: LiveActivityItem[];
  missionTimeline: TimelineEvent[];
  askArticleSections: Array<{ title: string; body: string }>;
  formatDateTime: (value?: string) => string;
  formatTime: (value?: string) => string;
  formatDuration: (sec?: number) => string;
  formatTokens: (value?: number) => string;
  formatMoney: (value?: number) => string;
  priorityLabel: (weight: number) => string;
  priorityClass: (weight: number) => string;
}>();

const ui = reactive({
  expandPipeline: {} as Record<string, boolean>,
  expandContext: {} as Record<string, boolean>,
  expandFinal: {
    done: true,
    files: true,
    reason: false,
    review: false,
    testing: false,
    memory: false,
    next: true,
  },
});

const isEmpty = computed(() => !props.mission);
</script>

<template>
  <section v-if="isEmpty" class="empty-card">Выберите задачу из истории или создайте новую миссию.</section>

  <section v-else class="mission-card">
    <header class="mission-header">
      <div>
        <h2>{{ mission!.title }}</h2>
        <p>{{ mission!.mode.toUpperCase() }} · {{ mission!.status }} · {{ formatDateTime(mission!.createdAt) }}</p>
      </div>
      <div class="stats-grid">
        <div>
          <span>Время</span>
          <strong>{{ formatDuration(mission!.durationSec) }}</strong>
        </div>
        <div>
          <span>Модели</span>
          <strong>{{ mission!.models.join(", ") || "авто" }}</strong>
        </div>
        <div>
          <span>Стоимость</span>
          <strong>{{ formatMoney(mission!.cost) }}</strong>
        </div>
        <div>
          <span>Токены</span>
          <strong>{{ formatTokens(mission!.tokens) }}</strong>
        </div>
      </div>
    </header>

    <section class="card-section">
      <h3>Пайплайн</h3>
      <div class="pipeline-list">
        <article v-for="stage in missionPipeline" :key="stage.id" class="pipeline-stage" :class="stage.status">
          <button class="stage-head" @click="ui.expandPipeline[stage.id] = !ui.expandPipeline[stage.id]">
            <div class="left">
              <span class="dot" />
              <strong>{{ stage.title }}</strong>
              <small>{{ stage.description }}</small>
            </div>
            <div class="right">
              <span>{{ stage.duration }}</span>
              <span>{{ stage.model }}</span>
            </div>
          </button>
          <div v-if="ui.expandPipeline[stage.id]" class="stage-body">
            {{ stage.expandableText || "Этап выполняется согласно плану компиляции." }}
          </div>
        </article>
      </div>
    </section>

    <section class="card-section split">
      <div>
        <h3>Живая активность</h3>
        <div class="activity-list">
          <div v-for="item in liveActivity" :key="item.id" class="activity-item">
            <div>
              <strong>{{ item.role }}</strong>
              <p>{{ item.action }}</p>
              <small>{{ item.target }}</small>
            </div>
            <time>{{ formatTime(item.at) }}</time>
          </div>
        </div>
      </div>
      <div>
        <h3>Таймлайн</h3>
        <div class="timeline">
          <div v-for="event in missionTimeline" :key="`${event.at}-${event.title}`" class="timeline-item">
            <time>{{ formatTime(event.at) }}</time>
            <div>
              <strong>{{ event.title }}</strong>
              <p>{{ event.details }}</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="card-section split">
      <div>
        <h3>Контекст-пакет</h3>
        <div v-if="mission!.compile?.contextPack?.items?.length" class="context-pack">
          <details
            v-for="item in mission!.compile?.contextPack?.items"
            :key="item.id"
            class="context-item"
            :open="ui.expandContext[item.id]"
            @toggle="ui.expandContext[item.id] = !ui.expandContext[item.id]"
          >
            <summary>
              <div>
                <strong>{{ item.title }}</strong>
                <small>{{ item.type }}</small>
              </div>
              <div class="meta">
                <span :class="priorityClass(item.weight)">{{ priorityLabel(item.weight) }}</span>
                <span>{{ item.estimatedTokens }} токенов</span>
              </div>
            </summary>
            <pre>{{ item.content }}</pre>
          </details>
        </div>
        <p v-else class="empty">Нет данных context pack.</p>
      </div>

      <div>
        <h3>Анализ влияния</h3>
        <div class="impact-grid" v-if="mission!.compile?.impact">
          <div>
            <span>Файлы</span>
            <strong>{{ mission!.compile!.impact.impactedFiles.length }}</strong>
          </div>
          <div>
            <span>Сервисы</span>
            <strong>{{ mission!.compile!.impact.impactedServices.length }}</strong>
          </div>
          <div>
            <span>API</span>
            <strong>{{ mission!.compile!.impact.impactedApi.length }}</strong>
          </div>
          <div>
            <span>Фичи</span>
            <strong>{{ mission!.compile!.impact.impactedPages.length }}</strong>
          </div>
          <div>
            <span>Тесты</span>
            <strong>{{ mission!.compile!.impact.testsToRun.length }}</strong>
          </div>
          <div>
            <span>Риск</span>
            <strong>{{ mission!.compile!.impact.riskLevel }} ({{ mission!.compile!.impact.riskScore }})</strong>
          </div>
        </div>
        <p v-else class="empty">Анализ влияния пока недоступен.</p>
      </div>
    </section>

    <section class="card-section">
      <h3>Итоговый отчёт</h3>
      <div class="final-grid">
        <details :open="ui.expandFinal.done">
          <summary>Что сделано</summary>
          <p>{{ mission!.resultSummary || "Результат будет доступен после завершения." }}</p>
        </details>
        <details :open="ui.expandFinal.files">
          <summary>Измененные файлы</summary>
          <ul>
            <li v-for="file in mission!.compile?.impact?.impactedFiles || []" :key="file">{{ file }}</li>
          </ul>
        </details>
        <details :open="ui.expandFinal.reason">
          <summary>Причина изменений</summary>
          <ul>
            <li v-for="reason in mission!.compile?.impact?.reasons || []" :key="reason">{{ reason }}</li>
          </ul>
        </details>
        <details :open="ui.expandFinal.review">
          <summary>Ревью</summary>
          <p>{{ mission!.mode === "ask" ? "Не применяется в режиме «Вопрос»." : "Проверка выполнена в рамках пайплайна." }}</p>
        </details>
        <details :open="ui.expandFinal.testing">
          <summary>Тестирование</summary>
          <ul>
            <li v-for="test in mission!.compile?.plan?.testsToRun || []" :key="test">{{ test }}</li>
          </ul>
        </details>
        <details :open="ui.expandFinal.memory">
          <summary>Обновление памяти</summary>
          <ul>
            <li v-for="memory in mission!.compile?.knowledge?.topMemory || []" :key="memory.id">{{ memory.title }}</li>
          </ul>
        </details>
        <details :open="ui.expandFinal.next">
          <summary>Следующие рекомендации</summary>
          <p>Проверьте критичные участки из анализа влияния и выполните smoke/regression тесты в CI.</p>
        </details>
      </div>
    </section>

    <section v-if="mission!.mode === 'ask'" class="card-section">
      <h3>Документация ответа</h3>
      <article class="ask-doc">
        <section v-for="section in askArticleSections" :key="section.title">
          <h4>{{ section.title }}</h4>
          <pre>{{ section.body }}</pre>
        </section>
      </article>
    </section>
  </section>
</template>

<style scoped>
.mission-card,
.empty-card {
  background: #11151b;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 16px;
  padding: 16px;
  margin-bottom: 14px;
}

.mission-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  padding-bottom: 12px;
}

.mission-header p {
  color: #94a3b8;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(130px, 1fr));
  gap: 8px;
}

.stats-grid > div {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 8px;
}

.stats-grid span {
  display: block;
  font-size: 11px;
  color: #94a3b8;
}

.card-section {
  margin-top: 14px;
}

.card-section h3 {
  font-size: 14px;
  margin-bottom: 8px;
}

.pipeline-list,
.activity-list,
.timeline,
.context-pack,
.final-grid,
.ask-doc {
  display: grid;
  gap: 8px;
}

.pipeline-stage {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 12px;
  overflow: hidden;
}

.pipeline-stage.done {
  border-color: rgba(52, 211, 153, 0.42);
}

.pipeline-stage.active {
  border-color: rgba(245, 158, 11, 0.42);
  animation: pulse 1.4s infinite;
}

.pipeline-stage.error {
  border-color: rgba(248, 113, 113, 0.45);
}

.stage-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  padding: 10px;
  background: #0f1319;
  text-align: left;
}

.stage-head .left {
  display: grid;
  grid-template-columns: 10px auto;
  gap: 8px;
  align-items: center;
}

.stage-head .left small {
  color: #94a3b8;
  grid-column: 2;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #64748b;
}

.pipeline-stage.done .dot {
  background: #34d399;
}

.pipeline-stage.active .dot {
  background: #f59e0b;
}

.pipeline-stage.error .dot {
  background: #f87171;
}

.stage-head .right {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: #94a3b8;
}

.stage-body {
  border-top: 1px solid rgba(148, 163, 184, 0.18);
  padding: 10px;
  white-space: pre-wrap;
  color: #cbd5e1;
}

.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.activity-item,
.timeline-item {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 8px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.activity-item small,
.timeline-item p,
.timeline-item time,
.activity-item time {
  color: #94a3b8;
  font-size: 11px;
}

.context-item {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 8px;
}

.context-item summary {
  list-style: none;
  display: flex;
  justify-content: space-between;
  cursor: pointer;
}

.context-item summary::-webkit-details-marker {
  display: none;
}

.context-item small {
  display: block;
  color: #94a3b8;
}

.context-item .meta {
  display: flex;
  gap: 8px;
  align-items: center;
  color: #94a3b8;
  font-size: 11px;
}

.context-item pre,
.ask-doc pre {
  white-space: pre-wrap;
  margin-top: 8px;
  background: #0f1319;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 10px;
  padding: 10px;
  color: #cbd5e1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  max-height: 220px;
  overflow: auto;
}

.critical {
  color: #f87171;
}

.high {
  color: #f59e0b;
}

.medium {
  color: #60a5fa;
}

.low {
  color: #94a3b8;
}

.impact-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.impact-grid > div,
.final-grid details {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 8px;
}

.impact-grid span {
  display: block;
  color: #94a3b8;
  font-size: 11px;
}

.final-grid summary {
  cursor: pointer;
  font-weight: 600;
}

.final-grid ul {
  margin-top: 8px;
  padding-left: 18px;
}

.empty,
.empty-card {
  color: #94a3b8;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.35);
  }
  70% {
    box-shadow: 0 0 0 8px rgba(245, 158, 11, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0);
  }
}

@media (max-width: 1220px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
