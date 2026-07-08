import { getFileDependencies, getFileDependents, getModuleDependencyNeighbors, getModuleDependents } from "@client/graph";
import {
  stableId,
  type ContextPackage,
  type ExecutionPlan,
  type ExecutionPreview,
  type GraphState,
  type ImpactReport,
  type PlanDependency,
  type PlanStep,
  type ResearchReport,
} from "@client/shared";

interface BuildPlanInput {
  runId: string;
  task: string;
  research: ResearchReport;
  impact: ImpactReport;
  context: ContextPackage;
  graph: GraphState;
}

interface PlanningGroup {
  label: string;
  files: string[];
}

export function buildExecutionPlan(input: BuildPlanInput): ExecutionPlan {
  const targetModules = input.research.affectedModules.slice(0, 6);
  const targetFiles = input.impact.affectedFiles.slice(0, 12);
  const entryPoints = input.research.entryPoints.slice(0, 6);
  const validationScope = input.impact.validationScope.slice(0, 8);
  const planningGroups = buildPlanningGroups(targetFiles, targetModules);
  const dependencyChains = buildDependencyChains(input.graph, planningGroups, targetModules);
  const requiresHybridFlow = shouldUseHybridStrategy(input, planningGroups, targetFiles, input.impact.risks, dependencyChains);
  const planningNotes = buildPlanningNotes(input, targetModules, targetFiles, entryPoints, validationScope, dependencyChains);
  const steps = buildPlanSteps(input, planningGroups, targetModules, targetFiles, entryPoints, validationScope, dependencyChains, requiresHybridFlow);

  return {
    planId: stableId(["plan", input.runId]),
    runId: input.runId,
    summary: buildPlanSummary(input, planningGroups, targetFiles, requiresHybridFlow, dependencyChains),
    strategy: requiresHybridFlow ? "hybrid" : "sequential",
    risks: input.impact.risks,
    targetModules,
    targetFiles,
    entryPoints,
    validationScope,
    planningNotes,
    dependencyChains,
    approvalRequired: true,
    steps,
  };
}

export function buildExecutionPreview(runId: string, plan: ExecutionPlan): ExecutionPreview {
  const allowedActions = [
    "Построение детерминированного graph-backed плана выполнения",
    "Подтверждение целевых модулей, файлов и точек входа",
    "Подготовка последовательности изменений по file/symbol dependency chains без выхода за impact scope",
    "Подготовка post-change переиндексации, обновления графа и знаний",
  ];

  if (plan.strategy === "hybrid") {
    allowedActions.push("Параллельная подготовка только тех потоков, для которых graph не показывает жёсткой зависимости");
  }

  return {
    previewId: stableId(["execution-preview", runId]),
    runId,
    mode: "safe-preview",
    summary: `Превью выполнения подготовлено для ${plan.steps.length} плановых шагов в стратегии ${plan.strategy} без реальной модификации проекта.`,
    allowedActions,
    blockedActions: [
      "Прямое изменение файлов проекта без отдельного execution runtime",
      "Выход за подтверждённый набор target files и target modules",
      "Игнорирование graph-backed dependency order",
      "Автономное выполнение без human approval",
    ],
    reindexRequired: true,
    graphRefreshRequired: true,
    knowledgeRefreshRequired: true,
  };
}

