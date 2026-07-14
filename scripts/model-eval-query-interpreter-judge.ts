// Standalone comparison harness for the two LLM steps discussed for Research
// Engine: expandTaskSearchKeywords (Query Interpreter) and validateEvidence
// (Retrieval Judge). Both already exist in @client/ai — this script does not
// add new production code, it exercises the existing functions against
// several models and prints a side-by-side comparison so we can see how
// model choice affects query-understanding/evidence-judgement behavior.
//
// Run: npx tsx --env-file=.env scripts/model-eval-query-interpreter-judge.ts
import { expandTaskSearchKeywords, validateEvidence } from "@client/ai";
import type { ValidationPacket } from "@client/shared";

const PROVIDER_BASE_URL = process.env.CLIENT_PROVIDER_BASE_URL?.trim() || "https://api.rout.my/v1";
const PROVIDER_API_KEY = process.env.CLIENT_PROVIDER_API_KEY?.trim() || "";

const DETERMINISTIC_FALLBACK_MARKER = "Validator оценивает readiness независимо от upstream confidence";

const MODELS = [
  { id: "nvidia/nemotron-3-ultra", label: "Nemotron 3 Ultra (0.0x)" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro (0.7x)" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini (0.8x)" },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (0.5x)" },
];

// --- Query Interpreter cases -------------------------------------------------
// Real documented gaps for the deterministic substring/alias search
// (see packages/ai/src/index.ts comment above expandTaskSearchKeywords and
// docs/state/test-scenarios.md §7.3).
const INTERPRETER_CASES = [
  {
    id: "translation-gap",
    task: "как устроена транспортировка пациента в проекте?",
    expectAnyOf: ["transport", "transfer", "shipment", "ride", "patient"],
  },
  {
    id: "conflicting-domains",
    task: "как связаны локализации и ssh подключения?",
    // No "expected" keywords — this case checks for over-eager fabrication
    // (a bad interpreter invents a connective keyword that does not exist).
    expectAnyOf: [],
  },
  {
    id: "subscription-check",
    task: "как проверяется подписка пользователя?",
    expectAnyOf: ["subscri", "trial", "plan", "billing"],
  },
];

// --- Retrieval Judge cases ----------------------------------------------------
function basePacket(overrides: Partial<ValidationPacket>): ValidationPacket {
  return {
    packetId: "eval-packet",
    runId: "eval-run",
    iteration: 0,
    task: "",
    questionType: "flow",
    researchSummary: "",
    functionalSummary: "",
    researchConfidence: 55,
    impactSummary: "",
    impactConfidence: 50,
    contextSummary: "",
    contextConfidence: 50,
    structuralAnchors: [],
    evidenceHighlights: [],
    graphCoverage: { nodeCount: 40, edgeCount: 60, relevantAnchorCount: 3, entryPointCount: 1 },
    diagnostics: [],
    priorActions: [],
    remainingIterationBudget: 2,
    ...overrides,
  };
}

const JUDGE_CASES: Array<{ id: string; expectation: string; packet: ValidationPacket }> = [
  {
    id: "domain-collision-user-vs-servers",
    expectation: "Should flag that evidence is about servers/vault, not the User model — status should not be ready-for-answer as-is.",
    packet: basePacket({
      task: "что хранит модель юзера",
      questionType: "schema",
      researchSummary: "Исследование нашло структурные опоры в зоне servers/vault.",
      functionalSummary: "Задача бьёт в servers/vault. Основные точки входа: app/Models/Server.php.",
      researchConfidence: 62,
      structuralAnchors: ["app/Models/Server.php", "app/Models/ServerCredentialLink.php"],
      evidenceHighlights: [
        { label: "Server.php", filePath: "app/Models/Server.php", reason: "path match: server", score: 44, origin: "structural" },
        { label: "ServerCredentialLink.php", filePath: "app/Models/ServerCredentialLink.php", reason: "path match: server credential", score: 38, origin: "structural" },
        { label: "path_to_private_key field", filePath: "database/migrations/2024_create_servers_table.php", reason: "content match: private_key", score: 30, origin: "structural" },
      ],
    }),
  },
  {
    id: "clean-auth-evidence",
    expectation: "Evidence is on-topic and reasonably strong — should lean toward ready-for-answer / sufficient.",
    packet: basePacket({
      task: "как работает модуль авторизации?",
      questionType: "flow",
      researchSummary: "Исследование нашло 5 сильных структурных опор в auth зоне.",
      functionalSummary: "Задача бьёт в auth, web-login. Точки входа: AuthController, WebLoginController.",
      researchConfidence: 81,
      structuralAnchors: ["routes/api/auth/routes.php", "app/Http/Controllers/AuthController.php", "app/Services/WebLoginTicketService.php"],
      evidenceHighlights: [
        { label: "AuthController.php", filePath: "app/Http/Controllers/AuthController.php", reason: "path+symbol match: auth", score: 52, origin: "structural" },
        { label: "routes/api/auth/routes.php", filePath: "routes/api/auth/routes.php", reason: "route match: auth", score: 48, origin: "structural" },
        { label: "WebLoginTicketService.php", filePath: "app/Services/WebLoginTicketService.php", reason: "path+symbol match: login", score: 40, origin: "structural" },
      ],
      graphCoverage: { nodeCount: 40, edgeCount: 60, relevantAnchorCount: 5, entryPointCount: 3 },
    }),
  },
  {
    id: "conflicting-domains",
    expectation: "Locale files and SSH/server files have no real relation — should be flagged as contradiction/noise, not merged into one story.",
    packet: basePacket({
      task: "как связаны локализации и ssh подключения?",
      questionType: "why",
      researchSummary: "Вопрос слишком широкий, найдены опоры сразу в двух неродственных зонах.",
      functionalSummary: "Задача частично бьёт в localization, частично в servers — прямой связи в графе не найдено.",
      researchConfidence: 34,
      structuralAnchors: ["lang/en/messages.php", "app/Models/Server.php"],
      evidenceHighlights: [
        { label: "lang/en/messages.php", filePath: "lang/en/messages.php", reason: "path match: lang", score: 20, origin: "structural" },
        { label: "Server.php", filePath: "app/Models/Server.php", reason: "path match: server/ssh", score: 18, origin: "structural" },
      ],
      graphCoverage: { nodeCount: 40, edgeCount: 60, relevantAnchorCount: 2, entryPointCount: 0 },
      diagnostics: ["Graph did not return a direct edge between localization and server/ssh subgraphs."],
    }),
  },
];

