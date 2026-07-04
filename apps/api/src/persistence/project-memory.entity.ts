import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { ProjectEntity } from "./project.entity.js";

@Entity({ name: "project_memory_entries" })
export class ProjectMemoryEntryEntity {
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
  summary!: string;

  @Column("text", { default: "" })
  details!: string;

  @Column("varchar", { default: "feature" })
  kind!: string;

  @Column("jsonb", { default: [] })
  tags!: string[];

  @Column("jsonb", { default: [] })
  relatedFiles!: string[];

  @Column("varchar", { nullable: true })
  sourceRunId!: string | null;

  @Column("varchar", { nullable: true })
  sourceChatId!: string | null;

  @Column("float", { default: 0.5 })
  relevanceScore!: number;

  @Column("boolean", { default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
