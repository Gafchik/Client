import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import { TeamsService } from "./teams.service.js";
import { SaveTeamDto } from "./dto/save-team.dto.js";

@Controller("teams")
export class TeamsController {
  constructor(@Inject(TeamsService) private readonly teamsService: TeamsService) {}

  @Get()
  async listTeams() {
    const teams = await this.teamsService.list();
    return {
      teams: teams.map((team) => ({
        id: team.id,
        name: team.name,
        description: team.description,
        providerId: team.providerId,
        ...team.config,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
      })),
    };
  }

  @Post()
  async saveTeam(@Body() body: SaveTeamDto) {
    const savedTeam = await this.teamsService.save(body);
    return {
      team: {
        id: savedTeam.id,
        name: savedTeam.name,
        description: savedTeam.description,
        providerId: savedTeam.providerId,
        ...(savedTeam.config as Record<string, unknown>),
        createdAt: savedTeam.createdAt,
        updatedAt: savedTeam.updatedAt,
      },
    };
  }

  @Delete(":id")
  async deleteTeam(@Param("id") id: string) {
    return this.teamsService.remove(id);
  }
}
