import {
  getFileDependencies,
  getFileDependents,
  getIncomingNeighbors,
  getModuleRelations,
  getNodesForQueryProfile,
  getOutgoingNeighbors,
  getStructuralNeighbors,
} from "@client/graph";
import { clamp, deriveStructuralModuleLabel, isConfigPath, isLocalizationPath, normalizePath, type GraphState, type ImpactReport, type ResearchReport } from "@client/shared";

interface ImpactInput {
  runId: string;
  graph: GraphState;
  research: ResearchReport;
}

export function analyzeImpact(input: ImpactInput): ImpactReport {
  const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  // Evidence-to-graph seam fix (2026-07-16): historically evidence.id was
  // assumed to BE a graph node id - true for the deterministic researcher
  // (its evidence items are born from graph nodes), never true for the
  // agentic researcher (stableId(["agentic-evidence", ...])), which made
  // impact silently start from nothing in team mode ("0 затронутых файлов"
  // on every team-mode run). Two-part fix: (1) drop evidence ids that don't
  // resolve to a real node BEFORE they occupy the startingPoints cap;
  // (2) resolve evidence to graph file-nodes by filePath as well - the
  // mode-independent link every researcher provides.
  const liveEvidenceNodeIds = input.research.evidence
    .map((item) => item.id)
    .filter((id) => nodeById.has(id));
  const fileNodeIdByPath = new Map(
    input.graph.nodes
      .filter((node) => node.kind === "file" && node.filePath)
      .map((node) => [normalizePath(node.filePath as string), node.id]),
  );
  const evidenceFileNodeIds = input.research.evidence
    .map((item) => (item.filePath ? fileNodeIdByPath.get(normalizePath(item.filePath)) : undefined))
    .filter((id): id is string => Boolean(id));
  const profileSeedNodes = getNodesForQueryProfile(
    input.graph,
    input.research.queryProfileKey,
    input.research.dominantModule !== "не определён" ? { moduleLabel: input.research.dominantModule } : undefined,
  );
  const startingPoints = uniqueStrings([
    ...liveEvidenceNodeIds.slice(0, 6),
    ...evidenceFileNodeIds.slice(0, 8),
    ...profileSeedNodes.slice(0, 8).map((node) => node.id),
  ]).slice(0, 10);
  const affectedFiles = new Set<string>();
  const affectedSymbols = new Set<string>();
  const affectedModules = new Set<string>();
  const infrastructureFocus =
    input.research.queryProfileKey === "storage-topology" || isInfrastructureQuestion(input.research.task);

  for (const nodeId of startingPoints) {
    const node = nodeById.get(nodeId);

    if (!node) {
      continue;
    }

    if (node.kind === "file" && node.filePath) {
      affectedFiles.add(node.filePath);
      affectedModules.add(deriveStructuralModuleLabel(node.filePath));
      expandFileImpact(input.graph, node.id, affectedFiles, affectedModules);
    }

    if (isGraphCodeNode(node.kind)) {
      affectedSymbols.add(node.label);
      if (node.filePath) {
        affectedModules.add(deriveStructuralModuleLabel(node.filePath));
      }

      for (const neighbor of getIncomingNeighbors(input.graph, nodeId)) {
        if (neighbor.kind === "file" && neighbor.filePath) {
          affectedFiles.add(neighbor.filePath);
          affectedModules.add(deriveStructuralModuleLabel(neighbor.filePath));
          expandFileImpact(input.graph, neighbor.id, affectedFiles, affectedModules);
        }
      }
    }

    for (const neighbor of getIncomingNeighbors(input.graph, nodeId)) {
      if (neighbor.kind === "file" && neighbor.filePath) {
        affectedFiles.add(neighbor.filePath);
        affectedModules.add(deriveStructuralModuleLabel(neighbor.filePath));
        expandFileImpact(input.graph, neighbor.id, affectedFiles, affectedModules);
      }
    }

    for (const neighbor of getOutgoingNeighbors(input.graph, nodeId)) {
      if (neighbor.kind === "file" && neighbor.filePath) {
        affectedFiles.add(neighbor.filePath);
        affectedModules.add(deriveStructuralModuleLabel(neighbor.filePath));
        expandFileImpact(input.graph, neighbor.id, affectedFiles, affectedModules);
      }

      if (isGraphCodeNode(neighbor.kind)) {
        affectedSymbols.add(neighbor.label);
        if (neighbor.filePath) {
          affectedModules.add(deriveStructuralModuleLabel(neighbor.filePath));
        }
      }
    }
  }

  for (const moduleLabel of input.research.affectedModules) {
    for (const relation of getModuleRelations(input.graph, moduleLabel)) {
      for (const candidate of [nodeById.get(relation.sourceId), nodeById.get(relation.targetId)]) {
        if (candidate?.kind === "module") {
          affectedModules.add(candidate.label);
        }
      }
    }
  }

  switch (input.research.queryProfileKey) {
    case "entrypoint-traversal":
      expandEntrypointImpact(input.graph, startingPoints, affectedFiles, affectedModules, affectedSymbols);
      break;
    case "storage-topology":
      expandInfrastructureImpact(input.graph, input.research, affectedFiles, affectedModules, affectedSymbols);
      break;
    case "localization-inventory":
      expandInventoryImpact(input.graph, affectedFiles, affectedModules, affectedSymbols, isLocalizationPath);
      break;
    case "config-inventory":
      expandInventoryImpact(input.graph, affectedFiles, affectedModules, affectedSymbols, isConfigPath);
      break;
    case "broad-scan":
      expandBroadImpact(input.graph, input.research, affectedFiles, affectedModules, affectedSymbols);
      break;
    default:
      if (infrastructureFocus) {
        expandInfrastructureImpact(input.graph, input.research, affectedFiles, affectedModules, affectedSymbols);
      }
      break;
  }

  const fileList = [...affectedFiles].sort();
  const symbolList = [...affectedSymbols, ...affectedModules].sort();
  const risks = buildRisks(fileList, symbolList, input.research);
  const validationScope = buildValidationScope(fileList);
  const confidence = computeConfidence(input.research.confidence, fileList.length, risks.length);

  return {
    runId: input.runId,
    summary:
      fileList.length > 0
        ? `Анализ влияния прогнозирует ${fileList.length} напрямую затронутых файлов и ${symbolList.length} структурных символов.`
        : "Анализ влияния не смог определить конкретный радиус затрагивания на основе текущих исследовательских опор.",
    startingPoints,
    affectedFiles: fileList,
    affectedSymbols: symbolList,
    risks,
    validationScope,
    confidence,
  };
}

