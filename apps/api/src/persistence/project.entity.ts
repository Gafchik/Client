import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { ChatEntity } from "./chat.entity.js";
import { TeamEntity } from "./team.entity.js";

@Entity({ name: "projects" })
export class ProjectEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  name!: string;

  @Column("text", { default: "" })
  description!: string;

  @Column("text")
  localPath!: string;

  @Column("text")
  containerPath!: string;

  @Column("varchar", { nullable: true })
  teamId!: string | null;

  @ManyToOne(() => TeamEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "teamId" })
  team!: TeamEntity | null;

  @Column("boolean", { default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => ChatEntity, (chat) => chat.project)
  chats!: ChatEntity[];
}
