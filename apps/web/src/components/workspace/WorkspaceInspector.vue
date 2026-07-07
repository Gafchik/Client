<script setup lang="ts">
import type { InspectorTab, MissionHistoryItem } from "./types";

const props = defineProps<{
  mission: MissionHistoryItem | null;
  tab: InspectorTab;
}>();

const emit = defineEmits<{
  (e: "update:tab", tab: InspectorTab): void;
}>();
</script>

<template>
  <aside class="right-panel">
    <div class="tabs">
      <button :class="{ active: tab === 'knowledge' }" @click="emit('update:tab', 'knowledge')">Knowledge</button>
      <button :class="{ active: tab === 'sources' }" @click="emit('update:tab', 'sources')">Sources</button>
      <button :class="{ active: tab === 'ir' }" @click="emit('update:tab', 'ir')">Compiler IR</button>
      <button :class="{ active: tab === 'plan' }" @click="emit('update:tab', 'plan')">Execution Plan</button>
    </div>

    <div class="inspector-content" v-if="mission">
      <template v-if="tab === 'knowledge'">
        <h4>Entities</h4>
        <ul>
          <li v-for="entity in mission.compile?.knowledge?.topEntities || []" :key="entity.id">
            <strong>{{ entity.name }}</strong> · {{ entity.kind }} · {{ entity.location }}
          </li>
        </ul>
        <h4>Graph / Feature / API / Tests / ADR</h4>
        <p>Данные подтягиваются из существующего Knowledge Graph и Project Memory.</p>
      </template>

      <template v-else-if="tab === 'sources'">
        <ul>
          <li>Knowledge Graph</li>
          <li>Git</li>
          <li>Documentation</li>
          <li>Experience Memory</li>
          <li>Project Memory</li>
        </ul>
      </template>

      <template v-else-if="tab === 'ir'">
        <dl>
          <dt>Type</dt>
          <dd>{{ mission.compile?.intent?.intentType || "—" }}</dd>
          <dt>Scope</dt>
          <dd>{{ mission.compile?.plan?.runMode || "—" }}</dd>
          <dt>Entities</dt>
          <dd>{{ (mission.compile?.intent?.entities || []).join(", ") || "—" }}</dd>
          <dt>Acceptance Criteria</dt>
          <dd>{{ mission.compile?.plan?.executionTask || "—" }}</dd>
          <dt>Risk</dt>
          <dd>{{ mission.compile?.impact?.riskLevel || "—" }}</dd>
          <dt>Restrictions</dt>
          <dd>{{ (mission.compile?.intent?.reasons || []).join("; ") || "—" }}</dd>
        </dl>
      </template>

      <template v-else>
        <h4>Execution Plan</h4>
        <p>{{ mission.compile?.plan?.executionTask || "План будет доступен после preview/compile." }}</p>
        <h4>Stages</h4>
        <ul>
          <li v-for="stage in mission.compile?.plan?.stages || []" :key="stage.id">
            {{ stage.title }} · {{ stage.enabled ? "enabled" : "disabled" }}
          </li>
        </ul>
      </template>
    </div>

    <div v-else class="inspector-empty">Нет выбранной миссии.</div>
  </aside>
</template>

<style scoped>
.right-panel {
  background: #0f1319;
  border-left: 1px solid rgba(148, 163, 184, 0.16);
  padding: 16px;
  overflow: auto;
}

.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.tabs button {
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: #0b0d10;
  color: #cbd5e1;
  padding: 8px;
  font-size: 12px;
  font-weight: 600;
}

.tabs button.active {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.5);
  background: rgba(16, 185, 129, 0.16);
}

.inspector-content h4 {
  margin: 10px 0 6px;
  color: #e2e8f0;
}

.inspector-content ul,
.inspector-content dl {
  display: grid;
  gap: 6px;
}

.inspector-content li,
.inspector-content dd {
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 10px;
  padding: 8px;
  color: #cbd5e1;
}

.inspector-content dt,
.inspector-empty {
  color: #94a3b8;
  font-size: 12px;
}
</style>
