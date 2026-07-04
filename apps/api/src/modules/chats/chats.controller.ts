import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { ChatsService } from "./chats.service.js";
import { SaveChatDto } from "./dto/save-chat.dto.js";
import { SendChatMessageDto } from "./dto/send-chat-message.dto.js";

@Controller("chats")
export class ChatsController {
  constructor(@Inject(ChatsService) private readonly chatsService: ChatsService) {}

  @Get()
  async listChats(@Query("projectId") projectId?: string) {
    const chats = await this.chatsService.list(projectId);
    return { chats };
  }

  @Get(":id")
  async getChat(@Param("id") id: string) {
    return this.chatsService.getById(id);
  }

  @Post()
  async saveChat(@Body() body: SaveChatDto) {
    const chat = await this.chatsService.save(body);
    return { chat };
  }

  @Post(":id/messages")
  async sendMessage(@Param("id") id: string, @Body() body: SendChatMessageDto) {
    return this.chatsService.sendMessageToOrchestrator(id, body.content, body.teamId);
  }

  @Delete(":id")
  async deleteChat(@Param("id") id: string) {
    return this.chatsService.remove(id);
  }
}
