import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** Validate the wire value before converting it; global primitive transformation must retain strings. */
@Injectable()
export class PositiveIntIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
      throw new BadRequestException('编号必须是有效的正整数');
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) {
      throw new BadRequestException('编号超出有效范围');
    }
    return value;
  }
}
