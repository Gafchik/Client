export class SaveTaskDto {
  id?: string;
  projectId!: string;
  title?: string;
  description?: string;
  status?: "backlog" | "in_progress" | "done";
  sourceChatId?: string | null;
}
