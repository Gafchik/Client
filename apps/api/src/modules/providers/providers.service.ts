import { Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProviderEntity } from "../../persistence/provider.entity.js";
import { SaveProviderDto } from "./dto/save-provider.dto.js";

type PublicProvider = Omit<ProviderEntity, "apiKey"> & {
  apiKey: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
};

const DEFAULT_PROVIDER = {
  name: "rout.my",
  baseUrl: "https://api.rout.my/v1",
  modelsUrl: "https://api.rout.my/v1/models",
} as const;

@Injectable()
export class ProvidersService implements OnModuleInit {
  constructor(
    @InjectRepository(ProviderEntity)
    private readonly providersRepository: Repository<ProviderEntity>,
  ) {}

  async onModuleInit() {
    const count = await this.providersRepository.count();
    if (count === 0) {
      await this.save({
        name: DEFAULT_PROVIDER.name,
        baseUrl: DEFAULT_PROVIDER.baseUrl,
        apiKey: "",
        modelsUrl: DEFAULT_PROVIDER.modelsUrl,
        isCurrent: true,
      });
    }
  }

  async list() {
    const providers = await this.providersRepository.find({
      order: {
        updatedAt: "DESC",
      },
    });
    return providers.map((provider) => this.toPublic(provider));
  }

  async getById(id: string) {
    const provider = await this.providersRepository.findOneBy({ id });
    if (!provider) throw new NotFoundException("Provider not found");
    return provider;
  }

  async getActive() {
    const provider = await this.providersRepository.findOne({
      where: { isCurrent: true },
      order: { updatedAt: "DESC" },
    });
    if (provider) return provider;

    const fallback = await this.providersRepository.findOne({
      where: { isActive: true },
      order: { updatedAt: "DESC" },
    });
    if (!fallback) throw new NotFoundException("No active provider found");
    return fallback;
  }

  async save(input: SaveProviderDto) {
    const existing = input.id ? await this.providersRepository.findOneBy({ id: input.id }) : null;
    const shouldBeCurrent = input.isCurrent ?? existing?.isCurrent ?? (await this.providersRepository.count()) === 0;

    if (shouldBeCurrent) {
      await this.providersRepository
        .createQueryBuilder()
        .update(ProviderEntity)
        .set({ isCurrent: false })
        .execute();
    }

    const entity = this.providersRepository.create({
      id: existing?.id || `provider-${Date.now()}`,
      name: input.name?.trim() || existing?.name || DEFAULT_PROVIDER.name,
      baseUrl: input.baseUrl?.trim() || existing?.baseUrl || DEFAULT_PROVIDER.baseUrl,
      apiKey: input.apiKey?.trim() || existing?.apiKey || "",
      modelsUrl: input.modelsUrl?.trim() || existing?.modelsUrl || DEFAULT_PROVIDER.modelsUrl,
      isActive: true,
      isCurrent: shouldBeCurrent,
      createdAt: existing?.createdAt || new Date(),
      updatedAt: new Date(),
    });

    const saved = await this.providersRepository.save(entity);
    return this.toPublic(saved);
  }

  async remove(id: string) {
    const provider = await this.getById(id);
    await this.providersRepository.remove(provider);
    const remaining = await this.providersRepository.find({
      order: { updatedAt: "DESC" },
    });
    if (remaining[0] && !remaining.some((item) => item.isCurrent)) {
      remaining[0].isCurrent = true;
      await this.providersRepository.save(remaining[0]);
    }
    return { ok: true };
  }

  private toPublic(provider: ProviderEntity): PublicProvider {
    return {
      ...provider,
      apiKey: "",
      apiKeyMasked: this.maskApiKey(provider.apiKey),
      hasApiKey: Boolean(provider.apiKey),
    };
  }

  private maskApiKey(apiKey: string) {
    const trimmed = apiKey?.trim() ?? "";
    if (!trimmed) return "";
    if (trimmed.length <= 8) return "*".repeat(trimmed.length);
    return `${trimmed.slice(0, 4)}${"*".repeat(Math.max(trimmed.length - 8, 4))}${trimmed.slice(-4)}`;
  }
}
