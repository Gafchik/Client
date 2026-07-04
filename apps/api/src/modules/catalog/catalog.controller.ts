import { Controller, Get, Inject, Logger, Query } from "@nestjs/common";
import { MODEL_CATALOG } from "../../shared/model-catalog.js";
import { ProvidersService } from "../providers/providers.service.js";

@Controller("catalog")
export class CatalogController {
  private readonly logger = new Logger(CatalogController.name);

  // Индекс захардкоженного каталога по id модели — чтобы добирать
  // множитель/label, если провайдер не прислал token_multiplier в своём
  // списке моделей (не у всех моделей в списке есть множитель).
  private readonly catalogById = new Map<string, (typeof MODEL_CATALOG)[number]>(
    MODEL_CATALOG.map((m) => [m.id, m] as const),
  );

  constructor(@Inject(ProvidersService) private readonly providersService: ProvidersService) {}

  @Get("models")
  async getModels(@Query("providerId") providerId?: string) {
    // Каждый провайдер хранит свой modelsUrl в БД. Каталог должен тянуть
    // модели из ссылки ВЫБРАННОГО провайдера (по providerId), а не из общего
    // захардкоженного списка и не только из активного провайдера. Если
    // providerId не передан — берём активный (isCurrent) для обратной
    // совместимости.
    let provider;
    try {
      provider = providerId
        ? await this.providersService.getById(providerId)
        : await this.providersService.getActive();
    } catch (error) {
      this.logger.warn(`getModels: provider not found (${providerId || "active"}): ${error instanceof Error ? error.message : String(error)}`);
      return { items: MODEL_CATALOG, source: "fallback" as const };
    }

    if (!provider.modelsUrl) {
      this.logger.warn(`getModels: provider ${provider.id} has no modelsUrl, returning fallback catalog`);
      return { items: MODEL_CATALOG, source: "fallback" as const };
    }

    try {
      const response = await fetch(provider.modelsUrl);
      if (!response.ok) {
        throw new Error(`models api failed with ${response.status}`);
      }
      const data = (await response.json()) as {
        data?: Array<{
          id: string;
          owned_by?: string;
          token_multiplier?: number;
          is_available?: boolean;
        }>;
      };

      const items = (data.data ?? [])
        .filter((item) => item.is_available !== false)
        .map((item) => {
          const known = this.catalogById.get(item.id);
          // Множитель в первую очередь берём из ответа провайдера; если его
          // там нет — добираем из локального каталога; иначе 1.
          const multiplier = item.token_multiplier ?? known?.multiplier ?? 1;
          return {
            provider: item.owned_by || item.id.split("/")[0] || known?.provider || "unknown",
            label: known?.label || item.id,
            id: item.id,
            multiplier,
          };
        });

      return { items, source: "provider" as const };
    } catch (error) {
      this.logger.warn(`getModels: failed to fetch ${provider.modelsUrl}: ${error instanceof Error ? error.message : String(error)}`);
      // Запасной вариант, чтобы UI не сломался, если провайдер недоступен.
      return { items: MODEL_CATALOG, source: "fallback" as const };
    }
  }
}
