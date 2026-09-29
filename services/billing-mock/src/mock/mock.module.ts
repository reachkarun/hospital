import { Module, type DynamicModule } from "@nestjs/common";
import { PlatformModule } from "@rounding/platform/http";
import { Database as Store } from "@rounding/platform/db";
import { MockController } from "./mock.controller.js";
import { MockService } from "./mock.service.js";
@Module({})
export class MockModule {
  static register(store: Store, token: string): DynamicModule {
    return {
      module: MockModule,
      imports: [
        PlatformModule.register({
          service: "billing-mock",
          credentials: {},
          externalToken: token,
        }),
      ],
      controllers: [MockController],
      providers: [
        { provide: Store, useValue: store },
        {
          provide: MockService,
          useFactory: (store: Store) => new MockService(store),
          inject: [Store],
        },
      ],
      exports: [MockService],
    };
  }
}
