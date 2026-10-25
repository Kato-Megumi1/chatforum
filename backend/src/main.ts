import { json, urlencoded } from 'express';
import { NestFactory } from '@nestjs/core';
import { RequestValidationPipe } from './common/request-validation.pipe';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module';
import configuration from './config/configuration';

async function bootstrap() {
  const config = configuration();
  if (config.env === 'production') {
    for (const secret of [config.jwt.accessSecret, config.jwt.refreshSecret])
      if (!secret || secret.length < 32 || /replace|change.?me/i.test(secret)) throw new Error('Production JWT secrets must be independently generated (32+ characters)');
    if (config.jwt.accessSecret === config.jwt.refreshSecret) throw new Error('Use distinct access/refresh secrets');
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  // Only trust our same-container Nginx; never trust arbitrary forwarded headers.
  if (config.env === 'production') app.set('trust proxy', 'loopback');

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  app.enableCors({
    origin: config.cors.origin.split(',').map(origin => origin.trim()).filter(Boolean),
    credentials: true,
  });

  app.useGlobalPipes(new RequestValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  app.setGlobalPrefix('api');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ChatForum API')
    .setDescription('ChatForum 智能对话与社区交流平台 API 文档')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  if (config.env !== 'production' || process.env.ENABLE_API_DOCS === 'true') {
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = config.port || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