function buildPlanSteps(
  input: BuildPlanInput,
  planningGroups: PlanningGroup[],
  targetModules: string[],
  targetFiles: string[],
  entryPoints: string[],
  validationScope: string[],
  dependencyChains: PlanDependency[],
  requiresHybridFlow: boolean,
): PlanStep[] {
  const confirmScopeStepId = stableId(["plan-step", input.runId, "confirm-scope"]);
  const sequenceStepId = stableId(["plan-step", input.runId, "map-dependency-order"]);
  const prepareValidationStepId = stableId(["plan-step", input.runId, "prepare-validation"]);
  const finalizeStepId = stableId(["plan-step", input.runId, "final-review"]);

  const steps: PlanStep[] = [
    {
      id: confirmScopeStepId,
      title: "Подтвердить рабочий scope",
      description: buildScopeDescription(targetModules, targetFiles, entryPoints),
      dependsOn: [],
      status: "planned",
      executor: "analysis-agent",
      parallelizable: false,
      scope: uniqueStrings([...targetModules, ...targetFiles]),
      outputs: ["Подтверждённый scope", "Подтверждённые entry points", "Зафиксированный набор зон изменения"],
      approvalRequired: false,
      validation: [
        "Проверить, что scope совпадает с Research Report",
        "Проверить, что scope не выходит за Impact Report",
      ],
    },
    {
      id: sequenceStepId,
      title: "Построить file-backed dependency sequence",
      description: buildSequenceDescription(planningGroups, dependencyChains, input.impact.risks),
      dependsOn: [confirmScopeStepId],
      status: "planned",
      executor: "analysis-agent",
      parallelizable: false,
      scope: planningGroups.flatMap((group) => group.files).slice(0, 8),
      outputs: ["Dependency order", "Кандидаты на параллельные потоки", "Подтверждённая safe sequence"],
      approvalRequired: true,
      validation: [
        "Проверить согласованность sequence с file/symbol graph relations",
        "Исключить скрытые обратные зависимости",
      ],
    },
  ];

  const workstreams = buildWorkstreams(input, planningGroups, sequenceStepId, dependencyChains, requiresHybridFlow);
  steps.push(...workstreams);

  steps.push({
    id: prepareValidationStepId,
    title: "Подготовить post-change validation contour",
    description: buildValidationDescription(validationScope, targetFiles),
    dependsOn: workstreams.map((step) => step.id),
    status: "planned",
    executor: "validation-agent",
    parallelizable: false,
    scope: uniqueStrings([...validationScope, ...targetFiles]),
    outputs: ["Validation scope", "План переиндексации", "План graph/knowledge refresh"],
    approvalRequired: false,
    validation: [
      "Проверить полноту validation scope",
      "Зафиксировать обязательную переиндексацию и refresh",
    ],
  });

  steps.push({
    id: finalizeStepId,
    title: "Подготовить финальный execution handoff",
    description: "Собрать воспроизводимый execution handoff: scope, dependency order, проверки и точки human approval.",
    dependsOn: [prepareValidationStepId],
    status: "planned",
    executor: "analysis-agent",
    parallelizable: false,
    scope: uniqueStrings([...targetModules, ...targetFiles, ...validationScope]),
    outputs: ["Финальный Execution Plan", "Approval package", "Execution constraints"],
    approvalRequired: true,
    validation: [
      "Подтвердить детерминированность плана",
      "Подтвердить воспроизводимость handoff",
    ],
  });

  return steps;
}

function buildWorkstreams(
  input: BuildPlanInput,
  groups: PlanningGroup[],
  sequenceStepId: string,
  dependencyChains: PlanDependency[],
  requiresHybridFlow: boolean,
): PlanStep[] {
  const orderedGroups = orderGroupsByDependencies(groups, dependencyChains);

  if (orderedGroups.length === 0) {
    return [
      {
        id: stableId(["plan-step", input.runId, "prepare-local-change"]),
        title: "Подготовить локальную рабочую зону изменения",
        description: "Сфокусировать изменение на одной компактной зоне, потому что graph не выделил отдельные workstreams.",
        dependsOn: [sequenceStepId],
        status: "planned",
        executor: "implementation-agent",
        parallelizable: false,
        scope: input.impact.affectedFiles,
        outputs: ["Локальный change batch", "Подтверждённый набор файлов"],
        approvalRequired: true,
        validation: ["Проверить локальность изменений", "Не выйти за текущий impact scope"],
      },
    ];
  }

  return orderedGroups.map((group, index) => {
    const dependentOn = orderedGroups
      .slice(0, index)
      .filter((candidate) => dependencyChains.some((chain) => chain.from === candidate.label && chain.to === group.label))
      .map((candidate) => stableId(["plan-step", input.runId, "workstream", candidate.label]));

    return {
      id: stableId(["plan-step", input.runId, "workstream", group.label]),
      title: `Подготовить рабочий поток: ${group.label}`,
      description: buildWorkstreamDescription(group, dependencyChains),
      dependsOn: dependentOn.length > 0 ? dependentOn : [sequenceStepId],
      status: "planned",
      executor: "implementation-agent",
      parallelizable: requiresHybridFlow && dependentOn.length === 0 && orderedGroups.length > 1,
      scope: group.files,
      outputs: [`Change batch для зоны ${group.label}`, "Согласованный file subset", "Локальный validation focus"],
      approvalRequired: true,
      validation: [
        "Проверить graph-backed зависимости группы",
        "Проверить, что группа остаётся внутри подтверждённого scope",
      ],
    } satisfies PlanStep;
  });
}

