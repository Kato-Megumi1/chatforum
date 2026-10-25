import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatService } from './chat.service';
import { ChatRunController } from './chat-run.controller';
import { ChatRunService } from './chat-run.service';
import { ChatController } from './chat.controller';
import { RagController } from './rag.controller';
import { PrismaService } from '../../common/prisma.service';
import { AgentModule } from '../agent/agent.module';
import { CodingController } from '../coding/coding.controller';
import { MemoryControlsController } from './memory-controls.controller';

@Module({
  imports: [JwtModule.register({}), AgentModule],
  controllers: [ChatController, ChatRunController, RagController, CodingController, MemoryControlsController],
  providers: [ChatService, ChatRunService, PrismaService],
})
export class ChatModule {}
