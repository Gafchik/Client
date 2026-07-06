export class SaveProjectMemoryDto {
  id?: string;
  projectId!: string;
  title?: string;
  summary?: string;
  details?: string;
  graph?: Record<string, unknown>;
  kind?: string;
  tags?: string[];
  relatedFiles?: string[];
  sourceRunId?: string | null;
  sourceChatId?: string | null;
  relevanceScore?: number | null;
}
