import { Controller, Get } from "@nestjs/common";

@Controller("settings")
export class SettingsController {
  @Get()
  getSettings() {
    return {
      env: {
        LOCAL_PROJECTS_ROOT: process.env.LOCAL_PROJECTS_ROOT || "/Users/evgenii",
        CONTAINER_PROJECTS_ROOT: process.env.CONTAINER_PROJECTS_ROOT || process.env.LOCAL_PROJECTS_ROOT || "/Users/evgenii",
      },
    };
  }
}
