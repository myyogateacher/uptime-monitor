// Run with: bun test (from sidecar-swarm/ or the repo root)
import { describe, expect, test } from 'bun:test'

import { extractServiceIdentity, normalizeBareContainerName, parseReplicaSlot } from './metrics'

const LABEL_SERVICE = 'com.docker.swarm.service.name'
const LABEL_TASK = 'com.docker.swarm.task.name'
const LABEL_STACK = 'com.docker.stack.namespace'

const SESSION_UUID = 'b7d942e1-b98d-465c-aa95-4b92da46ff90'

describe('normalizeBareContainerName', () => {
  test('strips a trailing full UUID', () => {
    expect(normalizeBareContainerName(`recorder-${SESSION_UUID}`)).toBe('recorder')
  })

  test('strips a trailing hex blob', () => {
    expect(normalizeBareContainerName('recorder-3f9a12ab77c1')).toBe('recorder')
  })

  test('keeps a deliberate numeric suffix', () => {
    expect(normalizeBareContainerName('worker-2')).toBe('worker-2')
  })

  test('leaves a plain name alone', () => {
    expect(normalizeBareContainerName('api')).toBe('api')
  })

  test('leaves a bare UUID alone — nothing human to keep', () => {
    expect(normalizeBareContainerName(SESSION_UUID)).toBe(SESSION_UUID)
  })
})

describe('extractServiceIdentity — tier 1, swarm', () => {
  test('per-session service `recorder-<uuid>` collapses into `recorder`', () => {
    const id = extractServiceIdentity(
      {
        [LABEL_SERVICE]: `recorder-${SESSION_UUID}`,
        [LABEL_TASK]: `recorder-${SESSION_UUID}.1.x3f9a2bc1d0`,
      },
      'recorder-b7d942e1.1.x3f9a2bc1d0',
    )
    expect(id.service_name).toBe('recorder')
    // The drill-down must still identify the individual session.
    expect(id.task_name).toContain(SESSION_UUID)
    // Slots are numbered per swarm service: every session would claim slot 1.
    expect(id.replica_slot).toBeNull()
  })

  test('per-session service without a task label falls back to the raw name', () => {
    const id = extractServiceIdentity({ [LABEL_SERVICE]: `recorder-${SESSION_UUID}` }, 'whatever')
    expect(id.service_name).toBe('recorder')
    expect(id.task_name).toBe(`recorder-${SESSION_UUID}`)
    expect(id.replica_slot).toBeNull()
  })

  test('normalisation still keeps the stack namespace', () => {
    const id = extractServiceIdentity(
      { [LABEL_SERVICE]: `recorder-${SESSION_UUID}`, [LABEL_STACK]: 'sessions' },
      'recorder-x',
    )
    expect(id.stack_namespace).toBe('sessions')
  })

  test('ordinary service `api` is untouched', () => {
    const labels = {
      [LABEL_SERVICE]: 'api',
      [LABEL_TASK]: 'api.3.qz81ab92cd',
      [LABEL_STACK]: 'prod',
    }
    expect(extractServiceIdentity(labels, 'api.3.qz81ab92cd')).toEqual({
      service_name: 'api',
      task_name: 'api.3.qz81ab92cd',
      replica_slot: 3,
      stack_namespace: 'prod',
    })
  })

  test('numeric-suffixed service `worker-2` is untouched', () => {
    const labels = {
      [LABEL_SERVICE]: 'worker-2',
      [LABEL_TASK]: 'worker-2.1.qz81ab92cd',
    }
    expect(extractServiceIdentity(labels, 'worker-2.1.qz81ab92cd')).toEqual({
      service_name: 'worker-2',
      task_name: 'worker-2.1.qz81ab92cd',
      replica_slot: 1,
      stack_namespace: null,
    })
  })

  test('global-mode task keeps its null slot', () => {
    const id = extractServiceIdentity(
      { [LABEL_SERVICE]: 'metrics-sidecar', [LABEL_TASK]: 'metrics-sidecar.node1.qz81ab92cd' },
      'metrics-sidecar.node1.qz81ab92cd',
    )
    expect(id.service_name).toBe('metrics-sidecar')
    expect(id.replica_slot).toBeNull()
  })
})

describe('extractServiceIdentity — tier 2, compose', () => {
  test('compose service names are not normalised', () => {
    const id = extractServiceIdentity(
      {
        'com.docker.compose.service': `recorder-${SESSION_UUID}`,
        'com.docker.compose.project': 'demo',
        'com.docker.compose.container-number': '2',
      },
      `demo-recorder-${SESSION_UUID}-2`,
    )
    expect(id.service_name).toBe(`recorder-${SESSION_UUID}`)
    expect(id.replica_slot).toBe(2)
    expect(id.stack_namespace).toBe('demo')
  })
})

describe('extractServiceIdentity — tier 3, bare docker run', () => {
  test('ephemeral container groups under the stripped name', () => {
    expect(extractServiceIdentity({}, `recorder-${SESSION_UUID}`)).toEqual({
      service_name: 'recorder',
      task_name: `recorder-${SESSION_UUID}`,
      replica_slot: null,
      stack_namespace: null,
    })
  })

  test('deliberate numeric suffix survives', () => {
    expect(extractServiceIdentity({}, 'worker-2')).toEqual({
      service_name: 'worker-2',
      task_name: 'worker-2',
      replica_slot: null,
      stack_namespace: null,
    })
  })

  test('empty container name yields a null identity', () => {
    expect(extractServiceIdentity({}, '')).toEqual({
      service_name: null,
      task_name: null,
      replica_slot: null,
      stack_namespace: null,
    })
  })
})

describe('parseReplicaSlot', () => {
  test('reads the slot out of a swarm task name', () => {
    expect(parseReplicaSlot('api.3.qz81ab92cd')).toBe(3)
  })

  test('global-mode node id is not a slot', () => {
    expect(parseReplicaSlot('api.node1.qz81ab92cd')).toBeNull()
  })

  test('null in, null out', () => {
    expect(parseReplicaSlot(null)).toBeNull()
  })
})
