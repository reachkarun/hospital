import { Module, type DynamicModule } from "@nestjs/common";
import { PlatformModule } from "@rounding/platform/http";
import type { Credentials } from "@rounding/platform/config";
import type { ServiceUrls } from "./gateway.service.js";
import { GatewayController } from "./gateway.controller.js";
import { GatewayService } from "./gateway.service.js";
const SERVICE_URLS = Symbol("SERVICE_URLS");
@Module({})
export class GatewayModule {
  static register(credentials: Credentials, urls: ServiceUrls): DynamicModule {
    return {
      module: GatewayModule,
      imports: [PlatformModule.register({ service: "gateway", credentials })],
      controllers: [GatewayController],
      providers: [
        { provide: SERVICE_URLS, useValue: urls },
        {
          provide: GatewayService,
          useFactory: (urls: ServiceUrls) => new GatewayService(urls),
          inject: [SERVICE_URLS],
        },
      ],
      exports: [GatewayService],
    };
  }
}
