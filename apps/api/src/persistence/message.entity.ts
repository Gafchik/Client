import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { ChatEntity } from "./chat.entity.js";

@Entity({ name: "messages" })
export class MessageEntity {
  @PrimaryColumn("varchar")
  id!: string;

  @Column("varchar")
  chatId!: string;

  @ManyToOne(() => ChatEntity, (chat) => chat.messages, { onDelete: "CASCADE" })
  @JoinColumn({ name: "chatId" })
  chat!: ChatEntity;

  @Column("varchar")
  role!: string;

  @Column("text")
  content!: string;

  @Column("jsonb", { nullable: true })
  meta!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;
}
