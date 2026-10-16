'use strict';

const { getGroupConfig } = require('../config/groups');
const { EVENT_TYPES } = require('../utils/validation');
const { HttpError } = require('../utils/errors');

class GroupRouterService {
  constructor(config, lookup = getGroupConfig) { this.config = config; this.lookup = lookup; }

  resolve(groupId) {
    const group = this.lookup(groupId, this.config);
    if (!group) throw new HttpError(503, 'GROUP_NOT_CONFIGURED', 'No integration is configured for this PACS group');
    if (group.enabled === false) throw new HttpError(503, 'GROUP_DISABLED', 'This PACS group integration is disabled');
    if (group.groupId !== groupId || typeof group.provider !== 'string' || !Array.isArray(group.events) ||
        !group.events.every((type) => EVENT_TYPES.includes(type))) {
      throw new HttpError(503, 'GROUP_CONFIG_INVALID', 'The group integration configuration needs correction');
    }
    return group;
  }
}

module.exports = { GroupRouterService };
