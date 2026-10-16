'use strict';

const { parseJson, validateEnvelope } = require('../utils/validation');
const { HttpError } = require('../utils/errors');

class OutboxService {
  constructor(repository, groupRouter, providers, logger) {
    this.repository = repository; this.groupRouter = groupRouter;
    this.providers = providers; this.logger = logger;
  }

  receive(rawBody, context) {
    const event = validateEnvelope(parseJson(rawBody));
    Object.assign(context, { eventId: event.id, groupId: event.groupId, eventType: event.type });
    const previous = this.repository.findEvent(event.id);
    if (previous) return this.duplicate(previous.group_id !== event.groupId, event, context);
    const group = this.groupRouter.resolve(event.groupId);
    context.provider = group.provider;
    if (group.events.includes(event.type) && event.payload.recipients?.length) this.providers.validate(group, event.type);
    let result;
    try { result = this.repository.accept(event, group, rawBody, context.requestId); }
    catch {
      this.logger.error('outbox.storage_failed', { ...context, errorCode: 'STORAGE_UNAVAILABLE' });
      throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Temporary storage failure; retry later');
    }
    if (result.duplicate) return this.duplicate(result.conflict, event, context);
    this.logger.info('outbox.accepted', { ...context, status: result.disposition, recipientCount: result.recipientCount });
    return { status: result.disposition === 'filtered' ? 'filtered' : 'accepted', id: event.id, groupId: event.groupId };
  }

  duplicate(conflict, event, context) {
    if (conflict) throw new HttpError(409, 'EVENT_ID_CONFLICT', 'This event ID already belongs to another PACS group');
    this.logger.info('outbox.duplicate', context);
    return { status: 'duplicate', id: event.id, groupId: event.groupId };
  }
}

module.exports = { OutboxService };
