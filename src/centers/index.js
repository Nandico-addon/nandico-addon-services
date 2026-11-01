'use strict';

// Register each center once. A center owns its configuration, optional custom
// workflow, environment validation and center-specific provider implementations.
const centers = [require('./ramsnehi'), require('./krj')];

function createCenterRegistry(configurations) {
  const groups = new Map();
  for (const configuration of configurations) {
    const placeholder = configuration.centerId === 'krj' && configuration.groupId === 0;
    if (!Number.isSafeInteger(configuration.groupId) || (configuration.groupId <= 0 && !placeholder) || groups.has(configuration.groupId)) {
      throw new Error('Each center must have a unique positive PACS group ID');
    }
    groups.set(configuration.groupId, structuredClone(configuration));
  }
  return {
    getGroupConfig(groupId) {
      const group = groups.get(groupId);
      // A request may change its own snapshot, never another request's settings.
      return group ? structuredClone(group) : null;
    },
  };
}

function getGroupConfig(groupId, config) {
  const env = config?.providerEnv || {};
  const configurations = centers.map(center => center.createConfig(env)).filter(Boolean);
  return createCenterRegistry(configurations).getGroupConfig(groupId);
}

function loadCenterSettings(env) {
  const settings = Object.assign({}, ...centers.map(center => center.validateEnvironment?.(env) || {}));
  // Validate configured group uniqueness at startup, including optional centers.
  createCenterRegistry(centers.map(center => center.createConfig(env)).filter(Boolean));
  return settings;
}

function planCenterJobs(event, group) {
  const center = centers.find(center => center.id === group.centerId) ||
    // Historical jobs predate centerId. Provider IDs remain stable across moves.
    centers.find(center => Object.hasOwn(center.providers || {}, group.provider));
  return center?.planJobs ? center.planJobs(event, group) : null;
}

function centerProviderEntries(config) {
  return centers.flatMap(center => Object.entries(center.providers || {})
    .map(([name, Provider]) => [name, new Provider(config)]));
}

module.exports = { createCenterRegistry, getGroupConfig, loadCenterSettings, planCenterJobs, centerProviderEntries };