function buildPlanningGroups(targetFiles: string[], targetModules: string[]): PlanningGroup[] {
  const groups = new Map<string, string[]>();

  for (const file of targetFiles) {
    const label = derivePlanningGroupLabel(file, targetModules);
    const current = groups.get(label) ?? [];
    current.push(file);
    groups.set(label, current);
  }

  return [...groups.entries()].map(([label, files]) => ({
    label,
    files: files.sort(),
  }));
}

function buildDependencyChains(graph: GraphState, planningGroups: PlanningGroup[], targetModules: string[]): PlanDependency[] {
  const fileChains = buildFileDependencyChains(graph, planningGroups);

  if (fileChains.length > 0) {
    return fileChains;
  }

  return buildModuleDependencyChains(graph, targetModules);
}

function buildFileDependencyChains(graph: GraphState, planningGroups: PlanningGroup[]): PlanDependency[] {
  const chains: PlanDependency[] = [];
  const labelByFilePath = new Map<string, string>();

  for (const group of planningGroups) {
    for (const file of group.files) {
      labelByFilePath.set(file, group.label);
    }
  }

  for (const group of planningGroups) {
    for (const filePath of group.files) {
      const fileNode = graph.nodes.find((node) => node.kind === "file" && node.filePath === filePath);

      if (!fileNode) {
        continue;
      }

      for (const dependency of getFileDependencies(graph, fileNode.id)) {
        const targetFilePath = dependency.filePath;
        const targetLabel = targetFilePath ? labelByFilePath.get(targetFilePath) : null;

        if (!targetLabel || targetLabel === group.label) {
          continue;
        }

        chains.push({
          from: group.label,
          to: targetLabel,
          reason: `Файл "${filePath}" использует "${targetFilePath}", поэтому поток "${group.label}" зависит от "${targetLabel}".`,
        });
      }

      for (const dependent of getFileDependents(graph, fileNode.id)) {
        const sourceFilePath = dependent.filePath;
        const sourceLabel = sourceFilePath ? labelByFilePath.get(sourceFilePath) : null;

        if (!sourceLabel || sourceLabel === group.label) {
          continue;
        }

        chains.push({
          from: sourceLabel,
          to: group.label,
          reason: `Файл "${sourceFilePath}" использует "${filePath}", поэтому поток "${sourceLabel}" зависит от "${group.label}".`,
        });
      }
    }
  }

  return uniqueDependencies(chains);
}

function buildModuleDependencyChains(graph: GraphState, targetModules: string[]): PlanDependency[] {
  const chains: PlanDependency[] = [];

  for (const moduleLabel of targetModules) {
    for (const dependency of getModuleDependencyNeighbors(graph, moduleLabel)) {
      if (dependency.kind !== "module" || !targetModules.includes(dependency.label)) {
        continue;
      }

      chains.push({
        from: moduleLabel,
        to: dependency.label,
        reason: `Graph показывает, что модуль "${moduleLabel}" зависит от "${dependency.label}".`,
      });
    }

    for (const dependent of getModuleDependents(graph, moduleLabel)) {
      if (dependent.kind !== "module" || !targetModules.includes(dependent.label)) {
        continue;
      }

      chains.push({
        from: dependent.label,
        to: moduleLabel,
        reason: `Graph показывает, что модуль "${dependent.label}" зависит от "${moduleLabel}".`,
      });
    }
  }

  return uniqueDependencies(chains);
}

