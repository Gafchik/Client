export const ROLE_ORDER = ["orchestrator", "analyst", "developer", "tester", "reviewer"] as const;

/** Tool kinds that can be requested during a run */
export type ToolKind = "file_read" | "file_write" | "shell" | "migration" | "search";

/** Per-role tool permissions */
export interface RoleToolPolicy {
  allowed: ToolKind[];
  shellWhitelist?: string[]; // read-only commands allowed for restricted roles
}

export const ROLE_TOOL_POLICIES: Record<string, RoleToolPolicy> = {
  orchestrator: {
    allowed: ["file_read", "search"],
    shellWhitelist: ["ls", "cat", "head", "tail", "grep", "find", "wc", "tree"],
  },
  analyst: {
    allowed: ["file_read", "search"],
    shellWhitelist: ["ls", "cat", "head", "tail", "grep", "find", "wc", "tree", "rg"],
  },
  developer: {
    allowed: ["file_read", "file_write", "shell", "migration", "search"],
  },
  tester: {
    allowed: ["file_read", "shell", "search"],
    shellWhitelist: ["ls", "cat", "head", "tail", "grep", "find", "wc", "tree", "rg", "npm test", "npm run test", "npx jest", "npx vitest", "npx playwright test", "git diff", "git log"],
  },
  reviewer: {
    allowed: ["file_read", "search"],
    shellWhitelist: ["ls", "cat", "head", "tail", "grep", "find", "wc", "tree", "rg", "git diff", "git log", "git show"],
  },
};

/** Maximum weighted tokens a single role turn may consume */
export const DEFAULT_MAX_TOKENS_PER_ROLE = 200_000;

export function createDefaultTeam(name = "Core Team") {
  return {
    id: `team-${Date.now()}`,
    name,
    description: "Дисциплинированная команда для сложного кода: оркестратор маршрутизирует, аналитик сжимает контекст, разработчик меняет только реальный код, верификатор проверяет фактами и возвращает баг назад.",
    language: "ru",
    budget: {
      dailyWeightedTokens: 50000000,
      timezone: process.env.TZ || "Europe/Kiev",
    },
    workspace: {
      maxFiles: 12,
      maxCharsPerFile: 12000,
      includeExtensions: [
        ".js",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".jsx",
        ".json",
        ".md",
        ".txt",
        ".css",
        ".scss",
        ".html",
        ".yml",
        ".yaml",
        ".py",
        ".php",
        ".rb",
        ".go",
        ".rs",
        ".java",
        ".kt",
        ".swift",
        ".sql",
      ],
      ignoreDirs: [".git", ".idea", "node_modules", "dist", "build", ".next", ".agent-team"],
    },
    run: {
      maxReviewRounds: 1,
      applyChanges: true,
      artifactDir: ".agent-team",
      requireApprovalForCommands: true,
      requireApprovalForFileWrites: false,
    },
    testing: {
      commands: [],
    },
    agents: {
      orchestrator: {
        name: "Alex",
        label: "Оркестратор",
        model: "deepseek/deepseek-v3.2",
        multiplier: 0.5,
        temperature: 0.05,
      },
      analyst: {
        name: "Mira",
        label: "Аналитик",
        model: "deepseek/deepseek-v4-pro",
        multiplier: 0.7,
        temperature: 0.1,
      },
      developer: {
        name: "Kai",
        label: "Разработчик",
        model: "deepseek/deepseek-v4-pro",
        multiplier: 0.7,
        temperature: 0.05,
      },
      tester: {
        name: "Nova",
        label: "Верификатор",
        model: "deepseek/deepseek-v4-flash",
        multiplier: 0.5,
        temperature: 0.05,
      },
      reviewer: {
        name: "Lex",
        label: "Критик",
        model: "deepseek/deepseek-v4-flash",
        multiplier: 0.5,
        temperature: 0.1,
      },
    },
  };
}
