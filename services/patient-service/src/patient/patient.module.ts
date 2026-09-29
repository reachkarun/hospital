import { Module, type DynamicModule } from "@nestjs/common";
import { PlatformModule } from "@rounding/platform/http";
import type { Credentials } from "@rounding/platform/config";
import { Store } from "../store.js";
import { PatientController } from "./patient.controller.js";
import { PatientService } from "./patient.service.js";
@Module({})
export class PatientModule {
  static register(
    store: Store,
    credentials: Credentials,
    serviceToken: string,
  ): DynamicModule {
    return {
      module: PatientModule,
      imports: [
        PlatformModule.register({
          service: "patient",
          credentials,
          database: store,
          serviceToken,
        }),
      ],
      controllers: [PatientController],
      providers: [
        { provide: Store, useValue: store },
        {
          provide: PatientService,
          useFactory: (store: Store) => new PatientService(store),
          inject: [Store],
        },
      ],
      exports: [PatientService],
    };
  }
}
