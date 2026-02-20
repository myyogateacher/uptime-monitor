import { EventEmitter } from 'node:events'

export const monitorEvents = new EventEmitter()

export const MONITOR_CHECKED_EVENT = 'monitor:checked'
export const GROUP_CREATED_EVENT = 'group:created'
export const GROUP_UPDATED_EVENT = 'group:updated'
export const GROUP_DELETED_EVENT = 'group:deleted'
export const ENDPOINT_CREATED_EVENT = 'endpoint:created'
export const ENDPOINT_UPDATED_EVENT = 'endpoint:updated'
export const ENDPOINT_DELETED_EVENT = 'endpoint:deleted'
