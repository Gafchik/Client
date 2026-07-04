<script setup lang="ts">
import { inject, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Provider, Team, Project } from "../types";

const route = useRoute();
const router = useRouter();

// Inject global data
const { providers: globalProviders, teams: globalTeams, projects: globalProjects, loading: globalLoading } = inject("globalData", {
  providers: ref<Provider[]>([]),
  teams: ref<Team[]>([]),
  projects: ref<Project[]>([]),
  loading: ref(true),
});

const providers = ref<Provider[]>([]);
const selectedProvider = ref<Provider | null>(null);
const busy = ref(false);
const showCreateForm = ref(false);
const newProvider = ref({ name: "", baseUrl: "https://api.rout.my/v1", apiKey: "", modelsUrl: "https://api.rout.my/v1/models", isCurrent: false });

async function loadData() {
  if (globalProviders.value.length) {
    providers.value = globalProviders.value;
  } else {
    const res = await api.providers();
    providers.value = res.providers;
  }
  const id = route.params.id as string | undefined;
  if (id) {
    selectedProvider.value = providers.value.find(p => p.id === id) || null;
  } else if (providers.value[0]) {
    selectedProvider.value = providers.value[0];
  }
}

async function createProvider() {
  busy.value = true;
  try {
    const res = await api.saveProvider(newProvider.value);
    providers.value.unshift(res.provider);
    selectedProvider.value = res.provider;
    newProvider.value = { name: "", baseUrl: "https://api.rout.my/v1", apiKey: "", modelsUrl: "https://api.rout.my/v1/models", isCurrent: providers.value.length === 1 };
    showCreateForm.value = false;
    router.push(`/providers/${res.provider.id}`);
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка создания");
  } finally {
    busy.value = false;
  }
}

async function saveProvider() {
  if (!selectedProvider.value) return;
  busy.value = true;
  try {
    const res = await api.saveProvider(selectedProvider.value);
    const idx = providers.value.findIndex(p => p.id === res.provider.id);
    if (idx >= 0) providers.value[idx] = res.provider;
    selectedProvider.value = res.provider;
    const modelsRes = await api.models();
    alert("Сохранено");
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка сохранения");
  } finally {
    busy.value = false;
  }
}

async function deleteProvider(id: string) {
  if (!confirm("Удалить провайдера?")) return;
  busy.value = true;
  try {
    await api.deleteProvider(id);
    providers.value = providers.value.filter(p => p.id !== id);
    if (selectedProvider.value?.id === id) {
      selectedProvider.value = providers.value[0] || null;
      router.push(selectedProvider.value ? `/providers/${selectedProvider.value.id}` : "/providers");
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : "Ошибка удаления");
  } finally {
    busy.value = false;
  }
}

watch(() => route.params.id, (id) => {
  if (id) selectedProvider.value = providers.value.find(p => p.id === id) || null;
});

onMounted(loadData);
</script>

<template>
  <div class="providers-view">
    <header class="view-header">
      <h1>Провайдеры</h1>
      <button class="btn btn-primary" @click="showCreateForm = true" :disabled="busy">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Новый провайдер
      </button>
    </header>

    <div class="view-grid">
      <aside class="providers-sidebar">
        <div v-if="showCreateForm" class="create-form card">
          <h3>Новый провайдер</h3>
          <div class="form-group"><label>Имя</label><input class="form-input" v-model="newProvider.name" placeholder="Название провайдера" /></div>
          <div class="form-group"><label>Base URL</label><input class="form-input" v-model="newProvider.baseUrl" placeholder="https://api.example.com/v1" /></div>
          <div class="form-group"><label>API Key</label><input class="form-input" type="password" v-model="newProvider.apiKey" placeholder="Вставь API ключ" /></div>
          <div class="form-group"><label>Models URL</label><input class="form-input" v-model="newProvider.modelsUrl" placeholder="https://api.example.com/v1/models" /></div>
          <div class="form-group"><label class="checkbox-row"><input type="checkbox" v-model="newProvider.isCurrent" /><span>Current provider</span></label></div>
          <div class="form-actions">
            <button class="btn btn-primary" @click="createProvider" :disabled="busy || !newProvider.name.trim()">Создать</button>
            <button class="btn btn-ghost" @click="showCreateForm = false">Отмена</button>
          </div>
        </div>

        <div v-else class="providers-list">
          <div v-for="p in providers" :key="p.id" class="provider-item" :class="{ active: selectedProvider?.id === p.id }" @click="router.push(`/providers/${p.id}`)">
            <strong>{{ p.name }}</strong>
            <span class="provider-url">{{ p.baseUrl }}</span>
          </div>
          <div v-if="!providers.length" class="empty-state">Провайдеров нет. Нажми «Новый провайдер».</div>
        </div>
      </aside>

      <section class="providers-detail" v-if="selectedProvider">
        <div class="card">
          <header class="detail-header">
            <h3>{{ selectedProvider.name }}</h3>
            <button class="btn btn-primary" @click="saveProvider" :disabled="busy">Сохранить</button>
          </header>
          <div class="form-group"><label>Имя</label><input class="form-input" v-model="selectedProvider.name" /></div>
          <div class="form-group"><label>Base URL</label><input class="form-input" v-model="selectedProvider.baseUrl" /></div>
          <div class="form-group"><label>API Key</label><input class="form-input" type="password" :placeholder="selectedProvider.hasApiKey ? selectedProvider.apiKeyMasked || 'Ключ уже сохранён' : 'Вставь API ключ'" v-model="selectedProvider.apiKey" /></div>
          <div class="form-group"><label>Models URL</label><input class="form-input" v-model="selectedProvider.modelsUrl" /></div>
          <div class="form-group"><label class="checkbox-row" style="display:flex;align-items:center;gap:10px"><input type="checkbox" v-model="selectedProvider.isCurrent" /><span>Current provider</span></label></div>
        </div>
      </section>

      <div v-else class="empty-state" style="flex:1;display:flex;align-items:center;justify-content:center"><p>Выбери провайдера слева или создай новый</p></div>
    </div>
  </div>
</template>

<style scoped>
.view-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding:0 20px; }
.view-grid { display:grid; grid-template-columns:300px 1fr; gap:20px; padding:0 20px 20px; }
.providers-sidebar { min-height:500px; }
.providers-list { display:flex; flex-direction:column; gap:8px; }
.provider-item { padding:12px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); cursor:pointer; }
.provider-item:hover { background:var(--bg); }
.provider-item.active { border-color:var(--accent); background:var(--accent-bg); }
.provider-url { font-size:12px; color:var(--muted); }
.create-form { display:flex; flex-direction:column; gap:12px; padding:16px; }
.form-group { display:flex; flex-direction:column; gap:6px; }
.form-group label { font-size:13px; color:var(--text-dim); }
.form-input, .form-select, .form-textarea { padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--bg); color:var(--text); font:inherit; }
.form-textarea { resize:vertical; min-height:80px; }
.form-actions { display:flex; gap:8px; margin-top:8px; }
.card { padding:20px; border-radius:var(--radius); background:var(--panel); border:1px solid var(--line); }
.detail-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
.checkbox-row { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--text); cursor:pointer; }
.empty-state { color:var(--muted); text-align:center; padding:40px; }
</style>