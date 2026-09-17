import { loadConfig } from './src/config.mjs';
import { createApp } from './src/app.mjs';
try {
  const config = loadConfig();
  const { server } = createApp(config);
  server.listen(config.port, config.host, () => console.log(`Dia Transcriber ouvindo em ${config.host}:${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
