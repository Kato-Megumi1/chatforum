import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Row-lock protocols require reads after the lock to see the latest committed
    // state, not a MySQL REPEATABLE READ snapshot established before waiting.
    super({ transactionOptions: { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5000, timeout: 10000 } });
  }
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
