import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/app-exception.filter';
import { TransformInterceptor } from './common/transform.interceptor';
import { runtimeConfig } from './common/runtime-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // quiet the verbose route-mapping/bootstrap logs so the combined
    // `pnpm dev` output stays readable. errors and warnings still show
    logger: ['error', 'warn'],
  });

  app.setGlobalPrefix('api');
  app.enableCors({ origin: runtimeConfig.webOrigin, credentials: true });
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  app.enableShutdownHooks();

  await app.listen(runtimeConfig.port);

  // this is the last thing to print after a `pnpm dev/start`, so show both
  // URLs here, the web one first since that's the one you actually open. the
  // plain console.log so it always shows regardless of the nest log level
  const webPort = process.env.WEB_PORT ?? '3002';
  console.log(
    `\n  Data Bridge · ready\n\n` +
      `    Web  http://localhost:${webPort}   ← open this\n` +
      `    API  http://localhost:${runtimeConfig.port}/api\n`,
  );
}

void bootstrap();
