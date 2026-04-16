import { config } from "./config.js";
import { SessionStore } from "./sessions.js";
import { TelegramBridge } from "./telegram.js";

async function main(): Promise<void> {
  const sessions = new SessionStore(config.stateDbPath);
  const bridge = new TelegramBridge(sessions);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`${sig} received, shutting down…`);
    try {
      await bridge.stop();
    } catch (err) {
      console.error("Error stopping bridge:", err);
    }
    sessions.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });

  await bridge.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
