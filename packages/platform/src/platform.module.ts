import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, APP_FILTER } from "@nestjs/core";
import { HTTP_OPTIONS, type HttpOptions } from "./http-options.js";
import { AuthenticationGuard } from "./authentication.guard.js";
import { ApiExceptionFilter } from "./api-exception.filter.js";
import { ApplicationLifecycle } from "./lifecycle.js";
import { PlatformService } from "./platform.service.js";
import { PlatformController, AuditController } from "./platform.controller.js";
@Global()
@Module({})
export class PlatformModule {
  static register(options: HttpOptions): DynamicModule {
    return {
      module: PlatformModule,
      controllers:
        options.externalToken !== undefined
          ? []
          : [
              PlatformController,
              ...(options.database ? [AuditController] : []),
            ],
      providers: [
        { provide: HTTP_OPTIONS, useValue: options },
        PlatformService,
        ApplicationLifecycle,
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
      exports: [ApplicationLifecycle],
    };
  }
}
