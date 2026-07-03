import { Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProviderEntity } from "../../persistence/provider.entity.js";
import { TeamEntity } from "../../persistence/team.entity.js";
import { createDefaultTeam } from "../../shared/default-team.js";
import type { TeamConfig } from "../../shared/types.js";
import { ProvidersService } from "../providers/providers.service.js";
import { SaveTeamDto } from "./dto/save-team.dto.js";

@Injectable()
export class TeamsService implements OnModuleInit {
  constructor(
    @InjectRepository(TeamEntity)
    private readonly teamsRepository: Repository<TeamEntity>,
    @InjectRepository(ProviderEntity)
    private readonly providersRepository: Repository<ProviderEntity>,
    private readonly providersService: ProvidersService,
  ) {}

  async onModuleInit() {
    const count = await this.teamsRepository.count();
    if (count === 0) {
      const seed = createDefaultTeam();
      const provider = await this.providersService.getActive();
      await this.save({
        ...seed,
        providerId: provider.id,
      });
    }
  }

  async list() {
    return this.teamsRepository.find({
      relations: {
        provider: true,
      },
      order: {
        updatedAt: "DESC",
      },
    });
  }

  async getById(id: string) {
    const team = await this.teamsRepository.findOne({
      where: { id },
      relations: {
        provider: true,
      },
    });
    if (!team) throw new NotFoundException("Team not found");
    return team;
  }

  async save(input: SaveTeamDto) {
    const fallback = createDefaultTeam(input.name || "New Team");
    const now = new Date();
    const defaultProvider = await this.providersService.getActive();
    const provider =
      input.providerId === null
        ? null
        : await this.providersRepository.findOneBy({
            id: input.providerId || defaultProvider.id,
          });

    const merged = {
      ...fallback,
      ...input,
      language: typeof input.language === "string" && input.language.trim() ? input.language.trim() : fallback.language,
      budget: {
        ...fallback.budget,
        ...(input.budget ?? {}),
      },
      workspace: {
        ...fallback.workspace,
        ...(input.workspace ?? {}),
        includeExtensions: Array.isArray((input.workspace as any)?.includeExtensions)
          ? (input.workspace as any).includeExtensions
          : fallback.workspace.includeExtensions,
        ignoreDirs: Array.isArray((input.workspace as any)?.ignoreDirs)
          ? (input.workspace as any).ignoreDirs
          : fallback.workspace.ignoreDirs,
      },
      run: {
        ...fallback.run,
        ...(input.run ?? {}),
      },
      testing: {
        ...fallback.testing,
        ...(input.testing ?? {}),
        commands: Array.isArray((input.testing as any)?.commands)
          ? (input.testing as any).commands
          : fallback.testing.commands,
      },
      agents: {
        ...fallback.agents,
        ...(input.agents ?? {}),
      },
    };

    const existing = input.id ? await this.teamsRepository.findOneBy({ id: input.id }) : null;
    const entity = this.teamsRepository.create({
      id: existing?.id || merged.id,
      name: merged.name,
      description: merged.description,
      providerId: provider?.id ?? null,
      config: merged as unknown as Record<string, unknown>,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    return this.teamsRepository.save(entity);
  }

  async remove(id: string) {
    const team = await this.getById(id);
    await this.teamsRepository.remove(team);
    return { ok: true };
  }
}
