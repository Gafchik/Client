import { TaskStatus } from "../../../persistence/task.entity.js";

export class SaveTaskDto {
  id?: string;
  projectId!: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  sourceChatId?: string | null;
}
