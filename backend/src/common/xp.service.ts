import { Injectable } from '@nestjs/common';

/**
 * XP and level system.
 * XP formula: xpForLevel(n) = n * n * 50
 * Level 1: 50 XP, Level 10: 5000 XP, Level 50: 125000 XP, Level 100: 500000 XP
 */
@Injectable()
export class XpService {
  /** XP required to reach a given level (cumulative from level 1) */
  static xpForLevel(level: number): number {
    return level * level * 50;
  }

  /** Calculate current level from total XP */
  static getLevel(totalXp: number): number {
    let level = 1;
    while (level < 100 && totalXp >= this.xpForLevel(level + 1)) {
      level++;
    }
    return level;
  }

  /** XP earned for login (once per day) */
  static readonly LOGIN_XP = 10;

  /** XP earned for creating a post */
  static readonly POST_XP = 20;
}
