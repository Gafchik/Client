import { Controller, Get } from "@nestjs/common";
import { MODEL_CATALOG } from "../../shared/model-catalog.js";
import { ProvidersService } from "../providers/providers.service.js";

@Controller("catalog")
export class CatalogController {
  constructor(private readonly providersService: ProvidersService) {}

  @Get("models")
  async getModels() {
    try {
      const provider = await this.providersService.getActive();
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
        .map((item) => ({
          provider: item.owned_by || item.id.split("/")[0] || "unknown",
          label: item.id,
          id: item.id,
          multiplier: item.token_multiplier ?? 1,
        }));

      return { items };
    } catch {
      return { items: MODEL_CATALOG };
    }
  }
}
