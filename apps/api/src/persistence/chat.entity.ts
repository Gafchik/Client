import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";
import { MessageEntity } from "./message.entity.js";
import { ProjectEntity } from "./project.entity.js";
import { RunEntity } from "./run.entity.js";
import { TeamEntity } from "./team.entity.js";

@Entity({ name: "chats" })
export class ChatEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  projectId!: string;

  @Column("varchar")
  teamId!: string;

  @ManyToOne(() => ProjectEntity, (project) => project.chats, { onDelete: "CASCADE" })
  @JoinColumn({ name: "projectId" })
  project!: ProjectEntity;

  @ManyToOne(() => TeamEntity, (team) => team.chats, { onDelete: "CASCADE" })
  @JoinColumn({ name: "teamId" })
  team!: TeamEntity;

  @Column("varchar")
  title!: string;

  @Column("text", { default: "" })
  summary!: string;

  @Column("boolean", { default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => MessageEntity, (message) => message.chat)
  messages!: MessageEntity[];

  @OneToMany(() => RunEntity, (run) => run.chat, { cascade: true })
  runs!: RunEntity[];
}