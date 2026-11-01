'use strict';

const { planCenterJobs } = require('../../centers');

function planJobs(event, group) {
  if (!group.events.includes(event.type)) return [];
  const planned = planCenterJobs(event, group);
  if (planned !== null) return planned;
  return [...new Map((event.payload.recipients || []).map(recipient => [recipient.mobile, recipient])).values()]
    .map(recipient => ({ ...recipient, action: 'notify', operationKey: null }));
}

module.exports = { planJobs };
