import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { ProviderEntity } from "./provider.entity.js";
import { RunEntity } from "./run.entity.js";
import { ChatEntity } from "./chat.entity.js";

@Entity({ name: "teams" })
export class TeamEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  name!: string;

  @Column("text", { default: "" })
  description!: string;

  @Column("varchar", { nullable: true })
  providerId!: string | null;

  @ManyToOne(() => ProviderEntity, (provider) => provider.teams, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "providerId" })
  provider!: ProviderEntity | null;

  @Column("jsonb")
  config!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => RunEntity, (run) => run.team)
  runs!: RunEntity[];

  @OneToMany(() => ChatEntity, (chat) => chat.team)
  chats!: ChatEntity[];
}