function expandEntrypointImpact(
  graph: GraphState,
  startingPoints: string[],
  affectedFiles: Set<string>,
  affectedModules: Set<string>,
  affectedSymbols: Set<string>,
): void {
  for (const nodeId of startingPoints) {
    for (const neighbor of getStructuralNeighbors(graph, nodeId, ["CALLS", "USES", "REFERENCES", "BELONGS_TO"], "both")) {
      if (neighbor.filePath) {
        affectedFiles.add(neighbor.filePath);
        affectedModules.add(deriveStructuralModuleLabel(neighbor.filePath));
      }

      if (isGraphCodeNode(neighbor.kind)) {
        affectedSymbols.add(neighbor.label);
      }
    }
  }
}

function expandFileImpact(
  graph: GraphState,
  fileNodeId: string,
  affectedFiles: Set<string>,
  affectedModules: Set<string>,
): void {
  for (const dependency of getFileDependencies(graph, fileNodeId)) {
    if (dependency.filePath) {
      affectedFiles.add(dependency.filePath);
      affectedModules.add(deriveStructuralModuleLabel(dependency.filePath));
    }
  }

  for (const dependent of getFileDependents(graph, fileNodeId)) {
    if (dependent.filePath) {
      affectedFiles.add(dependent.filePath);
      affectedModules.add(deriveStructuralModuleLabel(dependent.filePath));
    }
  }
}

function expandInventoryImpact(
  graph: GraphState,
  affectedFiles: Set<string>,
  affectedModules: Set<string>,
  affectedSymbols: Set<string>,
  matcher: (filePath: string) => boolean,
): void {
  for (const node of graph.nodes) {
    if (!node.filePath || !matcher(node.filePath.toLowerCase())) {
      continue;
    }

    affectedFiles.add(node.filePath);
    affectedModules.add(deriveStructuralModuleLabel(node.filePath));

    if (isGraphCodeNode(node.kind)) {
      affectedSymbols.add(node.label);
    }
  }
}

function expandInfrastructureImpact(
  graph: GraphState,
  research: ResearchReport,
  affectedFiles: Set<string>,
  affectedModules: Set<string>,
  affectedSymbols: Set<string>,
): void {
  const focusTerms = extractInfrastructureTerms(research);

  for (const node of graph.nodes) {
    const filePath = node.filePath?.toLowerCase() ?? "";
    const label = node.label.toLowerCase();

    if (!filePath) {
      continue;
    }

    let score = 0;

    if (filePath.includes("/models/") || filePath.includes("/entities/")) {
      score += 2;
    }

    if (filePath.includes("/repositories/") || filePath.includes("/repository/")) {
      score += 2;
    }

    if (filePath.includes("/migrations/")) {
      score += 3;
    }

    if (filePath.includes("/requests/")) {
      score += 2;
    }

    if (filePath.includes("/config/") || filePath.endsWith(".env") || filePath.includes(".env.")) {
      score += 2;
    }

    if (filePath.includes("credential") || filePath.includes("secret") || filePath.includes("vault")) {
      score += 3;
    }

    if (filePath.includes("server") || filePath.includes("connection") || filePath.includes("forwarding")) {
      score += 3;
    }

    if (focusTerms.some((term) => filePath.includes(term) || label.includes(term))) {
      score += 3;
    }

    if (score < 4) {
      continue;
    }

    affectedFiles.add(node.filePath!);
    affectedModules.add(deriveStructuralModuleLabel(node.filePath!));

    if (isGraphCodeNode(node.kind)) {
      affectedSymbols.add(node.label);
    }
  }
}