interface InterpreterRunResult {
  modelId: string;
  caseId: string;
  ok: boolean;
  latencyMs: number;
  keywords: string[];
  hitExpected: boolean | null;
  error?: string;
}

interface JudgeRunResult {
  modelId: string;
  caseId: string;
  ok: boolean;
  latencyMs: number;
  status: string;
  readinessScore: number;
  missingEntityHints: string[];
  contradictionLevel: string;
  looksLikeFallback: boolean;
  rationale: string;
  error?: string;
}

async function runInterpreterCase(modelId: string, testCase: (typeof INTERPRETER_CASES)[number]): Promise<InterpreterRunResult> {
  const start = Date.now();
  try {
    const keywords = await expandTaskSearchKeywords({
      task: testCase.task,
      providerBaseUrl: PROVIDER_BASE_URL,
      providerModel: modelId,
      providerApiKey: PROVIDER_API_KEY,
    });
    const latencyMs = Date.now() - start;
    const hitExpected =
      testCase.expectAnyOf.length === 0
        ? null
        : keywords.some((keyword) => testCase.expectAnyOf.some((needle) => keyword.toLowerCase().includes(needle)));

    return { modelId, caseId: testCase.id, ok: true, latencyMs, keywords, hitExpected };
  } catch (error) {
    return {
      modelId,
      caseId: testCase.id,
      ok: false,
      latencyMs: Date.now() - start,
      keywords: [],
      hitExpected: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runJudgeCase(modelId: string, testCase: (typeof JUDGE_CASES)[number]): Promise<JudgeRunResult> {
  const start = Date.now();
  try {
    const result = await validateEvidence({
      packet: testCase.packet,
      providerBaseUrl: PROVIDER_BASE_URL,
      providerModel: modelId,
      providerApiKey: PROVIDER_API_KEY,
    });
    const latencyMs = Date.now() - start;

    return {
      modelId,
      caseId: testCase.id,
      ok: true,
      latencyMs,
      status: result.status,
      readinessScore: result.readinessScore,
      missingEntityHints: result.missingEntityHints,
      contradictionLevel: result.contradictionLevel,
      looksLikeFallback: result.rationale.includes(DETERMINISTIC_FALLBACK_MARKER),
      rationale: result.rationale,
    };
  } catch (error) {
    return {
      modelId,
      caseId: testCase.id,
      ok: false,
      latencyMs: Date.now() - start,
      status: "error",
      readinessScore: -1,
      missingEntityHints: [],
      contradictionLevel: "unknown",
      looksLikeFallback: true,
      rationale: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  if (!PROVIDER_API_KEY) {
    console.error("CLIENT_PROVIDER_API_KEY is not set. Run with: npx tsx --env-file=.env scripts/model-eval-query-interpreter-judge.ts");
    process.exit(1);
  }

  console.log(`Provider: ${PROVIDER_BASE_URL}`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}\n`);

  const interpreterResults: InterpreterRunResult[] = [];
  const judgeResults: JudgeRunResult[] = [];

  for (const model of MODELS) {
    console.log(`\n=== ${model.label} (${model.id}) ===`);

    console.log("-- Query Interpreter --");
    for (const testCase of INTERPRETER_CASES) {
      const result = await runInterpreterCase(model.id, testCase);
      interpreterResults.push(result);
      console.log(
        `[${testCase.id}] ok=${result.ok} latency=${result.latencyMs}ms keywords=${JSON.stringify(result.keywords)} hitExpected=${result.hitExpected}${result.error ? ` error=${result.error}` : ""}`,
      );
    }

    console.log("-- Retrieval Judge --");
    for (const testCase of JUDGE_CASES) {
      const result = await runJudgeCase(model.id, testCase);
      judgeResults.push(result);
      console.log(
        `[${testCase.id}] ok=${result.ok} latency=${result.latencyMs}ms status=${result.status} readiness=${result.readinessScore} contradiction=${result.contradictionLevel} missingEntityHints=${JSON.stringify(result.missingEntityHints)} fallback=${result.looksLikeFallback}${result.error ? ` error=${result.error}` : ""}`,
      );
    }
  }

  console.log("\n\n=== SUMMARY (JSON) ===");
  console.log(JSON.stringify({ interpreterResults, judgeResults }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
