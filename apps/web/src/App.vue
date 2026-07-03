<script setup lang="ts">
import { RouterView, useRouter, useRoute } from "vue-router";
import { ref, computed } from "vue";
import { api } from "./api";
import type { Provider, Team, Project } from "./types";

const router = useRouter();
const route = useRoute();

const providers = ref<Provider[]>([]);
const teams = ref<Team[]>([]);
const projects = ref<Project[]>([]);
const loading = ref(true);
const showMobileNav = ref(false);

const currentRoute = computed(() => route.path);

const navItems = [
  { path: "/workspace", label: "Работа", icon: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>` },
  { path: "/projects", label: "Проекты", icon: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>` },
  { path: "/teams", label: "Команды", icon: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` },
  { path: "/providers", label: "Провайдеры", icon: `<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>` },
];

async function loadGlobalData() {
  try {
    const [providersRes, teamsRes, projectsRes] = await Promise.all([
      api.providers(),
      api.teams(),
      api.projects(),
    ]);
    providers.value = providersRes.providers;
    teams.value = teamsRes.teams;
    projects.value = projectsRes.projects;
  } catch (e) {
    console.error("Failed to load global data:", e);
  } finally {
    loading.value = false;
  }
}

// Provide global data to child components
import { provide } from "vue";
provide("globalData", {
  providers,
  teams,
  projects,
  loading,
});

loadGlobalData();
</script>

<template>
  <div class="app-layout">
    <header class="app-header" v-if="!loading">
      <div class="header-left">
        <h1 class="app-title">AI Agent Team</h1>
      </div>
      <nav class="main-nav" :class="{ open: showMobileNav }">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :class="{ active: currentRoute === item.path || (item.path !== '/workspace' && currentRoute.startsWith(item.path)) }"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="item.icon" />
          <span>{{ item.label }}</span>
        </router-link>
      </nav>
      <button class="burger-btn" @click="showMobileNav = !showMobileNav" aria-label="Меню">
        <svg v-if="!showMobileNav" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>
    <div v-else class="app-loading">Загрузка...</div>
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-layout { display:flex; flex-direction:column; min-height:100vh; background:var(--bg); }
.app-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; position:sticky; top:0; z-index:100; }
.app-title { margin:0; font-size:18px; font-weight:600; color:var(--text); }
.main-nav { display:flex; gap:4px; }
.nav-item { display:flex; align-items:center; gap:8px; padding:8px 12px; border-radius:var(--radius); color:var(--muted); text-decoration:none; font-size:14px; transition:all .15s; white-space:nowrap; }
.nav-item:hover { color:var(--text); background:var(--bg); }
.nav-item.active { color:var(--accent); background:var(--accent-bg); }
.nav-item svg { width:18px; height:18px; flex-shrink:0; }
.burger-btn { display:none; padding:8px; border-radius:var(--radius); background:var(--bg); border:1px solid var(--line); color:var(--text); cursor:pointer; }
.burger-btn svg { width:22px; height:22px; }
.app-main { flex:1; min-height:0; }
.app-loading { padding:40px; text-align:center; color:var(--muted); }
@media (max-width: 900px) {
  .main-nav { display:none; position:absolute; top:100%; left:0; right:0; flex-direction:column; background:var(--panel); border-bottom:1px solid var(--line); padding:8px 20px; box-shadow:0 10px 30px rgba(0,0,0,.2); z-index:50; }
  .main-nav.open { display:flex; }
  .burger-btn { display:flex; }
}
</style>