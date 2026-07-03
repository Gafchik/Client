import { createRouter, createWebHistory } from "vue-router";
import WorkspaceView from "./views/WorkspaceView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import TeamsView from "./views/TeamsView.vue";
import ProvidersView from "./views/ProvidersView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/workspace" },
    { path: "/workspace", name: "workspace", component: WorkspaceView },
    { path: "/projects", name: "projects", component: ProjectsView },
    { path: "/projects/:id", name: "project-detail", component: ProjectsView },
    { path: "/teams", name: "teams", component: TeamsView },
    { path: "/teams/:id", name: "team-detail", component: TeamsView },
    { path: "/providers", name: "providers", component: ProvidersView },
    { path: "/providers/:id", name: "provider-detail", component: ProvidersView },
  ],
});