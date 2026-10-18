'use strict';

const ramsnehi = require('./ramsnehi/config');

function createClientRegistry(clients) {
  const groups = new Map();
  for (const client of clients) {
    if (!Number.isSafeInteger(client.groupId) || client.groupId <= 0 || groups.has(client.groupId)) {
      throw new Error('Each client must have a unique positive PACS group ID');
    }
    groups.set(client.groupId, structuredClone(client));
  }
  return {
    getGroupConfig(groupId) {
      const group = groups.get(groupId);
      // A request may change its own snapshot, never another request's settings.
      return group ? structuredClone(group) : null;
    },
  };
}

// Register each client once. Unknown groups have no fallback.
const { getGroupConfig } = createClientRegistry([ramsnehi]);

module.exports = { createClientRegistry, getGroupConfig };
