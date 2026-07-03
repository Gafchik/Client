export interface TeamConfig {
  language: string;
  budget: {
    dailyWeightedTokens: number;
    timezone: string;
  };
  workspace: {
    maxFiles: number;
    maxCharsPerFile: number;
    includeExtensions: string[];
    ignoreDirs: string[];
  };
  run: {
    maxReviewRounds: number;
    applyChanges: boolean;
    artifactDir: string;
  };
  testing: {
    commands: string[];
  };
  agents: Record<
    string,
    {
      name?: string;
      label: string;
      model: string;
      multiplier: number;
      temperature: number;
    }
  >;
}
