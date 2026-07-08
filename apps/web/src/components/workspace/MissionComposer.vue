<script setup lang="ts">
const props = defineProps<{
  composer: string;
  compileBusy: boolean;
  error?: string;
  quickTemplates: string[];
  suggestedContext: string[];
  attachedContext: string[];
}>();

const emit = defineEmits<{
  (e: "update:composer", value: string): void;
  (e: "keydown", event: KeyboardEvent): void;
  (e: "use-template", value: string): void;
  (e: "toggle-attach", file: string): void;
  (e: "preview"): void;
  (e: "build"): void;
  (e: "ask"): void;
  (e: "composer-ref", el: HTMLTextAreaElement | null): void;
}>();

function setRef(el: Element | null) {
  emit("composer-ref", (el as HTMLTextAreaElement | null) || null);
}
</script>

<template>
  <section class="composer">
    <div class="composer-top">
      <h2>Новая миссия</h2>
      <div class="kbd-hints">
        <span>⌘/Ctrl + Enter → Сборка</span>
        <span>Shift + Enter → Вопрос</span>
      </div>
    </div>

    <textarea
      :ref="setRef"
      class="composer-input"
      :value="props.composer"
      placeholder="Опишите задачу для компиляции..."
      @input="emit('update:composer', ($event.target as HTMLTextAreaElement).value)"
      @keydown="emit('keydown', $event as KeyboardEvent)"
    />

    <div class="template-row">
      <button v-for="tpl in quickTemplates" :key="tpl" class="template-btn" @click="emit('use-template', tpl)">
        {{ tpl }}
      </button>
    </div>

    <div class="attach-block">
      <div class="label">Прикрепить контекст</div>
      <div class="attach-list">
        <button
          v-for="file in suggestedContext"
          :key="file"
          class="attach-chip"
          :class="{ active: attachedContext.includes(file) }"
          @click="emit('toggle-attach', file)"
        >
          {{ file }}
        </button>
      </div>
    </div>

    <div class="composer-actions">
      <button class="btn ghost" :disabled="compileBusy || !composer.trim()" @click="emit('preview')">Предпросмотр</button>
      <button class="btn primary" :disabled="compileBusy || !composer.trim()" @click="emit('build')">Сборка</button>
      <button class="btn ask" :disabled="compileBusy || !composer.trim()" @click="emit('ask')">Вопрос</button>
    </div>
    <p v-if="error" class="composer-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.composer {
  background: #11151b;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 16px;
  padding: 16px;
  margin-bottom: 14px;
}

.composer-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.kbd-hints {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: #94a3b8;
}

.composer-input {
  width: 100%;
  min-height: 96px;
  resize: none;
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: #0f1319;
  color: #e2e8f0;
  border-radius: 10px;
  padding: 10px 12px;
}

.template-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.template-btn,
.attach-chip {
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  color: #cbd5e1;
  background: #0f1319;
}

.attach-block {
  margin-top: 10px;
}

.label {
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 6px;
}

.attach-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attach-chip.active {
  border-color: rgba(52, 211, 153, 0.5);
  color: #6ee7b7;
  background: rgba(16, 185, 129, 0.16);
}

.composer-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  border-radius: 10px;
  padding: 10px 14px;
  font-weight: 600;
  border: 1px solid transparent;
}

.btn.ghost {
  background: #0f1319;
  border-color: rgba(148, 163, 184, 0.24);
  color: #cbd5e1;
}

.btn.primary {
  background: rgba(16, 185, 129, 0.2);
  border-color: rgba(52, 211, 153, 0.45);
  color: #6ee7b7;
}

.btn.ask {
  background: rgba(59, 130, 246, 0.2);
  border-color: rgba(96, 165, 250, 0.45);
  color: #93c5fd;
}

.composer-error {
  margin: 10px 0 0;
  color: #fca5a5;
  font-size: 12px;
  line-height: 1.4;
}
</style>