function expandBroadImpact(
  graph: GraphState,
  research: ResearchReport,
  affectedFiles: Set<string>,
  affectedModules: Set<string>,
  affectedSymbols: Set<string>,
): void {
  const topModules = research.affectedModules.slice(0, 4);

  for (const node of graph.nodes) {
    if (!node.filePath) {
      continue;
    }

    if (!topModules.some((moduleLabel) => node.filePath?.toLowerCase().includes(moduleLabel.toLowerCase()))) {
      continue;
    }

    affectedFiles.add(node.filePath);
    affectedModules.add(deriveStructuralModuleLabel(node.filePath));

    if (isGraphCodeNode(node.kind)) {
      affectedSymbols.add(node.label);
    }
  }
}

function buildRisks(files: string[], symbols: string[], research: ResearchReport): string[] {
  const risks: string[] = [];

  if (files.some((file) => file.startsWith("packages/shared"))) {
    risks.push("Изменения в shared-пакете могут каскадно затронуть и API, и web-часть.");
  }

  if (files.some((file) => file.startsWith("apps/api"))) {
    risks.push("Изменения в orchestration-слое API могут повлиять на детерминированный контракт пайплайна, который видит операторская консоль.");
  }

  if (files.some((file) => file.startsWith("apps/web"))) {
    risks.push("Изменения в операторской консоли требуют проверки, что нерелевантные артефакты не попадают в видимый контекст.");
  }

  if (files.length >= 8 || symbols.length >= 12) {
    risks.push("Радиус затрагивания достаточно широкий, поэтому регрессионные проверки должны покрывать несколько зон проекта.");
  }

  if (research.queryProfileKey === "broad-scan") {
    risks.push("Вопрос остаётся широким, поэтому impact scope требует дополнительного human narrowing перед execution.");
  }

  if (research.queryProfileKey === "config-inventory") {
    risks.push("Изменения в config/env зоне могут скрыто влиять на несколько runtime-сценариев даже при компактном file scope.");
  }

  if (research.queryProfileKey === "localization-inventory") {
    risks.push("Локализационный scope требует проверки полноты языковых каталогов и согласованности translation keys.");
  }

  // No generic filler risk here on purpose (removed 2026-07-15): this used
  // to unconditionally push a boilerplate "execution layer" line whenever
  // no specific risk condition matched - which leaked into plain read-only
  // questions ("what fields does this model have") that have no real risk
  // to report at all. buildRisksSection (packages/ai) already only renders
  // the "Что может пойти не так" section when risks is non-empty - a
  // genuinely empty array correctly omits the section instead of inventing
  // a platitude to fill it.
  return risks;
}

function buildValidationScope(files: string[]): string[] {
  const scope = ["Повторно выполнить полную индексацию", "Проверить сводку графа", "Проверить сохранённый артефакт знаний"];

  if (files.some((file) => file.startsWith("apps/api"))) {
    scope.push("Запустить typecheck для API workspace");
  }

  if (files.some((file) => file.startsWith("apps/web"))) {
    scope.push("Собрать операторскую консоль");
  }

  return scope;
}

function computeConfidence(researchConfidence: number, affectedFileCount: number, riskCount: number): number {
  let confidence = researchConfidence - riskCount * 3 + Math.min(affectedFileCount * 2, 12);
  return clamp(Math.round(confidence), 10, 95);
}

function isGraphCodeNode(kind: GraphState["nodes"][number]["kind"]): boolean {
  return ["class", "interface", "enum", "function", "method", "route", "middleware"].includes(kind);
}

function isInfrastructureQuestion(task: string): boolean {
  const normalized = task.toLowerCase();

  return [
    "ssh",
    "sftp",
    "ftp",
    "server",
    "servers",
    "connection",
    "connections",
    "credential",
    "credentials",
    "host",
    "hostname",
    "port",
    "private key",
    "private_key",
    "passphrase",
    "vault",
    "сервер",
    "подключение",
    "подключения",
    "соединение",
    "соединения",
    "хост",
    "порт",
    "пароль",
    "ключ",
  ].some((token) => normalized.includes(token));
}

function extractInfrastructureTerms(research: ResearchReport): string[] {
  const values = [
    research.task,
    research.functionalSummary,
    ...research.affectedModules,
    ...research.entryPoints,
    ...research.primaryEntities,
    ...research.references,
  ].join(" ").toLowerCase();

  const terms = [
    "server",
    "servers",
    "credential",
    "vault",
    "password",
    "private_key",
    "private",
    "passphrase",
    "forwarding",
    "host",
    "port",
    "connection",
    "ssh",
    "sftp",
  ];

  return terms.filter((term) => values.includes(term));
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => Boolean(value) && values.indexOf(value) === index);
}
