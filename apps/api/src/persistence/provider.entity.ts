import { Column, CreateDateColumn, Entity, OneToMany, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { TeamEntity } from "./team.entity.js";

@Entity({ name: "providers" })
export class ProviderEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  name!: string;

  @Column("text")
  baseUrl!: string;

  @Column("text")
  apiKey!: string;

  @Column("text")
  modelsUrl!: string;

  @Column("boolean", { default: true })
  isActive!: boolean;

  @Column("boolean", { default: false })
  isCurrent!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => TeamEntity, (team) => team.provider)
  teams!: TeamEntity[];
}