function shouldUseHybridStrategyBase(targetFiles: string[], risks: string[], dependencyChains: PlanDependency[]): boolean {
  if (targetFiles.length <= 1) {
    return false;
  }

  if (risks.length >= 2) {
    return false;
  }

  const denseDependencyGraph = dependencyChains.length >= Math.max(targetFiles.length - 1, 2);

  if (denseDependencyGraph) {
    return false;
  }

  return true;
}

function shouldUseHybridStrategy(
  input: BuildPlanInput,
  planningGroups: PlanningGroup[],
  targetFiles: string[],
  risks: string[],
  dependencyChains: PlanDependency[],
): boolean {
  if (input.research.queryProfileKey === "storage-topology") {
    return false;
  }

  if (input.research.queryProfileKey === "config-inventory") {
    return false;
  }

  if (input.research.queryProfileKey === "localization-inventory") {
    return false;
  }

  if (input.research.queryProfileKey === "broad-scan") {
    return false;
  }

  if (planningGroups.length <= 1) {
    return false;
  }

  return shouldUseHybridStrategyBase(targetFiles, risks, dependencyChains);
}

function buildPlanSummary(
  input: BuildPlanInput,
  planningGroups: PlanningGroup[],
  targetFiles: string[],
  requiresHybridFlow: boolean,
  dependencyChains: PlanDependency[],
): string {
  return `План выполнения собран для ${planningGroups.length || 1} рабочих зон и ${targetFiles.length || 1} файлов на основе ${input.context.selectedChunks.length} контекстных фрагментов. Стратегия: ${requiresHybridFlow ? "hybrid" : "sequential"}. Dependency links: ${dependencyChains.length}.`;
}

function buildPlanningNotes(
  input: BuildPlanInput,
  targetModules: string[],
  targetFiles: string[],
  entryPoints: string[],
  validationScope: string[],
  dependencyChains: PlanDependency[],
): string[] {
  const notes = [
    `Профиль исследования: ${input.research.queryProfileKey}.`,
    targetModules.length
      ? `Главная зона планирования: ${targetModules.join(", ")}.`
      : "Главная зона планирования не выделена явно, поэтому план опирается на file-level scope.",
    entryPoints.length
      ? `План начинается от подтверждённых entry points: ${entryPoints.slice(0, 3).join(", ")}.`
      : "Явные entry points не подтверждены, поэтому нужен дополнительный human check перед execution.",
    targetFiles.length
      ? `Impact ограничил основной file scope до ${targetFiles.length} файлов.`
      : "Impact не дал явного file scope, поэтому execution runtime должен остановиться до ручного уточнения.",
    validationScope.length
      ? `Post-change validation должен включать: ${validationScope.slice(0, 3).join(", ")}.`
      : "Validation scope пока неполный и требует обязательного уточнения перед execution.",
    dependencyChains.length
      ? `Graph подтвердил цепочки зависимостей: ${dependencyChains.slice(0, 3).map((item) => `${item.from} -> ${item.to}`).join(", ")}.`
      : "Graph не подтвердил жёсткие цепочки зависимостей внутри текущего scope, поэтому допустим более свободный порядок workstreams.",
  ];

  if (input.research.queryProfileKey === "storage-topology") {
    notes.push("Storage-topology профиль требует консервативного порядка: schema/model/repository/request зоны должны подтверждаться перед execution.");
  }

  if (input.research.queryProfileKey === "config-inventory") {
    notes.push("Config-inventory профиль должен оставаться обзорным и не превращаться в параллельные runtime workstreams без дополнительного уточнения задачи.");
  }

  if (input.research.queryProfileKey === "localization-inventory") {
    notes.push("Localization-inventory профиль должен группировать изменения по translation каталогам и избегать лишнего runtime sequencing.");
  }

  if (input.research.queryProfileKey === "broad-scan") {
    notes.push("Broad-scan профиль требует дополнительного narrowing: execution нельзя начинать до уточнения целевой функциональной или инфраструктурной зоны.");
  }

  if (input.impact.risks.length > 0) {
    notes.push(`Ключевые риски: ${input.impact.risks.slice(0, 2).join(" ")}`);
  }

  return notes;
}

