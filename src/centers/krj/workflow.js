'use strict';

// KRJ event selection follows the 31 October PACS contract.
// Persistence, dispatch and retries belong to the shared repository and worker.
function planJobs(event, group) {
  if (!group.events.includes(event.type)) return [];
  if (event.type === 'STUDY_UPLOADED') {
    // New envelope IDs identify new uploads, even when orderId/uploadCount
    // repeats after rollback or reaches the count cap. Never deduplicate by order.
    return [{ mobile: '', kind: 'HIMS', action: 'mark_uploaded', operationKey: null }];
  }
  if (event.type === 'SIGNOFF') {
    // A re-sign-off has a new event ID and must deliver the revised report.
    return [{ mobile: '', kind: 'HIMS', action: 'send_report', operationKey: null }];
  }
  return [];
}

module.exports = { planJobs };
