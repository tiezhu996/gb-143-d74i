import { PoolClient } from 'pg';
import { LEVEL_THRESHOLDS, BADGE_NAMES, BADGE_DESCRIPTIONS, Badge } from '../types';
import pool from '../db/pool';

export const calculateLevel = (totalPoints: number): number => {
  let currentLevel = 1;
  for (let level = 5; level >= 1; level--) {
    if (totalPoints >= LEVEL_THRESHOLDS[level]) {
      currentLevel = level;
      break;
    }
  }
  return currentLevel;
};

export const checkNewBadges = async (
  volunteerId: string,
  newLevel: number,
  currentBadges: Badge[]
): Promise<Badge[]> => {
  const newBadges: Badge[] = [];
  const currentLevels = currentBadges.map(b => b.star_level);

  for (let level = 2; level <= newLevel; level++) {
    if (!currentLevels.includes(level)) {
      const badgeName = BADGE_NAMES[level];
      const description = BADGE_DESCRIPTIONS[level];

      const client = await pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [volunteerId, level, badgeName, description]
        );
        newBadges.push(result.rows[0]);
      } finally {
        client.release();
      }
    }
  }

  return newBadges;
};

export const getVolunteerBadges = async (volunteerId: string): Promise<Badge[]> => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM badges WHERE volunteer_id = $1 ORDER BY star_level',
      [volunteerId]
    );
    return result.rows;
  } finally {
    client.release();
  }
};

export interface BadgeReconcileResult {
  awarded: Badge[];
  removed: Badge[];
}

/**
 * Make a volunteer's badge set match their current level within an open transaction.
 * Awards newly earned badges and revokes badges above the current level (e.g. after
 * an approved correction lowers total points), so badges always agree with the level.
 */
export const reconcileBadgesWithClient = async (
  client: PoolClient,
  volunteerId: string,
  newLevel: number
): Promise<BadgeReconcileResult> => {
  const currentBadgesResult = await client.query(
    'SELECT * FROM badges WHERE volunteer_id = $1 ORDER BY star_level',
    [volunteerId]
  );
  const currentBadges = currentBadgesResult.rows as Badge[];
  const currentLevels = currentBadges.map(b => b.star_level);

  const awarded: Badge[] = [];
  for (let level = 2; level <= newLevel; level++) {
    if (!currentLevels.includes(level)) {
      const result = await client.query(
        `INSERT INTO badges (volunteer_id, star_level, badge_name, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [volunteerId, level, BADGE_NAMES[level], BADGE_DESCRIPTIONS[level]]
      );
      awarded.push(result.rows[0]);
    }
  }

  const removed: Badge[] = [];
  for (const badge of currentBadges) {
    if (badge.star_level > newLevel) {
      await client.query(
        'DELETE FROM badges WHERE id = $1',
        [badge.id]
      );
      removed.push(badge);
    }
  }

  return { awarded, removed };
};

export { LEVEL_THRESHOLDS, BADGE_NAMES };
