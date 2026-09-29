import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Database } from "./db.js";
/** Nest drains background IO before closing HTTP, then releases storage after HTTP closes. */
@Injectable()
export class ApplicationLifecycle
  implements OnModuleDestroy, OnApplicationShutdown
{
  private stopping = false;
  private readonly tasks: Promise<void>[] = [];
  private database?: Database;
  private readonly logger = new Logger(ApplicationLifecycle.name);
  ownDatabase(database: Database) {
    this.database = database;
  }
  start(tick: () => Promise<unknown>, delay: number) {
    const task = (async () => {
      while (!this.stopping) {
        try {
          await tick();
        } catch {
          this.logger.error({ code: "BACKGROUND_TICK_FAILED" });
        }
        if (!this.stopping)
          await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
    this.tasks.push(task);
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.all(this.tasks);
  }
  async onApplicationShutdown() {
    await this.database?.close();
    this.database = undefined;
  }
}
