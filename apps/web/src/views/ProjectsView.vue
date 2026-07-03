<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Project, Team } from "../types";

const route = useRoute();
const router = useRouter();

// Inject global data
const { providers: globalProviders, teams: globalTeams, projects: globalProjects, loading: globalLoading } = inject("globalData", {
  providers: ref<Provider[]>([]),
  teams: ref<Team[]>([]),
  projects: ref<Project[]>([]),
  loading: ref(true),
});

const projects = ref<Project[]>([]);
const teams = ref<Team[]>([]);
const selectedProject = ref<Project | null>(null);
const busy = ref(false);
const showCreateForm = ref(false);
const newProject = ref({ name: "", description: "", localPath: "", teamId: "" as string });
const folderPickerSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;

async function loadData() {
  if (globalProjects.value.length) {
    projects.value = globalProjects.value;
    teams.value = globalTeams.value;
  } else {
    const [projectsRes, teamsRes] = await Promise.all([api.projects(), api.teams()]);
    projects.value = projectsRes.projects;
    teams.value = teamsRes.teams;
  }
  const id = route.params.id as string | undefined;
  if (id) {
    selectedProject.value = projects.value.find(p => p.id === id) || null;
  } else if (projects.value[0]) {
    selectedProject.value = projects.value[0];
  }
}

async function createProject() {
  busy.value = true;
  try {
    const res = await api.saveProject(newProject.value);
    projects.value.unshift(res.project);
    selectedProject.value = res.project;
    newProject.value = { name: "", description: "", localPath: "", teamId: "" };
    showCreateForm.value = false;
    router.push(`/projects/${res.project.id}`);
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка создания");
  } finally {
    busy.value = false;
  }
}

async function saveProject() {
  if (!selectedProject.value) return;
  busy.value = true;
  try {
    const res = await api.saveProject(selectedProject.value);
    const idx = projects.value.findIndex(p => p.id === res.project.id);
    if (idx >= 0) projects.value[idx] = res.project;
    selectedProject.value = res.project;
    alert("Сохранено");
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка сохранения");
  } finally {
    busy.value = false;
  }
}

async function deleteProject(id: string) {
  if (!confirm("Удалить проект и все данные?")) return;
  busy.value = true;
  try {
    await api.deleteProject(id);
    projects.value = projects.value.filter(p => p.id !== id);
    if (selectedProject.value?.id === id) {
      selectedProject.value = projects.value[0] || null;
      router.push(selectedProject.value ? `/projects/${selectedProject.value.id}` : "/projects");
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка удаления");
  } finally {
    busy.value = false;
  }
}

async function pickFolder() {
  if (!folderPickerSupported) {
    alert("Браузер не дает получить абсолютный путь. Вставь путь вручную.");
    return;
  }
  try {
    const handle = await (window as any).showDirectoryPicker();
    newProject.value.localPath = handle.name;
  } catch {}
}

watch(() => route.params.id, (id) => {
  if (id) selectedProject.value = projects.value.find(p => p.id === id) || null;
});

onMounted(loadData);
</script>

<template>
  <div class="projects-view">
    <header class="view-header">
      <h1>Проекты</h1>
      <button class="btn btn-primary" @click="showCreateForm = true" :disabled="busy">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Новый проект
      </button>
    </header>

    <div class="view-grid">
      <aside class="projects-sidebar">
        <div v-if="showCreateForm" class="create-form card">
          <h3>Новый проект</h3>
          <div class="form-group">
            <label>Имя</label>
            <input class="form-input" v-model="newProject.name" placeholder="Название проекта" />
          </div>
          <div class="form-group">
            <label>Локальная папка</label>
            <div style="display:flex;gap:8px">
              <input class="form-input" v-model="newProject.localPath" placeholder="/Users/evgenii/my-project" style="flex:1" />
              <button class="btn btn-ghost" @click="pickFolder" style="height:38px">Выбрать</button>
            </div>
          </div>
          <div class="form-group">
            <label>Описание</label>
            <textarea class="form-textarea" v-model="newProject.description" rows="3" placeholder="Описание проекта" />
          </div>
          <div class="form-group">
            <label>Команда</label>
            <select class="form-select" v-model="newProject.teamId">
              <option value="">Не назначена</option>
              <option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" @click="createProject" :disabled="busy || !newProject.name.trim()">Создать</button>
            <button class="btn btn-ghost" @click="showCreateForm = false">Отмена</button>
          </div>
        </div>

        <div v-else class="projects-list">
          <div v-for="p in projects" :key="p.id" class="project-item" :class="{ active: selectedProject?.id === p.id }" @click="router.push(`/projects/${p.id}`)">
            <div class="project-info">
              <strong>{{ p.name }}</strong>
              <span class="project-path">{{ p.localPath }}</span>
            </div>
          </div>
          <div v-if="!projects.length" class="empty-state">Проектов нет. Нажми «Новый проект».</div>
        </div>
      </aside>

      <section class="projects-detail" v-if="selectedProject">
        <div class="card">
          <h3>{{ selectedProject.name }}</h3>
          <div class="form-group">
            <label>Имя</label>
            <input class="form-input" v-model="selectedProject.name" />
          </div>
          <div class="form-group">
            <label>Локальная папка</label>
            <input class="form-input" v-model="selectedProject.localPath" />
          </div>
          <div class="form-group">
            <label>Описание</label>
            <textarea class="form-textarea" v-model="selectedProject.description" rows="3" />
          </div>
          <div class="form-group">
            <label>Команда проекта</label>
            <select class="form-select" v-model="selectedProject.teamId">
              <option value="">Не назначена</option>
              <option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>Контейнерный путь</label>
            <input class="form-input" :value="selectedProject.containerPath" readonly style="background:var(--bg);color:var(--muted)" />
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" @click="saveProject" :disabled="busy">Сохранить</button>
            <button class="btn btn-danger" @click="deleteProject(selectedProject.id)" :disabled="busy">Удалить проект и все данные</button>
          </div>
        </div>
      </section>

      <div v-else class="empty-state" style="flex:1;display:flex;align-items:center;justify-content:center">
        <p>Выбери проект слева или создай новый</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding:0 20px; }
.view-grid { display:grid; grid-template-columns:300px 1fr; gap:20px; padding:0 20px 20px; }
.projects-sidebar { min-height:500px; }
.projects-list { display:flex; flex-direction:column; gap:8px; }
.project-item { padding:12px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); cursor:pointer; transition:all .15s; }
.project-item:hover { background:var(--bg); }
.project-item.active { border-color:var(--accent); background:var(--accent-bg); }
.project-info { display:flex; flex-direction:column; gap:4px; }
.project-path { font-size:12px; color:var(--muted); }
.create-form { display:flex; flex-direction:column; gap:12px; padding:16px; }
.form-group { display:flex; flex-direction:column; gap:6px; }
.form-group label { font-size:13px; color:var(--text-dim); }
.form-input, .form-select, .form-textarea { padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; }
.form-textarea { resize:vertical; min-height:80px; }
.form-actions { display:flex; gap:8px; margin-top:8px; }
.card { padding:20px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); }
.empty-state { color:var(--muted); text-align:center; padding:40px; }
.projects-detail { min-height:500px; }
</style>