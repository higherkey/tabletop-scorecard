import { standings } from './model.js';

const key = (s) => s.trim().toLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function computeStats(games, { gameName = null } = {}) {
  const finished = games
    .filter((game) => game.finishedAt != null)
    .sort((a, b) => a.finishedAt - b.finishedAt);

  const gameNameMap = new Map();
  for (const game of finished) {
    const k = key(game.name);
    const entry = gameNameMap.get(k) ?? { name: game.name, count: 0 };
    entry.name = game.name;
    entry.count += 1;
    gameNameMap.set(k, entry);
  }
  const gameNames = [...gameNameMap.values()].sort((a, b) => b.count - a.count || byName(a, b));

  const filterKey = gameName == null ? '' : key(gameName);
  const scoped = filterKey ? finished.filter((game) => key(game.name) === filterKey) : finished;

  const playerMap = new Map();
  for (const game of scoped) {
    for (const { player, total, rank } of standings(game)) {
      const k = key(player.name);
      let entry = playerMap.get(k);
      if (!entry) {
        entry = { key: k, name: player.name, played: 0, wins: 0, sum: 0, highScore: -Infinity };
        playerMap.set(k, entry);
      }
      entry.name = player.name;
      entry.played += 1;
      if (rank === 1) entry.wins += 1;
      entry.sum += total;
      entry.highScore = Math.max(entry.highScore, total);
    }
  }

  const players = [...playerMap.values()]
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      played: entry.played,
      wins: entry.wins,
      winRate: entry.wins / entry.played,
      avgScore: Math.round((entry.sum / entry.played) * 10) / 10,
      highScore: entry.highScore,
    }))
    .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || byName(a, b));

  return { gamesPlayed: scoped.length, gameNames, players };
}
