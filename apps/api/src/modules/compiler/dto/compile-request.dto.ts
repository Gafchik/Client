export type CompilerMode = "auto" | "build" | "ask";

export class CompileRequestDto {
  projectId!: string;
  task!: string;
  chatId?: string;
  teamId?: string;
  mode?: CompilerMode;
  execute?: boolean;
  maxContextTokens?: number;
}

