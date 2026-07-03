import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/workspace" },
    { path: "/workspace", name: "workspace" },
    { path: "/providers", name: "providers" },
    { path: "/teams", name: "teams" },
    { path: "/projects", name: "projects" },
  ],
});
