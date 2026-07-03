import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { ChatEntity } from "./chat.entity.js";
import { ProjectEntity } from "./project.entity.js";
import { TaskCommentEntity } from "./task-comment.entity.js";

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

@Entity({ name: "tasks" })
export class TaskEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  projectId!: string;

  @ManyToOne(() => ProjectEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "projectId" })
  project!: ProjectEntity;

  @Column("varchar")
  title!: string;

  @Column("text", { default: "" })
  description!: string;

  @Column("varchar", { default: "backlog" })
  status!: TaskStatus;

  @Column("varchar", { nullable: true })
  sourceChatId!: string | null;

  @ManyToOne(() => ChatEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "sourceChatId" })
  sourceChat!: ChatEntity | null;

  @OneToMany(() => TaskCommentEntity, (comment) => comment.task)
  comments!: TaskCommentEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
