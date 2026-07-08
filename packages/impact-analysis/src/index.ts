import { getFileDependencies, getFileDependents, getIncomingNeighbors, getModuleRelations, getOutgoingNeighbors } from "@client/graph";
import { clamp, type GraphState, type ImpactReport, type ResearchReport } from "@client/shared";

interface ImpactInput {
  runId: string;
  graph: GraphState;
  research: ResearchReport;
}

export function analyzeImpact(input: ImpactInput): ImpactReport {
  const evidenceIds = input.research.evidence.map((item) => item.id);
  const startingPoints = evidenceIds.slice(0, 6);
  const affectedFiles = new Set<string>();
  const affectedSymbols = new Set<string>();
  const affectedModules = new Set<string>();

  for (const nodeId of startingPoints) {
    const node = input.graph.nodes.find((candidate) => candidate.id === nodeId);

    if (!node) {
      continue;
    }

    if (node.kind === "file" && node.filePath) {
      affectedFiles.add(node.filePath);
      affectedModules.add(node.filePath.split("/")[0] || "root");
      expandFileImpact(input.graph, node.id, affectedFiles, affectedModules);
    }

    if (isGraphCodeNode(node.kind)) {
      affectedSymbols.add(node.label);
      if (node.filePath) {
        affectedModules.add(node.filePath.split("/")[0] || "root");
      }

      for (const neighbor of getIncomingNeighbors(input.graph, nodeId)) {
        if (neighbor.kind === "file" && neighbor.filePath) {
          affectedFiles.add(neighbor.filePath);
          affectedModules.add(neighbor.filePath.split("/")[0] || "root");
          expandFileImpact(input.graph, neighbor.id, affectedFiles, affectedModules);
        }
      }
    }

    for (const neighbor of getIncomingNeighbors(input.graph, nodeId)) {
      if (neighbor.kind === "file" && neighbor.filePath) {
        affectedFiles.add(neighbor.filePath);
        affectedModules.add(neighbor.filePath.split("/")[0] || "root");
        expandFileImpact(input.graph, neighbor.id, affectedFiles, affectedModules);
      }
    }

    for (const neighbor of getOutgoingNeighbors(input.graph, nodeId)) {
      if (neighbor.kind === "file" && neighbor.filePath) {
        affectedFiles.add(neighbor.filePath);
        affectedModules.add(neighbor.filePath.split("/")[0] || "root");
        expandFileImpact(input.graph, neighbor.id, affectedFiles, affectedModules);
      }

      if (isGraphCodeNode(neighbor.kind)) {
        affectedSymbols.add(neighbor.label);
        if (neighbor.filePath) {
          affectedModules.add(neighbor.filePath.split("/")[0] || "root");
        }
      }
    }
  }

  for (const moduleLabel of input.research.affectedModules) {
    for (const relation of getModuleRelations(input.graph, moduleLabel)) {
      const targetNode = input.graph.nodes.find((node) => node.id === relation.sourceId || node.id === relation.targetId);

      if (targetNode?.kind === "module") {
        affectedModules.add(targetNode.label);
      }
    }
  }

  const fileList = [...affectedFiles].sort();
  const symbolList = [...affectedSymbols, ...affectedModules].sort();
  const risks = buildRisks(fileList, symbolList);
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

function expandFileImpact(
  graph: GraphState,
  fileNodeId: string,
  affectedFiles: Set<string>,
  affectedModules: Set<string>,
): void {
  for (const dependency of getFileDependencies(graph, fileNodeId)) {
    if (dependency.filePath) {
      affectedFiles.add(dependency.filePath);
      affectedModules.add(dependency.filePath.split("/")[0] || "root");
    }
  }

  for (const dependent of getFileDependents(graph, fileNodeId)) {
    if (dependent.filePath) {
      affectedFiles.add(dependent.filePath);
      affectedModules.add(dependent.filePath.split("/")[0] || "root");
    }
  }
}

function buildRisks(files: string[], symbols: string[]): string[] {
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

  if (risks.length === 0) {
    risks.push("Текущая зона влияния выглядит локальной, но точное runtime-поведение всё ещё зависит от будущей интеграции execution-слоя.");
  }

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
