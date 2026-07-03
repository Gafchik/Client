import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { ChatEntity } from "./chat.entity.js";
import { ProjectEntity } from "./project.entity.js";

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
  status!: "backlog" | "in_progress" | "done";

  @Column("varchar", { nullable: true })
  sourceChatId!: string | null;

  @ManyToOne(() => ChatEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "sourceChatId" })
  sourceChat!: ChatEntity | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