function buildScopeDescription(targetModules: string[], targetFiles: string[], entryPoints: string[]): string {
  const moduleText = targetModules.length ? targetModules.join(", ") : "неопределённые модули";
  const fileText = targetFiles.length ? `${targetFiles.length} подтверждённых файлов` : "неподтверждённый file scope";
  const entryPointText = entryPoints.length ? entryPoints.slice(0, 2).join(", ") : "неподтверждённые точки входа";
  return `Сверить, что задача действительно лежит в зонах ${moduleText}, ограничена набором ${fileText} и начинается из ${entryPointText}.`;
}

function buildSequenceDescription(groups: PlanningGroup[], dependencyChains: PlanDependency[], risks: string[]): string {
  const zoneText = groups.map((group) => group.label).join(", ");
  const dependencyText = dependencyChains.length
    ? dependencyChains.slice(0, 3).map((item) => `${item.from} -> ${item.to}`).join(", ")
    : "жёсткие file/symbol зависимости не подтверждены";
  const riskText = risks.length ? risks.slice(0, 2).join(" ") : "критичных рисков пока не выявлено";
  return `Разложить изменение по graph-зависимостям внутри ${zoneText || "текущего scope"}; подтверждённые связи: ${dependencyText}. Учесть риски: ${riskText}`;
}

function buildValidationDescription(validationScope: string[], targetFiles: string[]): string {
  const validationText = validationScope.length ? validationScope.join(", ") : "обязательная переиндексация и graph refresh";
  return `Определить набор проверок для зоны ${targetFiles.length || 1} файлов, включая ${validationText}.`;
}

function buildWorkstreamDescription(group: PlanningGroup, dependencyChains: PlanDependency[]): string {
  const related = dependencyChains.filter((item) => item.from === group.label || item.to === group.label);
  const dependencyText = related.length
    ? ` Graph-связи зоны: ${related.slice(0, 2).map((item) => `${item.from} -> ${item.to}`).join(", ")}.`
    : "";
  return `Подготовить change batch для зоны ${group.label} с фокусом на ${group.files.slice(0, 3).join(", ")}${group.files.length > 3 ? " и связанных файлах" : ""}.${dependencyText}`;
}

function orderGroupsByDependencies(groups: PlanningGroup[], dependencyChains: PlanDependency[]): PlanningGroup[] {
  const weightByLabel = new Map<string, number>();

  for (const group of groups) {
    weightByLabel.set(group.label, 0);
  }

  for (const chain of dependencyChains) {
    weightByLabel.set(chain.to, (weightByLabel.get(chain.to) ?? 0) + 1);
  }

  return [...groups].sort((left, right) => {
    const leftWeight = weightByLabel.get(left.label) ?? 0;
    const rightWeight = weightByLabel.get(right.label) ?? 0;
    return leftWeight - rightWeight || right.files.length - left.files.length || left.label.localeCompare(right.label);
  });
}

function derivePlanningLabel(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  return segments.slice(0, 3).join("/") || "root";
}

