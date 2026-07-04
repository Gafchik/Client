export const ROLE_ORDER = ["orchestrator", "developer", "tester", "analyst"] as const;

export function createDefaultTeam(name = "Core Team") {
  return {
    id: `team-${Date.now()}`,
    name,
    description: "Базовая команда: оркестратор -> аналитик -> разработчик -> тестировщик",
    language: "en",
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
        model: "openai/gpt-5.4-mini",
        multiplier: 0.8,
        temperature: 0.2,
      },
      analyst: {
        name: "Mira",
        label: "Бизнес-аналитик",
        model: "deepseek/deepseek-v4-pro",
        multiplier: 0.7,
        temperature: 0.2,
      },
      developer: {
        name: "Kai",
        label: "Разработчик",
        model: "openai/gpt-5.3-codex",
        multiplier: 2,
        temperature: 0.15,
      },
      tester: {
        name: "Nova",
        label: "Тестировщик",
        model: "deepseek/deepseek-v4-flash",
        multiplier: 0.5,
        temperature: 0.1,
      },
    },
  };
}
