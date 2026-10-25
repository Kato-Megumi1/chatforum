import { PrismaClient } from '@prisma/client';
import { ConfigModule } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';

async function main() {
  await ConfigModule.forRoot({ envFilePath: '.env' });
  const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
  if (!email || !email.includes('@') || !password || password.length < 14)
    throw new Error('Set ADMIN_EMAIL and a unique ADMIN_PASSWORD (at least 14 characters) in the private environment');
  const db = new PrismaClient();
  try {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing && existing.role !== 'ADMIN') throw new Error('Email belongs to a non-admin; no account was promoted');
    if (!existing) await db.user.create({ data: {
      email, username: process.env.ADMIN_USERNAME || '站点管理员', password: await bcrypt.hash(password, 12), role: 'ADMIN',
    } });
    for (const name of ['小说讨论', '角色交流', '学习分享', '日常闲聊'])
      await db.category.upsert({ where: { name }, create: { name }, update: {} });
    console.log('Bootstrap completed. Existing passwords, posts and conversations were not changed.');
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