function derivePlanningGroupLabel(filePath: string, targetModules: string[]): string {
  const normalized = filePath.toLowerCase();
  const matchedModule = targetModules.find((module) => normalized.includes(module.toLowerCase()));
  const semanticPrefix = deriveSemanticPrefix(filePath, matchedModule);

  if (normalized.startsWith("routes/")) {
    return semanticPrefix ? `${semanticPrefix}-routes` : matchedModule ? `${matchedModule}:routes` : "routes";
  }

  if (normalized.includes("/http/controllers/")) {
    return semanticPrefix ? `${semanticPrefix}-controllers` : matchedModule ? `${matchedModule}:controllers` : "controllers";
  }

  if (normalized.includes("/http/requests/")) {
    return semanticPrefix ? `${semanticPrefix}-requests` : matchedModule ? `${matchedModule}:requests` : "requests";
  }

  if (normalized.includes("/services/")) {
    return semanticPrefix ? `${semanticPrefix}-services` : matchedModule ? `${matchedModule}:services` : "services";
  }

  if (normalized.includes("/models/")) {
    return semanticPrefix ? `${semanticPrefix}-models` : matchedModule ? `${matchedModule}:models` : "models";
  }

  if (normalized.includes("/repositories/") || normalized.includes("/repository/")) {
    return semanticPrefix ? `${semanticPrefix}-repositories` : matchedModule ? `${matchedModule}:repositories` : "repositories";
  }

  if (normalized.includes("/migrations/")) {
    return semanticPrefix ? `${semanticPrefix}-migrations` : matchedModule ? `${matchedModule}:migrations` : "migrations";
  }

  if (normalized.startsWith("config/") || normalized.includes("/config/") || normalized.endsWith(".env") || normalized.includes(".env.")) {
    return semanticPrefix ? `${semanticPrefix}-config` : matchedModule ? `${matchedModule}:config` : "config";
  }

  if (normalized.startsWith("lang/") || normalized.includes("/lang/") || normalized.includes("/locales/") || normalized.includes("/i18n/")) {
    return semanticPrefix ? `${semanticPrefix}-localization` : matchedModule ? `${matchedModule}:localization` : "localization";
  }

  if (normalized.includes("/enums/")) {
    return semanticPrefix ? `${semanticPrefix}-enums` : matchedModule ? `${matchedModule}:enums` : "enums";
  }

  return matchedModule ?? derivePlanningLabel(filePath);
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => Boolean(value) && values.indexOf(value) === index);
}

function uniqueDependencies(values: PlanDependency[]): PlanDependency[] {
  const unique = new Map<string, PlanDependency>();

  for (const value of values) {
    const key = `${value.from}=>${value.to}`;

    if (!unique.has(key)) {
      unique.set(key, value);
      continue;
    }

    const existing = unique.get(key);

    if (existing && value.reason.length < existing.reason.length) {
      unique.set(key, value);
    }
  }

  return [...unique.values()];
}

function deriveSemanticPrefix(filePath: string, matchedModule: string | undefined): string | null {
  const normalized = filePath.toLowerCase();

  if (normalized.includes("web-login")) {
    return "web-login";
  }

  if (
    normalized.includes("weblogincontroller") ||
    normalized.includes("webloginticketservice") ||
    normalized.includes("ticketservice") ||
    normalized.includes("/claim") ||
    normalized.includes("/ticket")
  ) {
    return "web-login";
  }

  if (normalized.includes("verifyemail") || normalized.includes("emailverification")) {
    return "email-verification";
  }

  if (normalized.includes("/auth/") || normalized.includes("authcontroller") || normalized.includes("accesstype") || normalized.includes("status.php")) {
    return "auth";
  }

  if (normalized.includes("googleaccount")) {
    return "google-account";
  }

  if (normalized.includes("/user")) {
    return "user";
  }

  if (
    normalized.includes("/servers/")
    || normalized.includes("/models/server")
    || normalized.includes("servercredential")
    || normalized.includes("forwardingport")
  ) {
    return "servers";
  }

  if (
    normalized.includes("/vault/")
    || normalized.includes("/models/password")
    || normalized.includes("credential")
    || normalized.includes("private_key")
    || normalized.includes("passphrase")
  ) {
    return "vault";
  }

  if (normalized.startsWith("config/") || normalized.includes("/config/") || normalized.endsWith(".env") || normalized.includes(".env.")) {
    return "config";
  }

  if (normalized.startsWith("lang/") || normalized.includes("/lang/") || normalized.includes("/locales/") || normalized.includes("/i18n/")) {
    return "localization";
  }

  return matchedModule ?? null;
}
