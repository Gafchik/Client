import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { TaskEntity } from "./task.entity.js";

export const TASK_COMMENT_TYPES = ["status_change", "result"] as const;
export type TaskCommentType = (typeof TASK_COMMENT_TYPES)[number];

@Entity({ name: "task_comments" })
export class TaskCommentEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  taskId!: string;

  @ManyToOne(() => TaskEntity, (task) => task.comments, { onDelete: "CASCADE" })
  @JoinColumn({ name: "taskId" })
  task!: TaskEntity;

  @Column("varchar")
  type!: TaskCommentType;

  @Column("text")
  content!: string;

  @Column("varchar", { nullable: true })
  author!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
