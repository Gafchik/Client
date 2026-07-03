import { TaskStatus } from "../../../persistence/task.entity.js";

export class UpdateTaskStatusDto {
  status!: TaskStatus;
  comment?: string;
  author?: string;
}
