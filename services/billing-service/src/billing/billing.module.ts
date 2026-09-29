import { Module, type DynamicModule } from "@nestjs/common";
import { PlatformModule } from "@rounding/platform/http";
import type { Credentials } from "@rounding/platform/config";
import { Store } from "../store.js";

import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";

@Module({})
export class BillingModule {
  static register(
    store: Store,
    credentials: Credentials,
    serviceToken: string,
  ): DynamicModule {
    return {
      module: BillingModule,
      imports: [
        PlatformModule.register({
          service: "billing",
          credentials,
          database: store,
          serviceToken,
        }),
      ],
      controllers: [BillingController],
      providers: [
        { provide: Store, useValue: store },
        {
          provide: BillingService,
          useFactory: (store: Store) => new BillingService(store),
          inject: [Store],
        },
      ],
      exports: [BillingService],
    };
  }
}
