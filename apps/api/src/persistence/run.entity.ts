import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { ChatEntity } from "./chat.entity.js";
import { ProjectEntity } from "./project.entity.js";
import { TeamEntity } from "./team.entity.js";

@Entity({ name: "runs" })
export class RunEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  teamId!: string;

  @Column("varchar", { nullable: true })
  projectId!: string | null;

  @Column("varchar", { nullable: true })
  chatId!: string | null;

  @ManyToOne(() => TeamEntity, (team) => team.runs, { onDelete: "CASCADE" })
  @JoinColumn({ name: "teamId" })
  team!: TeamEntity;

  @ManyToOne(() => ProjectEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "projectId" })
  project!: ProjectEntity | null;

  @ManyToOne(() => ChatEntity, (chat) => chat.runs, { onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "chatId" })
  chat!: ChatEntity | null;

  @Column("varchar")
  teamName!: string;

  @Column("text")
  task!: string;

  /**
   * Исходное сообщение пользователя (как он написал в чат). Используется
   * детерминированным detectRunMode, чтобы стоп-фраза «код не пишите» не
   * терялась при переложении задачи в executionTask оркестратором.
   * nullable, т.к. старые runs и запуски не из чата его не имеют.
   */
  @Column("text", { nullable: true })
  originalMessage!: string | null;

  @Column("text")
  projectPath!: string;

  @Column("varchar")
  status!: string;

  @Column("jsonb", { default: [] })
  events!: Array<{ at: string; event: string; payload?: unknown }>;

  @Column("jsonb", { nullable: true })
  finalReport!: Record<string, unknown> | null;

  @Column("text", { nullable: true })
  runDir!: string | null;

  @Column("text", { nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  startedAt!: Date;

  @Column("timestamptz", { nullable: true })
  finishedAt!: Date | null;

  @Column("int", { default: 0 })
  retryCount!: number;
}

// Алиас для обратной совместимости
export { RunEntity as Run };
