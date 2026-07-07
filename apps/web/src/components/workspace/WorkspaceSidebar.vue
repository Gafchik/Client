<script setup lang="ts">
import type { Project, Team } from "../../types";
import type { MissionHistoryItem } from "./types";

const props = defineProps<{
  projects: Project[];
  teams: Team[];
  selectedProjectId: string;
  selectedTeamId: string;
  missionMode: "build" | "ask";
  search: string;
  missions: MissionHistoryItem[];
  selectedMissionId: string;
  formatDateTime: (value?: string) => string;
  formatDuration: (sec?: number) => string;
}>();

const emit = defineEmits<{
  (e: "update:selectedProjectId", value: string): void;
  (e: "update:selectedTeamId", value: string): void;
  (e: "update:missionMode", value: "build" | "ask"): void;
  (e: "update:search", value: string): void;
  (e: "select-mission", missionId: string): void;
}>();
</script>

<template>
  <aside class="left-panel">
    <div class="left-head">
      <div>
        <h1>Mission Control</h1>
        <p>AI Compiler Workspace</p>
      </div>
      <span class="mode-pill" :class="missionMode">{{ missionMode.toUpperCase() }}</span>
    </div>

    <div class="left-block">
      <label>Текущий проект</label>
      <select :value="selectedProjectId" @change="emit('update:selectedProjectId', ($event.target as HTMLSelectElement).value)">
        <option v-for="project in props.projects" :key="project.id" :value="project.id">
          {{ project.name }}
        </option>
      </select>
    </div>

    <div class="left-block">
      <label>Текущая команда</label>
      <select :value="selectedTeamId" @change="emit('update:selectedTeamId', ($event.target as HTMLSelectElement).value)">
        <option v-for="team in props.teams" :key="team.id" :value="team.id">
          {{ team.name }}
        </option>
      </select>
    </div>

    <div class="mode-switch">
      <button class="switch-btn" :class="{ active: missionMode === 'build' }" @click="emit('update:missionMode', 'build')">Build</button>
      <button class="switch-btn" :class="{ active: missionMode === 'ask' }" @click="emit('update:missionMode', 'ask')">Ask</button>
    </div>

    <div class="left-block">
      <label>Быстрый поиск</label>
      <input :value="search" type="text" placeholder="Поиск по задачам..." @input="emit('update:search', ($event.target as HTMLInputElement).value)" />
    </div>

    <div class="history">
      <div class="history-title">История задач</div>
      <button
        v-for="mission in missions"
        :key="mission.id"
        class="history-item"
        :class="{ active: selectedMissionId === mission.id }"
        @click="emit('select-mission', mission.id)"
      >
        <div class="row between">
          <strong>{{ mission.title }}</strong>
          <span class="status" :data-status="mission.status">{{ mission.status }}</span>
        </div>
        <div class="row mini">
          <span>{{ formatDateTime(mission.createdAt) }}</span>
          <span>{{ mission.models.join(", ") || "auto" }}</span>
        </div>
        <div class="row mini">
          <span>Duration: {{ formatDuration(mission.durationSec) }}</span>
          <span>Files: {{ mission.changedFiles }}</span>
        </div>
        <div class="result">{{ mission.resultSummary }}</div>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.left-panel {
  background: #0f1319;
  border-right: 1px solid rgba(148, 163, 184, 0.16);
  padding: 16px;
  overflow: auto;
}

.left-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.left-head h1 {
  margin: 0;
  font-size: 18px;
}

.left-head p {
  margin: 4px 0 0;
  font-size: 12px;
  color: #94a3b8;
}

.mode-pill {
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid transparent;
  height: fit-content;
}

.mode-pill.build {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(16, 185, 129, 0.14);
}

.mode-pill.ask {
  color: #60a5fa;
  border-color: rgba(96, 165, 250, 0.4);
  background: rgba(59, 130, 246, 0.14);
}

.left-block {
  margin-bottom: 12px;
}

.left-block label {
  display: block;
  margin-bottom: 6px;
  color: #94a3b8;
  font-size: 12px;
}

select,
input {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: #0b0d10;
  color: #e2e8f0;
  border-radius: 10px;
  padding: 10px 12px;
}

.mode-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.switch-btn {
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: #0b0d10;
  color: #cbd5e1;
  padding: 10px;
  font-weight: 600;
}

.switch-btn.active {
  background: rgba(16, 185, 129, 0.16);
  border-color: rgba(52, 211, 153, 0.45);
  color: #6ee7b7;
}

.history-title {
  margin-bottom: 10px;
  font-size: 12px;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.history-item {
  width: 100%;
  text-align: left;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 12px;
  padding: 10px;
  margin-bottom: 8px;
  background: #0b0d10;
}

.history-item.active {
  border-color: rgba(52, 211, 153, 0.5);
  box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.35) inset;
}

.row {
  display: flex;
  gap: 8px;
}

.row.between {
  justify-content: space-between;
}

.row.mini {
  justify-content: space-between;
  margin-top: 6px;
  color: #94a3b8;
  font-size: 11px;
}

.result {
  margin-top: 8px;
  color: #cbd5e1;
  font-size: 12px;
}

.status {
  font-size: 10px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 99px;
  padding: 2px 6px;
}

.status[data-status="running"],
.status[data-status="queued"],
.status[data-status="awaiting_approval"] {
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.45);
}

.status[data-status="completed"],
.status[data-status="done"] {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.45);
}

.status[data-status="failed"],
.status[data-status="cancelled"] {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.45);
}
</style>
