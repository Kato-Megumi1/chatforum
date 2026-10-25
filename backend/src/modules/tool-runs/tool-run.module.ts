import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';
import { ToolRunController } from './tool-run.controller';
import { ToolRunService } from './tool-run.service';

@Global()
@Module({imports:[JwtModule.register({})],controllers:[ToolRunController],providers:[PrismaService,ToolRunService],exports:[ToolRunService]})
export class ToolRunModule {}
