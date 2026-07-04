import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import { ProvidersService } from "./providers.service.js";
import { SaveProviderDto } from "./dto/save-provider.dto.js";

@Controller("providers")
export class ProvidersController {
  constructor(@Inject(ProvidersService) private readonly providersService: ProvidersService) {}

  @Get()
  async listProviders() {
    const providers = await this.providersService.list();
    return { providers };
  }

  @Post()
  async saveProvider(@Body() body: SaveProviderDto) {
    const provider = await this.providersService.save(body);
    return { provider };
  }

  @Delete(":id")
  async deleteProvider(@Param("id") id: string) {
    return this.providersService.remove(id);
  }
}
