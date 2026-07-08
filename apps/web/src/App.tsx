import { startTransition, useEffect, useState } from "react";
import type { ContextCandidate, KnowledgeCatalogEntry, PipelineRunResult, PipelineRunStatus, PipelineStage } from "@client/shared";

interface ProjectInfo {
  name: string;
  rootPath: string;
  summary: {
    totalFiles: number;
    indexedFiles: number;
    languages: Record<string, number>;
    profile?: "standard" | "large-repository";
  };
  recentRuns: KnowledgeCatalogEntry[];
  latestRun: PipelineRunResult | null;
}

type ArtifactTab = "research" | "impact" | "index" | "knowledge";
type ProviderDraft = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const PROVIDER_STORAGE_KEY = "client.provider-config";

function hasRunArtifacts(result: PipelineRunResult | null): result is PipelineRunResult {
  return Boolean(result?.runId && result?.project && result?.research && result?.impact);
}

function safeList<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function safeText(value: string | undefined | null, fallback = "Недоступно"): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function PanelFallback({ title, message }: { title: string; message: string }) {
  return (
    <div className="list">
      <div className="list-item fallback-item">
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
    </div>
  );
}

function ProjectPanel({ project, loading }: { project: ProjectInfo | null; loading: boolean }) {
  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Проект</h2>
        <span>{loading ? "Загрузка" : safeText(project?.name, "Неизвестно")}</span>
      </div>

      {project ? (
        <div className="stack">
          <div className="list">
            <div className="list-item">
              <strong>Текущий анализируемый проект</strong>
              <span>{safeText(project.name)}</span>
            </div>
            <div className="list-item compact">
              <span>{safeText(project.rootPath)}</span>
            </div>
          </div>
          <p className="stat">
            <strong>{safeCount(project.summary?.indexedFiles)}</strong> файлов проиндексировано в{" "}
            <strong>{Object.keys(project.summary?.languages ?? {}).length}</strong> языках.
          </p>
          <p className="muted">
            Профиль репозитория: {safeText(project.summary?.profile, "standard")}
          </p>
          <div className="chips">
            {Object.entries(project.summary?.languages ?? {}).map(([language, count]) => (
              <span key={language} className="chip">
                {language}: {count}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">Сводка по проекту появится здесь после ответа API.</p>
      )}
    </article>
  );
}

function RunsPanel({
  project,
  selectedRunId,
  onOpenRun,
}: {
  project: ProjectInfo | null;
  selectedRunId: string | null;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Последние Сохранённые Запуски</h2>
        <span>{safeList(project?.recentRuns).length}</span>
      </div>

      <div className="stack">
        {safeList(project?.recentRuns).length ? (
          safeList(project?.recentRuns)
            .slice(0, 5)
            .map((entry) => (
              <button
                key={entry.runId}
                type="button"
                className={`list-item selectable ${selectedRunId === entry.runId ? "selected" : ""}`}
                onClick={() => onOpenRun(entry.runId)}
              >
                <strong>{safeText(entry.summary)}</strong>
                <span>{safeText(entry.task)}</span>
                <span className="subtle">{new Date(entry.savedAt).toLocaleString()}</span>
              </button>
            ))
        ) : (
          <p className="muted">Пока нет сохранённых структурных запусков.</p>
        )}
      </div>
    </article>
  );
}

function ArtifactTabs({
  activeArtifact,
  setActiveArtifact,
}: {
  activeArtifact: ArtifactTab;
  setActiveArtifact: (value: ArtifactTab) => void;
}) {
  return (
    <div className="tabs">
      <button type="button" className={`tab ${activeArtifact === "research" ? "tab-active" : ""}`} onClick={() => setActiveArtifact("research")}>
        Исследование
      </button>
      <button type="button" className={`tab ${activeArtifact === "impact" ? "tab-active" : ""}`} onClick={() => setActiveArtifact("impact")}>
        Влияние
      </button>
      <button type="button" className={`tab ${activeArtifact === "index" ? "tab-active" : ""}`} onClick={() => setActiveArtifact("index")}>
        Индекс / Граф
      </button>
      <button type="button" className={`tab ${activeArtifact === "knowledge" ? "tab-active" : ""}`} onClick={() => setActiveArtifact("knowledge")}>
        Знания
      </button>
    </div>
  );
}

function ResearchArtifact({ result }: { result: PipelineRunResult }) {
  return (
    <div className="stack">
      <p className="stat">
        Уверенность исследования: <strong>{safeCount(result.research?.confidence)}%</strong>
      </p>
      <div className="list">
        <div className="list-item">
          <strong>Сводка</strong>
          <span>{safeText(result.research?.summary)}</span>
        </div>
        <div className="list-item">
          <strong>Класс вопроса</strong>
          <span>{safeText(result.research?.intentClass, "Не определён")}</span>
        </div>
        <div className="list-item">
          <strong>Стратегия исследования</strong>
          <span>{safeText(result.research?.strategyKey, "Не определена")}</span>
        </div>
        <div className="list-item">
          <strong>Профиль обхода</strong>
          <span>{safeText(result.research?.queryProfileKey, "Не определён")}</span>
        </div>
        <div className="list-item">
          <strong>Приоритетный модуль</strong>
          <span>{safeText(result.research?.dominantModule, "Не определён")}</span>
        </div>
        <div className="list-item">
          <strong>Затронутые модули</strong>
          <span>{safeList(result.research?.affectedModules).join(", ") || "Не определены"}</span>
        </div>
        <div className="list-item">
          <strong>Функциональная картина</strong>
          <span>{safeText(result.research?.functionalSummary)}</span>
        </div>
      </div>
      <div className="list">
        {safeList(result.research?.moduleIntents).length ? (
          safeList(result.research?.moduleIntents).slice(0, 3).map((intent) => (
            <div key={intent.module} className="list-item">
              <strong>{intent.module}</strong>
              <span>score {safeCount(intent.score)} / {intent.reasons.join(" ")}</span>
            </div>
          ))
        ) : (
          <PanelFallback title="Доменные модули" message="Для этого запуска модульный приоритет не был определён." />
        )}
      </div>
      <div className="list">
        <div className="list-item">
          <strong>Точки входа</strong>
          <span>{safeList(result.research?.entryPoints).join(", ") || "Не определены"}</span>
        </div>
        <div className="list-item">
          <strong>Ключевые сущности</strong>
          <span>{safeList(result.research?.primaryEntities).join(", ") || "Не определены"}</span>
        </div>
      </div>
      <div className="list">
        <div className="list-item">
          <strong>Побочные эффекты</strong>
          <span>{safeList(result.research?.sideEffects).join(", ") || "Не подтверждены"}</span>
        </div>
        <div className="list-item">
          <strong>Источники данных</strong>
          <span>{safeList(result.research?.dataSources).join(", ") || "Не определены"}</span>
        </div>
      </div>
      <div className="list">
        {safeList(result.research?.findings).length ? (
          safeList(result.research?.findings).map((finding) => (
            <div key={finding} className="list-item">
              <strong>Вывод</strong>
              <span>{finding}</span>
            </div>
          ))
        ) : (
          <PanelFallback title="Выводы" message="Для этого запуска выводы отсутствуют." />
        )}
      </div>
      <div className="list">
        {safeList(result.research?.unknowns).length ? (
          safeList(result.research?.unknowns).map((unknown) => (
            <div key={unknown} className="list-item">
              <strong>Неизвестная зона</strong>
              <span>{unknown}</span>
            </div>
          ))
        ) : (
          <div className="list-item">
            <strong>Неизвестные зоны</strong>
            <span>Критичных неизвестных зон не зафиксировано.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ImpactArtifact({ result }: { result: PipelineRunResult }) {
  return (
    <div className="stack">
      <p className="stat">
        Уверенность impact-анализа: <strong>{safeCount(result.impact?.confidence)}%</strong>
      </p>
      <div className="list">
        <div className="list-item">
          <strong>Сводка</strong>
          <span>{safeText(result.impact?.summary)}</span>
        </div>
        <div className="list-item">
          <strong>Стартовые точки</strong>
          <span>{safeList(result.impact?.startingPoints).length}</span>
        </div>
      </div>
      <div className="list">
        <div className="list-item">
          <strong>Затронутые файлы</strong>
          <span>{safeList(result.impact?.affectedFiles).join(", ") || "Не определены"}</span>
        </div>
        <div className="list-item">
          <strong>Затронутые символы</strong>
          <span>{safeList(result.impact?.affectedSymbols).join(", ") || "Не определены"}</span>
        </div>
      </div>
    </div>
  );
}

function IndexArtifact({ result }: { result: PipelineRunResult }) {
  return (
    <div className="stack">
      <div className="list">
        <div className="list-item">
          <strong>Git / ветка</strong>
          <span>{safeText(result.repository?.branch, result.repository?.isGitRepository ? "HEAD" : "Не Git-репозиторий")}</span>
        </div>
        <div className="list-item">
          <strong>Git / HEAD</strong>
          <span>{safeText(result.repository?.headCommit, "Недоступно")}</span>
        </div>
        <div className="list-item">
          <strong>Git / working tree</strong>
          <span>
            Всего {safeCount(result.repository?.summary?.changedFileCount)}, staged {safeCount(result.repository?.summary?.stagedCount)}, unstaged {safeCount(result.repository?.summary?.unstagedCount)}, untracked {safeCount(result.repository?.summary?.untrackedCount)}
          </span>
        </div>
        <div className="list-item">
          <strong>Манифест</strong>
          <span>{safeText(result.index?.manifest?.indexId)}</span>
        </div>
        <div className="list-item">
          <strong>Сводка графа</strong>
          <span>
            Узлы: {safeCount(result.graph?.summary?.nodeCount)}, рёбра: {safeCount(result.graph?.summary?.edgeCount)}
          </span>
        </div>
      </div>
      <div className="chips">
        {Object.entries(result.index?.stats?.languages ?? {}).map(([language, count]) => (
          <span key={language} className="chip">
            {language}: {count}
          </span>
        ))}
      </div>
    </div>
  );
}

function KnowledgeArtifact({ result }: { result: PipelineRunResult }) {
  return (
    <div className="stack">
      <div className="list">
        <div className="list-item">
          <strong>Repository Git</strong>
          <span>{result.repository?.isGitRepository ? "Подключён" : "Не обнаружен"}</span>
        </div>
        <div className="list-item">
          <strong>Base URL провайдера</strong>
          <span>{safeText(result.provider?.baseUrl, "Не задан")}</span>
        </div>
        <div className="list-item">
          <strong>Модель</strong>
          <span>{safeText(result.provider?.model, "Не задана")}</span>
        </div>
        <div className="list-item">
          <strong>API ключ</strong>
          <span>{safeText(result.provider?.apiKeyMasked, "Не задан")}</span>
        </div>
        <div className="list-item">
          <strong>Путь хранения</strong>
          <span>{safeText(result.knowledge?.storagePath)}</span>
        </div>
        <div className="list-item">
          <strong>Путь каталога</strong>
          <span>{safeText(result.knowledge?.catalogPath)}</span>
        </div>
        <div className="list-item">
          <strong>Количество артефактов</strong>
          <span>{safeCount(result.knowledge?.artifactCount)}</span>
        </div>
      </div>
    </div>
  );
}

function ArtifactViewer({ result, activeArtifact, setActiveArtifact }: { result: PipelineRunResult | null; activeArtifact: ArtifactTab; setActiveArtifact: (value: ArtifactTab) => void }) {
  return (
    <section className="panel panel-form">
      <div className="panel-header">
        <h2>Просмотр Артефактов</h2>
        <span>{result ? `Run ${result.runId.slice(0, 8)}` : "Ожидание"}</span>
      </div>

      <ArtifactTabs activeArtifact={activeArtifact} setActiveArtifact={setActiveArtifact} />

      {hasRunArtifacts(result) ? (
        <div className="artifact-view">
          {activeArtifact === "research" ? <ResearchArtifact result={result} /> : null}
          {activeArtifact === "impact" ? <ImpactArtifact result={result} /> : null}
          {activeArtifact === "index" ? <IndexArtifact result={result} /> : null}
          {activeArtifact === "knowledge" ? <KnowledgeArtifact result={result} /> : null}
        </div>
      ) : (
        <p className="muted">Выбери сохранённый запуск или запусти новый, чтобы открыть артефакты.</p>
      )}
    </section>
  );
}

function StagesPanel({ result }: { result: PipelineRunResult | null }) {
  const stages = hasRunArtifacts(result) ? safeList(result.stages) : [];

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Стадии Пайплайна</h2>
        <span>{hasRunArtifacts(result) ? `${stages.length} этапов` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        stages.length ? (
          <div className="list">
            {stages.map((stage: PipelineStage) => (
              <div key={stage.key} className="list-item">
                <strong>
                  {safeText(stage.label)} / {stage.status === "completed" ? "завершено" : safeText(stage.status)}
                </strong>
                <span>{safeText(stage.details)}</span>
                <span className="subtle">
                  {safeText(stage.startedAt, "-")} - {safeText(stage.completedAt, "-")}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <PanelFallback title="Стадии" message="Для этого запуска список стадий недоступен." />
        )
      ) : (
        <p className="muted">Статусы этапов появятся после запуска или выбора сохранённого run.</p>
      )}
    </article>
  );
}

function DiagnosticsPanel({ result }: { result: PipelineRunResult | null }) {
  const ignoredPaths = hasRunArtifacts(result) ? safeList(result.workspace?.ignoredPaths) : [];
  const diagnostics = hasRunArtifacts(result) ? safeList(result.index?.diagnostics) : [];
  const repositoryDiagnostics = hasRunArtifacts(result) ? safeList(result.repository?.diagnostics) : [];
  const diagnosticsCount = ignoredPaths.length + diagnostics.length + repositoryDiagnostics.length;

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Диагностика и Исключения</h2>
        <span>{hasRunArtifacts(result) ? diagnosticsCount : 0}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <div className="list">
            <div className="list-item">
              <strong>Диагностика repository/git</strong>
              <span>{repositoryDiagnostics.length}</span>
            </div>
            {repositoryDiagnostics.length ? (
              repositoryDiagnostics.slice(0, 10).map((diagnostic) => (
                <div key={diagnostic} className="list-item compact">
                  <span>{diagnostic}</span>
                </div>
              ))
            ) : (
              <p className="muted">Git-диагностика не выявила критичных проблем.</p>
            )}
          </div>

          <div className="list">
            <div className="list-item">
              <strong>Игнорируемые пути</strong>
              <span>{ignoredPaths.length}</span>
            </div>
            {ignoredPaths.slice(0, 10).map((pathValue) => (
              <div key={pathValue} className="list-item compact">
                <span>{pathValue}</span>
              </div>
            ))}
          </div>

          <div className="list">
            <div className="list-item">
              <strong>Диагностика index/workspace</strong>
              <span>{diagnostics.length}</span>
            </div>
            {diagnostics.length ? (
              diagnostics.slice(0, 10).map((diagnostic) => (
                <div key={diagnostic} className="list-item compact">
                  <span>{diagnostic}</span>
                </div>
              ))
            ) : (
              <p className="muted">Критичных диагностических сообщений нет.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Ignored paths и diagnostics будут показаны после запуска пайплайна.</p>
      )}
    </article>
  );
}

function ResearchPanel({ result }: { result: PipelineRunResult | null }) {
  const findings = hasRunArtifacts(result) ? safeList(result.research?.findings) : [];
  const evidence = hasRunArtifacts(result) ? safeList(result.research?.evidence).slice(0, 6) : [];
  const moduleIntents = hasRunArtifacts(result) ? safeList(result.research?.moduleIntents).slice(0, 3) : [];
  const entryPoints = hasRunArtifacts(result) ? safeList(result.research?.entryPoints).slice(0, 4) : [];
  const sideEffects = hasRunArtifacts(result) ? safeList(result.research?.sideEffects).slice(0, 4) : [];

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Отчёт Исследования</h2>
        <span>{hasRunArtifacts(result) ? `${safeCount(result.research?.confidence)}% уверенность` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p>{safeText(result.research?.summary)}</p>
          <div className="list">
            <div className="list-item">
              <strong>Что делает затронутая зона</strong>
              <span>{safeText(result.research?.functionalSummary)}</span>
            </div>
          </div>
          <div className="list">
            {moduleIntents.length ? (
              moduleIntents.map((intent) => (
                <div key={intent.module} className="list-item">
                  <strong>Выбранный модуль: {intent.module}</strong>
                  <span>{intent.reasons.join(" ")}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Модульный приоритет" message="Для этого запуска research не смог уверенно выделить функциональный модуль." />
            )}
          </div>
          <div className="list">
            {entryPoints.length ? (
              entryPoints.map((entryPoint) => (
                <div key={entryPoint} className="list-item">
                  <strong>Точка входа</strong>
                  <span>{entryPoint}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Точки входа" message="Для этого запуска точки входа не выделены." />
            )}
          </div>
          <div className="list">
            {sideEffects.length ? (
              sideEffects.map((effect) => (
                <div key={effect} className="list-item">
                  <strong>Побочный эффект</strong>
                  <span>{effect}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Побочные эффекты" message="Для этого запуска побочные эффекты не подтверждены." />
            )}
          </div>
          <div className="list">
            {findings.length ? (
              findings.map((finding) => (
                <div key={finding} className="list-item">
                  <strong>Вывод</strong>
                  <span>{finding}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Выводы" message="Для этого запуска список findings недоступен." />
            )}
          </div>
          <div className="list">
            {evidence.length ? (
              evidence.map((item) => (
                <div key={item.id} className="list-item">
                  <strong>{item.label}</strong>
                  <span>
                    оценка {item.score} / {item.reason}
                  </span>
                </div>
              ))
            ) : (
              <PanelFallback title="Опорные данные" message="Для этого запуска опорные данные недоступны." />
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Запусти пайплайн, чтобы получить детерминированный отчёт исследования.</p>
      )}
    </article>
  );
}

function ImpactPanel({ result }: { result: PipelineRunResult | null }) {
  const risks = hasRunArtifacts(result) ? safeList(result.impact?.risks).slice(0, 6) : [];
  const scope = hasRunArtifacts(result) ? safeList(result.impact?.validationScope).slice(0, 6) : [];

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Отчёт Влияния</h2>
        <span>{hasRunArtifacts(result) ? `${safeCount(result.impact?.confidence)}% уверенность` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p>{safeText(result.impact?.summary)}</p>
          <div className="list">
            {risks.length ? (
              risks.map((risk) => (
                <div key={risk} className="list-item">
                  <strong>Риск</strong>
                  <span>{risk}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Риски" message="Для этого запуска риски impact-анализа недоступны." />
            )}
          </div>
          <div className="list">
            {scope.length ? (
              scope.map((item) => (
                <div key={item} className="list-item">
                  <strong>Проверка</strong>
                  <span>{item}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Проверки" message="Для этого запуска validation scope недоступен." />
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Анализ влияния появится здесь после завершения research.</p>
      )}
    </article>
  );
}

function ContextPanel({ result }: { result: PipelineRunResult | null }) {
  const chunks = hasRunArtifacts(result) ? safeList(result.context?.selectedChunks).slice(0, 6) : [];
  const highlights = hasRunArtifacts(result) ? safeList(result.context?.functionalHighlights).slice(0, 4) : [];
  const focusZones = hasRunArtifacts(result) ? safeList(result.context?.focusZones).slice(0, 6) : [];
  const rankingSummary = hasRunArtifacts(result) ? safeList(result.context?.rankingSummary).slice(0, 4) : [];

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>Контекстный пакет</h2>
        <span>{hasRunArtifacts(result) ? `${safeCount(result.context?.confidence)}% уверенность` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p className="stat">
            <strong>{safeList(result.context?.selectedChunks).length}</strong> выбранных фрагментов,{" "}
            <strong>{safeList(result.context?.omittedCandidates).length}</strong> исключено,{" "}
            <strong>{safeCount(result.context?.estimatedTokens)}</strong> оценочных токенов.
          </p>
          <div className="list">
            {highlights.length ? (
              highlights.map((highlight) => (
                <div key={highlight} className="list-item">
                  <strong>Функциональный фокус</strong>
                  <span>{highlight}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Функциональный фокус" message="Для этого запуска функциональные акценты контекста не выделены." />
            )}
          </div>
          <div className="list">
            {focusZones.length ? (
              focusZones.map((zone) => (
                <div key={zone} className="list-item">
                  <strong>Focus zone</strong>
                  <span>{zone}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Focus zones" message="Для этого запуска focus zones не были выделены." />
            )}
          </div>
          <div className="list">
            {rankingSummary.length ? (
              rankingSummary.map((item) => (
                <div key={item} className="list-item">
                  <strong>Правило отбора</strong>
                  <span>{item}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Отбор контекста" message="Для этого запуска объяснение ranking не подготовлено." />
            )}
          </div>
          <div className="list">
            {chunks.length ? (
              chunks.map((chunk: ContextCandidate) => (
                <div key={chunk.id} className="list-item">
                  <strong>{safeText(chunk.label)}</strong>
                  <span>{safeText(chunk.reason)}</span>
                  <span className="subtle">
                    Приоритет: {safeText(chunk.priority)} / score: {safeCount(chunk.score)} / токены: {safeCount(chunk.tokenEstimate)}
                  </span>
                </div>
              ))
            ) : (
              <PanelFallback title="Контекст" message="Для этого запуска выбранные фрагменты недоступны." />
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Собранный context package появится здесь.</p>
      )}
    </article>
  );
}

function PlanPanel({ result }: { result: PipelineRunResult | null }) {
  const steps = hasRunArtifacts(result) ? safeList(result.plan?.steps) : [];
  const targetModules = hasRunArtifacts(result) ? safeList(result.plan?.targetModules) : [];
  const targetFiles = hasRunArtifacts(result) ? safeList(result.plan?.targetFiles).slice(0, 8) : [];
  const entryPoints = hasRunArtifacts(result) ? safeList(result.plan?.entryPoints).slice(0, 4) : [];
  const validationScope = hasRunArtifacts(result) ? safeList(result.plan?.validationScope).slice(0, 6) : [];
  const planningNotes = hasRunArtifacts(result) ? safeList(result.plan?.planningNotes).slice(0, 6) : [];
  const dependencyChains = hasRunArtifacts(result) ? safeList(result.plan?.dependencyChains).slice(0, 6) : [];
  const repositoryChanges = hasRunArtifacts(result) ? safeList(result.repository?.changedFiles).slice(0, 8) : [];

  return (
    <article className="panel">
      <div className="panel-header">
        <h2>План Выполнения и Превью</h2>
        <span>{hasRunArtifacts(result) ? `${steps.length} шагов` : "Ожидание"}</span>
      </div>

      {hasRunArtifacts(result) ? (
        <div className="stack">
          <p>{safeText(result.plan?.summary)}</p>
          <div className="list">
            <div className="list-item">
              <strong>Стратегия</strong>
              <span>{safeText(result.plan?.strategy)}</span>
            </div>
            <div className="list-item">
              <strong>Целевые модули</strong>
              <span>{targetModules.join(", ") || "Не определены"}</span>
            </div>
            <div className="list-item">
              <strong>Точки входа плана</strong>
              <span>{entryPoints.join(", ") || "Не определены"}</span>
            </div>
          </div>
          <div className="list">
            {planningNotes.length ? (
              planningNotes.map((note) => (
                <div key={note} className="list-item">
                  <strong>Planning note</strong>
                  <span>{note}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Planning notes" message="Для этого запуска notes планирования недоступны." />
            )}
          </div>
          <div className="list">
            {repositoryChanges.length ? (
              repositoryChanges.map((change) => (
                <div key={`${change.scope}:${change.changeType}:${change.previousPath ?? ""}:${change.path}`} className="list-item">
                  <strong>Git change scope</strong>
                  <span>
                    {change.scope} / {change.changeType} / {change.previousPath ? `${change.previousPath} -> ` : ""}
                    {change.path}
                  </span>
                </div>
              ))
            ) : (
              <PanelFallback title="Git change scope" message="Локальные изменения в репозитории не обнаружены или Git недоступен." />
            )}
          </div>
          <div className="list">
            {dependencyChains.length ? (
              dependencyChains.map((chain) => (
                <div key={`${chain.from}-${chain.to}-${chain.reason}`} className="list-item">
                  <strong>
                    {chain.from} → {chain.to}
                  </strong>
                  <span>{chain.reason}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="Dependency chains" message="Для этого запуска жёсткие graph-backed цепочки зависимостей не выделены." />
            )}
          </div>
          <div className="list">
            {steps.length ? (
              steps.map((step) => (
                <div key={step.id} className="list-item">
                  <strong>{safeText(step.title)}</strong>
                  <span>{safeText(step.description)}</span>
                  <span className="subtle">
                    Исполнитель: {safeText(step.executor)} / {step.parallelizable ? "можно параллелить" : "последовательно"}
                  </span>
                  <span className="subtle">Scope: {safeList(step.scope).slice(0, 4).join(", ") || "Не определён"}</span>
                  <span className="subtle">Outputs: {safeList(step.outputs).join(", ") || "Не определены"}</span>
                  <span className="subtle">Approval: {step.approvalRequired ? "нужно" : "не нужно"}</span>
                </div>
              ))
            ) : (
              <PanelFallback title="План" message="Для этого запуска execution plan steps недоступны." />
            )}
          </div>
          <div className="list">
            <div className="list-item">
              <strong>Целевые файлы</strong>
              <span>{targetFiles.join(", ") || "Не определены"}</span>
            </div>
            <div className="list-item">
              <strong>Validation scope</strong>
              <span>{validationScope.join(", ") || "Не определён"}</span>
            </div>
          </div>
          <div className="list">
            <div className="list-item">
              <strong>Безопасное превью выполнения</strong>
              <span>{safeText(result.executionPreview?.summary)}</span>
            </div>
            <div className="list-item compact">
              <span>Разрешено: {safeList(result.executionPreview?.allowedActions).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Запрещено: {safeList(result.executionPreview?.blockedActions).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Переиндексация: да / Обновление графа: да / Обновление знаний: да</span>
            </div>
          </div>
          <div className="list">
            <div className="list-item">
              <strong>Controlled execution runtime</strong>
              <span>{safeText(result.executionRuntime?.summary)}</span>
            </div>
            <div className="list-item compact">
              <span>Статус: {safeText(result.executionRuntime?.status, "Недоступно")}</span>
            </div>
            <div className="list-item compact">
              <span>Разрешённые файлы: {safeList(result.executionRuntime?.allowedWriteFiles).slice(0, 8).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Заблокированные write-зоны: {safeList(result.executionRuntime?.blockedWriteZones).join(", ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Scope guards: {safeList(result.executionRuntime?.scopeGuards).slice(0, 3).join(" | ") || "Нет данных"}</span>
            </div>
            <div className="list-item compact">
              <span>Approval checks: {safeList(result.executionRuntime?.approvalChecks).slice(0, 3).join(" | ") || "Нет данных"}</span>
            </div>
          </div>
          <code className="path">{safeText(result.knowledge?.storagePath)}</code>
        </div>
      ) : (
        <p className="muted">Execution plan и safe preview появятся здесь после запуска.</p>
      )}
    </article>
  );
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [task, setTask] = useState("Построй структурный отчёт по текущему проекту и покажи ключевые зависимости.");
  const [projectPath, setProjectPath] = useState("");
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    baseUrl: "",
    model: "",
    apiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<PipelineRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineRunResult | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactTab>("research");

  useEffect(() => {
    void loadProject();
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROVIDER_STORAGE_KEY);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as Partial<ProviderDraft>;

      setProviderDraft({
        baseUrl: parsed.baseUrl ?? "",
        model: parsed.model ?? "",
        apiKey: parsed.apiKey ?? "",
      });
    } catch {
      // ignore broken local storage payload
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(providerDraft));
  }, [providerDraft]);

  async function loadProject(nextProjectPath?: string) {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      const requestedProjectPath = nextProjectPath?.trim() || projectPath.trim();

      if (requestedProjectPath) {
        params.set("projectPath", requestedProjectPath);
      }

      const response = await fetch(`${API_BASE_URL}/api/project${params.size ? `?${params.toString()}` : ""}`);
      const data = (await response.json()) as ProjectInfo;

      startTransition(() => {
        setProject(data);
        setProjectPath(data.rootPath);
        setResult((current) => current ?? data.latestRun ?? null);
        setSelectedRunId((current) => current ?? data.latestRun?.runId ?? null);
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить сводку по проекту.");
    } finally {
      setLoading(false);
    }
  }

  async function runPipeline(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunning(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/pipeline/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task,
          projectPath,
          providerBaseUrl: providerDraft.baseUrl,
          providerModel: providerDraft.model,
          providerApiKey: providerDraft.apiKey,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string };
        throw new Error(payload.message ?? "Не удалось запустить пайплайн.");
      }

      const accepted = (await response.json()) as PipelineRunStatus;

      startTransition(() => {
        setRunStatus(accepted);
        setSelectedRunId(accepted.runId);
        setActiveArtifact("research");
      });

      await pollPipelineStatus(accepted.runId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Не удалось выполнить пайплайн.");
    } finally {
      setRunning(false);
    }
  }

  async function pollPipelineStatus(runId: string) {
    for (;;) {
      const response = await fetch(`${API_BASE_URL}/api/pipeline/status?runId=${encodeURIComponent(runId)}`);

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string };
        throw new Error(payload.message ?? "Не удалось получить статус пайплайна.");
      }

      const status = (await response.json()) as PipelineRunStatus;

      startTransition(() => {
        setRunStatus(status);
      });

      if (status.status === "completed" && status.result) {
        startTransition(() => {
          setResult(status.result ?? null);
          setProject((current) =>
            current
              ? {
                  ...current,
                  name: status.result?.project.name ?? current.name,
                  rootPath: status.result?.project.rootPath ?? current.rootPath,
                  summary: status.result?.project.summary ?? current.summary,
                  latestRun: status.result ?? current.latestRun,
                  recentRuns: status.result
                    ? [
                        {
                          runId: status.result.runId,
                          task: status.task,
                          savedAt: status.result.knowledge.savedAt,
                          storagePath: status.result.knowledge.storagePath,
                          summary: status.result.research.summary,
                        },
                        ...current.recentRuns.filter((entry) => entry.runId !== status.result?.runId),
                      ].slice(0, 20)
                    : current.recentRuns,
                }
              : current,
          );
        });
        return;
      }

      if (status.status === "failed") {
        throw new Error(status.errorMessage || "Пайплайн завершился ошибкой.");
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }

  async function openSavedRun(runId: string) {
    setError(null);

    try {
      const params = new URLSearchParams({
        projectPath,
        runId,
      });
      const response = await fetch(`${API_BASE_URL}/api/runs/selected?${params.toString()}`);

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string };
        throw new Error(payload.message ?? "Не удалось загрузить сохранённый запуск.");
      }

      const data = (await response.json()) as PipelineRunResult;

      startTransition(() => {
        setResult(data);
        setSelectedRunId(runId);
        setActiveArtifact("research");
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить сохранённый запуск.");
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Client MVP / Срез 1</p>
        <h1>Консоль Структурного Анализа</h1>
        <p className="hero-copy">
          Эта операторская консоль запускает первый воспроизводимый цикл: инициализация workspace, полная индексация,
          построение graph, research, impact analysis и сохранение knowledge.
        </p>
      </section>

      <section className="panel panel-form">
        <div className="panel-header">
          <h2>Запуск Пайплайна</h2>
          <span>{running ? "Выполняется" : "Готово"}</span>
        </div>

        <form onSubmit={runPipeline} className="form">
          <label>
            <span>Путь к проекту</span>
            <input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} />
          </label>

          <div className="provider-grid">
            <label>
              <span>Base URL провайдера ИИ</span>
              <input
                value={providerDraft.baseUrl}
                onChange={(event) =>
                  setProviderDraft((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }
                placeholder="https://api.openai.com/v1"
              />
            </label>

            <label>
              <span>Название модели</span>
              <input
                value={providerDraft.model}
                onChange={(event) =>
                  setProviderDraft((current) => ({
                    ...current,
                    model: event.target.value,
                  }))
                }
                placeholder="gpt-5"
              />
            </label>
          </div>

          <label>
            <span>API ключ</span>
            <input
              type="password"
              value={providerDraft.apiKey}
              onChange={(event) =>
                setProviderDraft((current) => ({
                  ...current,
                  apiKey: event.target.value,
                }))
              }
              placeholder="sk-..."
            />
          </label>

          <label>
            <span>Задача</span>
            <textarea value={task} onChange={(event) => setTask(event.target.value)} rows={5} />
          </label>

          <button type="submit" disabled={running || loading}>
            {running ? "Запускаю структурный пайплайн..." : "Запустить структурный пайплайн"}
          </button>
        </form>

        {runStatus ? (
          <div className="list">
            <div className="list-item">
              <strong>Статус запуска</strong>
              <span>{runStatus.status}</span>
            </div>
            <div className="list-item">
              <strong>Текущий этап</strong>
              <span>{safeText(runStatus.currentStageLabel, "Ожидание")}</span>
            </div>
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="grid">
        <ProjectPanel project={project} loading={loading} />
        <RunsPanel project={project} selectedRunId={selectedRunId} onOpenRun={(runId) => void openSavedRun(runId)} />
      </section>

      <ArtifactViewer result={result} activeArtifact={activeArtifact} setActiveArtifact={setActiveArtifact} />

      <section className="grid grid-wide">
        <StagesPanel result={result} />
        <DiagnosticsPanel result={result} />
        <ResearchPanel result={result} />
        <ImpactPanel result={result} />
        <ContextPanel result={result} />
        <PlanPanel result={result} />
      </section>
    </main>
  );
}
