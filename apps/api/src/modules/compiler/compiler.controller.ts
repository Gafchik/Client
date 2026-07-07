import { Body, Controller, Inject, Post } from "@nestjs/common";
import { CompilerService } from "./compiler.service.js";
import { CompileRequestDto } from "./dto/compile-request.dto.js";

@Controller("compile")
export class CompilerController {
  constructor(
    @Inject(CompilerService)
    private readonly compilerService: CompilerService,
  ) {}

  @Post()
  async compile(@Body() body: CompileRequestDto) {
    const result = await this.compilerService.compile({
      ...body,
      mode: body.mode || "auto",
    });
    return { result };
  }

  @Post("build")
  async build(@Body() body: CompileRequestDto) {
    const result = await this.compilerService.compile({
      ...body,
      mode: "build",
      execute: body.execute ?? true,
    });
    return { result };
  }

  @Post("ask")
  async ask(@Body() body: CompileRequestDto) {
    const result = await this.compilerService.ask({
      ...body,
      mode: "ask",
      execute: false,
    });
    return { result };
  }
}

