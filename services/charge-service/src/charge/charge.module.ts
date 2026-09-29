import { Module, type DynamicModule } from "@nestjs/common";
import { PlatformModule } from "@rounding/platform/http";
import type { Credentials } from "@rounding/platform/config";
import { Store } from "../store.js";
import type { ResolveEncounter } from "./charge-operations.js";
import { ChargeController } from "./charge.controller.js";
import { ChargeService } from "./charge.service.js";
const RESOLVE_ENCOUNTER = Symbol("RESOLVE_ENCOUNTER");
@Module({})
export class ChargeModule {
  static register(
    store: Store,
    credentials: Credentials,
    resolve: ResolveEncounter,
  ): DynamicModule {
    return {
      module: ChargeModule,
      imports: [
        PlatformModule.register({
          service: "charge",
          credentials,
          database: store,
        }),
      ],
      controllers: [ChargeController],
      providers: [
        { provide: Store, useValue: store },
        { provide: RESOLVE_ENCOUNTER, useValue: resolve },
        {
          provide: ChargeService,
          useFactory: (store: Store, resolve: ResolveEncounter) =>
            new ChargeService(store, resolve),
          inject: [Store, RESOLVE_ENCOUNTER],
        },
      ],
      exports: [ChargeService],
    };
  }
}
