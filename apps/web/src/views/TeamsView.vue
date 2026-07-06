<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Team, Provider, Project, ModelCatalogItem } from "../types";

const route = useRoute();
const router = useRouter();

// Inject global data
const { providers: globalProviders, teams: globalTeams, projects: globalProjects, loading: globalLoading } = inject("globalData", {
  providers: ref<Provider[]>([]),
  teams: ref<Team[]>([]),
  projects: ref<Project[]>([]),
  loading: ref(true),
});

const teams = ref<Team[]>([]);
const providers = ref<Provider[]>([]);
const models = ref<ModelCatalogItem[]>([]);
const selectedTeam = ref<Team | null>(null);
const busy = ref(false);
const showCreateForm = ref(false);
const newTeam = ref({
  name: "",
  description: "",
  providerId: "",
  language: "ru",
  budget: { dailyWeightedTokens: 50000000, timezone: "Europe/Kiev" },
  workspace: { maxFiles: 12, maxCharsPerFile: 12000, includeExtensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html", ".py", ".php", ".vue"], ignoreDirs: [".git", "node_modules", "dist", "build"] },
  run: { maxReviewRounds: 1, applyChanges: true },
  testing: { commands: [] },
  agents: {
    pm: { name: "Mira", label: "Проджект-менеджер", model: "", multiplier: 1, temperature: 0.2 },
    developer: { name: "Kai", label: "Разработчик", model: "", multiplier: 1, temperature: 0.15 },
    tester: { name: "Nova", label: "Тестировщик", model: "", multiplier: 1, temperature: 0.1 },
    reviewer: { name: "Rex", label: "Ревьювер", model: "", multiplier: 1, temperature: 0.1 },
  },
});

const TEAM_LANGUAGES = [
  { value: "en", label: "English" }, { value: "ru", label: "Русский" }, { value: "uk", label: "Українська" },
  { value: "ar", label: "العربية" }, { value: "hi", label: "हिन्दी" }, { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" }, { value: "es", label: "Español" }, { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" }, { value: "pl", label: "Polski" }, { value: "tr", label: "Türkçe" },
  { value: "zh", label: "中文" }, { value: "ja", label: "日本語" }, { value: "ko", label: "한국어" },
] as const;

const modelGroups = computed(() =>
  models.value.reduce<Record<string, ModelCatalogItem[]>>((groups, model) => {
    if (!groups[model.provider]) groups[model.provider] = [];
    groups[model.provider].push(model);
    return groups;
  }, {}),
);

async function loadModelsForProvider(providerId: string) {
  // Модели тянутся из modelsUrl КОНКРЕТНОГО провайдера (в БД у каждого свой).
  // Раньше грузили общий список — и при выборе стороннего провайдера команда
  // видела модели дефолтного rout.my, а сохранённый multiplier не совпадал с
  // реальным у модели выбранного провайдера.
  const modelsRes = await api.models(providerId);
  models.value = modelsRes.items;
  return models.value;
}

async function loadData() {
  if (globalTeams.value.length) {
    teams.value = globalTeams.value;
    providers.value = globalProviders.value;
  } else {
    const [teamsRes, providersRes] = await Promise.all([api.teams(), api.providers()]);
    teams.value = teamsRes.teams;
    providers.value = providersRes.providers;
  }

  const id = route.params.id as string | undefined;
  if (id) {
    selectedTeam.value = teams.value.find(t => t.id === id) || null;
  } else if (teams.value[0]) {
    selectedTeam.value = teams.value[0];
  }
  if (providers.value[0] && !newTeam.value.providerId) newTeam.value.providerId = providers.value[0].id;

  // Грузим модели под провайдер выбранной команды (или дефолтного — для формы).
  const initialProviderId =
    selectedTeam.value?.providerId ||
    newTeam.value.providerId ||
    providers.value[0]?.id ||
    "";
  if (initialProviderId) {
    await loadModelsForProvider(initialProviderId);
    if (models.value[0]) {
      const firstModel = models.value[0].id;
      const firstMultiplier = models.value[0].multiplier;
      (Object.keys(newTeam.value.agents) as Array<keyof typeof newTeam.value.agents>).forEach(role => {
        newTeam.value.agents[role].model = firstModel;
        newTeam.value.agents[role].multiplier = firstMultiplier;
      });
    }
  }
}

function applyModel(role: string, modelId: string) {
  if (!selectedTeam.value) return;
  const model = models.value.find(m => m.id === modelId);
  if (!model) return;
  selectedTeam.value.agents[role].model = model.id;
  selectedTeam.value.agents[role].multiplier = model.multiplier;
}

async function createTeam() {
  busy.value = true;
  try {
    const res = await api.saveTeam(newTeam.value);
    teams.value.unshift(res.team);
    selectedTeam.value = res.team;
    newTeam.value = {
      name: "", description: "", providerId: providers.value[0]?.id || "", language: "ru",
      budget: { dailyWeightedTokens: 50000000, timezone: "Europe/Kiev" },
      workspace: { maxFiles: 12, maxCharsPerFile: 12000, includeExtensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html", ".py", ".php", ".vue"], ignoreDirs: [".git", "node_modules", "dist", "build"] },
      run: { maxReviewRounds: 1, applyChanges: true }, testing: { commands: [] },
      agents: {
        pm: { name: "Mira", label: "Проджект-менеджер", model: models.value[0]?.id || "", multiplier: models.value[0]?.multiplier || 1, temperature: 0.2 },
        developer: { name: "Kai", label: "Разработчик", model: models.value[0]?.id || "", multiplier: models.value[0]?.multiplier || 1, temperature: 0.15 },
        tester: { name: "Nova", label: "Тестировщик", model: models.value[0]?.id || "", multiplier: models.value[0]?.multiplier || 1, temperature: 0.1 },
        reviewer: { name: "Rex", label: "Ревьювер", model: models.value[0]?.id || "", multiplier: models.value[0]?.multiplier || 1, temperature: 0.1 },
      },
    };
    showCreateForm.value = false;
    router.push(`/teams/${res.team.id}`);
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка создания");
  } finally {
    busy.value = false;
  }
}

async function saveTeam() {
  if (!selectedTeam.value) return;
  busy.value = true;
  try {
    const res = await api.saveTeam(selectedTeam.value);
    const idx = teams.value.findIndex(t => t.id === res.team.id);
    if (idx >= 0) teams.value[idx] = res.team;
    selectedTeam.value = res.team;
    alert("Сохранено");
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка сохранения");
  } finally {
    busy.value = false;
  }
}

function confirmDeleteTeam() {
  if (!selectedTeam.value) return;
  if (!confirm(`Удалить команду «${selectedTeam.value.name}»? Это действие нельзя отменить.`)) return;
  deleteTeam(selectedTeam.value.id);
}

async function deleteTeam(id: string) {
  busy.value = true;
  try {
    await api.deleteTeam(id);
    teams.value = teams.value.filter(t => t.id !== id);
    if (selectedTeam.value?.id === id) {
      selectedTeam.value = teams.value[0] || null;
      router.push(selectedTeam.value ? `/teams/${selectedTeam.value.id}` : "/teams");
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка удаления");
  } finally {
    busy.value = false;
  }
}

// При переключении команды — подгружаем модели её провайдера, чтобы селект
// моделей показывал именно её список (а не «чужой» от прошлого провайдера).
watch(() => route.params.id, async (id) => {
  if (id) {
    selectedTeam.value = teams.value.find(t => t.id === id) || null;
    const pid = selectedTeam.value?.providerId;
    if (pid) await loadModelsForProvider(pid);
  }
});

// При смене провайдера прямо в форме команды — перезагружаем каталог моделей
// под новый провайдер. Если у текущих агентов модель отсутствует в новом
// списке, сбрасываем её на первую доступную (и подтягиваем её multiplier).
watch(() => selectedTeam.value?.providerId, async (pid) => {
  if (!pid) return;
  await loadModelsForProvider(pid);
  if (!selectedTeam.value) return;
  const first = models.value[0];
  for (const role of Object.keys(selectedTeam.value.agents)) {
    const agent = selectedTeam.value.agents[role as keyof typeof selectedTeam.value.agents] as { model: string; multiplier: number };
    if (!models.value.some(m => m.id === agent.model)) {
      agent.model = first?.id || "";
      agent.multiplier = first?.multiplier ?? 1;
    }
  }
});

// Аналогично для формы создания новой команды: сменили провайдер → сменили
// доступные модели и умолчания для агентов.
watch(() => newTeam.value.providerId, async (pid) => {
  if (!pid) return;
  await loadModelsForProvider(pid);
  const first = models.value[0];
  if (first) {
    Object.keys(newTeam.value.agents).forEach(role => {
      newTeam.value.agents[role as keyof typeof newTeam.value.agents].model = first.id;
      newTeam.value.agents[role as keyof typeof newTeam.value.agents].multiplier = first.multiplier;
    });
  }
});

onMounted(loadData);
</script>

<template>
  <div class="teams-view">
    <header class="view-header">
      <h1>Команды</h1>
      <button class="btn btn-primary" @click="showCreateForm = true" :disabled="busy">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Новая команда
      </button>
    </header>

    <div class="view-grid">
      <aside class="teams-sidebar">
        <div v-if="showCreateForm" class="create-form card">
          <h3>Новая команда</h3>
          <div class="form-group"><label>Название</label><input class="form-input" v-model="newTeam.name" /></div>
          <div class="form-group"><label>Описание</label><textarea class="form-textarea" v-model="newTeam.description" rows="3" /></div>
          <div class="form-group"><label>Провайдер</label><select class="form-select" v-model="newTeam.providerId"><option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option></select></div>
          <div class="form-group"><label>Язык ответов</label><select class="form-select" v-model="newTeam.language"><option v-for="l in TEAM_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option></select></div>
          <div class="form-actions">
            <button class="btn btn-primary" @click="createTeam" :disabled="busy || !newTeam.name.trim()">Создать</button>
            <button class="btn btn-ghost" @click="showCreateForm = false">Отмена</button>
          </div>
        </div>

        <div v-else class="teams-list">
          <div v-for="t in teams" :key="t.id" class="team-item" :class="{ active: selectedTeam?.id === t.id }" @click="router.push(`/teams/${t.id}`)">
            <strong>{{ t.name }}</strong>
            <span class="team-desc">{{ t.description }}</span>
          </div>
          <div v-if="!teams.length" class="empty-state">Команд нет. Нажми «Новая команда».</div>
        </div>
      </aside>

      <section class="teams-detail" v-if="selectedTeam">
        <div class="card">
          <header class="detail-header">
            <h3>{{ selectedTeam.name }}</h3>
            <div class="detail-actions">
              <button class="btn btn-primary" @click="saveTeam" :disabled="busy">Сохранить</button>
              <button class="btn btn-danger" @click="confirmDeleteTeam" :disabled="busy">Удалить команду</button>
            </div>
          </header>
          <div class="detail-grid">
            <div class="setting-card">
              <h4>Базовые настройки</h4>
              <div class="form-group"><label>Название</label><input class="form-input" v-model="selectedTeam.name" /></div>
              <div class="form-group"><label>Описание</label><textarea class="form-textarea" v-model="selectedTeam.description" rows="3" /></div>
              <div class="form-group"><label>Провайдер</label><select class="form-select" v-model="selectedTeam.providerId"><option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option></select></div>
              <div class="form-group"><label>Язык ответов</label><select class="form-select" v-model="selectedTeam.language"><option v-for="l in TEAM_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option></select></div>
            </div>
            <div class="setting-card">
              <h4>Контекст и запуск</h4>
              <div style="display:grid;gap:12px">
                <div class="report-view small">Лимит файлов: {{ selectedTeam.workspace.maxFiles }}</div>
                <div class="report-view small">Символов на файл: {{ selectedTeam.workspace.maxCharsPerFile }}</div>
                <div class="report-view small">Review rounds: {{ selectedTeam.run.maxReviewRounds }}</div>
                <div class="report-view small">Дневной budget: {{ selectedTeam.budget.dailyWeightedTokens.toLocaleString() }} weighted</div>
              </div>
            </div>
            <div class="setting-card" style="grid-column:1/-1">
              <h4>Роли команды</h4>
              <div class="agent-grid">
                <div v-for="(agent, role) in selectedTeam.agents" :key="role" class="agent-card">
                  <div class="agent-header">
                    <div class="agent-avatar" :class="role">{{ role.charAt(0).toUpperCase() }}</div>
                    <div class="agent-info"><h4>{{ agent.name || agent.label }}</h4><span class="agent-role">{{ role }}</span></div>
                  </div>
                  <div class="agent-fields">
                    <div class="form-group"><label>Имя агента</label><input class="form-input" v-model="agent.name" /></div>
                    <div class="form-group"><label>Название</label><input class="form-input" v-model="agent.label" /></div>
                    <div class="form-group"><label>Модель</label><select class="form-select" :value="agent.model" @change="applyModel(role, ($event.target as HTMLSelectElement).value)"><optgroup v-for="(items, provider) in modelGroups" :key="provider" :label="provider"><option v-for="m in items" :key="m.id" :value="m.id">{{ m.label }} ({{ m.multiplier }}x)</option></optgroup></select></div>
                    <div class="form-group"><label>Множитель</label><input class="form-input" type="number" step="0.1" v-model.number="agent.multiplier" /></div>
                    <div class="form-group"><label>Temperature</label><input class="form-input" type="number" step="0.05" v-model.number="agent.temperature" /></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div v-else class="empty-state" style="flex:1;display:flex;align-items:center;justify-content:center"><p>Выбери команду слева или создай новую</p></div>
    </div>
  </div>
</template>

<style scoped>
.view-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding:0 20px; }
.view-grid { display:grid; grid-template-columns:300px 1fr; gap:20px; padding:0 20px 20px; }
.teams-sidebar { min-height:500px; }
.teams-list { display:flex; flex-direction:column; gap:8px; }
.team-item { padding:12px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); cursor:pointer; }
.team-item:hover { background:var(--bg); }
.team-item.active { border-color:var(--accent); background:var(--accent-bg); }
.team-desc { font-size:12px; color:var(--muted); }
.create-form { display:flex; flex-direction:column; gap:12px; padding:16px; }
.form-group { display:flex; flex-direction:column; gap:6px; }
.form-group label { font-size:13px; color:var(--text-dim); }
.form-input, .form-select, .form-textarea { padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; }
.form-textarea { resize:vertical; min-height:80px; }
.form-actions { display:flex; gap:8px; margin-top:8px; }
.card { padding:20px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); }
.detail-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
.detail-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:20px; }
.setting-card { padding:16px; border-radius:var(--radius); background:var(--bg); border:1px solid var(--line); }
.setting-card h4 { margin:0 0 16px; font-size:14px; color:var(--text-dim); }
.agent-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
.agent-card { padding:16px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); }
.agent-header { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
.agent-avatar { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:600; font-size:14px; }
.agent-avatar.developer { background:#f59e0b; }
.agent-avatar.tester { background:#ef4444; }
.agent-avatar.pm { background:#10b981; }
.agent-avatar.reviewer { background:#8b5cf6; }
.agent-info h4 { margin:0; font-size:14px; }
.agent-role { font-size:11px; color:var(--muted); text-transform:uppercase; }
.agent-fields { display:flex; flex-direction:column; gap:12px; }
.empty-state { color:var(--muted); text-align:center; padding:40px; }
.report-view.small { padding:8px 12px; font-size:12px; }
.detail-actions { display:flex; gap:8px; align-items:center; }
.btn-danger { background:#ef4444; color:#fff; border:none; }
.btn-danger:hover { background:#dc2626; }
.btn-danger:disabled { opacity:0.6; cursor:not-allowed; }
</style>