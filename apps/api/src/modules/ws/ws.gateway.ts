import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect, ConnectedSocket, MessageBody } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { Inject, Injectable, Logger } from "@nestjs/common";

interface AuthenticatedSocket extends Socket {
  userId?: string;
  projectId?: string;
  chatId?: string;
}

@WebSocketGateway({
  cors: { origin: "*" },
  path: "/ws/socket.io",
})
@Injectable()
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WsGateway.name);
  private clientRooms = new Map<string, Set<string>>();

  constructor(@Inject(JwtService) private readonly jwtService: JwtService) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (token) {
        const payload = this.jwtService.verify(token);
        client.userId = payload.sub;
      }
      this.logger.log(`Client connected: ${client.id} (user: ${client.userId || 'anonymous'})`);
    } catch (e) {
      this.logger.warn(`Client ${client.id} connected without valid auth`);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const rooms = this.clientRooms.get(client.id);
    if (rooms) {
      for (const room of rooms) {
        this.leaveRoom(client, room);
      }
      this.clientRooms.delete(client.id);
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage("join:chat")
  handleJoinChat(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() data: { chatId: string }) {
    const room = `chat:${data.chatId}`;
    client.join(room);
    this.addToRoom(client.id, room);
    client.chatId = data.chatId;
    this.logger.log(`Client ${client.id} joined chat ${data.chatId}`);
    return { ok: true, room };
  }

  @SubscribeMessage("join:project")
  handleJoinProject(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() data: { projectId: string }) {
    const room = `project:${data.projectId}`;
    client.join(room);
    this.addToRoom(client.id, room);
    client.projectId = data.projectId;
    this.logger.log(`Client ${client.id} joined project ${data.projectId}`);
    return { ok: true, room };
  }

  @SubscribeMessage("leave:chat")
  handleLeaveChat(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() data: { chatId: string }) {
    const room = `chat:${data.chatId}`;
    this.leaveRoom(client, room);
    return { ok: true };
  }

  @SubscribeMessage("leave:project")
  handleLeaveProject(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() data: { projectId: string }) {
    const room = `project:${data.projectId}`;
    this.leaveRoom(client, room);
    return { ok: true };
  }

  private addToRoom(clientId: string, room: string) {
    if (!this.clientRooms.has(clientId)) this.clientRooms.set(clientId, new Set());
    this.clientRooms.get(clientId)!.add(room);
  }

  private leaveRoom(client: Socket, room: string) {
    client.leave(room);
    const rooms = this.clientRooms.get(client.id);
    if (rooms) rooms.delete(room);
  }

  broadcastToChat(chatId: string, event: string, data: unknown) {
    this.server.to(`chat:${chatId}`).emit(event, data);
  }

  broadcastToProject(projectId: string, event: string, data: unknown) {
    this.server.to(`project:${projectId}`).emit(event, data);
  }

  broadcastRunEvent(runId: string, chatId: string, event: string, data: unknown) {
    this.server.to(`chat:${chatId}`).emit("run:event", { runId, event, data, timestamp: new Date().toISOString() });
  }

  broadcastTokenStream(chatId: string, data: { role: string; content: string; done: boolean; usage?: any }) {
    this.server.to(`chat:${chatId}`).emit("token:stream", data);
  }

  broadcastAgentActivity(chatId: string, data: { role: string; agentName: string; label: string; status: "working" | "idle" | "done" | "error"; detail: string }) {
    this.server.to(`chat:${chatId}`).emit("agent:activity", data);
  }
}
