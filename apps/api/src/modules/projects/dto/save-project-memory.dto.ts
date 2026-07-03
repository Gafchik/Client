export class SaveProjectMemoryDto {
  id?: string;
  projectId!: string;
  title?: string;
  summary?: string;
  details?: string;
  kind?: string;
  tags?: string[];
  relatedFiles?: string[];
  sourceRunId?: string | null;
}
